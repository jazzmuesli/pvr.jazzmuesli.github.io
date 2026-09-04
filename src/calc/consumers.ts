// Consumer load profiles (kWh per 15-minute step).
//
// All profiles are deterministic (no RNG) so the simulation is fully
// reproducible and unit-testable. Shapes are grounded in:
//  - BDEW standard load profile H0 for a typical household,
//  - typical heat-pump seasonality (winter-heavy, night-heavy),
//  - the user's Brauchwasserwärmepumpe spec (~40 kWh/month, midday, ~0.6 kW),
//  - the user's wallbox data (charging mostly 08:00–12:00 on sunny days).

import { STEPS_PER_DAY, TOTAL_STEPS, STEPS_PER_HOUR, monthOfStep, hourOfStep } from "./types";

export interface HouseholdConfig {
  enabled: boolean;
  /** Annual household consumption in kWh (1000–2500 typical for a home). */
  annualKWh: number;
}

export interface HeatPumpConfig {
  enabled: boolean;
  /** Annual heat-pump consumption in kWh (1000–5000). */
  annualKWh: number;
}

export interface BwwpConfig {
  enabled: boolean;
  /** Annual hot-water electricity demand in kWh (default 480 ≈ 40 kWh/month).
   *  When the BWWP is enabled this energy is served by the dedicated BWWP
   *  (midday PV block). When it is disabled, the same energy is instead added
   *  to the space-heating heat pump (year-round hot-water load), so the total
   *  hot-water demand is identical either way — only *who* serves it changes.
   *  Optional so existing callers keep working; falls back to DEFAULT_BWWP_KWH. */
  annualKWh?: number;
}

/** Default annual hot-water electricity demand for the BWWP (≈ 40 kWh/month). */
export const DEFAULT_BWWP_KWH = 480;

export interface EvConfig {
  enabled: boolean;
  /** Annual EV charging demand in kWh (500–5000). */
  annualKWh: number;
  /** Fraction (0..1) charged during sunny midday hours vs a fixed window. */
  pvShare: number;
}

export interface ConsumerConfig {
  household: HouseholdConfig;
  heatpump: HeatPumpConfig;
  bwwp: BwwpConfig;
  ev: EvConfig;
}

// ---------------------------------------------------------------------------
// Normalized 24-hour shapes (mean = 1 over the day).
// ---------------------------------------------------------------------------

// BDEW H0 household: morning (07–09) and evening (17–21) peaks, low at night.
const H0_HOURLY = [
  0.62, 0.55, 0.5, 0.48, 0.5, 0.62, 1.0, 1.6, 1.42, 1.02, 0.9, 0.86, 0.9, 0.85,
  0.85, 0.9, 1.0, 1.22, 1.5, 1.7, 1.6, 1.4, 1.1, 0.82,
];

// Heat pump: heat demand tracks the outdoor-temperature deficit, which is
// largest in the cold early-morning hours (roughly 03:00–08:00) and smallest
// around midday (solar + internal gains). Weather-compensated controls
// therefore run the pump hardest overnight and in the early morning and back
// off around noon. This shape keeps the night/early-morning emphasis (buffer
// charging on cheap night tariffs) while making the coldest morning hours the
// peak of demand rather than a dip.
const HP_HOURLY = [
  1.35, 1.4, 1.45, 1.5, 1.5, 1.45, 1.35, 1.2, 1.0, 0.85, 0.78, 0.72, 0.7, 0.7,
  0.72, 0.78, 0.88, 1.0, 1.1, 1.18, 1.22, 1.28, 1.32, 1.35,
];

// ---------------------------------------------------------------------------
// Normalized monthly weights (mean = 1 over the year).
// ---------------------------------------------------------------------------

// H0: winter higher (lighting/heating), summer lower.
const H0_MONTHLY = [
  1.15, 1.12, 1.05, 0.98, 0.92, 0.88, 0.9, 0.9, 0.95, 1.02, 1.08, 1.14,
];

// Heat pump: space-heating only (Raumheizung). Strongly winter-heavy with a
// near-zero summer, because domestic hot water is modelled separately (either
// by the dedicated BWWP or, when that is disabled, added back as a year-round
// hot-water load — see `HW_MONTHLY`). June–August are essentially zero: no
// space heating is needed in a German summer.
const HP_MONTHLY = [
  2.15, 2.0, 1.55, 0.85, 0.25, 0.02, 0.0, 0.0, 0.15, 0.9, 1.55, 2.05,
];

