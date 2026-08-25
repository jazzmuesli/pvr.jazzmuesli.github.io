import { describe, it, expect } from "vitest";
import {
  declination,
  solarVector,
  incidenceCos,
  pvProductionPerStep,
  monthlyTotals,
  LOCATIONS,
  DEG,
} from "../src/calc/solar";
import { TOTAL_STEPS, STEPS_PER_DAY } from "../src/calc/index";

function sum(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

describe("solar position", () => {
  it("declination is ~0 at the equinox (day 81) and max at summer solstice (~day 172)", () => {
    expect(declination(81)).toBeCloseTo(0, 1);
    expect(declination(172)).toBeCloseTo(23.45 * DEG, 1);
    expect(declination(355)).toBeLessThan(0); // winter, negative
  });

  it("elevation is non-positive at night", () => {
    const night = solarVector(53.5, 1, 0); // Jan 1, midnight
    expect(Math.sin(night.elevationRad)).toBeLessThanOrEqual(0);
  });

  it("sun is due south at local solar noon in the northern hemisphere", () => {
    const noon = solarVector(53.5, 172, 12);
    const azDeg = (noon.azimuthRad / DEG + 360) % 360;
    expect(azDeg).toBeCloseTo(180, 0);
  });
});

describe("incidence angle", () => {
  it("south-facing surface catches more midday sun than an east-facing one", () => {
    const sun = solarVector(53.5, 172, 12);
    const south = incidenceCos(sun, 35, 180);
    const east = incidenceCos(sun, 35, 90);
    expect(south).toBeGreaterThan(east);
  });
});

describe("pv production", () => {
  const cfg = { peakKWp: 10, tiltDeg: 35, orientation: "south" as const, location: "hamburg" };

  it("produces a full-year 15-min series of non-negative values", () => {
    const p = pvProductionPerStep({ ...cfg, orientation: "south" });
    expect(p.length).toBe(TOTAL_STEPS);
    for (let i = 0; i < p.length; i += 997) expect(p[i]).toBeGreaterThanOrEqual(0);
  });

  it("produces ~0 at night (hour 0) and positive at midday", () => {
    // step 0 is 00:00 -> night
    const nightP = pvProductionPerStep({ ...cfg, orientation: "south" })[0];
    expect(nightP).toBeCloseTo(0, 3);
    // midday step for Jan 1: day0, hour12 -> step 48
    const midP = pvProductionPerStep({ ...cfg, orientation: "south" })[48];
    expect(midP).toBeGreaterThan(0);
  });

  it("south array peaks near solar noon; east array peaks earlier", () => {
    // Compare the hour-of-day of the daily peak for a summer day.
    const day = 172;
    const south = pvProductionPerStep({ ...cfg, orientation: "south" });
    const east = pvProductionPerStep({ ...cfg, orientation: "east" });
    const peakHour = (arr: Float64Array) => {
      let best = -1;
      let bestVal = -1;
      for (let h = 0; h < 24; h++) {
        const v = arr[day * STEPS_PER_DAY + h * 4];
        if (v > bestVal) { bestVal = v; best = h; }
      }
      return best;
    };
    expect(peakHour(south)).toBeGreaterThanOrEqual(11);
    expect(peakHour(south)).toBeLessThanOrEqual(13);
    expect(peakHour(east)).toBeLessThan(peakHour(south));
  });

  it("10 kWp @ 45° south in Hamburg yields roughly 10,000 kWh/year", () => {
    const p = pvProductionPerStep({ peakKWp: 10, tiltDeg: 45, orientation: "south", location: "hamburg" });
    const annual = sum(p);
    expect(annual).toBeGreaterThan(9000);
    expect(annual).toBeLessThan(10500);
  });

  it("south outperforms east/west and east/west matches a single east array (symmetric)", () => {
    const south = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "south", location: "hamburg" }));
    const east = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "east", location: "hamburg" }));
    const ew = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "east_west", location: "hamburg" }));
    expect(south).toBeGreaterThan(ew);
    expect(ew).toBeGreaterThan(0);
    // east/west split is symmetric, so it equals a single east array of the same peak.
    expect(ew).toBeGreaterThanOrEqual(east * 0.999);
    expect(ew).toBeLessThanOrEqual(east * 1.001);
  });

  it("monthly totals sum to the annual production", () => {
    const p = pvProductionPerStep(cfg);
    const m = monthlyTotals(p);
    expect(sum(Float64Array.from(m))).toBeCloseTo(sum(p), 0);
  });

  it("all locations are defined with positive yields", () => {
    for (const k of Object.keys(LOCATIONS)) {
      expect(LOCATIONS[k].annualYieldPerKWp).toBeGreaterThan(0);
    }
  });
});
