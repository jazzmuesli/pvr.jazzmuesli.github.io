// Small shared numeric helpers.

/** Round to two decimals (the report's money/energy precision). */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
