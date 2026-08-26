import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, loadByConsumer, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { importPriceArray } from "../src/calc/tariff";
import { effectiveNetPrice } from "../src/calc/vwap";
import { monthForStep } from "../src/calc/revenue";
import { SimConfig } from "../src/calc/types";

function baseConfig(load: Float64Array, capacityKWh: number): SimConfig {
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
  household: { enabled: true, annualKWh: 4000 },
  heatpump: { enabled: true, annualKWh: 5000 },
  bwwp: { enabled: true },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

describe("effective net price (Import − Export) / Verbrauch", () => {
  const prices = generatePrices(12345);
  const city = "Boizenburg";
  const fixedCt = 24;
  const load = totalLoad(consumers);
  const result = simulate(baseConfig(load, 19.353));
  const loads = loadByConsumer(consumers);

  it("equals (Importkosten − Exporterlös) / Gesamtverbrauch", () => {
    const imp = importPriceArray("fixed", city, prices);
    const exportEUR = 1234;
    const eff = effectiveNetPrice(loads, result.load, result.gridImport, imp, exportEUR);
    let importCost = 0;
    for (let i = 0; i < result.load.length; i++) importCost += (result.gridImport[i] * imp[i]) / 100;
    const totalKWh = load.reduce((a, b) => a + b, 0);
    expect(eff.overallCt).toBeCloseTo(((importCost - exportEUR) / totalKWh) * 100, 6);
  });

  it("under a fixed tariff the effective price is well below the flat rate", () => {
    const imp = importPriceArray("fixed", city, prices);
    // export revenue 0 here isolates the import side; self-consumed PV is free
    const eff = effectiveNetPrice(loads, result.load, result.gridImport, imp, 0);
    expect(eff.overallCt).toBeLessThan(fixedCt);
    // Per-consumer effective = pure grid-import cost, so it lies in [0, fixedCt].
    for (const k of ["household", "heatpump", "bwwp", "ev"] as const) {
      expect(eff.byConsumer[k]).toBeGreaterThanOrEqual(0);
      expect(eff.byConsumer[k]).toBeLessThanOrEqual(fixedCt);
    }
    // The heat pump runs mostly in winter/night, so it draws a lot from the
    // grid and its effective price sits well above the PV-heavy consumers.
    expect(eff.byConsumer.heatpump).toBeGreaterThan(5);
    expect(eff.byConsumer.heatpump).toBeLessThan(23);
    expect(Number.isFinite(eff.byConsumer.bwwp)).toBe(true);
  });

  it("per-consumer effective equals the blended price of that consumer's grid imports", () => {
    const imp = importPriceArray("fixed", city, prices);
    const eff = effectiveNetPrice(loads, result.load, result.gridImport, imp, 0);
    for (const k of ["household", "heatpump", "bwwp", "ev"] as const) {
      const arr = loads[k];
      let cost = 0, cons = 0;
      for (let i = 0; i < result.load.length; i++) {
        cons += arr[i];
        if (result.load[i] > 0) cost += (arr[i] / result.load[i]) * result.gridImport[i] * (imp[i] / 100);
      }
      expect(eff.byConsumer[k]).toBeCloseTo(cons > 0 ? (cost / cons) * 100 : 0, 6);
    }
  });

  it("under a dynamic tariff the effective price is never negative", () => {
    const imp = importPriceArray("dynamic", city, prices);
    const eff = effectiveNetPrice(loads, result.load, result.gridImport, imp, 0);
    expect(eff.overallCt).toBeLessThan(fixedCt);
    for (const k of ["household", "heatpump", "ev"] as const) {
      expect(eff.byConsumer[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it("imports far more in winter than in summer", () => {
    let wImport = 0;
    let sImport = 0;
    for (let i = 0; i < result.gridImport.length; i++) {
      const m = monthForStep(i);
      if (m === 12 || m === 1 || m === 2) wImport += result.gridImport[i];
      else if (m === 6 || m === 7 || m === 8) sImport += result.gridImport[i];
    }
    expect(wImport).toBeGreaterThan(sImport);
  });

  it("more self-consumed PV lowers the effective price", () => {
    const small = simulate(baseConfig(totalLoad(consumers), 0)); // no battery
    const big = simulate(baseConfig(totalLoad(consumers), 30)); // large battery stores more PV
    const imp = importPriceArray("fixed", city, prices);
    const effSmall = effectiveNetPrice(loads, small.load, small.gridImport, imp, 0);
    const effBig = effectiveNetPrice(loads, big.load, big.gridImport, imp, 0);
    // bigger battery => less grid import => cheaper effective price
    expect(effBig.overallCt).toBeLessThan(effSmall.overallCt);
  });
});
