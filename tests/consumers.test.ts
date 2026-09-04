import { describe, it, expect } from "vitest";
import {
  householdLoad,
  heatpumpLoad,
  bwwpLoad,
  heatpumpHotWaterLoad,
  loadByConsumer,
  DEFAULT_BWWP_KWH,
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

  it("is space-heating only: near-zero in the summer (Jun–Aug)", () => {
    // Hot water is modelled separately (BWWP or WP fallback), so the pure
    // space-heating profile must produce almost nothing in high summer.
    const l = heatpumpLoad(5000);
    const summer = sumOverMonths(l, [6, 7, 8]);
    expect(summer).toBeLessThan(5000 * 0.03); // < 3% of the annual heating energy
  });

  it("is night-heavy", () => {
    const l = heatpumpLoad(5000);
    const night = sumOverHours(l, [23, 0, 1, 2, 3, 4]);
    const mid = sumOverHours(l, [11, 12, 13, 14]);
    expect(night).toBeGreaterThan(mid);
  });

  it("peaks in the cold early-morning hours and troughs around midday", () => {
    // Heat demand tracks the outdoor-temperature deficit: highest in the cold
    // early morning (~03:00–05:00), lowest around midday (solar + internal
    // gains). This guards against the old inverted profile that dipped at
    // 07:00–08:00 (the coldest, highest-demand hours).
    const l = heatpumpLoad(5000);
    const hourly = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) hourly[h] = sumOverHours(l, [h]);
    let peakH = 0;
    let minH = 0;
    for (let h = 0; h < 24; h++) {
      if (hourly[h] > hourly[peakH]) peakH = h;
      if (hourly[h] < hourly[minH]) minH = h;
    }
    expect(peakH).toBeGreaterThanOrEqual(0);
    expect(peakH).toBeLessThanOrEqual(5); // peak in the cold early-morning band
    expect(minH).toBeGreaterThanOrEqual(10);
    expect(minH).toBeLessThanOrEqual(14); // trough around midday
    // Early-morning demand must exceed the previously-buggy 07:00–08:00 dip.
    expect(sumOverHours(l, [4])).toBeGreaterThan(sumOverHours(l, [8]));
  });
});

