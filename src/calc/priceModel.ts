// Synthetic but realistic intraday/year spot-price model (EUR/MWh).
//
// German day-ahead spot exhibits: a winter premium, a midday "solar" dip, and
// occasional negative prices (oversupply around midday in spring/summer). A
// seeded PRNG keeps the series deterministic so simulations and tests are
// reproducible.

import { STEPS_PER_DAY } from "./types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  // Box-Muller
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Build one year of prices at the given resolution with realistic bounds. */
function buildYear(mean: number, seed: number, stepsPerHour: number): Float64Array {
  const rng = mulberry32(seed);
  const totalSteps = 365 * 24 * stepsPerHour;
  const out = new Float64Array(totalSteps);

  // Normalise the intraday shape so it averages to 1 (keeps the annual mean = `mean`).
  let meanIntraday = 0;
  for (let h = 0; h < 24; h++) {
    const morning = 0.45 * Math.exp(-((h - 8) ** 2) / 8);
    const evening = 0.7 * Math.exp(-((h - 19) ** 2) / 6);
    const middayDip = -0.4 * Math.exp(-((h - 13) ** 2) / 10);
    meanIntraday += 1 + morning + evening + middayDip;
  }
  meanIntraday /= 24;

  // Pre-roll per-day negative-price events for spring/summer.
  const negEvent = new Float64Array(365); // event depth (EUR/MWh) per day, 0 = none
  for (let d = 0; d < 365; d++) {
    const solar = Math.max(0, Math.sin((Math.PI * (d - 81)) / 183));
    if (rng() < solar * 0.6) negEvent[d] = 40 + rng() * 110; // 40..150 depth
  }

  for (let i = 0; i < totalSteps; i++) {
    const d = Math.floor(i / (24 * stepsPerHour));
    const hour = (i % (24 * stepsPerHour)) / stepsPerHour;

    // Seasonal level around the annual mean (winter premium, summer dip).
    const seasonal = mean + 18 * Math.cos((2 * Math.PI * (d - 15)) / 365);

    // Intraday shape: morning + evening peaks, midday solar dip.
    const morning = 0.45 * Math.exp(-((hour - 8) ** 2) / 8);
    const evening = 0.7 * Math.exp(-((hour - 19) ** 2) / 6);
    const middayDip = -0.4 * Math.exp(-((hour - 13) ** 2) / 10);
    const intraday = (1 + morning + evening + middayDip) / meanIntraday;

    let price = seasonal * intraday;

    // Negative-price event: a midday trough (more likely / deeper in summer).
    const depth = negEvent[d];
    if (depth > 0) {
      const trough = depth * Math.exp(-((hour - 12.5) ** 2) / 9);
      price -= trough;
    }

    price += gaussian(rng) * 10;
    // Realistic bounds: day-ahead spot rarely leaves [-200, +400] €/MWh.
    price = Math.max(-200, Math.min(400, price));
    out[i] = price;
  }
  return out;
}

/**
 * Generate a full-year 15-minute price series with a ~75 €/MWh mean.
 * @param seed PRNG seed for reproducibility.
 */
export function generatePrices(seed = 20231130): Float64Array {
  return buildYear(75, seed, STEPS_PER_DAY / 24);
}

/** Hourly price series for a given annual mean (used to build the price data file). */
export function generateYearlyPrices(mean: number, seed: number): number[] {
  return Array.from(buildYear(mean, seed, 1));
}

/** Count steps with non-positive prices (for sanity checks). */
export function countNonPositive(prices: Float64Array): number {
  let n = 0;
  for (let i = 0; i < prices.length; i++) if (prices[i] <= 0) n++;
  return n;
}
