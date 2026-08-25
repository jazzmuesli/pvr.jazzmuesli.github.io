// Synthetic but realistic intraday/year spot-price model (EUR/MWh).
//
// German day-ahead spot exhibits: a winter premium, a midday "solar" dip, and
// occasional negative prices (oversupply around midday in spring/summer). A
// seeded PRNG keeps the series deterministic so simulations and tests are
// reproducible.
import { STEPS_PER_DAY, STEP_HOURS, TOTAL_STEPS } from "./types";
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function gaussian(rng) {
    // Box-Muller
    const u = Math.max(1e-9, rng());
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/**
 * Generate a full-year 15-minute price series.
 * @param seed PRNG seed for reproducibility.
 */
export function generatePrices(seed = 20231130) {
    const rng = mulberry32(seed);
    const out = new Float64Array(TOTAL_STEPS);
    const stepsPerHour = STEPS_PER_DAY / 24;
    // Pre-roll per-day negative-price events for spring/summer.
    const negEvent = new Float64Array(365); // event depth (EUR/MWh) per day, 0 = none
    for (let d = 0; d < 365; d++) {
        // solar strength: high in summer (doy ~ 172)
        const solar = Math.max(0, Math.sin((Math.PI * (d - 81)) / 183));
        const pEvent = solar * 0.55; // up to ~55% of summer days get an event
        if (rng() < pEvent) {
            negEvent[d] = 40 + rng() * 90; // 40..130 depth
        }
    }
    for (let i = 0; i < TOTAL_STEPS; i++) {
        const d = Math.floor(i / STEPS_PER_DAY);
        const hour = (i % STEPS_PER_DAY) / stepsPerHour; // 0..24
        // Seasonal base level (EUR/MWh): winter high, summer low.
        const seasonal = 75 + 30 * Math.cos((2 * Math.PI * (d - 15)) / 365);
        // Intraday shape multipliers.
        const morning = 0.45 * Math.exp(-((hour - 8) ** 2) / 8);
        const evening = 0.7 * Math.exp(-((hour - 19) ** 2) / 6);
        const middayDip = -0.4 * Math.exp(-((hour - 13) ** 2) / 10);
        const intraday = 1 + morning + evening + middayDip;
        let price = seasonal * intraday;
        // Negative-price event: a midday trough.
        const depth = negEvent[d];
        if (depth > 0) {
            const trough = depth * Math.exp(-((hour - 12.5) ** 2) / 6);
            price -= trough;
        }
        // Noise.
        price += gaussian(rng) * 12;
        out[i] = price;
    }
    return out;
}
/** Count steps with non-positive prices (for sanity checks). */
export function countNonPositive(prices) {
    let n = 0;
    for (let i = 0; i < prices.length; i++)
        if (prices[i] <= 0)
            n++;
    return n;
}
export { STEP_HOURS };
