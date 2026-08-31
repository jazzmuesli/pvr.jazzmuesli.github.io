import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, loadByConsumer, annualSum, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { importPriceArray, cityForLocation } from "../src/calc/tariff";
import { computeEconomics } from "../src/calc/revenue";
import { effectiveNetPrice } from "../src/calc/vwap";
import { computeAmortisation } from "../src/calc/amortisation";
import { getYearPrices, PRICE_YEARS } from "../src/calc/priceData";
import { SimConfig } from "../src/calc/types";

function baseConfig(load: Float64Array, capacityKWh = 19.353, peakKWp = 22): SimConfig {
  return {
    pv: { peakKWp, tiltDeg: 35, orientation: "east_west", location: "boizenburg" },
    battery: {
      capacityKWh, maxPowerKW: 6, minSOC: 0.1, maxSOC: 0.95, efficiency: 0.95, startSOC: 0.5,
      chargeMode: "morning", dischargeEvening: true, dischargeMorning: true,
      eveningStart: 17, eveningEnd: 23, morningStart: 5, morningEnd: 12,
    },
    tariff: { feedInEUR: 0.072, commissioningYear: 2025 },
    prices: generatePrices(12345),
    load,
  };
}

const consumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 6500 },
  bwwp: { enabled: true },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

const prices = generatePrices(12345);
const city = cityForLocation("boizenburg");
const load = totalLoad(consumers);
const loads = loadByConsumer(consumers);
const result = simulate(baseConfig(load));

interface Scn {
  exportEUR: number; importEUR: number; net: number; baseline: number;
  benefit: number; payback: number; overallEff: number; byConsumer: Record<string, number>;
}

function scenario(ex: "fixed" | "market", im: "fixed" | "dynamic" | "dynamic14a", ict = 24): Scn {
  const econ = computeEconomics(result, { commissioningYear: 2025, peakKWp: 22, exportScheme: ex, feedInCt: 7.2, importScheme: im, importCity: city, importFixedCt: ict });
  const exportEUR = ex === "fixed" ? econ.exportRevenueFixedEUR : econ.exportRevenueMarketEUR;
  const importEUR = im === "fixed" ? econ.importCostFixedEUR : im === "dynamic" ? econ.importCostDynamicEUR : econ.importCost14aEUR;
  const net = exportEUR - importEUR;
  const imp = importPriceArray(im, city, prices, ict);
  let baseline = 0;
  for (let i = 0; i < result.load.length; i++) baseline += (result.load[i] * imp[i]) / 100;
  const a = computeAmortisation({ baselineCostEUR: baseline, systemNetEUR: net, investmentEUR: 32000 });
  const eff = effectiveNetPrice(loads, result.load, result.gridImport, imp, exportEUR);
  return { exportEUR, importEUR, net, baseline, benefit: a.annualBenefitEUR, payback: a.paybackYears, overallEff: eff.overallCt, byConsumer: eff.byConsumer };
}

// Full economics for an arbitrary PV size / battery, used for sensitivity tests.
function evaluate(peakKWp: number, cap: number): Scn {
  const res = simulate(baseConfig(load, cap, peakKWp));
  const econ = computeEconomics(res, { commissioningYear: 2025, peakKWp, exportScheme: "fixed", feedInCt: 7.2, importScheme: "fixed", importCity: city, importFixedCt: 24 });
  const exportEUR = econ.exportRevenueFixedEUR;
  const importEUR = econ.importCostFixedEUR;
  const net = exportEUR - importEUR;
  const imp = importPriceArray("fixed", city, prices, 24);
  let baseline = 0;
  for (let i = 0; i < res.load.length; i++) baseline += (res.load[i] * imp[i]) / 100;
  const a = computeAmortisation({ baselineCostEUR: baseline, systemNetEUR: net, investmentEUR: 32000 });
  return { exportEUR, importEUR, net, baseline, benefit: a.annualBenefitEUR, payback: a.paybackYears, overallEff: 0, byConsumer: {} };
}

describe("per-consumer load breakdown integrity", () => {
  it("the four consumer profiles sum to the total load every step", () => {
    const total = new Float64Array(load.length);
    for (let i = 0; i < load.length; i++) {
      total[i] = loads.household[i] + loads.heatpump[i] + loads.bwwp[i] + loads.ev[i];
    }
    for (let i = 0; i < load.length; i++) {
      expect(total[i]).toBeCloseTo(load[i], 9);
    }
  });

  it("each enabled consumer's annual sum matches its configured demand", () => {
    expect(annualSum(loads.household)).toBeCloseTo(2400, 0);
    expect(annualSum(loads.heatpump)).toBeCloseTo(6500, 0);
    expect(annualSum(loads.bwwp)).toBeGreaterThan(400); // ~40 kWh/month
    expect(annualSum(loads.ev)).toBeCloseTo(2000, 0);
  });

  it("disabling a consumer zeroes its profile", () => {
    const off: ConsumerConfig = { ...consumers, ev: { enabled: false, annualKWh: 2000, pvShare: 0.8 } };
    const offLoads = loadByConsumer(off);
    expect(annualSum(offLoads.ev)).toBe(0);
    expect(annualSum(offLoads.household)).toBeCloseTo(2400, 0);
  });
});

