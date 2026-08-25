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
}

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

// Heat pump: night-heavy (comfort heating at night), dip midday.
const HP_HOURLY = [
  1.5, 1.55, 1.5, 1.4, 1.25, 1.05, 0.85, 0.7, 0.65, 0.7, 0.78, 0.9, 1.0, 1.0,
  0.9, 0.8, 0.8, 0.95, 1.15, 1.25, 1.3, 1.35, 1.45, 1.5,
];

// ---------------------------------------------------------------------------
// Normalized monthly weights (mean = 1 over the year).
// ---------------------------------------------------------------------------

// H0: winter higher (lighting/heating), summer lower.
const H0_MONTHLY = [
  1.15, 1.12, 1.05, 0.98, 0.92, 0.88, 0.9, 0.9, 0.95, 1.02, 1.08, 1.14,
];

// Heat pump: strongly winter-heavy (space-heating season Oct–Mar).
const HP_MONTHLY = [
  1.9, 1.8, 1.5, 1.05, 0.6, 0.35, 0.3, 0.32, 0.5, 1.0, 1.4, 1.8,
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
 * Brauchwasserwärmepumpe load (kWh/step).
 * ~40 kWh/month, runs a 2 h block around solar noon (12:00) at ~0.66 kW
 * (0.66 kW x 2 h = 1.32 kWh/day x 365 ≈ 482 kWh/year ≈ 40 kWh/month).
 */
export function bwwpLoad(): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  const dailyKWh = (40 * 12) / 365; // ≈ 40 kWh/month
  const powerKW = dailyKWh / 2; // over a 2-hour block
  const perStepKWh = powerKW * (1 / STEPS_PER_HOUR);
  const middayStep = 12 * STEPS_PER_HOUR;
  const blockSteps = 2 * STEPS_PER_HOUR;
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    for (let k = 0; k < blockSteps; k++) {
      const idx = dayStart + middayStep + k;
      if (idx < TOTAL_STEPS) out[idx] = perStepKWh;
    }
  }
  return out;
}

/**
 * Electric-vehicle load (kWh/step).
 * `pvShare` of the daily demand is placed in the sunny midday window
 * (10:00–14:00); the rest in a fixed evening window (19:00–21:00). The
 * dispatch later decides whether PV, battery or grid serves it.
 */
export function evLoad(annualKWh: number, pvShare: number): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (annualKWh <= 0) return out;
  const share = Math.max(0, Math.min(1, pvShare));
  const dailyKWh = annualKWh / 365;
  const middaySteps = 4 * STEPS_PER_HOUR; // 10:00–14:00 = 4 h
  const eveningSteps = 2 * STEPS_PER_HOUR; // 19:00–21:00 = 2 h
  const middayStart = 10 * STEPS_PER_HOUR;
  const eveningStart = 19 * STEPS_PER_HOUR;
  const middayPerStep = (dailyKWh * share) / middaySteps;
  const eveningPerStep = (dailyKWh * (1 - share)) / eveningSteps;
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    for (let k = 0; k < middaySteps; k++) out[dayStart + middayStart + k] += middayPerStep;
    for (let k = 0; k < eveningSteps; k++) out[dayStart + eveningStart + k] += eveningPerStep;
  }
  return out;
}

/** Sum of all enabled consumer profiles (kWh/step). */
export function totalLoad(cfg: ConsumerConfig): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  if (cfg.household.enabled) addInto(out, householdLoad(cfg.household.annualKWh));
  if (cfg.heatpump.enabled) addInto(out, heatpumpLoad(cfg.heatpump.annualKWh));
  if (cfg.bwwp.enabled) addInto(out, bwwpLoad());
  if (cfg.ev.enabled) addInto(out, evLoad(cfg.ev.annualKWh, cfg.ev.pvShare));
  return out;
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
