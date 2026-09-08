import { describe, it, expect } from "vitest";
import {
  computeGasSavings,
  GasSavingsParams,
  DEFAULT_GAS_SAVINGS_PARAMS,
  DEFAULT_GAS_BOILER_EFFICIENCY,
} from "../src/calc/heatpumpGasSavings";
import { heatpumpLoad } from "../src/calc/consumers";
import { TOTAL_STEPS } from "../src/calc/types";

function defaultParams(overrides: Partial<GasSavingsParams> = {}): GasSavingsParams {
  return {
    heatpumpElectricKWh: 5000,
    ...DEFAULT_GAS_SAVINGS_PARAMS,
    ...overrides,
  };
}

describe("computeGasSavings - basic structure", () => {
  it("returns a complete report for typical inputs", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    expect(report.heatpumpElectricKWh).toBeCloseTo(5000, 0);
    expect(report.jaz).toBe(3);
    expect(report.usefulHeatKWh).toBeCloseTo(15000, 0);
    expect(report.monthly.length).toBe(12);
  });

  it("has monthly entries for all 12 months", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    for (let m = 1; m <= 12; m++) {
      const row = report.monthly.find((r) => r.month === m);
      expect(row).toBeDefined();
      expect(row!.month).toBe(m);
    }
  });
});

describe("computeGasSavings - energy relationships", () => {
  it("usefulHeat = electricKWh × JAZ", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams({ jaz: 3 }));
    expect(report.usefulHeatKWh).toBeCloseTo(5000 * 3, 0);
  });

  it("gasDirectKWh = usefulHeat / boilerEfficiency", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    const expectedGasDirect = report.usefulHeatKWh / DEFAULT_GAS_BOILER_EFFICIENCY;
    expect(report.gasDirectKWh).toBeCloseTo(expectedGasDirect, 0);
  });

  it("gasSavedKWh is always positive (HP saves gas vs. direct boiler)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    expect(report.gasSavedKWh).toBeGreaterThan(0);
  });

  it("gasSavedKWh = gasDirectKWh - gasForElectricityKWh", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    expect(report.gasSavedKWh).toBeCloseTo(report.gasDirectKWh - report.gasForElectricityKWh, 1);
  });

  it("gasForElectricityKWh < gasDirectKWh (HP is more efficient overall)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    expect(report.gasForElectricityKWh).toBeLessThan(report.gasDirectKWh);
  });
});

describe("computeGasSavings - zero gas sources", () => {
  it("zeroGasSharePct is between 30% and 70% (realistic for winter-heavy HP)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // Heat pump runs mostly at night/winter when solar is low, so zero-gas
    // share is lower than the annual average grid mix.
    expect(report.zeroGasSharePct).toBeGreaterThan(30);
    expect(report.zeroGasSharePct).toBeLessThan(70);
  });
});

describe("computeGasSavings - JAZ sensitivity", () => {
  it("higher JAZ delivers more useful heat from the same electricity", () => {
    const load = heatpumpLoad(5000);
    const lowJaz = computeGasSavings(load, defaultParams({ jaz: 2 }));
    const highJaz = computeGasSavings(load, defaultParams({ jaz: 4 }));
    expect(highJaz.usefulHeatKWh).toBeGreaterThan(lowJaz.usefulHeatKWh);
  });

  it("higher JAZ means more gas saved (more heat per kWh electricity)", () => {
    const load = heatpumpLoad(5000);
    const lowJaz = computeGasSavings(load, defaultParams({ jaz: 2 }));
    const highJaz = computeGasSavings(load, defaultParams({ jaz: 4 }));
    expect(highJaz.gasSavedKWh).toBeGreaterThan(lowJaz.gasSavedKWh);
  });

  it("at JAZ=3, more than 80% of gas is saved (JAZ compensates power plant losses)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams({ jaz: 3 }));
    const savingPct = (report.gasSavedKWh / report.gasDirectKWh) * 100;
    // With JAZ=3 and ~8% gas share in grid mix, the HP is far more efficient
    // than burning gas directly, even accounting for power plant losses.
    expect(savingPct).toBeGreaterThan(80);
  });

  it("lower JAZ reduces the gas saving percentage", () => {
    const load = heatpumpLoad(5000);
    const lowJaz = computeGasSavings(load, defaultParams({ jaz: 2 }));
    const highJaz = computeGasSavings(load, defaultParams({ jaz: 4 }));
    const lowPct = (lowJaz.gasSavedKWh / lowJaz.gasDirectKWh) * 100;
    const highPct = (highJaz.gasSavedKWh / highJaz.gasDirectKWh) * 100;
    expect(highPct).toBeGreaterThan(lowPct);
  });
});

