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
import { WIND_LOCATIONS } from "../src/calc/wind";
import { CITIES, NET_ENTGELT_CT, cityForLocation } from "../src/calc/tariff";

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

  it("south outperforms east/west, and an east-west split out-yields a single east array", () => {
    const south = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "south", location: "hamburg" }));
    const east = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "east", location: "hamburg" }));
    const west = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "west", location: "hamburg" }));
    const ew = sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: 35, orientation: "east_west", location: "hamburg" }));
    expect(south).toBeGreaterThan(ew);
    expect(east).toBeCloseTo(west, 0); // east and west are symmetric
    // A real east-west split catches both the morning and afternoon sun, so it
    // yields MORE per kWp than a single east (or west) array — but still less
    // than an optimal south array.
    expect(ew).toBeGreaterThan(east);
    expect(ew).toBeLessThan(south);
  });

  it("annual yield depends on tilt: it peaks near the optimum and falls off for flat / vertical arrays", () => {
    const y = (tilt: number) =>
      sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: tilt, orientation: "south", location: "hamburg" }));
    const flat = y(0);
    const optimal = y(35);
    const vertical = y(90);
    // Flat and vertical both under-produce relative to the ~35–40° optimum.
    expect(flat).toBeLessThan(optimal);
    expect(vertical).toBeLessThan(optimal);
    // A flat roof still captures a large share (~75–90 %) of the optimum.
    expect(flat / optimal).toBeGreaterThan(0.7);
    expect(flat / optimal).toBeLessThan(0.95);
    // A vertical south façade is materially worse than the optimum.
    expect(vertical / optimal).toBeLessThan(0.85);
    // The optimum tilt (30–45°) beats both a shallow (15°) and a steep (60°) tilt.
    expect(optimal).toBeGreaterThan(y(15));
    expect(optimal).toBeGreaterThanOrEqual(y(60));
  });

  it("annual yield peaks near the latitude-dependent optimal tilt (~30–45° for Germany)", () => {
    const yield_ = (tilt: number) =>
      sum(pvProductionPerStep({ peakKWp: 10, tiltDeg: tilt, orientation: "south", location: "munich" }));
    // Scan tilts and find the best; it should land in the German optimal band.
    let bestTilt = 0;
    let best = -1;
    for (let t = 0; t <= 90; t += 5) {
      const y = yield_(t);
      if (y > best) { best = y; bestTilt = t; }
    }
    expect(bestTilt).toBeGreaterThanOrEqual(25);
    expect(bestTilt).toBeLessThanOrEqual(50);
  });

  it("monthly totals sum to the annual production", () => {
    const p = pvProductionPerStep(cfg);
    const m = monthlyTotals(p);
    expect(sum(Float64Array.from(m))).toBeCloseTo(sum(p), 0);
  });

  it("monthly bucketing uses the real calendar: 12 buckets, none empty, calendar-consistent", () => {
    const p = pvProductionPerStep(cfg);
    const m = monthlyTotals(p);
    expect(m).toHaveLength(12);
    // Every month has some PV (even December in Hamburg is > 0).
    for (let i = 0; i < 12; i++) expect(m[i]).toBeGreaterThan(0);
    // Independent recomputation using the same calendar mapping must match
    // exactly (guards against the previous 30.4375-day average-month drift).
    const ref = new Array(12).fill(0);
    for (let i = 0; i < p.length; i++) {
      const day = Math.floor(i / STEPS_PER_DAY);
      const month = new Date(Date.UTC(2023, 0, 1 + day)).getUTCMonth();
      ref[month] += p[i];
    }
    for (let i = 0; i < 12; i++) expect(m[i]).toBeCloseTo(ref[i], 6);
  });

  it("PV is summer-heavy: summer (JJA) months clearly out-produce winter (DJF)", () => {
    const m = monthlyTotals(pvProductionPerStep(cfg));
    const summer = m[5] + m[6] + m[7]; // Jun, Jul, Aug
    const winter = m[0] + m[1] + m[11]; // Jan, Feb, Dec
    // Complementary to wind: PV peaks in summer. In Hamburg summer PV is many
    // times the winter figure.
    expect(summer).toBeGreaterThan(winter * 2);
    // Peak month is a summer month, minimum is a winter month.
    let maxM = 0, minM = 0;
    for (let i = 1; i < 12; i++) {
      if (m[i] > m[maxM]) maxM = i;
      if (m[i] < m[minM]) minM = i;
    }
    expect([4, 5, 6, 7]).toContain(maxM); // May–Aug
    expect([10, 11, 0, 1]).toContain(minM); // Nov–Feb
  });

  it("all locations are defined with positive yields", () => {
    for (const k of Object.keys(LOCATIONS)) {
      expect(LOCATIONS[k].annualYieldPerKWp).toBeGreaterThan(0);
    }
  });
});

