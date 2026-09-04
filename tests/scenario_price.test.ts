import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, loadByConsumer, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { importPriceArray, cityForLocation } from "../src/calc/tariff";
import { computeEconomics, EconOptions } from "../src/calc/revenue";
import { effectiveNetPrice } from "../src/calc/vwap";

function baseConfig(load: Float64Array, capacityKWh = 19.353): Parameters<typeof simulate>[0] {
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "east_west", location: "boizenburg" },
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
const result = simulate(baseConfig(load));
const loads = loadByConsumer(consumers);
const fixedCt = 24;

function effFor(exportScheme: "fixed" | "market", importScheme: "fixed" | "dynamic" | "dynamic14a") {
  const opts: EconOptions = {
    commissioningYear: 2025, peakKWp: 22, exportScheme, feedInCt: 7.2,
    importScheme, importCity: city, importFixedCt: fixedCt,
  };
  const econ = computeEconomics(result, opts);
  const imp = importPriceArray(importScheme, city, prices);
  const exportEUR = exportScheme === "fixed" ? econ.exportRevenueFixedEUR : econ.exportRevenueMarketEUR;
  return effectiveNetPrice(loads, result.load, result.gridImport, imp, exportEUR);
}

describe("scenario plausibility — effective price < flat tariff", () => {
  const scenarios: [string, "fixed" | "market", "fixed" | "dynamic" | "dynamic14a"][] = [
    ["Fest+Fest", "fixed", "fixed"],
    ["DV+Fest", "market", "fixed"],
    ["DV+Dyn", "market", "dynamic"],
    ["DV+§14a/3", "market", "dynamic14a"],
  ];

  for (const [name, ex, im] of scenarios) {
    it(`${name}: effective price is sensible (never negative; <= flat for fixed import)`, () => {
      const eff = effFor(ex, im);
      expect(eff.overallCt).toBeLessThan(fixedCt);
      for (const k of ["household", "heatpump", "ev"] as const) {
        expect(eff.byConsumer[k]).toBeGreaterThanOrEqual(0);
        if (im === "fixed") expect(eff.byConsumer[k]).toBeLessThanOrEqual(fixedCt);
      }
    });
  }

  it("§14a/3 import is never more expensive than plain dynamic for the same profile", () => {
    // The effective (net-of-export) price is floored at 0, so compare the raw
    // import cost of the two dynamic schemes for the identical import profile:
    // §14a/3 shifts grid fees into cheaper windows, so it can only help (or be
    // neutral), never cost more, than the flat-Netzentgelt dynamic tariff.
    const imp = (scheme: "dynamic" | "dynamic14a") =>
      importPriceArray(scheme, city, prices);
    let costDyn = 0;
    let cost14a = 0;
    const dyn = imp("dynamic");
    const a14 = imp("dynamic14a");
    for (let i = 0; i < result.gridImport.length; i++) {
      costDyn += (result.gridImport[i] * dyn[i]) / 100;
      cost14a += (result.gridImport[i] * a14[i]) / 100;
    }
    expect(cost14a).toBeLessThanOrEqual(costDyn + 1e-9);
  });

  it("a battery lowers the effective price versus no battery", () => {
    const withBat = effFor("market", "dynamic");
    const noBatLoad = totalLoad(consumers);
    const noBat = simulate(baseConfig(noBatLoad, 0));
    const imp = importPriceArray("dynamic", city, prices);
    const econ = computeEconomics(noBat, {
      commissioningYear: 2025, peakKWp: 22, exportScheme: "market", feedInCt: 7.2,
      importScheme: "dynamic", importCity: city, importFixedCt: fixedCt,
    });
    const effNoBat = effectiveNetPrice(loads, noBat.load, noBat.gridImport, imp, econ.exportRevenueMarketEUR);
    expect(withBat.overallCt).toBeLessThanOrEqual(effNoBat.overallCt + 1e-9);
  });
});
