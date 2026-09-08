// German electricity grid mix model (hourly resolution).
//
// Based on historical data from Bundesnetzagentur / energy-charts.info (2022-2024).
// Germany's electricity generation by source varies strongly by month and hour:
//  - Wind: ~25-30% annual, winter-heavy, weather-driven
//  - Solar: ~12-15% annual, strictly daytime, summer-heavy
//  - Gas: ~10-15%, peak/balancing, inversely correlated with solar
//  - Coal (lignite + hard coal): ~15-20%, baseload + ramping
//  - Biomass: ~5-8%, relatively constant
//  - Hydro: ~3-4%, relatively constant
//  - Other: ~2-3%
//
// This model provides the fraction of grid electricity from each source for a
// given hour-of-day and month-of-year, allowing the simulation to track where
// a heat pump's grid electricity actually comes from.

import { TOTAL_STEPS, monthOfStep, hourOfStep } from "./types";

// ---------------------------------------------------------------------------
// Source fractions by month (rows) and hour of day (columns 0..23).
// Each row sums to 1.0. Based on German annual generation shares, modulated
// by realistic seasonal and diurnal patterns.
// ---------------------------------------------------------------------------

// Monthly wind capacity factor (% of installed capacity, roughly maps to share):
//   Jan=55, Feb=50, Mar=42, Apr=38, May=30, Jun=25, Jul=22, Aug=25, Sep=35, Oct=42, Nov=50, Dec=55
// Hourly solar shape: 0 at night, ramp 6-10, peak 11-14, ramp 15-19, 0 after 20
// Gas inversely correlated with solar (peaks in evening/night when solar is absent)

/** Hourly wind share (0..1) for each month. Peak at night in winter. */
const WIND_MONTHLY_HOURLY: number[][] = [
  // Jan: high wind, moderate at night, dips slightly midday due to thermal effects
  [0.35, 0.36, 0.37, 0.37, 0.36, 0.34, 0.33, 0.32, 0.30, 0.28, 0.27, 0.26, 0.25, 0.25, 0.26, 0.27, 0.29, 0.31, 0.33, 0.34, 0.35, 0.36, 0.36, 0.35],
  // Feb: slightly lower than Jan
  [0.32, 0.33, 0.34, 0.34, 0.33, 0.31, 0.30, 0.29, 0.27, 0.25, 0.24, 0.23, 0.22, 0.22, 0.23, 0.24, 0.26, 0.28, 0.30, 0.31, 0.32, 0.33, 0.33, 0.32],
  // Mar: transitional
  [0.26, 0.27, 0.28, 0.28, 0.27, 0.25, 0.24, 0.22, 0.20, 0.18, 0.17, 0.16, 0.16, 0.16, 0.17, 0.18, 0.20, 0.22, 0.24, 0.25, 0.26, 0.27, 0.27, 0.26],
  // Apr: moderate wind
  [0.22, 0.23, 0.24, 0.24, 0.23, 0.21, 0.20, 0.18, 0.16, 0.14, 0.13, 0.12, 0.12, 0.12, 0.13, 0.14, 0.16, 0.18, 0.20, 0.21, 0.22, 0.23, 0.23, 0.22],
  // May: lower wind, strong solar offset
  [0.18, 0.19, 0.20, 0.20, 0.19, 0.17, 0.16, 0.14, 0.12, 0.10, 0.09, 0.08, 0.08, 0.08, 0.09, 0.10, 0.12, 0.14, 0.16, 0.17, 0.18, 0.19, 0.19, 0.18],
  // Jun: lowest wind
  [0.15, 0.16, 0.17, 0.17, 0.16, 0.14, 0.13, 0.11, 0.09, 0.07, 0.06, 0.05, 0.05, 0.05, 0.06, 0.07, 0.09, 0.11, 0.13, 0.14, 0.15, 0.16, 0.16, 0.15],
  // Jul: lowest wind, highest solar
  [0.13, 0.14, 0.15, 0.15, 0.14, 0.12, 0.11, 0.09, 0.07, 0.05, 0.04, 0.04, 0.04, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.13, 0.14, 0.15, 0.15, 0.13],
  // Aug: slightly higher wind than Jul
  [0.15, 0.16, 0.17, 0.17, 0.16, 0.14, 0.13, 0.11, 0.09, 0.07, 0.06, 0.05, 0.05, 0.05, 0.06, 0.07, 0.09, 0.11, 0.13, 0.14, 0.15, 0.16, 0.16, 0.15],
  // Sep: increasing wind
  [0.20, 0.21, 0.22, 0.22, 0.21, 0.19, 0.18, 0.16, 0.14, 0.12, 0.11, 0.10, 0.10, 0.10, 0.11, 0.12, 0.14, 0.16, 0.18, 0.19, 0.20, 0.21, 0.21, 0.20],
  // Oct: higher wind
  [0.26, 0.27, 0.28, 0.28, 0.27, 0.25, 0.24, 0.22, 0.20, 0.18, 0.17, 0.16, 0.16, 0.16, 0.17, 0.18, 0.20, 0.22, 0.24, 0.25, 0.26, 0.27, 0.27, 0.26],
  // Nov: high wind, low solar
  [0.32, 0.33, 0.34, 0.34, 0.33, 0.31, 0.30, 0.28, 0.26, 0.24, 0.23, 0.22, 0.22, 0.22, 0.23, 0.24, 0.26, 0.28, 0.30, 0.31, 0.32, 0.33, 0.33, 0.32],
  // Dec: highest wind
  [0.36, 0.37, 0.38, 0.38, 0.37, 0.35, 0.34, 0.32, 0.30, 0.28, 0.27, 0.26, 0.25, 0.25, 0.26, 0.27, 0.29, 0.31, 0.33, 0.34, 0.35, 0.36, 0.36, 0.35],
];

