import { describe, it, expect } from "vitest";
import { simulate, computeDispatchFlags } from "../src/calc/index";
import { computeRevenue } from "../src/calc/revenue";
import { generatePrices, countNonPositive } from "../src/calc/priceModel";
import { SimConfig, TOTAL_STEPS } from "../src/calc/types";

const prices = generatePrices();

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
      chargeMode: "solar",
      dischargeEvening: true,
      dischargeMorning: true,
      eveningStart: 17,
      eveningEnd: 23,
      morningStart: 5,
      morningEnd: 12,
      ...overrides,
    },
    tariff: { feedInEUR: 0.072, marketPremiumEUR: 0 },
  };
}

function sum(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

describe("price model", () => {
  it("produces a full-year series with some negative prices but not absurdly many", () => {
    const p = generatePrices();
    expect(p.length).toBe(TOTAL_STEPS);
    const neg = countNonPositive(p);
    expect(neg).toBeGreaterThan(0);
    expect(neg).toBeLessThan(TOTAL_STEPS * 0.4);
    // average in a plausible range
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

  it("dispatches battery export into expensive windows (raises VWAP vs no battery)", () => {
    const withBat = simulate({ ...baseConfig(), prices });
    const noBat = simulate({
      ...baseConfig({ capacityKWh: 0, dischargeEvening: false, dischargeMorning: false }),
      prices,
    });
    const revBat = computeRevenue(withBat, baseConfig().tariff);
    const revNo = computeRevenue(noBat, baseConfig().tariff);
    expect(sum(withBat.exportBattery)).toBeGreaterThan(0);
    expect(revBat.vwapMarketEURperMWh).toBeGreaterThanOrEqual(revNo.vwapMarketEURperMWh);
    expect(revBat.netMarketEUR).toBeGreaterThanOrEqual(revNo.netMarketEUR - 1e-6);
  });

  it("solar-charge mode exports no more than PV production", () => {
    const r = simulate({ ...baseConfig(), prices });
    expect(sum(r.exportTotal)).toBeLessThanOrEqual(sum(r.pv) + 1e-6);
  });

  it("lowPrice mode buys grid energy (chargeGrid > 0)", () => {
    const r = simulate({ ...baseConfig({ chargeMode: "lowPrice" }), prices });
    expect(sum(r.chargeGrid)).toBeGreaterThan(0);
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

describe("dispatch flags", () => {
  it("only marks non-negative steps for discharge windows", () => {
    const cfg = baseConfig();
    const flags = computeDispatchFlags(cfg.battery, prices);
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i]) expect(prices[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("revenue", () => {
  it("fixed tariff value equals export * tariff", () => {
    const r = simulate({ ...baseConfig(), prices });
    const tariff = { feedInEUR: 0.072, marketPremiumEUR: 0.0 };
    const rev = computeRevenue(r, tariff);
    expect(rev.fixedValueEUR).toBeCloseTo(rev.totalExportKWh * tariff.feedInEUR, 3);
  });

  it("market premium increases net market revenue", () => {
    const r = simulate({ ...baseConfig(), prices });
    const base = computeRevenue(r, { feedInEUR: 0.072, marketPremiumEUR: 0 });
    const withPrem = computeRevenue(r, { feedInEUR: 0.072, marketPremiumEUR: 0.02 });
    expect(withPrem.netMarketEUR).toBeGreaterThan(base.netMarketEUR);
    expect(withPrem.netMarketEUR - base.netMarketEUR).toBeCloseTo(rev_totalExportTimesPremium(r), 2);
  });

  it("monthly breakdown has 12 rows", () => {
    const r = simulate({ ...baseConfig(), prices });
    const rev = computeRevenue(r, { feedInEUR: 0.072, marketPremiumEUR: 0 });
    expect(rev.monthly.length).toBe(12);
  });
});

function rev_totalExportTimesPremium(r: ReturnType<typeof simulate>): number {
  let s = 0;
  for (let i = 0; i < r.exportTotal.length; i++) s += r.exportTotal[i];
  return s * 0.02;
}