describe("bwwpLoad", () => {
  it("delivers ~40 kWh per month clustered at solar noon", () => {
    const l = bwwpLoad(480);
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

  it("runs entirely inside the 11:00–15:00 midday PV window", () => {
    const l = bwwpLoad(480);
    // Energy only in hours 11,12,13,14; nothing outside that window.
    for (const h of [11, 12, 13, 14]) expect(sumOverHours(l, [h])).toBeGreaterThan(0);
    for (const h of [0, 3, 7, 9, 10, 15, 16, 18, 20, 23]) expect(sumOverHours(l, [h])).toBe(0);
    // The four in-window hours carry (almost) all of the daily energy evenly.
    const windowKWh = sumOverHours(l, [11, 12, 13, 14]);
    expect(windowKWh).toBeCloseTo(annualSum(l), 6);
  });

  it("totals about 480 kWh/year", () => {
    const sum = annualSum(bwwpLoad(480));
    expect(sum).toBeGreaterThan(450);
    expect(sum).toBeLessThan(510);
  });

  it("scales with the requested annual demand", () => {
    expect(annualSum(bwwpLoad(300))).toBeCloseTo(300, 0);
    expect(annualSum(bwwpLoad(800))).toBeCloseTo(800, 0);
  });
});

describe("hot-water switch: BWWP vs. heat-pump fallback", () => {
  const baseHP = 5000; // pure space-heating electricity
  const hw = 480; // hot-water electricity

  const withBwwp: ConsumerConfig = {
    household: { enabled: false, annualKWh: 0 },
    heatpump: { enabled: true, annualKWh: baseHP },
    bwwp: { enabled: true, annualKWh: hw },
    ev: { enabled: false, annualKWh: 0, pvShare: 0 },
  };
  const withoutBwwp: ConsumerConfig = {
    ...withBwwp,
    bwwp: { enabled: false, annualKWh: hw },
  };

  it("total load is identical whether hot water is served by the BWWP or the WP", () => {
    const a = annualSum(totalLoad(withBwwp));
    const b = annualSum(totalLoad(withoutBwwp));
    expect(a).toBeCloseTo(baseHP + hw, 0);
    expect(b).toBeCloseTo(baseHP + hw, 0);
    expect(a).toBeCloseTo(b, 1);
  });

  it("with BWWP: the WP carries only space heating, the BWWP carries the hot water", () => {
    const loads = loadByConsumer(withBwwp);
    expect(annualSum(loads.heatpump)).toBeCloseTo(baseHP, 0);
    expect(annualSum(loads.bwwp)).toBeCloseTo(hw, 0);
  });

  it("without BWWP: the WP absorbs the hot water (consumes more), BWWP is zero", () => {
    const loads = loadByConsumer(withoutBwwp);
    expect(annualSum(loads.heatpump)).toBeCloseTo(baseHP + hw, 0);
    expect(annualSum(loads.bwwp)).toBe(0);
  });

  it("the WP fallback puts hot water in the night/early-morning hours, not the midday PV block", () => {
    const bwwpMidday = sumOverHours(bwwpLoad(hw), [11, 12, 13, 14]);
    expect(bwwpMidday).toBeCloseTo(hw, 0); // BWWP is all midday
    const wpHW = heatpumpHotWaterLoad(hw);
    const wpMidday = sumOverHours(wpHW, [11, 12, 13, 14]);
    // The WP hot-water fallback is night-heavy, so far less lands at midday.
    expect(wpMidday).toBeLessThan(hw * 0.3);
  });

  it("DEFAULT_BWWP_KWH is 480", () => {
    expect(DEFAULT_BWWP_KWH).toBe(480);
  });
});

describe("evLoad", () => {
  it("scales to the requested annual demand", () => {
    const sum = annualSum(evLoad(2000, 0.8));
    expect(sum).toBeGreaterThan(2000 * 0.98);
    expect(sum).toBeLessThan(2000 * 1.02);
  });

  it("shifts load toward midday as pvShare increases, and to the cheap night window otherwise", () => {
    const low = evLoad(2000, 0.0);
    const high = evLoad(2000, 1.0);
    const midday = [10, 11, 12, 13, 14];
    const night = [0, 1, 2, 3, 4];
    const evening = [19, 20, 21];
    // More PV share ⇒ more midday charging.
    expect(sumOverHours(high, midday)).toBeGreaterThan(sumOverHours(low, midday));
    // Less PV share ⇒ more overnight charging (cheap hours), not evening.
    expect(sumOverHours(low, night)).toBeGreaterThan(sumOverHours(high, night));
    // With no PV share everything is charged at night; nothing in the evening peak.
    expect(sumOverHours(low, night)).toBeCloseTo(2000, 0);
    expect(sumOverHours(low, evening)).toBe(0);
    // With full PV share everything is charged at midday.
    expect(sumOverHours(high, midday)).toBeCloseTo(2000, 0);
  });
});

describe("totalLoad", () => {
  it("sums the enabled consumers", () => {
    const cfg: ConsumerConfig = {
      household: { enabled: true, annualKWh: 2400 },
      heatpump: { enabled: true, annualKWh: 6500 },
      bwwp: { enabled: true },
      ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
    };
    const total = annualSum(totalLoad(cfg));
    const parts =
      annualSum(householdLoad(2400)) +
      annualSum(heatpumpLoad(6500)) +
      annualSum(bwwpLoad(480)) +
      annualSum(evLoad(2000, 0.8));
    expect(total).toBeCloseTo(parts, 1);
    expect(total).toBeCloseTo(2400 + 6500 + 480 + 2000, 0);
  });

  it("is empty when nothing is enabled", () => {
    expect(annualSum(totalLoad(noConsumers))).toBe(0);
  });
});

// Sanity: array length is exactly one year.
expect(TOTAL_STEPS).toBe(365 * STEPS_PER_DAY);
