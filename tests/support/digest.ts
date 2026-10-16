// Stable, dependency-free digest used by the characterization/acceptance tests.
// A non-cryptographic hash is enough here: we only need "did the output move?".

function cyrb128(str: string): string {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k = 0; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

export function roundDeep(v: unknown, dp = 4): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? Number(v.toFixed(dp)) : String(v);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, dp));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) out[k] = roundDeep((v as Record<string, unknown>)[k], dp);
    return out;
  }
  return v;
}

/** Digest of an arbitrary JSON value, tolerant to 4th-decimal float noise. */
export function digest(value: unknown): string {
  return cyrb128(JSON.stringify(roundDeep(value))).slice(0, 16);
}
