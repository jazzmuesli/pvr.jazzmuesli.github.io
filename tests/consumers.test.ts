import { describe, it, expect } from "vitest";
import {
  householdLoad,
  heatpumpLoad,
  bwwpLoad,
  evLoad,
  totalLoad,
  annualSum,
  ConsumerConfig,
} from "../src/calc/consumers";
import { STEPS_PER_DAY, monthOfStep, hourOfStep, TOTAL_STEPS } from "../src/calc/types";

function sumOverHours(load: Float64Array, hours: number[]): number {
  let s = 0;
  for (let i = 0; i < load.length; i++) {
    if (hours.includes(hourOfStep(i))) s += load[i];
  }
  return s;
}

function sumOverMonths(load: Float64Array, months: number[]): number {
  let s = 0;
  for (let i = 0; i < load.length; i++) {
    if (months.includes(monthOfStep(i))) s += load[i];
  }
  return s;
}

const noConsumers: ConsumerConfig = {
  household: { enabled: false, annualKWh: 0 },
  heatpump: { enabled: false, annualKWh: 0 },
  bwwp: { enabled: false },
  ev: { enabled: false, annualKWh: 0, pvShare: 0.5 },
};

describe("householdLoad", () => {
  it("scales to the requested annual consumption", () => {
    const sum = annualSum(householdLoad(4000));
    expect(sum).toBeGreaterThan(4000 * 0.98);
    expect(sum).toBeLessThan(4000 * 1.02);
  });

  it("has an evening/morning peak higher than the night trough", () => {
    const l = householdLoad(4000);
    const peak = sumOverHours(l, [7, 8, 18, 19, 20]);
    const night = sumOverHours(l, [2, 3, 4]);
    expect(peak).toBeGreaterThan(night);
  });

  it("returns zero for non-positive consumption", () => {
    expect(annualSum(householdLoad(0))).toBe(0);
  });
});

describe("heatpumpLoad", () => {
  it("scales to the requested annual consumption", () => {
    const sum = annualSum(heatpumpLoad(5000));
    expect(sum).toBeGreaterThan(5000 * 0.98);
    expect(sum).toBeLessThan(5000 * 1.02);
  });

  it("is strongly winter-heavy", () => {
    const l = heatpumpLoad(5000);
    const winter = sumOverMonths(l, [12, 1, 2]);
    const summer = sumOverMonths(l, [6, 7, 8]);
    expect(winter).toBeGreaterThan(summer * 2.5);
  });

  it("is night-heavy", () => {
    const l = heatpumpLoad(5000);
    const night = sumOverHours(l, [23, 0, 1, 2, 3, 4]);
    const mid = sumOverHours(l, [11, 12, 13, 14]);
    expect(night).toBeGreaterThan(mid);
  });
});

describe("bwwpLoad", () => {
  it("delivers ~40 kWh per month clustered at solar noon", () => {
    const l = bwwpLoad();
    // Average monthly energy should be ~40 kWh.
    let total = 0;
    for (let m = 1; m <= 12; m++) total += sumOverMonths(l, [m]);
    const perMonth = total / 12;
    expect(perMonth).toBeGreaterThan(36);
    expect(perMonth).toBeLessThan(44);
    // Peak at 12:00, near-zero at 03:00.
    const noon = sumOverHours(l, [12]);
    const night = sumOverHours(l, [3]);
    expect(noon).toBeGreaterThan(0);
    expect(night).toBe(0);
  });

  it("totals about 480 kWh/year", () => {
    const sum = annualSum(bwwpLoad());
    expect(sum).toBeGreaterThan(450);
    expect(sum).toBeLessThan(510);
  });
});

describe("evLoad", () => {
  it("scales to the requested annual demand", () => {
    const sum = annualSum(evLoad(2000, 0.8));
    expect(sum).toBeGreaterThan(2000 * 0.98);
    expect(sum).toBeLessThan(2000 * 1.02);
  });

  it("shifts load toward midday as pvShare increases", () => {
    const low = evLoad(2000, 0.0);
    const high = evLoad(2000, 1.0);
    const midday = [10, 11, 12, 13];
    const evening = [19, 20];
    expect(sumOverHours(high, midday)).toBeGreaterThan(sumOverHours(low, midday));
    expect(sumOverHours(low, evening)).toBeGreaterThan(sumOverHours(high, evening));
  });
});

describe("totalLoad", () => {
  it("sums the enabled consumers", () => {
    const cfg: ConsumerConfig = {
      household: { enabled: true, annualKWh: 4000 },
      heatpump: { enabled: true, annualKWh: 5000 },
      bwwp: { enabled: true },
      ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
    };
    const total = annualSum(totalLoad(cfg));
    const parts =
      annualSum(householdLoad(4000)) +
      annualSum(heatpumpLoad(5000)) +
      annualSum(bwwpLoad()) +
      annualSum(evLoad(2000, 0.8));
    expect(total).toBeCloseTo(parts, 1);
    expect(total).toBeCloseTo(4000 + 5000 + 480 + 2000, 0);
  });

  it("is empty when nothing is enabled", () => {
    expect(annualSum(totalLoad(noConsumers))).toBe(0);
  });
});

// Sanity: array length is exactly one year.
expect(TOTAL_STEPS).toBe(365 * STEPS_PER_DAY);
