// Peak-price discharge: *which* hours the battery releases into.
//
// The "windows" strategy schedules the discharge inside the morning/evening
// clock ranges a household lives by. The "peak" strategy drops the clock
// entirely: every day it ranks the 24 hours by spot price and releases into the
// `N = capacityKWh / maxPowerKW` most expensive ones — 40 kWh at 14.5 kW is
// 2.76 h, i.e. the time the battery needs to hand back its whole capacity at
// full power. These tests pin that window down hour by hour with a synthetic
// price series, then check that a real June day behaves the same way and that
// the resulting dispatch still satisfies every energy invariant.

import { describe, it, expect } from "vitest";
import { simulate, computeDispatchFlags, peakDischargeHours } from "../src/calc/simulation";
import { simParamsFromQuery, runSimulation, DEFAULT_SIM_PARAMS } from "../src/calc/report";
import {
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  TOTAL_STEPS,
  SimConfig,
  BatteryConfig,
} from "../src/calc/types";
import { getYearPrices } from "../src/calc/priceData";
import { totalLoad } from "../src/calc/consumers";
import { parseDischargeMode } from "../src/calc/types";

/** Injected surplus energy per HOUR, identical on every day of the year. */
function surplusSeries(byHour: Record<number, number>): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  const perStep = (kwh: number) => kwh / STEPS_PER_HOUR;
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    for (const [h, kwh] of Object.entries(byHour)) {
      const hour = Number(h);
      for (let k = 0; k < STEPS_PER_HOUR; k++) {
        out[d * STEPS_PER_DAY + hour * STEPS_PER_HOUR + k] = perStep(kwh);
      }
    }
  }
  return out;
}

/** Flat hourly price profile, identical on every day. */
function priceSeries(byHour: Record<number, number>, fallback = 50): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < STEPS_PER_HOUR; k++) {
        out[d * STEPS_PER_DAY + h * STEPS_PER_HOUR + k] = byHour[h] ?? fallback;
      }
    }
  }
  return out;
}

/** Mean spot price of every hour of a day — the ranking the planner uses. */
function hourlyMeans(prices: Float64Array, day: number): number[] {
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    let sum = 0;
    for (let k = 0; k < STEPS_PER_HOUR; k++) sum += prices[day * STEPS_PER_DAY + h * STEPS_PER_HOUR + k];
    out.push(sum / STEPS_PER_HOUR);
  }
  return out;
}

/**
 * Contiguous runs of the discharge flag on one day, as `[start, end)` hour
 * ranges. Quarter-hours are exact (`20.75` = 20:00–20:45), so a truncated hour
 * is never mistaken for a whole one.
 */
function dischargeRuns(flags: Uint8Array, day: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let k = 0; k <= STEPS_PER_DAY; k++) {
    const on = k < STEPS_PER_DAY && flags[day * STEPS_PER_DAY + k] === 1;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      runs.push([start / STEPS_PER_HOUR, k / STEPS_PER_HOUR]);
      start = -1;
    }
  }
  return runs;
}

function flaggedSteps(flags: Uint8Array, day: number): number {
  let n = 0;
  for (let k = 0; k < STEPS_PER_DAY; k++) n += flags[day * STEPS_PER_DAY + k];
  return n;
}

const BATTERY: BatteryConfig = {
  capacityKWh: 40,
  maxPowerKW: 14.5,
  minSOC: 0.1,
  maxSOC: 0.95,
  efficiency: 0.95,
  startSOC: 0.1,
  chargeMode: "cheapest",
  dischargeMode: "peak",
  dischargeEvening: false,
  dischargeMorning: false,
  eveningStart: 17,
  eveningEnd: 23,
  morningStart: 5,
  morningEnd: 12,
};

/** Merchant plant: no local load, so the injected `wind` is all the energy. */
function cfg(over: Partial<SimConfig> = {}, batteryOver: Partial<BatteryConfig> = {}): SimConfig {
  return {
    pv: { peakKWp: 0, tiltDeg: 35, orientation: "south", location: "hamburg" },
    battery: { ...BATTERY, ...batteryOver },
    tariff: { feedInEUR: 0.06, commissioningYear: 2025 },
    load: new Float64Array(TOTAL_STEPS),
    ...over,
  };
}

