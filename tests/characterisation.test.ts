import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runSimulation } from "../src/calc/report";
import { SCENARIOS } from "./fixtures";

/**
 * Characterisation (golden) tests for the whole simulation.
 *
 * These are the tests that make everything else possible. Every assertion in
 * the rest of the suite is a hand-written inequality ("greater than 0", "less
 * than 4500"); none of them would notice a silent 0.4 % shift in the annual
 * Marktprämie, a month of labels drifting, or a whole chart series changing
 * shape. This suite pins the *entire* `SimReport` — every monthly row, every
 * one of the 288 typical-day cells, every tariff combination, every CO2
 * scenario — for a dozen feature-shaped configurations.
 *
 * Regenerate deliberately with:
 *
 *   UPDATE_GOLDEN=1 npm test -- characterisation
 *
 * and then read the diff. A one-line change in the output is a feature. A
 * thousand-line change means a formula moved and nobody decided whether that
 * was correct.
 */

const GOLDEN_DIR = path.join(__dirname, "__golden__");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

/** 6 significant-ish decimals: far finer than any published figure, coarse enough
 *  to survive an unrelated float reassociation in an untouched expression. */
function round(v: unknown): unknown {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    const r = Number(v.toFixed(6));
    return Object.is(r, -0) ? 0 : r;
  }
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = round((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function goldenPath(name: string): string {
  return path.join(GOLDEN_DIR, `${name}.json`);
}

function compareOrWrite(name: string, actual: unknown): void {
  const serialised = `${JSON.stringify(round(actual), null, 2)}\n`;
  const file = goldenPath(name);
  if (UPDATE || !existsSync(file)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, serialised);
    return;
  }
  const expected = readFileSync(file, "utf8");
  if (expected === serialised) return;

  // Report the first differing path rather than dumping two 10 000-line blobs.
  const a = expected.split("\n");
  const b = serialised.split("\n");
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line++;
  const context = a.slice(Math.max(0, line - 4), line + 4).join("\n");
  throw new Error(
    `Golden mismatch in ${name}.json at line ${line + 1}.\n` +
      `If this change is intended, re-run with UPDATE_GOLDEN=1.\n\n` +
      `--- expected (around the change) ---\n${context}\n\n` +
      `--- actual ---\n${b.slice(Math.max(0, line - 4), line + 4).join("\n")}\n`,
  );
}

describe("characterisation: full SimReport", () => {
  for (const s of SCENARIOS) {
    it(`pins the report for "${s.name}" (${s.about})`, () => {
      compareOrWrite(s.name, runSimulation(s.params));
    });
  }

  it("covers every feature axis the report exposes", () => {
    // A guard on the fixture list itself: if a new feature axis is added to
    // SimParams, one of these scenarios must change, or the golden net has a
    // hole in it.
    const names = new Set(SCENARIOS.map((s) => s.name));
    for (const required of [
      "baseline", "defaults", "no-battery", "no-pv-no-battery",
      "direct-marketing", "charge-cheapest", "wind", "bwwp-off", "long-horizon",
    ]) {
      expect(names, `missing scenario "${required}"`).toContain(required);
    }
    const exportSchemes = new Set(SCENARIOS.map((s) => s.params.exportScheme));
    const importSchemes = new Set(SCENARIOS.map((s) => s.params.importScheme));
    const chargeModes = new Set(SCENARIOS.map((s) => s.params.chargeMode));
    expect(exportSchemes).toContain("market");
    expect(importSchemes).toContain("dynamic");
    expect(importSchemes).toContain("dynamic14a");
    expect(chargeModes).toContain("cheapest");
    expect(chargeModes).toContain("gridNegative");
    expect(SCENARIOS.some((s) => s.params.windEnabled)).toBe(true);
    expect(SCENARIOS.some((s) => s.params.consumers.bwwp.enabled === false)).toBe(true);
    expect(SCENARIOS.some((s) => s.params.horizonYears > 20)).toBe(true);
  });
});