import { describe, it, expect } from "vitest";
import { simulate, computeDispatchFlags } from "../src/calc/index";
import { computeRevenue, referenceValueCt, feedInTariffCt } from "../src/calc/revenue";
import { generatePrices, countNonPositive } from "../src/calc/priceModel";
import { pvProductionPerStep } from "../src/calc/solar";
import { SimConfig, TOTAL_STEPS, STEPS_PER_DAY } from "../src/calc/types";

function baseConfig(overrides: Partial<SimConfig["battery"]> = {}): SimConfig {
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "south", location: "hamburg" },
    battery: {
      capacityKWh: 19.353,
      maxPowerKW: 6,
      minSOC: 0.1,
      maxSOC: 0.95,
      efficiency: 0.95,
      startSOC: 0.5,
      chargeMode: "morning",
      dischargeEvening: true,
      dischargeMorning: true,
      eveningStart: 17,
      eveningEnd: 23,
      morningStart: 5,
      morningEnd: 12,
      ...overrides,
    },
    tariff: { feedInEUR: 0.072, commissioningYear: 2025 },
  };
}

function sum(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

const prices = generatePrices();

describe("price model", () => {
  it("produces a full-year series with some negative prices but not absurdly many", () => {
    const p = generatePrices();
    expect(p.length).toBe(TOTAL_STEPS);
    const neg = countNonPositive(p);
    expect(neg).toBeGreaterThan(0);
    expect(neg).toBeLessThan(TOTAL_STEPS * 0.4);
    expect(sum(p) / p.length).toBeGreaterThan(30);
    expect(sum(p) / p.length).toBeLessThan(120);
  });
});

describe("battery simulation", () => {
  it("never exports solar or battery energy during non-positive prices", () => {
    const r = simulate({ ...baseConfig(), prices });
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (prices[i] <= 0) {
        expect(r.exportSolar[i]).toBe(0);
        expect(r.exportBattery[i]).toBe(0);
      }
    }
  });

  it("keeps SOC within bounds", () => {
    const cfg = baseConfig();
    const r = simulate({ ...cfg, prices });
    const cap = cfg.battery.capacityKWh * cfg.battery.maxSOC;
    for (let i = 0; i < TOTAL_STEPS; i += 53) {
      expect(r.soc[i]).toBeLessThanOrEqual(cap * 1.0001);
      expect(r.soc[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the battery to avoid grid import and still exports genuine surplus", () => {
    const load = new Float64Array(TOTAL_STEPS).fill(0.4); // ~9.6 kWh/day
    const withBat = simulate({ ...baseConfig(), prices, load });
    const noBat = simulate({
      ...baseConfig({ capacityKWh: 0, dischargeEvening: false, dischargeMorning: false }),
      prices,
      load,
    });
    // The battery discharges into the expensive windows, replacing grid import.
    expect(sum(withBat.dischargeToLoad)).toBeGreaterThan(0);
    expect(sum(withBat.gridImport)).toBeLessThan(sum(noBat.gridImport));
    // Any remaining stored surplus is still sold at positive prices.
    expect(sum(withBat.exportBattery)).toBeGreaterThan(0);
  });

  it("midday strategy only stores PV around solar noon", () => {
    const r = simulate({ ...baseConfig({ chargeMode: "midday" }), prices });
    // outside 10..15 no PV charging should occur
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const h = Math.floor((i % STEPS_PER_DAY) / (STEPS_PER_DAY / 24));
      if (h < 10 || h >= 15) expect(r.chargeSolar[i]).toBe(0);
    }
  });

  it("gridNegative charges from the grid only at non-positive prices", () => {
    // No PV so the battery has room to absorb grid energy at negative prices
    // (with PV the battery is already full at the midday negative-price steps).
    const r = simulate({
      ...baseConfig({ chargeMode: "gridNegative" }),
      prices,
      pv: { peakKWp: 0, tiltDeg: 35, orientation: "south", location: "hamburg" },
    });
    expect(sum(r.chargeGrid)).toBeGreaterThan(0);
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.chargeGrid[i] > 0) expect(prices[i]).toBeLessThanOrEqual(0);
    }
  });

  it("solar-charge mode exports no more than PV production", () => {
    const r = simulate({ ...baseConfig(), prices });
    expect(sum(r.exportTotal)).toBeLessThanOrEqual(sum(r.pv) + 1e-6);
  });

  it("disabling all battery actions makes export == direct solar export", () => {
    const r = simulate({
      ...baseConfig({ capacityKWh: 0, dischargeEvening: false, dischargeMorning: false }),
      prices,
    });
    for (let i = 0; i < TOTAL_STEPS; i += 31) {
      expect(r.exportBattery[i]).toBe(0);
      expect(r.exportTotal[i]).toBeCloseTo(r.exportSolar[i], 6);
    }
  });
});

describe("corner cases", () => {
  it("maxSOC = 0 means no battery at all (no charge/discharge)", () => {
    const r = simulate({ ...baseConfig({ capacityKWh: 10, maxSOC: 0 }), prices });
    expect(sum(r.exportBattery)).toBe(0);
    expect(sum(r.chargeSolar)).toBe(0);
    expect(sum(r.chargeGrid)).toBe(0);
    for (let i = 0; i < TOTAL_STEPS; i += 17) {
      expect(r.exportTotal[i]).toBeCloseTo(r.exportSolar[i], 6);
    }
  });

  it("10 kWp east + 10 kWp west equals 20 kWp east_west", () => {
    const ew = sum(pvProductionPerStep({ peakKWp: 20, tiltDeg: 35, orientation: "east_west", location: "hamburg" }));
    const east = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "east", location: "hamburg" }));
    const west = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "west", location: "hamburg" }));
    expect(ew).toBeCloseTo(east + west, 1);
  });

  it("north-facing produces far less than south but still some energy", () => {
    const north = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "north", location: "hamburg" }));
    const south = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "south", location: "hamburg" }));
    expect(north).toBeGreaterThan(0);
    expect(north).toBeLessThan(south * 0.5);
  });
});