// Hot water (Warmwasser): a roughly flat year-round demand with a mild winter
// bias (colder inlet water needs more energy). Mean ≈ 1 so the annual total
// equals the requested kWh. Used both for the BWWP and for the WP fallback
// when the BWWP is disabled.
const HW_MONTHLY = [
  1.15, 1.12, 1.08, 1.0, 0.95, 0.9, 0.85, 0.85, 0.92, 1.0, 1.08, 1.12,
];

function normalizeMean(arr: number[]): number[] {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.map((v) => v / mean);
}

// Days per month for the simulated (non-leap) year. Used to day-weight the
// monthly profiles so the calendar-weighted mean is 1 and the annual total
// equals the requested consumption exactly (winter months are longer).
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const YEAR_DAYS = DAYS_IN_MONTH.reduce((a, b) => a + b, 0);

function normalizeDayWeighted(arr: number[]): number[] {
  let wsum = 0;
  for (let m = 0; m < 12; m++) wsum += DAYS_IN_MONTH[m] * arr[m];
  const wmean = wsum / YEAR_DAYS;
  return arr.map((v) => v / wmean);
}

const H0_HOURLY_N = normalizeMean(H0_HOURLY);
const HP_HOURLY_N = normalizeMean(HP_HOURLY);
const H0_MONTHLY_N = normalizeDayWeighted(H0_MONTHLY);
const HP_MONTHLY_N = normalizeDayWeighted(HP_MONTHLY);
const HW_MONTHLY_N = normalizeDayWeighted(HW_MONTHLY);

/** Typical household load (kWh/step), scaled to `annualKWh`. */
export function householdLoad(annualKWh: number): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (annualKWh <= 0) return out;
  const perStepYear = annualKWh / TOTAL_STEPS;
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const m = monthOfStep(i);
    const h = hourOfStep(i);
    out[i] = perStepYear * H0_MONTHLY_N[m - 1] * H0_HOURLY_N[h];
  }
  return out;
}

/** Heat-pump load (kWh/step), scaled to `annualKWh`, winter- and night-heavy. */
export function heatpumpLoad(annualKWh: number): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (annualKWh <= 0) return out;
  const perStepYear = annualKWh / TOTAL_STEPS;
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const m = monthOfStep(i);
    const h = hourOfStep(i);
    out[i] = perStepYear * HP_MONTHLY_N[m - 1] * HP_HOURLY_N[h];
  }
  return out;
}

/**
 * Brauchwasserwärmepumpe (domestic-hot-water heat pump) load (kWh/step).
 * The requested `annualKWh` (default 480 ≈ 40 kWh/month) is run entirely
 * inside the midday PV window 11:00–15:00 so the hot-water tank is heated
 * mostly from the owner's own solar. Spread evenly over the 4 h block, with a
 * mild seasonal weighting (colder inlet water in winter).
 */
export function bwwpLoad(annualKWh: number): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (annualKWh <= 0) return out;
  const blockHours = 4; // 11:00–15:00
  const startStep = 11 * STEPS_PER_HOUR;
  const blockSteps = blockHours * STEPS_PER_HOUR;
  // Per-day base energy, seasonally weighted so the annual total matches.
  const perDayBase = annualKWh / YEAR_DAYS;
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    const m = monthOfStep(dayStart);
    const dailyKWh = perDayBase * HW_MONTHLY_N[m - 1];
    const perStepKWh = dailyKWh / blockSteps;
    for (let k = 0; k < blockSteps; k++) {
      const idx = dayStart + startStep + k;
      if (idx < TOTAL_STEPS) out[idx] = perStepKWh;
    }
  }
  return out;
}

/**
 * Hot-water load served by the *space-heating heat pump* when there is no
 * dedicated BWWP. Same annual energy and seasonal shape as `bwwpLoad`, but
 * distributed over the heat pump's hourly profile (night/early-morning heavy)
 * instead of the midday PV block — so, unlike the BWWP, it is NOT
 * conveniently placed in the sun and draws far more from the grid.
 */
export function heatpumpHotWaterLoad(annualKWh: number): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (annualKWh <= 0) return out;
  const perStepYear = annualKWh / TOTAL_STEPS;
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const m = monthOfStep(i);
    const h = hourOfStep(i);
    out[i] = perStepYear * HW_MONTHLY_N[m - 1] * HP_HOURLY_N[h];
  }
  return out;
}