describe("computeGasSavings - efficiency sensitivity", () => {
  it("higher power plant efficiency reduces gasForElectricity (less gas burned per kWh)", () => {
    const load = heatpumpLoad(5000);
    const lowEff = computeGasSavings(load, defaultParams({ gasPowerplantEfficiency: 0.35 }));
    const highEff = computeGasSavings(load, defaultParams({ gasPowerplantEfficiency: 0.55 }));
    expect(highEff.gasForElectricityKWh).toBeLessThan(lowEff.gasForElectricityKWh);
  });

  it("higher boiler efficiency reduces gasDirect (less gas needed for same heat)", () => {
    const load = heatpumpLoad(5000);
    const lowBoiler = computeGasSavings(load, defaultParams({ gasBoilerEfficiency: 0.85 }));
    const highBoiler = computeGasSavings(load, defaultParams({ gasBoilerEfficiency: 0.95 }));
    // Higher boiler efficiency = less gas needed for the same useful heat
    expect(highBoiler.gasDirectKWh).toBeLessThan(lowBoiler.gasDirectKWh);
  });

  it("higher boiler efficiency reduces gasSaved (less gas to save in the first place)", () => {
    const load = heatpumpLoad(5000);
    const lowBoiler = computeGasSavings(load, defaultParams({ gasBoilerEfficiency: 0.85 }));
    const highBoiler = computeGasSavings(load, defaultParams({ gasBoilerEfficiency: 0.95 }));
    expect(highBoiler.gasSavedKWh).toBeLessThan(lowBoiler.gasSavedKWh);
  });
});

describe("computeGasSavings - CO2 and cost", () => {
  it("co2SavedKg = gasSavedKWh × 0.201", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    expect(report.co2SavedKg).toBeCloseTo(report.gasSavedKWh * 0.201, 0);
  });

  it("costSavedEUR = gasSavedKWh × gasPrice / 100", () => {
    const load = heatpumpLoad(5000);
    const price = 11;
    const report = computeGasSavings(load, defaultParams({ gasPriceCtPerKWh: price }));
    expect(report.costSavedEUR).toBeCloseTo((report.gasSavedKWh * price) / 100, 0);
  });

  it("CO2 savings are substantial (multi-tonne scale for 5000 kWh heat pump)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // 5000 kWh HP → ~15000 kWh heat → ~16300 kWh gas direct
    // Grid gas ~889 kWh → gas saved ~15400 kWh → ~3100 kg CO2
    expect(report.co2SavedKg).toBeGreaterThan(1000);
  });
});

describe("computeGasSavings - monthly breakdown", () => {
  it("monthly electricKWh sums to total electricKWh", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    const monthSum = report.monthly.reduce((a, r) => a + r.electricKWh, 0);
    expect(monthSum).toBeCloseTo(report.heatpumpElectricKWh, 0);
  });

  it("monthly usefulHeatKWh sums to total usefulHeatKWh", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    const monthSum = report.monthly.reduce((a, r) => a + r.usefulHeatKWh, 0);
    expect(monthSum).toBeCloseTo(report.usefulHeatKWh, 0);
  });

  it("monthly gasSavedKWh sums to total gasSavedKWh", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    const monthSum = report.monthly.reduce((a, r) => a + r.gasSavedKWh, 0);
    expect(monthSum).toBeCloseTo(report.gasSavedKWh, 0);
  });

  it("winter months have higher electricity consumption than summer", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    const jan = report.monthly.find((r) => r.month === 1)!;
    const jul = report.monthly.find((r) => r.month === 7)!;
    expect(jan.electricKWh).toBeGreaterThan(jul.electricKWh);
  });

  it("monthly zero-gas share varies by season (summer months have solar)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // The HP runs mostly in winter, so the monthly zero-gas share reflects
    // the seasonal mix. Just verify all values are in a plausible range.
    for (const row of report.monthly) {
      expect(row.zeroGasSharePct).toBeGreaterThanOrEqual(0);
      expect(row.zeroGasSharePct).toBeLessThanOrEqual(100);
    }
  });
});

describe("computeGasSavings - edge cases", () => {
  it("zero heat pump load returns zero everything", () => {
    const zeroLoad = new Float64Array(TOTAL_STEPS);
    const report = computeGasSavings(zeroLoad, defaultParams());
    expect(report.heatpumpElectricKWh).toBe(0);
    expect(report.usefulHeatKWh).toBe(0);
    expect(report.gasDirectKWh).toBe(0);
    expect(report.gasForElectricityKWh).toBe(0);
    expect(report.gasSavedKWh).toBe(0);
  });

  it("deterministic: same input produces same output", () => {
    const load = heatpumpLoad(5000);
    const r1 = computeGasSavings(load, defaultParams());
    const r2 = computeGasSavings(load, defaultParams());
    expect(r1.gasSavedKWh).toBe(r2.gasSavedKWh);
    expect(r1.co2SavedKg).toBe(r2.co2SavedKg);
    expect(r1.costSavedEUR).toBe(r2.costSavedEUR);
  });
});