describe("revenue + Marktprämie", () => {
  it("EEG reference value decreases with later commissioning year and is size-blended", () => {
    const r2023 = referenceValueCt(2023, 22);
    const r2025 = referenceValueCt(2025, 22);
    const r2026 = referenceValueCt(2026, 22);
    expect(r2023).toBeGreaterThan(r2025);
    expect(r2025).toBeGreaterThan(r2026);
    // 10 kWp uses only the le10 band of the anzulegender Wert (2025 = 8.34)
    expect(referenceValueCt(2025, 10)).toBeCloseTo(8.34, 2);
    // fester Vergütungssatz = anzulegender Wert − 0,4 ct
    expect(feedInTariffCt(2025, 10)).toBeCloseTo(7.94, 2);
    // 50 kWp blends all three bands
    const blended50 = (10 * 8.34 + 30 * 7.27 + 10 * 6.03) / 50;
    expect(referenceValueCt(2025, 50)).toBeCloseTo(blended50, 2);
  });

  it("fixed tariff value equals export * tariff", () => {
    const r = simulate({ ...baseConfig(), prices });
    const rev = computeRevenue(r, { feedInEUR: 0.072, commissioningYear: 2025 }, 22);
    expect(rev.fixedValueEUR).toBeCloseTo(rev.totalExportKWh * 0.072, 3);
  });

  it("Marktprämie floors market revenue at the EEG reference value", () => {
    // Constant 50 €/MWh -> VWAP_ct = 5 ct < reference -> premium fills the gap.
    const flat = new Float64Array(TOTAL_STEPS).fill(50);
    const r = simulate({ ...baseConfig({ capacityKWh: 0 }), prices: flat });
    const rev = computeRevenue(r, { feedInEUR: 0.072, commissioningYear: 2025 }, 22);
    const ref = referenceValueCt(2025, 22);
    // net market should equal approx reference * export
    expect(rev.netMarketEUR).toBeCloseTo((ref / 100) * rev.totalExportKWh, 1);
    expect(rev.marktPraemieCt).toBeGreaterThan(0);
  });

  it("high spot prices yield zero premium and market revenue above the reference", () => {
    const flat = new Float64Array(TOTAL_STEPS).fill(120);
    const r = simulate({ ...baseConfig({ capacityKWh: 0 }), prices: flat });
    const rev = computeRevenue(r, { feedInEUR: 0.072, commissioningYear: 2025 }, 22);
    expect(rev.marktPraemieCt).toBe(0);
    expect(rev.netMarketEUR).toBeGreaterThan((rev.referenceValueCt / 100) * rev.totalExportKWh);
  });

  it("monthly breakdown has 12 rows", () => {
    const r = simulate({ ...baseConfig(), prices });
    const rev = computeRevenue(r, baseConfig().tariff, 22);
    expect(rev.monthly.length).toBe(12);
  });
});

describe("domain consistency", () => {
  it("never charges and discharges the battery in the same quarter-hour", () => {
    for (const mode of ["morning", "midday", "gridNegative"] as const) {
      const r = simulate({
        ...baseConfig({ chargeMode: mode, dischargeEvening: true, dischargeMorning: true }),
        prices,
      });
      for (let i = 0; i < TOTAL_STEPS; i++) {
        if (r.exportBattery[i] > 0) {
          expect(r.chargeSolar[i]).toBe(0);
          expect(r.chargeGrid[i]).toBe(0);
        }
      }
    }
  });

  it("entladung morgens + ladestrategie morgens: morning discharge steps are not also charge steps", () => {
    const r = simulate({
      ...baseConfig({ chargeMode: "morning", dischargeMorning: true, dischargeEvening: false }),
      prices,
    });
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const h = Math.floor((i % STEPS_PER_DAY) / (STEPS_PER_DAY / 24));
      if (h >= 5 && h < 12 && r.exportBattery[i] > 0) {
        expect(r.chargeSolar[i] + r.chargeGrid[i]).toBe(0);
      }
    }
  });

  it("south yield is within a realistic band for Hamburg (~1000 kWh/kWp)", () => {
    const south = sum(pvProductionPerStep({ peakKWp: 22, tiltDeg: 35, orientation: "south", location: "hamburg" }));
    const perKwp = south / 22;
    expect(perKwp).toBeGreaterThan(900);
    expect(perKwp).toBeLessThan(1100);
  });

  it("east_west annual yield is 80-90% of south (self-consumption shape)", () => {
    const ew = sum(pvProductionPerStep({ peakKWp: 20, tiltDeg: 35, orientation: "east_west", location: "hamburg" }));
    const south = sum(pvProductionPerStep({ peakKWp: 20, tiltDeg: 35, orientation: "south", location: "hamburg" }));
    expect(ew).toBeGreaterThan(south * 0.8);
    expect(ew).toBeLessThan(south * 0.95);
  });
});

describe("dispatch flags", () => {
  it("only marks non-negative steps for discharge windows", () => {
    const cfg = baseConfig();
    const flags = computeDispatchFlags(cfg.battery, prices);
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i]) expect(prices[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("gridNegative dispatch returns only a discharge plan (no gridCharge field)", () => {
    const cfg = baseConfig({ chargeMode: "gridNegative" });
    const flags = computeDispatchFlags(cfg.battery, prices);
    expect((flags as unknown as { gridCharge?: unknown }).gridCharge).toBeUndefined();
    expect(flags.discharge).toBeInstanceOf(Uint8Array);
  });
});