/**
 * Electric-vehicle load (kWh/step).
 * The owner charges either when the sun is up (midday) or, when it isn't, at
 * night on the cheap tariff:
 *  - `pvShare` of the daily demand is placed in the sunny midday window
 *    (10:00–15:00) so PV can cover it directly.
 *  - the remaining `1 − pvShare` is charged overnight (00:00–05:00), the
 *    cheapest hours (low spot / § 14a night tariff) — NOT in the evening peak.
 * The dispatch later decides whether PV, battery or grid actually serves it.
 */
export function evLoad(annualKWh: number, pvShare: number): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (annualKWh <= 0) return out;
  const share = Math.max(0, Math.min(1, pvShare));
  const dailyKWh = annualKWh / 365;
  const middaySteps = 5 * STEPS_PER_HOUR; // 10:00–15:00 = 5 h (PV window)
  const nightSteps = 5 * STEPS_PER_HOUR; // 00:00–05:00 = 5 h (cheap night window)
  const middayStart = 10 * STEPS_PER_HOUR;
  const nightStart = 0 * STEPS_PER_HOUR;
  const middayPerStep = (dailyKWh * share) / middaySteps;
  const nightPerStep = (dailyKWh * (1 - share)) / nightSteps;
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    for (let k = 0; k < middaySteps; k++) out[dayStart + middayStart + k] += middayPerStep;
    for (let k = 0; k < nightSteps; k++) out[dayStart + nightStart + k] += nightPerStep;
  }
  return out;
}

/** Sum of all enabled consumer profiles (kWh/step). */
export function totalLoad(cfg: ConsumerConfig): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (cfg.household.enabled) addInto(out, householdLoad(cfg.household.annualKWh));
  if (cfg.heatpump.enabled) addInto(out, heatpumpLoad(cfg.heatpump.annualKWh));
  // Hot water: served by the BWWP when enabled, otherwise by the space-heating
  // heat pump (only if that heat pump exists). The energy is the same either
  // way — just placed in a different daily window.
  if (cfg.bwwp.enabled) {
    addInto(out, bwwpLoad(cfg.bwwp.annualKWh ?? DEFAULT_BWWP_KWH));
  } else if (cfg.heatpump.enabled) {
    addInto(out, heatpumpHotWaterLoad(cfg.bwwp.annualKWh ?? DEFAULT_BWWP_KWH));
  }
  if (cfg.ev.enabled) addInto(out, evLoad(cfg.ev.annualKWh, cfg.ev.pvShare));
  return out;
}

/** Each consumer's load separately (zeros for disabled consumers). */
export interface ConsumerLoads {
  household: Float64Array;
  heatpump: Float64Array;
  bwwp: Float64Array;
  ev: Float64Array;
}

export function loadByConsumer(cfg: ConsumerConfig): ConsumerLoads {
  // Space-heating load of the heat pump.
  const heatpump = cfg.heatpump.enabled
    ? heatpumpLoad(cfg.heatpump.annualKWh)
    : new Float64Array(TOTAL_STEPS);
  // Hot water goes to the BWWP when enabled; otherwise it is folded into the
  // heat pump (year-round, night-heavy) so the WP "consumes more".
  let bwwp: Float64Array;
  if (cfg.bwwp.enabled) {
    bwwp = bwwpLoad(cfg.bwwp.annualKWh ?? DEFAULT_BWWP_KWH);
  } else {
    bwwp = new Float64Array(TOTAL_STEPS);
    if (cfg.heatpump.enabled) addInto(heatpump, heatpumpHotWaterLoad(cfg.bwwp.annualKWh ?? DEFAULT_BWWP_KWH));
  }
  return {
    household: cfg.household.enabled ? householdLoad(cfg.household.annualKWh) : new Float64Array(TOTAL_STEPS),
    heatpump,
    bwwp,
    ev: cfg.ev.enabled ? evLoad(cfg.ev.annualKWh, cfg.ev.pvShare) : new Float64Array(TOTAL_STEPS),
  };
}

function addInto(dst: Float64Array, src: Float64Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] += src[i];
}

/** Sum of a load profile over the whole year (kWh). */
export function annualSum(load: Float64Array): number {
  let s = 0;
  for (let i = 0; i < load.length; i++) s += load[i];
  return s;
}