describe("location plausibility", () => {
  /** Annual yield (kWh per kWp) of a south array at the model's own optimum tilt. */
  const atOptimalTilt = (key: string) => {
    const opt = Math.max(0, Math.min(90, 0.76 * LOCATIONS[key].latDeg - 3.1));
    return sum(pvProductionPerStep({ peakKWp: 1, tiltDeg: opt, orientation: "south", location: key }));
  };

  it("reproduces each location's stored empirical yield exactly at the optimum tilt", () => {
    for (const [key, loc] of Object.entries(LOCATIONS)) {
      expect(atOptimalTilt(key), key).toBeCloseTo(loc.annualYieldPerKWp, 1);
    }
  });

  // PVGIS 5.3 grid-connected PV, SARAH3, 1 kWp c-Si, 14 % system loss, optimally
  // tilted south array, at the coordinates stored in LOCATIONS. Reproduce with:
  //   curl "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=<lat>&lon=<lon>\
  // &peakpower=1&loss=14&optimalangles=1&outputformat=json" → outputs.totals.fixed.E_y
  const PVGIS_E_Y: Record<string, number> = {
    hamburg: 989.5,
    berlin: 1061.1,
    munich: 1140.7,
    cologne: 1040.6,
    boizenburg: 1028.5,
    barcelona: 1570.9,
    lisbon: 1579.8,
    paris: 1148.7,
    london: 1022.9,
  };

  it("tracks PVGIS specific yield within 5 % for every location", () => {
    for (const [key, ref] of Object.entries(PVGIS_E_Y)) {
      const dev = (Math.abs(atOptimalTilt(key) - ref) / ref) * 100;
      expect(dev, `${key}: ${atOptimalTilt(key).toFixed(0)} vs PVGIS ${ref}`).toBeLessThan(5);
    }
  });

  it("orders yields as latitude-and-insolation would predict", () => {
    const y = (k: string) => atOptimalTilt(k);
    // Sunny Iberian sites far out-yield central/northern Europe.
    expect(y("barcelona")).toBeGreaterThan(y("paris") * 1.3);
    expect(y("lisbon")).toBeGreaterThan(y("london") * 1.4);
    // Paris sits between Hamburg and the Iberian sites, near Munich.
    expect(y("paris")).toBeGreaterThan(y("hamburg"));
    expect(y("paris")).toBeGreaterThan(y("london"));
    expect(y("paris")).toBeLessThan(y("barcelona"));
    // London is marginally below Berlin at a comparable latitude.
    expect(y("london")).toBeLessThan(y("berlin"));
  });

  it("produces a realistic capacity factor for every location", () => {
    // Annual yield / (kWp * 8760 h). European rooftop PV sits around 11–19 %.
    for (const key of Object.keys(LOCATIONS)) {
      const cf = atOptimalTilt(key) / 8760;
      expect(cf, key).toBeGreaterThan(0.1);
      expect(cf, key).toBeLessThan(0.2);
    }
  });

  it("never exceeds 1 kWp of instantaneous output per kWp, nor produces at night", () => {
    for (const key of Object.keys(LOCATIONS)) {
      const opt = Math.max(0, Math.min(90, 0.76 * LOCATIONS[key].latDeg - 3.1));
      const c = pvProductionPerStep({ peakKWp: 1, tiltDeg: opt, orientation: "south", location: key });
      let peak = 0;
      for (let i = 0; i < c.length; i++) {
        expect(Number.isFinite(c[i]), key).toBe(true);
        expect(c[i], key).toBeGreaterThanOrEqual(0);
        if (c[i] > peak) peak = c[i];
      }
      // 15-min step → kW.
      expect(peak * 4, key).toBeLessThan(1);
      expect(peak * 4, key).toBeGreaterThan(0.3);
      // Local midnight (steps 0..3) must be exactly zero.
      for (let d = 0; d < 365; d++)
        for (let s = 0; s < 4; s++) expect(c[d * STEPS_PER_DAY + s], `${key} day ${d}`).toBe(0);
    }
  });

  it("seasonality matches hemisphere and climate: summer peak, and a flatter year in Iberia", () => {
    const ratio = (key: string) => {
      const m = monthlyTotals(
        pvProductionPerStep({
          peakKWp: 1,
          tiltDeg: Math.max(0, Math.min(90, 0.76 * LOCATIONS[key].latDeg - 3.1)),
          orientation: "south",
          location: key,
        }),
      );
      return { summer: m[5] + m[6] + m[7], winter: m[0] + m[1] + m[11], m };
    };
    for (const key of Object.keys(LOCATIONS)) {
      const { summer, winter, m } = ratio(key);
      // Northern hemisphere only: summer always beats winter, peak in May–Aug.
      expect(summer, key).toBeGreaterThan(winter);
      const maxM = m.indexOf(Math.max(...m));
      expect([4, 5, 6, 7], key).toContain(maxM);
      // Barcelona's winter is genuinely sunny, so its profile is much flatter
      // than Hamburg's rather than merely "also summer-heavy".
      expect(summer / winter, key).toBeLessThan(3);
    }
    expect(ratio("barcelona").summer / ratio("barcelona").winter).toBeLessThan(
      ratio("hamburg").summer / ratio("hamburg").winter,
    );
  });

  it("computes the right day length at each latitude", () => {
    const dayLength = (latDeg: number, day: number) => {
      let n = 0;
      for (let i = 0; i < STEPS_PER_DAY; i++) {
        const hr = ((i % STEPS_PER_DAY) / STEPS_PER_DAY) * 24;
        if (solarVector(latDeg, day + 0.5, hr).elevationRad > 0) n++;
      }
      return (n / STEPS_PER_DAY) * 24;
    };
    // June solstice / December solstice / equinox.
    expect(dayLength(LOCATIONS.hamburg.latDeg, 172)).toBeCloseTo(16.75, 1); // 53.55°N
    expect(dayLength(LOCATIONS.barcelona.latDeg, 172)).toBeCloseTo(14.75, 1); // 41.39°N
    expect(dayLength(LOCATIONS.lisbon.latDeg, 355)).toBeCloseTo(9.25, 1); // 38.72°N
    expect(dayLength(LOCATIONS.london.latDeg, 355)).toBeCloseTo(7.75, 1); // 51.51°N
    // Every latitude sees ~12 h at the equinox, and longer days in June.
    for (const key of Object.keys(LOCATIONS)) {
      const lat = LOCATIONS[key].latDeg;
      expect(dayLength(lat, 80), key).toBeCloseTo(12, 0);
      expect(dayLength(lat, 172), key).toBeGreaterThan(dayLength(lat, 355));
    }
  });

  it("has a sane optimal tilt for every latitude, including the sub-40° sites", () => {
    for (const [key, loc] of Object.entries(LOCATIONS)) {
      let bestTilt = 0;
      let best = -1;
      for (let tilt = 0; tilt <= 60; tilt += 5) {
        const y = sum(pvProductionPerStep({ peakKWp: 1, tiltDeg: tilt, orientation: "south", location: key }));
        if (y > best) { best = y; bestTilt = tilt; }
      }
      // The optimum tracks latitude: lower for Lisbon/Barcelona than for Hamburg,
      // and never more than ~8° from PVGIS's own optimum.
      expect(bestTilt, key).toBeGreaterThanOrEqual(20);
      expect(bestTilt, key).toBeLessThanOrEqual(50);
      expect(Math.abs(bestTilt - loc.pvgisOptimalTiltDeg), key).toBeLessThanOrEqual(8);
      // A flat roof still captures a large share of the optimum.
      const flat = sum(pvProductionPerStep({ peakKWp: 1, tiltDeg: 0, orientation: "south", location: key }));
      expect(flat / best, key).toBeGreaterThan(0.7);
    }
    const peakAt = (key: string) => {
      let bt = 0, b = -1;
      for (let tilt = 0; tilt <= 60; tilt += 5) {
        const y = sum(pvProductionPerStep({ peakKWp: 1, tiltDeg: tilt, orientation: "south", location: key }));
        if (y > b) { b = y; bt = tilt; }
      }
      return bt;
    };
    expect(peakAt("lisbon")).toBeLessThan(peakAt("hamburg"));
    expect(peakAt("barcelona")).toBeLessThan(peakAt("munich"));
  });

  it("every location key has wind and tariff data too", () => {
    // Guards the silent Hamburg fallback in report.ts / tariff.ts when a key is
    // added to LOCATIONS without a matching entry elsewhere.
    for (const key of Object.keys(LOCATIONS)) {
      expect(WIND_LOCATIONS[key], `WIND_LOCATIONS missing "${key}"`).toBeDefined();
      expect(cityForLocation(key)).toBeDefined();
      expect(CITIES).toContain(cityForLocation(key));
      expect(NET_ENTGELT_CT[cityForLocation(key)]).toBeGreaterThan(0);
      // Wind and PV must agree on the latitude.
      expect(WIND_LOCATIONS[key].latDeg, key).toBe(LOCATIONS[key].latDeg);
    }
  });
});