/** Hourly solar share (0..1) for each month. Zero at night, peak at solar noon. */
const SOLAR_MONTHLY_HOURLY: number[][] = [
  // Jan: very low solar
  [0, 0, 0, 0, 0, 0, 0.02, 0.04, 0.06, 0.08, 0.09, 0.10, 0.10, 0.09, 0.08, 0.06, 0.03, 0, 0, 0, 0, 0, 0, 0],
  // Feb
  [0, 0, 0, 0, 0, 0, 0.03, 0.06, 0.09, 0.12, 0.13, 0.14, 0.14, 0.13, 0.11, 0.08, 0.04, 0, 0, 0, 0, 0, 0, 0],
  // Mar: moderate solar
  [0, 0, 0, 0, 0, 0, 0.04, 0.08, 0.13, 0.17, 0.19, 0.20, 0.20, 0.18, 0.15, 0.10, 0.05, 0, 0, 0, 0, 0, 0, 0],
  // Apr: good solar
  [0, 0, 0, 0, 0, 0, 0.05, 0.11, 0.18, 0.24, 0.27, 0.28, 0.28, 0.25, 0.20, 0.14, 0.06, 0, 0, 0, 0, 0, 0, 0],
  // May: strong solar
  [0, 0, 0, 0, 0, 0.02, 0.07, 0.14, 0.22, 0.30, 0.34, 0.36, 0.35, 0.31, 0.25, 0.17, 0.08, 0.01, 0, 0, 0, 0, 0, 0],
  // Jun: peak solar
  [0, 0, 0, 0, 0, 0.03, 0.09, 0.17, 0.27, 0.36, 0.40, 0.42, 0.41, 0.37, 0.30, 0.20, 0.10, 0.02, 0, 0, 0, 0, 0, 0],
  // Jul: peak solar
  [0, 0, 0, 0, 0, 0.02, 0.08, 0.16, 0.26, 0.35, 0.39, 0.41, 0.40, 0.36, 0.29, 0.19, 0.09, 0.01, 0, 0, 0, 0, 0, 0],
  // Aug: strong solar
  [0, 0, 0, 0, 0, 0.01, 0.07, 0.14, 0.22, 0.30, 0.34, 0.35, 0.35, 0.31, 0.25, 0.16, 0.07, 0, 0, 0, 0, 0, 0, 0],
  // Sep: moderate solar
  [0, 0, 0, 0, 0, 0, 0.05, 0.10, 0.16, 0.21, 0.24, 0.25, 0.24, 0.21, 0.17, 0.11, 0.05, 0, 0, 0, 0, 0, 0, 0],
  // Oct: low solar
  [0, 0, 0, 0, 0, 0, 0.03, 0.06, 0.10, 0.13, 0.15, 0.16, 0.15, 0.13, 0.10, 0.06, 0.03, 0, 0, 0, 0, 0, 0, 0],
  // Nov: very low solar
  [0, 0, 0, 0, 0, 0, 0.01, 0.03, 0.05, 0.07, 0.08, 0.08, 0.08, 0.07, 0.05, 0.03, 0.01, 0, 0, 0, 0, 0, 0, 0],
  // Dec: minimal solar
  [0, 0, 0, 0, 0, 0, 0.01, 0.02, 0.04, 0.05, 0.06, 0.06, 0.06, 0.05, 0.04, 0.02, 0.01, 0, 0, 0, 0, 0, 0, 0],
];