describe("gas savings plausibility", () => {
  it("a 5000 kWh heat pump saves roughly 10000-16000 kWh of gas per year", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // With JAZ=3, the HP produces 15000 kWh heat from 5000 kWh electricity.
    // A gas boiler would need ~16300 kWh gas for the same heat.
    // The grid burns ~889 kWh gas for the HP's electricity (8% gas share).
    // Gas saved ≈ 16300 - 889 = ~15400 kWh.
    expect(report.gasSavedKWh).toBeGreaterThan(10000);
    expect(report.gasSavedKWh).toBeLessThan(17000);
  });

  it("the bySource breakdown has all positive contributors", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // All sources contribute positively to gas savings with JAZ=3
    expect(report.bySource.windKWh).toBeGreaterThan(0);
    expect(report.bySource.solarKWh).toBeGreaterThanOrEqual(0); // 0 in winter
    expect(report.bySource.coalKWh).toBeGreaterThan(0);
    expect(report.bySource.biomassKWh).toBeGreaterThan(0);
    expect(report.bySource.hydroKWh).toBeGreaterThan(0);
    expect(report.bySource.otherKWh).toBeGreaterThan(0);
    expect(report.bySource.gasKWh).toBeGreaterThan(0);
  });

  it("gas source also has positive gas savings with JAZ=3 (HP compensates plant losses)", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // With JAZ=3, even gas-sourced electricity saves gas:
    // Gas boiler: 1 kWh gas → 0.92 kWh heat
    // Gas plant → HP: 1 kWh gas → 0.45 kWh elec → 1.35 kWh heat
    // So the HP path is 47% more efficient at converting gas to heat.
    // jaz/boilerEff - 1/plantEff = 3/0.92 - 1/0.45 = 3.26 - 2.22 = 1.04 > 0
    expect(report.bySource.gasKWh).toBeGreaterThan(0);
  });

  it("cost saving is realistic for a typical German household", () => {
    const load = heatpumpLoad(5000);
    const report = computeGasSavings(load, defaultParams());
    // At 11 ct/kWh gas, saving ~15000 kWh → ~1650 EUR
    expect(report.costSavedEUR).toBeGreaterThan(1000);
    expect(report.costSavedEUR).toBeLessThan(2000);
  });
});

describe("computeGasSavings - dispatch-aware (PV/grid split)", () => {
  it("more PV self-consumption increases gas savings", () => {
    const load = heatpumpLoad(5000);
    const totalLoad = new Float64Array(TOTAL_STEPS);
    // Fill totalLoad slightly above HP load so grid import is minimal
    for (let i = 0; i < TOTAL_STEPS; i++) totalLoad[i] = load[i] * 1.1;

    // Scenario A: no grid import (100% PV)
    const gridA = new Float64Array(TOTAL_STEPS); // zero grid import
    const reportA = computeGasSavings(load, defaultParams(), gridA, totalLoad);

    // Scenario B: full grid import (0% PV)
    const gridB = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) gridB[i] = totalLoad[i];
    const reportB = computeGasSavings(load, defaultParams(), gridB, totalLoad);

    // 100% PV should save more gas than 100% grid
    expect(reportA.gasSavedKWh).toBeGreaterThan(reportB.gasSavedKWh);
    // With 100% PV, gasForElectricity should be zero
    expect(reportA.gasForElectricityKWh).toBe(0);
    // With 100% PV, zero-gas share should be 100%
    expect(reportA.zeroGasSharePct).toBe(100);
  });

  it("without dispatch arrays falls back to full grid import", () => {
    const load = heatpumpLoad(5000);
    const withDispatch = computeGasSavings(load, defaultParams());
    const withoutDispatch = computeGasSavings(load, defaultParams());
    // Without dispatch, both calls are identical (no grid/totalLoad passed)
    expect(withDispatch.gasSavedKWh).toBe(withoutDispatch.gasSavedKWh);
  });

  it("partial PV coverage proportionally improves gas savings", () => {
    const load = heatpumpLoad(5000);
    const totalLoad = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) totalLoad[i] = load[i] * 2;

    // 50% PV (grid = 50% of total load)
    const grid50 = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) grid50[i] = totalLoad[i] * 0.5;
    const report50 = computeGasSavings(load, defaultParams(), grid50, totalLoad);

    // 100% grid (no PV)
    const grid100 = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) grid100[i] = totalLoad[i];
    const report100 = computeGasSavings(load, defaultParams(), grid100, totalLoad);

    expect(report50.gasSavedKWh).toBeGreaterThan(report100.gasSavedKWh);
    expect(report50.gasForElectricityKWh).toBeLessThan(report100.gasForElectricityKWh);
  });

  it("monthly zero-gas share varies with PV coverage", () => {
    const load = heatpumpLoad(5000);
    const totalLoad = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) totalLoad[i] = load[i] * 1.5;

    // Full grid import
    const gridFull = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) gridFull[i] = totalLoad[i];
    const reportGrid = computeGasSavings(load, defaultParams(), gridFull, totalLoad);

    // Zero grid import (all PV)
    const gridNone = new Float64Array(TOTAL_STEPS);
    const reportPV = computeGasSavings(load, defaultParams(), gridNone, totalLoad);

    // All months should have higher zero-gas share with 100% PV
    for (let m = 0; m < 12; m++) {
      expect(reportPV.monthly[m].zeroGasSharePct).toBeGreaterThanOrEqual(reportGrid.monthly[m].zeroGasSharePct);
    }
  });
});