describe("peakDischargeHours", () => {
  it("is the capacity divided by the maximum power", () => {
    expect(peakDischargeHours(BATTERY)).toBeCloseTo(40 / 14.5, 9);
    expect(peakDischargeHours({ ...BATTERY, capacityKWh: 10, maxPowerKW: 5 })).toBeCloseTo(2, 9);
  });

  it("is the whole capacity, not just the usable SOC window", () => {
    // (maxSOC − minSOC) × capacity would be 2.48 h here; the window is sized on
    // the nominal 40 kWh so a never-fully-charged battery still opens a window
    // it can use. The SOC window itself is enforced by the step loop.
    expect(peakDischargeHours(BATTERY)).not.toBeCloseTo((0.95 - 0.1) * 40 / 14.5, 3);
  });

  it("never collapses below one quarter hour or grows beyond a day", () => {
    // 1 kWh at 20 kW would be 3 minutes — clamped up to one quarter hour.
    expect(peakDischargeHours({ ...BATTERY, capacityKWh: 1, maxPowerKW: 20 })).toBeCloseTo(0.25, 9);
    expect(peakDischargeHours({ ...BATTERY, capacityKWh: 40, maxPowerKW: 0 })).toBe(24);
  });

  it("is zero without a usable battery", () => {
    expect(peakDischargeHours({ ...BATTERY, capacityKWh: 0 })).toBe(0);
    expect(peakDischargeHours({ ...BATTERY, maxSOC: 0.1, minSOC: 0.1 })).toBe(0);
  });
});

describe("parseDischargeMode", () => {
  it("accepts the two known strategies", () => {
    expect(parseDischargeMode("peak", "windows")).toBe("peak");
    expect(parseDischargeMode("windows", "peak")).toBe("windows");
  });

  it("falls back for unknown, empty and missing values (old links keep working)", () => {
    expect(parseDischargeMode("nonsense", "windows")).toBe("windows");
    expect(parseDischargeMode("", "peak")).toBe("peak");
    expect(parseDischargeMode(null, "windows")).toBe("windows");
    expect(parseDischargeMode(undefined, "peak")).toBe("peak");
  });
});

