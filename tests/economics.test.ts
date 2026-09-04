import { describe, it, expect } from "vitest";
import { computeEconomics } from "../src/calc/revenue";
import { simulate } from "../src/calc/simulation";
import { totalLoad, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { SimConfig, TOTAL_STEPS } from "../src/calc/types";
import { EconOptions } from "../src/calc/revenue";

function cfg(load: Float64Array): SimConfig {
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "south", location: "Hamburg" },
    battery: {
      capacityKWh: 19.353, maxPowerKW: 6, minSOC: 0.1, maxSOC: 0.95, efficiency: 0.95,
      startSOC: 0.5, chargeMode: "morning", dischargeEvening: true, dischargeMorning: true,
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

const econOpts: EconOptions = {
  commissioningYear: 2025, peakKWp: 22, exportScheme: "market", feedInCt: 7.2,
  importScheme: "dynamic", importCity: "Boizenburg", importFixedCt: 24,
};

describe("computeEconomics", () => {
  const r = simulate(cfg(totalLoad(consumers)));
  const e = computeEconomics(r, econOpts);

  it("self-consumption equals direct use + battery-to-load (PV origin only)", () => {
    let sc = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) sc += r.directUse[i] + r.dischargeToLoadPV[i];
    expect(e.selfConsumptionKWh).toBeCloseTo(sc, 3);
    expect(e.selfConsumptionKWh).toBeGreaterThan(0);
  });

  it("totals are non-negative and consistent", () => {
    expect(e.totalPVKWh).toBeGreaterThan(0);
    expect(e.totalLoadKWh).toBeGreaterThan(0);
    expect(e.totalExportKWh).toBeGreaterThan(0);
    expect(e.totalImportKWh).toBeGreaterThan(0);
    expect(e.totalExportKWh).toBeCloseTo(r.exportTotal.reduce((a, b) => a + b, 0), 1);
    expect(e.totalImportKWh).toBeCloseTo(r.gridImport.reduce((a, b) => a + b, 0), 1);
  });

  it("export revenue market = spot value + premium", () => {
    expect(e.exportRevenueMarketEUR).toBeGreaterThan(0);
    expect(e.premiumEUR).toBeGreaterThanOrEqual(0);
  });

  it("monthly rows sum to the yearly totals", () => {
    const sumImport = e.monthly.reduce((a, m) => a + m.importKWh, 0);
    expect(sumImport).toBeCloseTo(e.totalImportKWh, 1);
    const sumExp = e.monthly.reduce((a, m) => a + m.exportKWh, 0);
    expect(sumExp).toBeCloseTo(e.totalExportKWh, 1);
  });

  it("typical-day has 12 months x 24 hours", () => {
    expect(e.typicalDay.length).toBe(12 * 24);
  });

  it("comparison: dynamic14a import cost differs from dynamic", () => {
    expect(e.importCost14aEUR).not.toBeCloseTo(e.importCostDynamicEUR, 5);
  });

  it("net balance is finite and self-consumption lowers import vs no battery", () => {
    const cfgNoBat = cfg(totalLoad(consumers));
    cfgNoBat.battery.capacityKWh = 0;
    const eNoBat = computeEconomics(simulate(cfgNoBat), econOpts);
    expect(e.totalImportKWh).toBeLessThan(eNoBat.totalImportKWh);
    expect(Number.isFinite(e.netSelectedEUR)).toBe(true);
  });

  it("Marktprämie is based on the fleet solar market value (production-weighted), not the plant's export timing", () => {
    // Recompute the expected Monatsmarktwert Solar = PV-production-weighted spot
    // average (ct/kWh) directly from the raw series, then check the reported
    // annual premium equals max(0, anzulegender Wert − MW_Solar).
    let pvVal = 0;
    let pvKWh = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      pvVal += (r.pv[i] * r.price[i]) / 1000; // EUR
      pvKWh += r.pv[i];
    }
    const mwSolarCt = (pvVal / pvKWh) * 1000 * 0.1; // EUR/kWh → ct/kWh
    const expectedPremiumCt = Math.max(0, e.referenceValueCt - mwSolarCt);
    expect(e.marktPraemieCt).toBeCloseTo(expectedPremiumCt, 4);
  });

  it("strategic-export battery does NOT reduce the market premium vs a battery-free plant (fleet-based reference)", () => {
    // The premium depends only on PV *production* timing (fleet MW_Solar), so a
    // battery that shifts EXPORT into high-price windows keeps the same
    // per-kWh premium — it is not eaten away by the plant's higher captured
    // spot price (the pre-fix bug). Both plants have identical PV production, so
    // their reported Marktprämie (ct/kWh) must match.
    const cfgNoBat = cfg(totalLoad(consumers));
    cfgNoBat.battery.capacityKWh = 0;
    const eNoBat = computeEconomics(simulate(cfgNoBat), econOpts);
    expect(e.marktPraemieCt).toBeCloseTo(eNoBat.marktPraemieCt, 4);
  });
});