// Baseload shares (relatively constant across hours and months):
// Biomass ~6%, Hydro ~3%, Other (waste, geothermal, etc.) ~2%
const BIOMASS_SHARE = 0.06;
const HYDRO_SHARE = 0.03;
const OTHER_SHARE = 0.02;
const BASELOAD_TOTAL = BIOMASS_SHARE + HYDRO_SHARE + OTHER_SHARE;

// Coal share is the residual after wind, solar, and baseload are allocated.
// Coal acts as the flexible baseload that fills the gap.

export interface ElectricitySourceShares {
  /** Wind (onshore + offshore) share, 0..1 */
  wind: number;
  /** Solar (PV) share, 0..1 */
  solar: number;
  /** Natural gas share, 0..1 */
  gas: number;
  /** Coal (lignite + hard coal) share, 0..1 */
  coal: number;
  /** Biomass share, 0..1 */
  biomass: number;
  /** Hydro share, 0..1 */
  hydro: number;
  /** Other sources share, 0..1 */
  other: number;
}

/**
 * Get the electricity mix shares for a given month (1..12) and hour (0..23).
 * The fractions sum to 1.0 and represent the approximate German grid mix.
 */
export function electricityMixForHour(month: number, hour: number): ElectricitySourceShares {
  const m = Math.max(1, Math.min(12, month)) - 1;
  const h = Math.max(0, Math.min(23, hour));

  const wind = WIND_MONTHLY_HOURLY[m][h];
  const solar = SOLAR_MONTHLY_HOURLY[m][h];
  const remaining = Math.max(0, 1 - wind - solar - BASELOAD_TOTAL);

  // Gas gets a fixed baseload + peaks inversely correlated with solar.
  // When solar is high, gas backs off; coal fills the residual.
  const gasBaseload = 0.08;
  const gasSolarOffset = solar * 0.3; // Gas backs off when solar is high
  const gasPeakEvening = h >= 17 && h <= 21 ? 0.05 : 0; // Evening peak
  const gasNightRamp = h <= 5 || h >= 22 ? 0.03 : 0; // Night ramping
  const gasRaw = gasBaseload + gasPeakEvening + gasNightRamp - gasSolarOffset;
  const gas = Math.max(0, Math.min(remaining, gasRaw));
  const coal = remaining - gas; // Coal fills the exact residual

  return {
    wind: round4(wind),
    solar: round4(solar),
    gas: round4(gas),
    coal: round4(coal),
    biomass: BIOMASS_SHARE,
    hydro: HYDRO_SHARE,
    other: OTHER_SHARE,
  };
}

/**
 * Get electricity mix for a 15-minute simulation step index.
 * Uses monthOfStep and hourOfStep to map step → calendar position.
 */
export function electricityMixForStep(step: number): ElectricitySourceShares {
  const month = monthOfStep(step);
  const hour = hourOfStep(step);
  return electricityMixForHour(month, hour);
}

/**
 * Get electricity mix for every step of the simulated year.
 * Returns an array of ElectricitySourceShares of length TOTAL_STEPS.
 */
export function electricityMixYear(): ElectricitySourceShares[] {
  const out: ElectricitySourceShares[] = new Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) {
    out[i] = electricityMixForStep(i);
  }
  return out;
}

/**
 * Annual average electricity mix across all 8760 hours.
 * Useful for reporting the overall grid composition.
 */
export function annualAverageMix(): ElectricitySourceShares {
  let wind = 0, solar = 0, gas = 0, coal = 0;
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const mix = electricityMixForStep(i);
    wind += mix.wind;
    solar += mix.solar;
    gas += mix.gas;
    coal += mix.coal;
  }
  const n = TOTAL_STEPS;
  return {
    wind: round4(wind / n),
    solar: round4(solar / n),
    gas: round4(gas / n),
    coal: round4(coal / n),
    biomass: BIOMASS_SHARE,
    hydro: HYDRO_SHARE,
    other: OTHER_SHARE,
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
