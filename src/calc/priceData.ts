// Real German day-ahead spot prices (€/MWh, hourly) per year, from
// Bundesnetzagentur / SMARD via energy-charts.info (CC BY 4.0). 2026 is
// extrapolated for the remaining months using the 2023–2025 average.

import pricesJson from "../data/prices.json";
import { TOTAL_STEPS, STEPS_PER_DAY } from "./types";

export const PRICE_YEARS: string[] = Object.keys(pricesJson).sort();

function hourlyToQuarterHourly(hourly: number[]): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  const stepsPerDay = STEPS_PER_DAY; // 96
  for (let i = 0; i < hourly.length; i++) {
    const day = Math.floor(i / 24);
    const h = i % 24;
    const base = day * stepsPerDay + h * (stepsPerDay / 24);
    for (let k = 0; k < stepsPerDay / 24; k++) out[base + k] = hourly[i];
  }
  return out;
}

const cache = new Map<string, Float64Array>();

/** Return the 15-minute price series (EUR/MWh) for a given year. */
export function getYearPrices(year: string | number): Float64Array {
  const key = String(year);
  const cached = cache.get(key);
  if (cached) return cached;
  const hourly = (pricesJson as Record<string, number[]>)[key];
  if (!hourly) throw new Error(`No price data for year ${key}`);
  const expanded = hourlyToQuarterHourly(hourly);
  cache.set(key, expanded);
  return expanded;
}