describe("peak window = the N most expensive hours of the day", () => {
  // Surplus 10:00–15:00, prices peak at 19:00 — far outside any plausible
  // evening window of an "evening 17–23" habit, and with a morning spike at
  // 07:00 that a "morning 5–12" habit would have picked.
  const surplus = surplusSeries({ 10: 20, 11: 20, 12: 20, 13: 20, 14: 20, 15: 20 });
  const prices = priceSeries({
    5: 40, 6: 40, 7: 110, 8: 40, 9: 40, 10: 20, 11: 10, 12: 15, 13: 20, 14: 30, 15: 45,
    17: 50, 18: 60, 19: 150, 20: 90, 21: 55,
  });
  // 40 kWh / 14.5 kW = 2.759 h → 11 quarter-hours.
  const N_STEPS = 11;

  // Without a generation series the planner has no basis for a feasibility
  // guard, so `plan` is a pure price ranking. The hours the battery cannot
  // physically serve yet are covered separately below.
  const plan = () => computeDispatchFlags(BATTERY, prices, undefined);
  const planWithGeneration = () => computeDispatchFlags(BATTERY, prices, undefined, surplus);

  it("marks exactly N = capacity / maxPower quarter-hours", () => {
    const flags = plan();
    for (const day of [0, 40, 200, 364]) expect(flaggedSteps(flags.discharge, day)).toBe(N_STEPS);
  });

  it("picks the globally most expensive hours, not the ones inside a clock window", () => {
    // Ranking: 19:00 (150) > 07:00 (110) > 20:00 (90) > 18:00 (60) …
    // 11 steps = two full hours plus the first quarter of the third.
    expect(dischargeRuns(plan().discharge, 0)).toEqual([[7, 8], [19, 20.75]]);
    // The third (90 €/MWh at 20:00) hour is truncated at three quarter-hours.
    const flags = plan();
    for (let k = 0; k < 3; k++) expect(flags.discharge[20 * STEPS_PER_HOUR + k]).toBe(1);
    expect(flags.discharge[20 * STEPS_PER_HOUR + 3]).toBe(0);
    expect(flaggedSteps(flags.discharge, 0)).toBe(N_STEPS);
  });

  it("ignores the morning/evening clock settings entirely", () => {
    const shifted = computeDispatchFlags(
      { ...BATTERY, dischargeEvening: true, dischargeMorning: true, eveningStart: 12, eveningEnd: 14, morningStart: 8, morningEnd: 9 },
      prices,
      undefined,
    );
    expect(dischargeRuns(shifted.discharge, 0)).toEqual([[7, 8], [19, 20.75]]);
  });

  it("is a per-day plan, not one global window", () => {
    // Day 0 and day 40 have identical profiles; day 200 has a different peak.
    const shifted = new Float64Array(prices);
    for (let k = 0; k < STEPS_PER_DAY; k++) {
      shifted[200 * STEPS_PER_DAY + 3 * STEPS_PER_HOUR + k] = 400; // a 03:00 spike
    }
    const flags = computeDispatchFlags(BATTERY, shifted);
    expect(dischargeRuns(flags.discharge, 0)).toEqual([[7, 8], [19, 20.75]]);
    // On day 200 the 03:00 spike (400) pushes the old top hours out: 03:00 in
    // full, 19:00 in full and only three quarters of 07:00.
    expect(dischargeRuns(flags.discharge, 200)).toEqual([[3, 5.75]]);
  });

  it("never releases energy into a negative-price hour", () => {
    // Make the two most expensive hours of the day negative: a battery that is
    // paid to consume must be charging there, not discharging.
    const negative = priceSeries({ 3: -300, 4: -200, 19: 150, 20: 90 }, -10);
    const flags = computeDispatchFlags(BATTERY, negative);
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i]) expect(negative[i]).toBeGreaterThan(0);
    }
    // 03:00/04:00 are out and nothing else is worth discharging into, so the
    // window is simply shorter than N rather than padded with junk hours.
    expect(dischargeRuns(flags.discharge, 0)).toEqual([[19, 21]]);
    expect(flaggedSteps(flags.discharge, 0)).toBe(8);
  });

  it("breaks price ties towards the earlier hour so the plan is deterministic", () => {
    const tied = priceSeries({ 19: 150, 20: 150, 21: 150, 22: 150 }, -10);
    const flags = computeDispatchFlags(BATTERY, tied);
    expect(dischargeRuns(flags.discharge, 0)).toEqual([[19, 21.75]]);
  });

  it("grows the window with a bigger battery / weaker inverter", () => {
    const big = computeDispatchFlags({ ...BATTERY, capacityKWh: 400, maxPowerKW: 50 }, prices);
    // 400/50 = 8 h → 32 steps.
    expect(flaggedSteps(big.discharge, 0)).toBe(32);
    // …and shrinks with a smaller one: 5 kWh at 5 kW = exactly one hour.
    const small = computeDispatchFlags({ ...BATTERY, capacityKWh: 5, maxPowerKW: 5 }, prices);
    expect(flaggedSteps(small.discharge, 0)).toBe(4);
    expect(dischargeRuns(small.discharge, 0)).toEqual([[19, 20]]);
  });

  it("does not spend the window budget on hours before the battery holds anything", () => {
    // The battery is empty at 04:00 (its own surplus only starts at 10:00), so
    // the priciest hour of the day must not swallow the window the 19:00 peak
    // needs — and the leftover budget must not be spent on junk hours either.
    const cheapAtNight = priceSeries({ 4: 95, 19: 90, 20: 60 }, -10);
    const flags = computeDispatchFlags(BATTERY, cheapAtNight, undefined, surplus);
    expect(dischargeRuns(flags.discharge, 0)).toEqual([[19, 21]]);
    // Without a generation series there is nothing to be clever about, so the
    // plan stays a pure price ranking and takes 04:00 as well.
    const noTrace = computeDispatchFlags(BATTERY, cheapAtNight);
    expect(dischargeRuns(noTrace.discharge, 0)).toEqual([[4, 5], [19, 20.75]]);
  });

  it("also treats a free grid-charging hour as the start of the battery's day", () => {
    // 04:00 is negative, so a `gridNegative` battery may fill up for free then.
    const trough = priceSeries({ 4: -95, 5: 80, 19: 90, 20: 60 }, -10);
    const gridCharged = computeDispatchFlags(
      { ...BATTERY, chargeMode: "gridNegative" },
      trough,
      undefined,
      new Float64Array(TOTAL_STEPS),
    );
    // 05:00 is now reachable and takes the second slot (80 €/MWh), pushing the
    // 20:00 hour (60 €/MWh) down to a truncated quarter.
    expect(dischargeRuns(gridCharged.discharge, 0)).toEqual([[5, 6], [19, 20.75]]);
    // Without the free charging the battery has nothing before its own 10:00
    // surplus, so 05:00 drops out again.
    const ownOnly = computeDispatchFlags(BATTERY, trough, undefined, surplus);
    expect(dischargeRuns(ownOnly.discharge, 0)).toEqual([[19, 21]]);
  });

  it("flags merchant hours only where the site has no load of its own", () => {
    const load = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) load[i] = 0.01;
    for (let k = 0; k < STEPS_PER_HOUR; k++) load[19 * STEPS_PER_HOUR + k] = 0; // load-free peak hour
    const flags = computeDispatchFlags(BATTERY, prices, load);
    expect(flags.merchant[19 * STEPS_PER_HOUR]).toBe(1);
    expect(flags.merchant[7 * STEPS_PER_HOUR]).toBe(0);
    expect(flags.merchant[20 * STEPS_PER_HOUR]).toBe(0);
  });

  it("never reserves a charge hour inside the discharge window", () => {
    const flags = planWithGeneration();
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i]) expect(flags.charge[i]).toBe(0);
    }
  });

  it("sells the stored energy into the window on a load-free merchant plant", () => {
    // Same flat profile, but now nothing competes for the energy, so the
    // battery may actually sell — and it may only do so inside the window.
    const battery = { ...BATTERY, startSOC: 0.5, maxSOC: 0.95 };
    const flags = computeDispatchFlags(battery, prices, new Float64Array(TOTAL_STEPS), surplus);
    const r = simulate(cfg({ wind: surplus, prices }, { startSOC: 0.5 }));
    let sold = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.exportBattery[i] <= 0) continue;
      expect(flags.discharge[i]).toBe(1);
      expect(flags.merchant[i]).toBe(1);
      sold += r.exportBattery[i];
    }
    expect(sold).toBeGreaterThan(0);
  });

  it("leaves the whole plan empty without a battery", () => {
    const flags = computeDispatchFlags({ ...BATTERY, capacityKWh: 0 }, prices, undefined, surplus);
    expect(flaggedSteps(flags.discharge, 0)).toBe(0);
    expect(flaggedSteps(flags.charge, 0)).toBe(0);
  });
});

