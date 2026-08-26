import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, loadByConsumer, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { importPriceArray, cityForLocation } from "../src/calc/tariff";
import { computeEconomics } from "../src/calc/revenue";
import { effectiveNetPrice } from "../src/calc/vwap";
import { computeAmortisation } from "../src/calc/amortisation";
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
  const a = computeAmortisation({ peakKWp: 22, capacityKWh: 19.353, baselineCostEUR: baseline, systemNetEUR: net });
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
  const a = computeAmortisation({ peakKWp, capacityKWh: cap, baselineCostEUR: baseline, systemNetEUR: net });
  return { exportEUR, importEUR, net, baseline, benefit: a.annualBenefitEUR, payback: a.paybackYears, overallEff: 0, byConsumer: {} };
}

describe("scenario economics plausibility", () => {
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

  it("net balance is best for DV + §14a/3 and worst for Fest + Fest", () => {
    expect(ma.net).toBeGreaterThanOrEqual(md.net);
    expect(md.net).toBeGreaterThanOrEqual(mf.net);
    expect(mf.net).toBeGreaterThanOrEqual(ff.net);
  });

  it("effective price stays below the 24 ct flat tariff and is never negative per consumer", () => {
    for (const sc of [ff, mf, md, ma]) {
      expect(sc.overallEff).toBeLessThan(24);
      for (const k of ["household", "heatpump", "bwwp", "ev"] as const) {
        expect(sc.byConsumer[k]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a higher import tariff shortens payback (PV displaces more expensive grid energy)", () => {
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

  it("every realistic configuration has a finite, positive payback", () => {
    for (const sc of [ff, mf, md, ma]) {
      expect(sc.benefit).toBeGreaterThan(0);
      expect(sc.payback).toBeGreaterThan(0);
      expect(sc.payback).toBeLessThan(40);
    }
  });
});