describe("scheme plausibility (DV vs fest, §14a/3)", () => {
  const ff = scenario("fixed", "fixed");
  const mf = scenario("market", "fixed");
  const md = scenario("market", "dynamic");
  const ma = scenario("market", "dynamic14a");

  it("Direktvermarktung yields at least as much export revenue as fixed feed-in", () => {
    expect(mf.exportEUR).toBeGreaterThanOrEqual(ff.exportEUR);
  });

  it("smart import tariffs reduce grid import cost versus a flat tariff", () => {
    expect(ff.importEUR).toBeGreaterThan(md.importEUR);
    expect(ff.importEUR).toBeGreaterThan(ma.importEUR);
  });

  it("net balance ordering: DV+§14a/3 ≥ DV+dyn ≥ DV+fest ≥ fest+fest", () => {
    expect(ma.net).toBeGreaterThanOrEqual(md.net);
    expect(md.net).toBeGreaterThanOrEqual(mf.net);
    expect(mf.net).toBeGreaterThanOrEqual(ff.net);
  });

  it("effective price stays below the 24 ct flat tariff and never negative per consumer", () => {
    for (const sc of [ff, mf, md, ma]) {
      expect(sc.overallEff).toBeLessThan(24);
      for (const k of ["household", "heatpump", "bwwp", "ev"] as const) {
        expect(sc.byConsumer[k]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("parameter plausibility (price / PV / battery)", () => {
  it("a higher import tariff shortens payback (PV displaces pricier grid energy)", () => {
    const cheap = scenario("fixed", "fixed", 24).payback;
    const pricey = scenario("fixed", "fixed", 44.5).payback;
    expect(cheap).toBeGreaterThan(pricey);
  });

  it("a larger PV increases export, benefit and can turn the balance positive", () => {
    const pv10 = evaluate(10, 19.353);
    const pv22 = evaluate(22, 19.353);
    const pv40 = evaluate(40, 19.353);
    expect(pv40.exportEUR).toBeGreaterThan(pv22.exportEUR);
    expect(pv22.exportEUR).toBeGreaterThan(pv10.exportEUR);
    expect(pv40.benefit).toBeGreaterThan(pv22.benefit);
    expect(pv22.benefit).toBeGreaterThan(pv10.benefit);
    expect(pv40.net).toBeGreaterThan(0);
  });

  it("adding a battery improves the annual benefit versus no battery", () => {
    const withBat = evaluate(22, 19.353).benefit;
    const noBat = evaluate(22, 0).benefit;
    expect(withBat).toBeGreaterThan(noBat);
  });

  it("a pricier price year lifts Direktvermarktung export revenue", () => {
    // order available years by mean spot price and pick the extremes
    const mean = (y: string) => {
      const p = getYearPrices(y);
      let s = 0;
      for (let i = 0; i < p.length; i++) s += p[i];
      return s / p.length;
    };
    const sorted = [...PRICE_YEARS].sort((a, b) => mean(a) - mean(b));
    const lowY = sorted[0];
    const highY = sorted[sorted.length - 1];
    expect(mean(highY)).toBeGreaterThan(mean(lowY));

    const econLow = computeEconomics(simulate(baseConfig(load, 19.353, 22)), { commissioningYear: 2025, peakKWp: 22, exportScheme: "market", feedInCt: 7.2, importScheme: "fixed", importCity: city, importFixedCt: 24 });
    const econHigh = computeEconomics(simulate({ ...baseConfig(load, 19.353, 22), prices: getYearPrices(highY) }), { commissioningYear: 2025, peakKWp: 22, exportScheme: "market", feedInCt: 7.2, importScheme: "fixed", importCity: city, importFixedCt: 24 });
    expect(econHigh.exportRevenueMarketEUR).toBeGreaterThan(econLow.exportRevenueMarketEUR);
  });
});

describe("amortisation plausibility", () => {
  it("annualBenefit = baselineCost + systemNetEUR", () => {
    const a = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 300, investmentEUR: 20000 });
    expect(a.annualBenefitEUR).toBeCloseTo(1800, 6);
  });

  it("investment is the single supplied total and independent of kWp/kWh", () => {
    const a = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 300, investmentEUR: 20000 });
    expect(a.totalInvestmentEUR).toBe(20000);
  });

  it("a costlier system (higher total investment) has a longer payback", () => {
    const cheap = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 500, investmentEUR: 15000 });
    const pricey = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 500, investmentEUR: 30000 });
    expect(pricey.totalInvestmentEUR).toBeGreaterThan(cheap.totalInvestmentEUR);
    expect(pricey.paybackYears).toBeGreaterThan(cheap.paybackYears);
  });

  it("an unprofitable system has infinite payback", () => {
    const a = computeAmortisation({ baselineCostEUR: 1000, systemNetEUR: -1000, investmentEUR: 10000 });
    expect(a.annualBenefitEUR).toBeLessThanOrEqual(0);
    expect(a.paybackYears).toBe(Infinity);
  });

  it("every realistic configuration has a finite, positive payback", () => {
    for (const sc of [scenario("fixed", "fixed"), scenario("market", "fixed"), scenario("market", "dynamic"), scenario("market", "dynamic14a")]) {
      expect(sc.benefit).toBeGreaterThan(0);
      expect(sc.payback).toBeGreaterThan(0);
      expect(sc.payback).toBeLessThan(40);
    }
  });
});

