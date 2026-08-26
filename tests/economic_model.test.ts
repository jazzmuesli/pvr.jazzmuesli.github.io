import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, loadByConsumer, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { importPriceArray, cityForLocation } from "../src/calc/tariff";
import { computeEconomics } from "../src/calc/revenue";
import { effectiveNetPrice } from "../src/calc/vwap";
import { computeAmortisation } from "../src/calc/amortisation";
import { SimConfig } from "../src/calc/types";

const FLAT = 24; // fixed import tariff in ct/kWh used throughout

function baseConfig(load: Float64Array, cap: number, peak: number): SimConfig {
  return {
    pv: { peakKWp: peak, tiltDeg: 35, orientation: "east_west", location: "boizenburg" },
    battery: {
      capacityKWh: cap, maxPowerKW: 6, minSOC: 0.1, maxSOC: 0.95, efficiency: 0.95, startSOC: 0.5,
      chargeMode: "morning", dischargeEvening: true, dischargeMorning: true,
      eveningStart: 17, eveningEnd: 23, morningStart: 5, morningEnd: 12,
    },
    tariff: { feedInEUR: 0.072, commissioningYear: 2025 },
    prices: generatePrices(12345),
    load,
  };
}

function consumers(evPvShare: number, evKWh = 2000): ConsumerConfig {
  return {
    household: { enabled: true, annualKWh: 4000 },
    heatpump: { enabled: true, annualKWh: 5000 },
    bwwp: { enabled: true },
    ev: { enabled: true, annualKWh: evKWh, pvShare: evPvShare },
  };
}

const prices = generatePrices(12345);
const city = cityForLocation("boizenburg");

interface Model {
  econ: ReturnType<typeof computeEconomics>;
  eff: ReturnType<typeof effectiveNetPrice>;
  amort: ReturnType<typeof computeAmortisation>;
  baseline: number;
}

function model(peak: number, cap: number, evPvShare: number, ict = FLAT, exportScheme: "fixed" | "market" = "fixed"): Model {
  const cfg = consumers(evPvShare);
  const load = totalLoad(cfg);
  const loads = loadByConsumer(cfg);
  const result = simulate(baseConfig(load, cap, peak));
  const econ = computeEconomics(result, { commissioningYear: 2025, peakKWp: peak, exportScheme, feedInCt: 7.2, importScheme: "fixed", importCity: city, importFixedCt: ict });
  const imp = importPriceArray("fixed", city, prices, ict);
  let baseline = 0;
  for (let i = 0; i < result.load.length; i++) baseline += (result.load[i] * imp[i]) / 100;
  const exportEUR = exportScheme === "fixed" ? econ.exportRevenueFixedEUR : econ.exportRevenueMarketEUR;
  const eff = effectiveNetPrice(loads, result.load, result.gridImport, imp, exportEUR);
  const amort = computeAmortisation({ baselineCostEUR: baseline, systemNetEUR: econ.netSelectedEUR, investmentEUR: 32000 });
  return { econ, eff, amort, baseline };
}

describe("effective price semantics", () => {
  it("with no PV and no battery every consumer pays exactly the flat tariff", () => {
    const m = model(0, 0, 1);
    for (const k of ["household", "heatpump", "bwwp", "ev"] as const) {
      expect(m.eff.byConsumer[k]).toBeCloseTo(FLAT, 1);
    }
    expect(m.eff.overallCt).toBeCloseTo(FLAT, 1);
  });

  it("EV effective price falls as its PV share rises (more midday self-supply)", () => {
    const ev0 = model(22, 19.353, 0).eff.byConsumer.ev;
    const ev1 = model(22, 19.353, 1).eff.byConsumer.ev;
    // 0% PV still benefits from the evening battery discharge, so it stays
    // below the flat tariff, but it must be higher than 100% PV share.
    expect(ev0).toBeLessThan(FLAT);
    expect(ev1).toBeLessThan(ev0);
  });

  it("all per-consumer effective prices stay at/below the flat import tariff", () => {
    const m = model(22, 19.353, 1);
    for (const k of ["household", "heatpump", "bwwp", "ev"] as const) {
      expect(m.eff.byConsumer[k]).toBeLessThanOrEqual(FLAT);
    }
    expect(m.eff.overallCt).toBeLessThan(FLAT);
  });
});

describe("PV usage / self-consumption", () => {
  const selfRate = (m: Model) => m.econ.selfConsumptionKWh / m.econ.totalPVKWh;

  it("self-consumption + export cannot exceed PV generation (battery losses)", () => {
    const m = model(22, 19.353, 1).econ;
    expect(m.selfConsumptionKWh + m.totalExportKWh).toBeLessThanOrEqual(m.totalPVKWh + 1e-6);
    expect(m.selfConsumptionKWh).toBeLessThanOrEqual(m.totalPVKWh + 1e-6);
    expect(m.totalExportKWh).toBeLessThanOrEqual(m.totalPVKWh + 1e-6);
  });

  it("self-consumption never exceeds total load", () => {
    const m = model(22, 19.353, 1).econ;
    expect(m.selfConsumptionKWh).toBeLessThanOrEqual(m.totalLoadKWh + 1e-6);
  });

  it("a battery raises the self-consumption share of PV", () => {
    const withBat = selfRate(model(22, 19.353, 1));
    const noBat = selfRate(model(22, 0, 1));
    expect(withBat).toBeGreaterThan(noBat);
  });

  it("a smaller PV (relative to load) self-consumes a larger share of its yield", () => {
    const big = selfRate(model(22, 19.353, 1));
    const small = selfRate(model(5, 19.353, 1));
    expect(small).toBeGreaterThan(big);
  });
});

describe("amortisation consistency", () => {
  it("no PV and no battery yields zero annual benefit and infinite payback", () => {
    const m = model(0, 0, 1);
    expect(m.amort.annualBenefitEUR).toBeCloseTo(0, 6);
    expect(m.amort.paybackYears).toBe(Infinity);
  });

  it("annualBenefit = baselineCost + systemNetEUR", () => {
    const m = model(22, 19.353, 1);
    expect(m.amort.annualBenefitEUR).toBeCloseTo(m.baseline + m.econ.netSelectedEUR, 4);
  });

  it("investment is the single supplied total", () => {
    const a = computeAmortisation({ baselineCostEUR: 100, systemNetEUR: 10, investmentEUR: 32000 });
    expect(a.totalInvestmentEUR).toBe(32000);
  });

  it("a costlier system (higher total investment) has a longer payback", () => {
    const cheap = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 500, investmentEUR: 15000 });
    const pricey = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 500, investmentEUR: 30000 });
    expect(pricey.totalInvestmentEUR).toBeGreaterThan(cheap.totalInvestmentEUR);
    expect(pricey.paybackYears).toBeGreaterThan(cheap.paybackYears);
  });

  it("the realistic default has a finite, positive payback", () => {
    const m = model(22, 19.353, 1);
    expect(m.amort.annualBenefitEUR).toBeGreaterThan(0);
    expect(m.amort.paybackYears).toBeGreaterThan(0);
    expect(m.amort.paybackYears).toBeLessThan(40);
  });
});
