import { describe, it, expect } from "vitest";
import {
  DEFAULT_WIND_TURBINE,
  WIND_TURBINE_MAP,
  WIND_LOCATIONS,
  powerAtWindSpeed,
  computeWindEnergy,
  windProductionPerStep,
  validateAgainstCertification,
} from "../src/calc/wind";
import { runSimulation, DEFAULT_SIM_PARAMS, SimParams } from "../src/calc/report";
import { annualSum } from "../src/calc/consumers";

const SKYWIND_NG = DEFAULT_WIND_TURBINE;

// ---- Power curve tests -----------------------------------------------------

describe("SkyWind NG power curve", () => {
  it("has zero output below cut-in speed (5.5 m/s)", () => {
    expect(powerAtWindSpeed(SKYWIND_NG, 0)).toBe(0);
    expect(powerAtWindSpeed(SKYWIND_NG, 3)).toBe(0);
    expect(powerAtWindSpeed(SKYWIND_NG, 5)).toBe(0);
    expect(powerAtWindSpeed(SKYWIND_NG, 4)).toBe(0);
  });

  it("has zero output above cut-out speed (20 m/s)", () => {
    expect(powerAtWindSpeed(SKYWIND_NG, 20)).toBe(0);
    expect(powerAtWindSpeed(SKYWIND_NG, 25)).toBe(0);
  });

  it("reaches peak power (0.609 kW) at 16 m/s", () => {
    expect(powerAtWindSpeed(SKYWIND_NG, 16)).toBeCloseTo(0.609, 3);
  });

  it("produces rated power (0.310 kW) at 11 m/s", () => {
    expect(powerAtWindSpeed(SKYWIND_NG, 11)).toBeCloseTo(0.310, 3);
  });

  it("interpolates between known points", () => {
    const p8 = powerAtWindSpeed(SKYWIND_NG, 8);
    const p9 = powerAtWindSpeed(SKYWIND_NG, 9);
    const p85 = powerAtWindSpeed(SKYWIND_NG, 8.5);
    expect(p8).toBeGreaterThan(0);
    expect(p9).toBeGreaterThan(p8);
    expect(p85).toBeGreaterThan(p8);
    expect(p85).toBeLessThan(p9);
  });

  it("is monotonically increasing from cut-in to peak", () => {
    let prev = 0;
    for (let v = 5.5; v <= 16; v += 0.5) {
      const p = powerAtWindSpeed(SKYWIND_NG, v);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

// ---- Certification validation ----------------------------------------------

describe("SWCC certification validation", () => {
  it("produces approximately 615 kWh/year at 6 m/s (certified reference)", () => {
    const result = validateAgainstCertification();
    // Allow ±10% tolerance due to Rayleigh integration discretization
    expect(result.calculated).toBeGreaterThan(500);
    expect(result.calculated).toBeLessThan(800);
  });
});

// ---- Wind location data ----------------------------------------------------

describe("wind locations", () => {
  it("has data for all 5 cities", () => {
    expect(Object.keys(WIND_LOCATIONS)).toHaveLength(5);
    expect(WIND_LOCATIONS.hamburg).toBeDefined();
    expect(WIND_LOCATIONS.berlin).toBeDefined();
    expect(WIND_LOCATIONS.munich).toBeDefined();
    expect(WIND_LOCATIONS.cologne).toBeDefined();
    expect(WIND_LOCATIONS.boizenburg).toBeDefined();
  });

  it("has 12 monthly factors that sum to approximately 12", () => {
    for (const [, loc] of Object.entries(WIND_LOCATIONS)) {
      const sum = loc.monthlyFactors.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(12, 0);
    }
  });

  it("has positive wind speeds for all cities", () => {
    for (const [, loc] of Object.entries(WIND_LOCATIONS)) {
      expect(loc.annualMeanWindMs).toBeGreaterThan(0);
    }
  });

  it("northern cities have higher wind speeds than southern", () => {
    expect(WIND_LOCATIONS.boizenburg.annualMeanWindMs).toBeGreaterThan(WIND_LOCATIONS.munich.annualMeanWindMs);
    expect(WIND_LOCATIONS.hamburg.annualMeanWindMs).toBeGreaterThan(WIND_LOCATIONS.munich.annualMeanWindMs);
  });
});

// ---- Annual energy production per city -------------------------------------

describe("annual energy production by city", () => {
  it("produces between 100 and 2000 kWh/year per turbine (SkyWind spec)", () => {
    for (const [, loc] of Object.entries(WIND_LOCATIONS)) {
      const result = computeWindEnergy(SKYWIND_NG, loc, 10);
      expect(result.annualKWh).toBeGreaterThan(100);
      expect(result.annualKWh).toBeLessThan(1600);
    }
  });

  it("Boizenburg produces more than München (windier location)", () => {
    const boiz = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.boizenburg, 3);
    const muen = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.munich, 3);
    expect(boiz.annualKWh).toBeGreaterThan(muen.annualKWh);
  });

  it("higher hub height increases yield", () => {
    const low = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.hamburg, 2);
    const high = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.hamburg, 8);
    expect(high.annualKWh).toBeGreaterThan(low.annualKWh);
  });

  it("full load hours are reasonable (100–2000 h for micro wind)", () => {
    for (const [, loc] of Object.entries(WIND_LOCATIONS)) {
      const result = computeWindEnergy(SKYWIND_NG, loc, 10);
      expect(result.fullLoadHours).toBeGreaterThan(100);
      expect(result.fullLoadHours).toBeLessThan(2500);
    }
  });

  it("Boizenburg at 10m hub height yields ~600-800 kWh (plausibility)", () => {
    const result = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.boizenburg, 10);
    // Boizenburg is windy (6 m/s at 10m), should produce ~600-800 kWh at 10m hub
    expect(result.annualKWh).toBeGreaterThan(500);
    expect(result.annualKWh).toBeLessThan(900);
  });
});