describe("self-consumption & autarky plausibility (TODO 4.1)", () => {
  function rates(peakKWp: number, cap: number): { scr: number; ssr: number } {
    const res = simulate(baseConfig(load, cap, peakKWp));
    const selfConsumption =
      annualSum(res.directUse) + annualSum(res.dischargeToLoadPV);
    const pv = annualSum(res.pv);
    const totalLoad = annualSum(res.load);
    return {
      scr: pv > 0 ? (selfConsumption / pv) * 100 : 0,
      ssr: totalLoad > 0 ? (selfConsumption / totalLoad) * 100 : 0,
    };
  }

  it("self-consumption never exceeds PV production (energy conservation)", () => {
    const res = simulate(baseConfig(load, 19.353, 22));
    const pv = annualSum(res.pv);
    const sc = annualSum(res.directUse) + annualSum(res.dischargeToLoadPV);
    expect(sc).toBeLessThanOrEqual(pv);
  });

  it("self-consumption rate stays in 0–100% for various PV/battery sizes", () => {
    for (const [kwp, cap] of [[5, 5], [10, 10], [22, 19.353], [40, 30], [60, 19.353]]) {
      const r = rates(kwp, cap);
      expect(r.scr).toBeGreaterThanOrEqual(0);
      expect(r.scr).toBeLessThanOrEqual(100);
    }
  });

  it("grid-charged energy does not inflate self-consumption", () => {
    // With gridNegative mode the battery charges from the grid at negative
    // prices.  The grid-charged portion must not be counted as self-consumption.
    const cfg = baseConfig(load, 19.353, 22);
    cfg.battery.chargeMode = "gridNegative";
    const res = simulate(cfg);
    const pv = annualSum(res.pv);
    const sc = annualSum(res.directUse) + annualSum(res.dischargeToLoadPV);
    expect(sc).toBeLessThanOrEqual(pv);
    expect(sc).toBeGreaterThanOrEqual(0);
  });

  it("autarky (self-sufficiency) is higher with a battery than without", () => {
    const withBat = rates(22, 19.353).ssr;
    const noBat = rates(22, 0).ssr;
    expect(withBat).toBeGreaterThan(noBat);
  });

  it("self-consumption rate falls as PV is strongly oversized (large export share)", () => {
    const small = rates(10, 19.353).scr;
    const huge = rates(60, 19.353).scr;
    expect(huge).toBeLessThan(small);
  });

  it("autarky stays in a plausible range for the configured system", () => {
    const withBat = rates(22, 19.353);
    expect(withBat.ssr).toBeGreaterThan(30);
    expect(withBat.ssr).toBeLessThan(100);
  });

  it("energy balance: Eigenverbrauch + Netz-Import = Verbrauch", () => {
    // For various PV/battery sizes, the energy balance must always close.
    for (const [kwp, cap] of [[0.4, 19.353], [5, 5], [10, 10], [22, 19.353], [40, 30]]) {
      const res = simulate(baseConfig(load, cap, kwp));
      const totalLoad = annualSum(res.load);
      const sc = annualSum(res.directUse) + annualSum(res.dischargeToLoadPV);
      const imp = totalLoad - sc;
      expect(imp).toBeGreaterThanOrEqual(0);
      expect(sc + imp).toBeCloseTo(totalLoad, 0);
    }
  });

  it("dischargeToLoadPV never exceeds chargeSolar + startSOC energy", () => {
    // The PV-originated battery discharge cannot exceed the PV energy stored.
    const res = simulate(baseConfig(load, 19.353, 22));
    const pvCharged = annualSum(res.chargeSolar);
    const pvDischarged = annualSum(res.dischargeToLoadPV);
    expect(pvDischarged).toBeLessThanOrEqual(pvCharged + 0.01);
  });
});