describe("peak dispatch on a real June day", () => {
  // The URL scenario: 50 kWp south-facing in Boizenburg, 40 kWh / 14.5 kW
  // battery, price-ranked charging, market export.
  const prices = getYearPrices("2025")!;
  const load = totalLoad({
    household: { enabled: true, annualKWh: 2400 },
    heatpump: { enabled: false, annualKWh: 5000 },
    bwwp: { enabled: false, annualKWh: 480 },
    ev: { enabled: false, annualKWh: 2000, pvShare: 0.8 },
  });
  const battery: BatteryConfig = {
    capacityKWh: 40,
    maxPowerKW: 14.5,
    minSOC: 0.1,
    maxSOC: 1,
    efficiency: 0.95,
    startSOC: 0.5,
    chargeMode: "cheapest",
    dischargeMode: "peak",
    dischargeEvening: true,
    dischargeMorning: true,
    eveningStart: 17,
    eveningEnd: 23,
    morningStart: 5,
    morningEnd: 12,
  };
  const sim = (over: Partial<BatteryConfig> = {}): SimConfig => ({
    pv: { peakKWp: 50, tiltDeg: 25, orientation: "south", location: "boizenburg" },
    battery: { ...battery, ...over },
    tariff: { feedInEUR: 0.06836, commissioningYear: 2025 },
    prices,
    load,
  });

  // 15 June — day 0 is 1 January, so 15 June is day 165.
  const JUNE = 165;

  it("targets the most expensive hours of that day, wherever they fall", () => {
    const flags = computeDispatchFlags(battery, prices, load);
    // Rank the day independently: 19:00 is the priciest hour (127 EUR/MWh),
    // 18:00 the second (112) and 07:00 the third (102) — an evening peak that
    // the "morning 05-12" habit would have missed completely.
    const ranked = hourlyMeans(prices, JUNE)
      .map((p, h) => ({ h, p }))
      .sort((a, b) => b.p - a.p || a.h - b.h);
    expect(ranked.slice(0, 3).map((x) => x.h)).toEqual([19, 18, 7]);

    // 11 quarter-hours = 18:00 and 19:00 in full plus three quarters of 07:00.
    expect(dischargeRuns(flags.discharge, JUNE)).toEqual([[7, 7.75], [18, 20]]);
    expect(flaggedSteps(flags.discharge, JUNE)).toBe(11);
    // Nothing outside the day's three most expensive hours is ever scheduled.
    for (const [start] of dischargeRuns(flags.discharge, JUNE)) {
      expect([7, 18, 19]).toContain(start);
    }
  });

  it("keeps the same plan when the generation trace is available", () => {
    // `simulate` also passes the generation series, which lets the planner skip
    // hours the battery cannot hold anything for yet. On 15 June the surplus
    // starts long before 07:00, so the two plans coincide.
    const withTrace = computeDispatchFlags(battery, prices, load, undefined);
    expect(dischargeRuns(withTrace.discharge, JUNE)).toEqual([[7, 7.75], [18, 20]]);
  });

  it("realises a higher average sale price than the fixed evening window", () => {
    const avgSalePrice = (r: ReturnType<typeof simulate>): number => {
      let kWh = 0;
      let eur = 0;
      for (let i = 0; i < TOTAL_STEPS; i++) {
        kWh += r.exportBattery[i];
        eur += r.exportBattery[i] * prices[i];
      }
      return kWh > 0 ? eur / kWh : 0;
    };
    const peak = simulate(sim({ dischargeMode: "peak" }));
    const windows = simulate(sim({ dischargeMode: "windows" }));
    expect(avgSalePrice(peak)).toBeGreaterThan(avgSalePrice(windows));
  });

  it("keeps every physical invariant the dispatcher promises", () => {
    const r = simulate(sim());
    const maxSOC = battery.maxSOC * battery.capacityKWh;
    const minSOC = battery.minSOC * battery.capacityKWh;
    let sold = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      expect(r.soc[i]).toBeGreaterThanOrEqual(minSOC - 1e-9);
      expect(r.soc[i]).toBeLessThanOrEqual(maxSOC + 1e-9);
      // Never charge and discharge in the same quarter hour.
      const charging = r.chargeSolar[i] + r.chargeWind[i] + r.chargeGrid[i];
      const discharging = r.dischargeToLoad[i] + r.exportBattery[i];
      expect(charging === 0 || discharging === 0).toBe(true);
      // Every step is balanced.
      expect(r.load[i]).toBeCloseTo(r.directUse[i] + r.directUseWind[i] + r.dischargeToLoad[i] + r.gridImport[i], 9);
      if (prices[i] >= 0) {
        expect(r.pv[i]).toBeCloseTo(r.directUse[i] + r.chargeSolar[i] + r.exportSolar[i], 9);
      }
      if (r.exportBattery[i] > 0) expect(prices[i]).toBeGreaterThanOrEqual(0);
      sold += r.exportBattery[i];
    }
    expect(sold).toBeGreaterThan(0);
  });

  it("reproduces through the URL the app is opened with", () => {
    const qs =
      "expert=1&kwp=50&tilt=25&o=south&loc=boizenburg&cap=40&pwr=14.5&minsoc=0.1&maxsoc=1" +
      "&eff=0.95&soc0=0.5&charge=cheapest&dsp=peak&de=1&dm=1&evs=17&eve=23&mns=5&mne=12" +
      "&fi=6.836&yr=2025&py=2025&hh=1&hk=2400&wp=0&ev=0&ex=market&im=fixed&ict=24&inv=32000";
    const p = simParamsFromQuery(new URLSearchParams(qs));
    expect(p.dischargeMode).toBe("peak");
    const report = runSimulation(p);
    expect(report.inputs.capacityKWh).toBe(40);
    expect(Number.isFinite(report.summary.netSelectedEUR)).toBe(true);
  });

  it("defaults to the clock windows when the URL says nothing", () => {
    expect(simParamsFromQuery(new URLSearchParams("")).dischargeMode).toBe("windows");
    expect(DEFAULT_SIM_PARAMS.dischargeMode).toBe("windows");
  });

  it("survives the app's own share-link round trip", async () => {
    const { serializeState, deserializeState } = await import("../src/ui/url");
    const { DEFAULT_STATE, toSimConfig, toSimParams } = await import("../src/ui/state");
    const qs = serializeState({ ...DEFAULT_STATE, dischargeMode: "peak", expertMode: true });
    expect(qs).toContain("dsp=peak");
    const restored = deserializeState(qs);
    expect(restored.dischargeMode).toBe("peak");
    expect(toSimConfig(restored).battery.dischargeMode).toBe("peak");
    expect(toSimParams(restored).dischargeMode).toBe("peak");
    // The default share link keeps the old behaviour.
    expect(deserializeState(serializeState(DEFAULT_STATE)).dischargeMode).toBe("windows");
    // …and the simple (non-expert) view always uses the clock windows, however
    // the link was written.
    expect(toSimParams({ ...DEFAULT_STATE, expertMode: false, dischargeMode: "peak" }).dischargeMode)
      .toBe("windows");
  });
});