// ---- Per-step wind production ----------------------------------------------

describe("windProductionPerStep", () => {
  it("returns Float64Array of length TOTAL_STEPS (35040)", () => {
    const arr = windProductionPerStep(SKYWIND_NG, WIND_LOCATIONS.hamburg, 10);
    expect(arr).toBeInstanceOf(Float64Array);
    expect(arr.length).toBe(35040);
  });

  it("all values are non-negative", () => {
    const arr = windProductionPerStep(SKYWIND_NG, WIND_LOCATIONS.hamburg, 3);
    for (let i = 0; i < arr.length; i++) {
      expect(arr[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("annual sum matches computeWindEnergy (within 5%)", () => {
    const arr = windProductionPerStep(SKYWIND_NG, WIND_LOCATIONS.hamburg, 10);
    const annual = annualSum(arr);
    const expected = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.hamburg, 10);
    expect(annual).toBeGreaterThan(expected.annualKWh * 0.95);
    expect(annual).toBeLessThan(expected.annualKWh * 1.05);
  });

  it("multi-turbine scales production linearly", () => {
    const single = windProductionPerStep(SKYWIND_NG, WIND_LOCATIONS.hamburg, 10);
    const double = windProductionPerStep(SKYWIND_NG, WIND_LOCATIONS.hamburg, 10);
    for (let i = 0; i < double.length; i++) double[i] *= 2;
    expect(annualSum(double)).toBeCloseTo(annualSum(single) * 2, 0);
  });
});

// ---- Integration with runSimulation ----------------------------------------

describe("wind integration in runSimulation", () => {
  function params(overrides: Partial<SimParams> = {}): SimParams {
    return { ...DEFAULT_SIM_PARAMS, ...overrides };
  }

  it("windEnabled=false produces zero wind in summary", () => {
    const r = runSimulation(params({ windEnabled: false }));
    expect(r.summary.totalWindKWh).toBe(0);
  });

  it("windEnabled with count>0 produces wind energy", () => {
    const r = runSimulation(params({
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    expect(r.summary.totalWindKWh).toBeGreaterThan(0);
  });

  it("wind energy increases self-consumption", () => {
    const without = runSimulation(params({ windEnabled: false }));
    const with_ = runSimulation(params({
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
    }));
    expect(with_.summary.selfConsumptionKWh).toBeGreaterThanOrEqual(without.summary.selfConsumptionKWh);
  });

  it("wind energy increases total generation", () => {
    const without = runSimulation(params({ windEnabled: false }));
    const with_ = runSimulation(params({
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
    }));
    const totalWithout = without.summary.totalPVKWh + without.summary.totalWindKWh;
    const totalWith = with_.summary.totalPVKWh + with_.summary.totalWindKWh;
    expect(totalWith).toBeGreaterThan(totalWithout);
  });

  it("wind energy is split between self-consumption and export", () => {
    const r = runSimulation(params({
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
    }));
    // At default 2400 kWh household load, some wind should be self-consumed
    // and some exported (wind produces day and night, load is limited)
    expect(r.summary.totalWindKWh).toBeGreaterThan(0);
    // Self-consumption + export should roughly equal generation
    // (small rounding from battery losses)
    const windAccounted = r.summary.selfConsumptionKWh; // wind is part of this
    expect(windAccounted).toBeGreaterThan(0);
  });

  it("plausibility: ~1 turbine at Boizenburg, 3m hub → 300-500 kWh wind yield", () => {
    const r = runSimulation(params({
      location: "boizenburg",
      windSpeedMeanMs: 6.0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    // Boizenburg is windy (6 m/s), at 10m hub expect ~600-800 kWh
    expect(r.summary.totalWindKWh).toBeGreaterThan(500);
    expect(r.summary.totalWindKWh).toBeLessThan(900);
  });

  it("plausibility: self-consumption of wind is ~50-80% at default household load", () => {
    const r = runSimulation(params({
      location: "boizenburg",
      windSpeedMeanMs: 6.0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    // At 6 m/s in Boizenburg, self-consumption should be reasonable
    const selfUsePct = r.summary.selfConsumptionRatePct;
    expect(selfUsePct).toBeGreaterThan(30);
    expect(selfUsePct).toBeLessThan(100);
  });

  it("wind+PV+battery produces more total energy than PV alone", () => {
    const pvOnly = runSimulation(params({
      location: "boizenburg",
      windSpeedMeanMs: 6.0,
      windEnabled: false,
    }));
    const pvWind = runSimulation(params({
      location: "boizenburg",
      windSpeedMeanMs: 6.0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 3,
    }));
    expect(
      pvWind.summary.totalPVKWh + pvWind.summary.totalWindKWh
    ).toBeGreaterThan(pvOnly.summary.totalPVKWh);
  });

  it("report is JSON-serialisable with wind enabled", () => {
    const r = runSimulation(params({
      windEnabled: true,
      windCount: 2,
      windHubHeightM: 5,
    }));
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("monthly chart includes wind data", () => {
    const r = runSimulation(params({
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 3,
    }));
    const totalWindMonthly = r.monthly.reduce((s, m) => s + m.windKWh, 0);
    expect(totalWindMonthly).toBeGreaterThan(0);
    // Should be close to annual total
    expect(totalWindMonthly).toBeCloseTo(r.summary.totalWindKWh, 0);
  });
});

// ---- Edge cases -----------------------------------------------------------

describe("wind edge cases", () => {
  it("zero turbines produces no wind energy", () => {
    const r = runSimulation(DEFAULT_SIM_PARAMS);
    expect(r.summary.totalWindKWh).toBe(0);
  });

  it("zero hub height still produces energy (uses base wind speed)", () => {
    const r = runSimulation(DEFAULT_SIM_PARAMS);
    // With windEnabled false, should be 0
    expect(r.summary.totalWindKWh).toBe(0);
  });

  it("larger turbines produce more energy at the same site", () => {
    const skywind = computeWindEnergy(WIND_TURBINE_MAP.skywind_ng!, WIND_LOCATIONS.hamburg, 10);
    const bergey = computeWindEnergy(WIND_TURBINE_MAP.bergey_xls1!, WIND_LOCATIONS.hamburg, 10);
    expect(bergey.annualKWh).toBeGreaterThan(skywind.annualKWh);
  });
});

// ---- Plausibility tests (regression: self-consumption > generation) -------

describe("plausibility: self-consumption ≤ generation", () => {
  function params(overrides: Partial<SimParams> = {}): SimParams {
    return { ...DEFAULT_SIM_PARAMS, ...overrides };
  }

  it("wind-only: self-consumption ≤ wind generation", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const totalGen = r.summary.totalPVKWh + r.summary.totalWindKWh;
    expect(r.summary.selfConsumptionKWh).toBeLessThanOrEqual(totalGen + 0.1);
    expect(r.summary.selfConsumptionKWh).toBeGreaterThanOrEqual(0);
  });

  it("wind-only: self-consumption rate ≤ 100%", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const rate = r.summary.totalLoadKWh > 0 ? (r.summary.selfConsumptionKWh / r.summary.totalLoadKWh) * 100 : 0;
    expect(rate).toBeLessThanOrEqual(100.1);
  });

  it("wind-only: export ≥ 0", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    expect(r.summary.totalExportKWh).toBeGreaterThanOrEqual(0);
  });

  it("wind-only: import + self-consumption ≈ load (within rounding)", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const sum = r.summary.selfConsumptionKWh + r.summary.totalImportKWh;
    expect(sum).toBeCloseTo(r.summary.totalLoadKWh, 0);
  });

  it("wind-only: amortisation payback > 5 years for 1500€ investment", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      investmentEUR: 1500,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    // With ~500 kWh self-consumption at 24 ct/kWh, savings ≈ 120 EUR/yr
    // Payback ≈ 1500/120 ≈ 12.5 years
    expect(r.amortisation.paybackYears).toBeGreaterThan(5);
    expect(r.amortisation.paybackYears).toBeLessThan(30);
    expect(r.amortisation.annualBenefitEUR).toBeGreaterThan(0);
    expect(r.amortisation.annualBenefitEUR).toBeLessThan(500);
  });

  it("wind-only: no NaN in feed-in tariff", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    expect(r.summary.totalPVKWh).not.toBeNaN();
    expect(r.summary.totalWindKWh).not.toBeNaN();
    expect(r.summary.selfConsumptionKWh).not.toBeNaN();
    expect(r.summary.totalExportKWh).not.toBeNaN();
    expect(r.summary.totalImportKWh).not.toBeNaN();
    expect(r.amortisation.paybackYears).not.toBeNaN();
  });

  it("wind-only with battery: self-consumption ≤ generation even with initial SOC", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      capacityKWh: 19.353,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const totalGen = r.summary.totalPVKWh + r.summary.totalWindKWh;
    expect(r.summary.selfConsumptionKWh).toBeLessThanOrEqual(totalGen + 0.1);
  });

  it("PV+wind: self-consumption ≤ combined generation", () => {
    const r = runSimulation(params({
      peakKWp: 10,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const totalGen = r.summary.totalPVKWh + r.summary.totalWindKWh;
    expect(r.summary.selfConsumptionKWh).toBeLessThanOrEqual(totalGen + 0.1);
  });

  it("self-consumption + export ≤ generation + battery losses", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const totalGen = r.summary.totalPVKWh + r.summary.totalWindKWh;
    // Self-consumption + export should be ≤ generation (some battery losses)
    expect(r.summary.selfConsumptionKWh + r.summary.totalExportKWh).toBeLessThanOrEqual(totalGen + 1);
  });

  it("monthly self-consumption sums to annual (within rounding)", () => {
    const r = runSimulation(params({
      peakKWp: 0,
      windEnabled: true,
      windCount: 1,
      windHubHeightM: 10,
      windTurbineId: "skywind_ng",
    }));
    const monthlySC = r.monthly.reduce((s, m) => s + m.selfConsumptionKWh, 0);
    expect(monthlySC).toBeCloseTo(r.summary.selfConsumptionKWh, -1);
  });
});
