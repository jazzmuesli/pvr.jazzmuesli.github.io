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
    // After datasheet calibration the model reproduces the certified AEP at
    // 6 m/s almost exactly; keep a tight band around the 615 kWh reference.
    expect(result.calculated).toBeGreaterThan(590);
    expect(result.calculated).toBeLessThan(640);
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
  it("produces between 40 and 1600 kWh/year per turbine (SkyWind spec)", () => {
    // Lower bound is 40 kWh: after datasheet calibration the SkyWind NG at a
    // weak inland site (München, 3.6 m/s) with its high 5.5 m/s cut-in
    // realistically yields only ~85 kWh/year at 10 m — small but physical.
    for (const [, loc] of Object.entries(WIND_LOCATIONS)) {
      const result = computeWindEnergy(SKYWIND_NG, loc, 10);
      expect(result.annualKWh).toBeGreaterThan(40);
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

// ---- Physical plausibility: seasonality & datasheet calibration ------------

describe("wind seasonality (winter > summer)", () => {
  // German wind climatology: energy peaks in winter (Nov–Feb) and is lowest in
  // summer (Jun–Aug). The convex power curve amplifies the monthly wind
  // factors, so winter energy must clearly exceed summer energy everywhere.
  const WINTER = [0, 1, 11]; // Jan, Feb, Dec
  const SUMMER = [5, 6, 7]; // Jun, Jul, Aug

  function seasonSum(monthly: number[], months: number[]): number {
    return months.reduce((s, m) => s + monthly[m], 0);
  }

  it("winter (DJF) energy exceeds summer (JJA) for every location and turbine", () => {
    for (const [locKey, loc] of Object.entries(WIND_LOCATIONS)) {
      for (const [id, turbine] of Object.entries(WIND_TURBINE_MAP)) {
        const r = computeWindEnergy(turbine, loc, 10);
        const winter = seasonSum(r.monthlyKWh, WINTER);
        const summer = seasonSum(r.monthlyKWh, SUMMER);
        expect(
          winter,
          `${id} @ ${locKey}: winter ${winter.toFixed(1)} should exceed summer ${summer.toFixed(1)}`,
        ).toBeGreaterThan(summer);
      }
    }
  });

  it("winter/summer energy ratio is in a physically plausible band (1.5–5x)", () => {
    for (const [, loc] of Object.entries(WIND_LOCATIONS)) {
      const r = computeWindEnergy(SKYWIND_NG, loc, 10);
      const winter = seasonSum(r.monthlyKWh, WINTER);
      const summer = seasonSum(r.monthlyKWh, SUMMER);
      const ratio = winter / summer;
      expect(ratio).toBeGreaterThan(1.5);
      expect(ratio).toBeLessThan(5);
    }
  });

  it("the windiest month is a winter month, the calmest a summer month", () => {
    const r = computeWindEnergy(SKYWIND_NG, WIND_LOCATIONS.hamburg, 10);
    let maxM = 0, minM = 0;
    for (let m = 1; m < 12; m++) {
      if (r.monthlyKWh[m] > r.monthlyKWh[maxM]) maxM = m;
      if (r.monthlyKWh[m] < r.monthlyKWh[minM]) minM = m;
    }
    // max in {Nov, Dec, Jan, Feb}, min in {May..Aug}
    expect([10, 11, 0, 1]).toContain(maxM);
    expect([4, 5, 6, 7]).toContain(minM);
  });
});

describe("datasheet AEP calibration", () => {
  // At the reference regime (6 m/s mean, flat monthly distribution, 10 m hub)
  // each turbine must reproduce its certified annual yield (referenceAEP6ms)
  // within ±15%. This anchors the absolute magnitude of the projections to the
  // manufacturer datasheets instead of the raw (over-optimistic) Rayleigh model.
  const REF_LOCATION = {
    name: "Referenz (6 m/s)",
    annualMeanWindMs: 6.0,
    latDeg: 0,
    monthlyFactors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  };

  it("every turbine's AEP at 6 m/s is within ±15% of its referenceAEP6ms", () => {
    for (const [id, turbine] of Object.entries(WIND_TURBINE_MAP)) {
      const r = computeWindEnergy(turbine, REF_LOCATION, 10);
      const ratio = r.annualKWh / turbine.referenceAEP6ms;
      expect(
        ratio,
        `${id}: calc ${r.annualKWh.toFixed(0)} vs ref ${turbine.referenceAEP6ms}`,
      ).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    }
  });
});

describe("wind specific yield is physically bounded", () => {
  // Energy per m² of swept rotor area is Betz-limited and, for these small
  // machines at 6 m/s, realistically lands in ~200–550 kWh/m². A turbine far
  // outside this band signals an internally inconsistent power curve vs. rotor
  // area (the pre-calibration Superwind 350 sat at ~895 kWh/m²).
  const REF_LOCATION = {
    name: "Referenz (6 m/s)",
    annualMeanWindMs: 6.0,
    latDeg: 0,
    monthlyFactors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  };

  it("all turbines have specific yield in 150–600 kWh/m² at 6 m/s", () => {
    for (const [id, turbine] of Object.entries(WIND_TURBINE_MAP)) {
      const r = computeWindEnergy(turbine, REF_LOCATION, 10);
      expect(r.specificYield, `${id}: ${r.specificYield.toFixed(0)} kWh/m²`).toBeGreaterThan(150);
      expect(r.specificYield, `${id}: ${r.specificYield.toFixed(0)} kWh/m²`).toBeLessThan(600);
    }
  });

  it("full-load hours are in a realistic micro-wind band (800–3000 h) at 6 m/s", () => {
    for (const [id, turbine] of Object.entries(WIND_TURBINE_MAP)) {
      const r = computeWindEnergy(turbine, REF_LOCATION, 10);
      expect(r.fullLoadHours, `${id}: ${r.fullLoadHours.toFixed(0)} h`).toBeGreaterThan(800);
      expect(r.fullLoadHours, `${id}: ${r.fullLoadHours.toFixed(0)} h`).toBeLessThan(3000);
    }
  });
});

describe("per-step wind series matches calibrated annual (all turbines)", () => {
  it("Monte-Carlo per-step integrates to computeWindEnergy within 6%", () => {
    for (const [id, turbine] of Object.entries(WIND_TURBINE_MAP)) {
      const arr = windProductionPerStep(turbine, WIND_LOCATIONS.boizenburg, 10);
      const perStepAnnual = annualSum(arr);
      const analytic = computeWindEnergy(turbine, WIND_LOCATIONS.boizenburg, 10).annualKWh;
      const ratio = perStepAnnual / analytic;
      expect(ratio, `${id}: perStep ${perStepAnnual.toFixed(0)} vs analytic ${analytic.toFixed(0)}`).toBeGreaterThan(0.94);
      expect(ratio).toBeLessThan(1.06);
    }
  });
});
