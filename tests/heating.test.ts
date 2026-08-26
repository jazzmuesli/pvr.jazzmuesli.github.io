import { describe, it, expect } from "vitest";
import {
  computeHeating,
  usefulHeatKWh,
  heatpumpAlternative,
  oilAlternative,
  gasAlternative,
  HeatingParams,
  DEFAULT_HEATING_PARAMS,
  DEFAULT_OIL_EUR_PER_100L,
  DEFAULT_GAS_CT_PER_KWH,
} from "../src/calc/heating";

function params(overrides: Partial<HeatingParams> = {}): HeatingParams {
  return {
    heatpumpElectricKWh: 5000,
    jaz: 3,
    ...DEFAULT_HEATING_PARAMS,
    ...overrides,
  };
}

describe("usefulHeatKWh", () => {
  it("is electricity times JAZ", () => {
    expect(usefulHeatKWh(5000, 3)).toBe(15000);
    expect(usefulHeatKWh(5000, 4)).toBe(20000);
  });

  it("defaults to JAZ 3 in the report", () => {
    const r = computeHeating(params());
    expect(r.usefulHeatKWh).toBe(15000);
  });
});

describe("heat pump alternative", () => {
  it("costs electricity price times consumption", () => {
    const r = computeHeating(params());
    // 5000 kWh * 24 ct/kWh = 1200 €
    expect(r.heatpump.energyCostEUR).toBeCloseTo(1200, 2);
    expect(r.heatpump.totalEUR).toBeCloseTo(1200, 2);
    expect(r.heatpump.deltaVsHeatpumpEUR).toBe(0);
  });

  it("scales with the heat-pump electricity price", () => {
    const cheap = computeHeating(params({ heatpumpElectricCt: 20 }));
    const exp = computeHeating(params({ heatpumpElectricCt: 30 }));
    expect(cheap.heatpump.totalEUR).toBeLessThan(exp.heatpump.totalEUR);
  });
});

describe("heating oil alternative", () => {
  it("includes fuel plus Schornsteinfeger (200 €)", () => {
    const r = computeHeating(params());
    // 15000 kWh / 0.85 eff = 17647.06 kWh oil ; / 10 kWh per L = 1764.7 L
    // * 1.30 €/L = 2294.12 € + 200 € chimney = 2494.12 €
    expect(r.oil.primaryEnergyKWh).toBeCloseTo(17647.06, 1);
    expect(r.oil.chimneySweepEUR).toBe(200);
    expect(r.oil.totalEUR).toBeCloseTo(2494.12, 1);
  });

  it("scales with oil price", () => {
    const cheap = computeHeating(params({ oilEurPer100L: 100 }));
    const exp = computeHeating(params({ oilEurPer100L: 150 }));
    expect(cheap.oil.totalEUR).toBeLessThan(exp.oil.totalEUR);
  });

  it("uses the configured oil price default (130 €/100L)", () => {
    const r = computeHeating(params({ oilEurPer100L: DEFAULT_OIL_EUR_PER_100L }));
    expect(r.oil.energyCostEUR).toBeGreaterThan(0);
  });
});

describe("gas alternative", () => {
  it("includes gas, netzentgelt, Nebenkosten and Schornsteinfeger", () => {
    const r = computeHeating(params());
    // 15000 / 0.92 = 16304.35 kWh gas
    // energy 16304.35 * 0.11 = 1793.48 €
    // grid   16304.35 * 0.02 = 326.09 €
    // + 120 Nebenkosten + 200 Schornsteinfeger
    expect(r.gas.primaryEnergyKWh).toBeCloseTo(16304.35, 1);
    expect(r.gas.energyCostEUR).toBeCloseTo(1793.48, 1);
    expect(r.gas.gridFeeEUR).toBeCloseTo(326.09, 1);
    expect(r.gas.otherNebenkostenEUR).toBe(120);
    expect(r.gas.chimneySweepEUR).toBe(200);
    expect(r.gas.totalEUR).toBeCloseTo(2439.57, 1);
  });

  it("scales with gas price", () => {
    const cheap = computeHeating(params({ gasCtPerKWh: 8 }));
    const exp = computeHeating(params({ gasCtPerKWh: DEFAULT_GAS_CT_PER_KWH }));
    expect(cheap.gas.totalEUR).toBeLessThan(exp.gas.totalEUR);
  });
});

describe("delta vs heat pump", () => {
  it("oil and gas are more expensive than the heat pump at JAZ 3 / 24 ct", () => {
    const r = computeHeating(params());
    expect(r.oil.deltaVsHeatpumpEUR).toBeCloseTo(r.oil.totalEUR - r.heatpump.totalEUR, 6);
    expect(r.gas.deltaVsHeatpumpEUR).toBeCloseTo(r.gas.totalEUR - r.heatpump.totalEUR, 6);
    expect(r.oil.deltaVsHeatpumpEUR).toBeGreaterThan(0);
    expect(r.gas.deltaVsHeatpumpEUR).toBeGreaterThan(0);
  });

  it("a lower JAZ makes the heat pump less competitive", () => {
    const lowJaz = computeHeating(params({ jaz: 2 }));
    const highJaz = computeHeating(params({ jaz: 4 }));
    // Same electricity (5000 kWh) → same electricity cost, but a lower JAZ
    // delivers less useful heat, so the fossil options (priced per kWh heat)
    // get cheaper and the heat pump's advantage shrinks.
    expect(lowJaz.heatpump.totalEUR).toBeCloseTo(highJaz.heatpump.totalEUR, 6);
    expect(lowJaz.usefulHeatKWh).toBeLessThan(highJaz.usefulHeatKWh);
    expect(lowJaz.gas.deltaVsHeatpumpEUR).toBeLessThan(highJaz.gas.deltaVsHeatpumpEUR);
  });
});

describe("disabled heat pump", () => {
  it("reports zero useful heat and zero heat-pump cost, but fossil fixed fees remain", () => {
    const r = computeHeating(params({ heatpumpElectricKWh: 0 }));
    expect(r.usefulHeatKWh).toBe(0);
    expect(r.heatpump.totalEUR).toBe(0);
    // Fossil options still carry their fixed fees (Schornsteinfeger / Nebenkosten).
    expect(r.oil.totalEUR).toBeCloseTo(r.oil.chimneySweepEUR, 6);
    expect(r.gas.totalEUR).toBeCloseTo(r.gas.chimneySweepEUR + r.gas.otherNebenkostenEUR, 6);
  });
});

describe("individual alternative functions", () => {
  it("oilAlternative is deterministic and matches the report", () => {
    const p = params();
    const a = oilAlternative(p, 15000);
    expect(a.totalEUR).toBeCloseTo(computeHeating(p).oil.totalEUR, 6);
  });

  it("gasAlternative is deterministic and matches the report", () => {
    const p = params();
    const a = gasAlternative(p, 15000);
    expect(a.totalEUR).toBeCloseTo(computeHeating(p).gas.totalEUR, 6);
  });

  it("heatpumpAlternative is deterministic and matches the report", () => {
    const p = params();
    const a = heatpumpAlternative(p, 15000);
    expect(a.totalEUR).toBeCloseTo(computeHeating(p).heatpump.totalEUR, 6);
  });
});
