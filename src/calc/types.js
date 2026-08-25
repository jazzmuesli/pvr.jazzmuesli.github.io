// Core domain types and shared constants for the PV/battery simulator.
/** Number of 15-minute steps per day. */
export const STEPS_PER_DAY = 96;
/** Step duration in hours (15 minutes). */
export const STEP_HOURS = STEPS_PER_DAY / 24; // 0.25
/** Default simulated year: a non-leap year so the grid is exactly 365 days. */
export const SIM_YEAR = 2023;
/** Total number of steps in the simulated year. */
export const TOTAL_STEPS = 365 * STEPS_PER_DAY;
