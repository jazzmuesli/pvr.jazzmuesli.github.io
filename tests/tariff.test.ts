import { describe, it, expect } from "vitest";
import {
  importPriceCtPerKWh,
  importPriceArray,
  modul3NetzentgeltCt,
  NET_ENTGELT_CT,
} from "../src/calc/tariff";
import { STEPS_PER_DAY, TOTAL_STEPS } from "../src/calc/types";

describe("modul3NetzentgeltCt (§14a Modul 3, Boizenburg VBE 2026)", () => {
  it("uses the cheap Niedriglasttarif at night (00:00–05:00)", () => {
    const step = 10 * STEPS_PER_DAY + 3 * 4; // any day, 03:00
    expect(modul3NetzentgeltCt("Boizenburg", step)).toBeCloseTo(2.25, 5);
  });

  it("uses the Hochtarif in winter evening peaks (18–20, Q1/Q4)", () => {
    const jan = (15 - 1) * STEPS_PER_DAY + 19 * 4; // mid-Jan, 19:00
    const oct = (300 - 1) * STEPS_PER_DAY + 19 * 4; // late Oct, 19:00
    expect(modul3NetzentgeltCt("Boizenburg", jan)).toBeCloseTo(12.85, 5);
    expect(modul3NetzentgeltCt("Boizenburg", oct)).toBeCloseTo(12.85, 5);
  });

  it("uses the Standardlasttarif otherwise (e.g. summer day, midday)", () => {
    const jul = (182) * STEPS_PER_DAY + 12 * 4; // mid-July, 12:00
    expect(modul3NetzentgeltCt("Boizenburg", jul)).toBeCloseTo(7.5, 5);
  });

  it("approximates Modul 3 for other cities around their base rate", () => {
    const step = 10 * STEPS_PER_DAY + 3 * 4; // night
    expect(modul3NetzentgeltCt("Hamburg", step)).toBeCloseTo(NET_ENTGELT_CT.Hamburg * 0.3, 5);
  });
});

describe("importPriceCtPerKWh", () => {
  it("fixed scheme is a constant", () => {
    expect(importPriceCtPerKWh("fixed", "Hamburg", 9, 0, 24)).toBe(24);
    expect(importPriceCtPerKWh("fixed", "Berlin", 50, 9999, 30)).toBe(30);
  });

  it("dynamic equals spot + flat netzentgelt + adders", () => {
    const spot = 8.9;
    const got = importPriceCtPerKWh("dynamic", "Hamburg", spot, 0);
    const adders = 2.05 + 1.1 + 0.5 + 1.5;
    expect(got).toBeCloseTo(spot + NET_ENTGELT_CT.Hamburg + adders, 5);
  });

  it("dynamic14a is cheaper than dynamic at night (Niedriglast)", () => {
    const step = 10 * STEPS_PER_DAY + 3 * 4; // 03:00
    const spot = 10;
    const dyn = importPriceCtPerKWh("dynamic", "Boizenburg", spot, step);
    const dyn14 = importPriceCtPerKWh("dynamic14a", "Boizenburg", spot, step);
    expect(dyn14).toBeLessThan(dyn);
  });

  it("dynamic14a is more expensive than dynamic in winter evening Hochtarif", () => {
    const step = (15 - 1) * STEPS_PER_DAY + 19 * 4; // Jan, 19:00
    const spot = 10;
    const dyn = importPriceCtPerKWh("dynamic", "Boizenburg", spot, step);
    const dyn14 = importPriceCtPerKWh("dynamic14a", "Boizenburg", spot, step);
    expect(dyn14).toBeGreaterThan(dyn);
  });

  it("reflects city differences", () => {
    const spot = 10;
    const h = importPriceCtPerKWh("dynamic", "Hamburg", spot, 0);
    const m = importPriceCtPerKWh("dynamic", "Muenchen", spot, 0);
    expect(h).not.toBeCloseTo(m, 2);
  });
});

describe("importPriceArray", () => {
  it("produces one price per step and respects the scheme", () => {
    const spot = new Float64Array(TOTAL_STEPS).fill(90); // 9 ct/kWh
    const arr = importPriceArray("dynamic", "Berlin", spot);
    expect(arr.length).toBe(TOTAL_STEPS);
    const adders = 2.05 + 1.1 + 0.5 + 1.5;
    expect(arr[0]).toBeCloseTo(9 + NET_ENTGELT_CT.Berlin + adders, 5);
  });
});
