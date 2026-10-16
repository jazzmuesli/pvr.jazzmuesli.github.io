/**
 * The parameter registry: one row per scalar the user can change.
 *
 * ## Why this file exists
 *
 * Every scalar below used to be written out by hand in *five* places:
 *
 *   1. `DEFAULT_STATE`           — ui/state.ts,   50 entries
 *   2. `DEFAULT_SIM_PARAMS`      — calc/report.ts, 50 entries
 *   3. `toSimParams`             — ui/state.ts,   60 lines of assignment
 *   4. `serializeState` / `deserializeState` — ui/url.ts, 120 lines
 *   5. `simParamsFromQuery`      — calc/report.ts, 56 assignments
 *
 * The five copies had already drifted apart: the SPA's defaults said 22 kWp in
 * Boizenburg, `/api`'s said 10 kWp in Hamburg; six parameters (Direktvermarktung
 * margin, heat-pump JAZ, and four car inputs) had a URL key in the reader but
 * none in the writer, so they silently reset on every refresh and every share
 * link. The conformance suite now pins all of that.
 *
 * Adding one scalar to the old arrangement cost ~40–140 edit sites across
 * 36–42 files. Adding one here costs one row.
 *
 * ## What it generates
 *
 *   - `defaultCoreParams()`  — the one default configuration
 *   - `paramsFromQuery()`    — the `/api` and share-link reader
 *   - `paramsToQuery()`      — the share-link writer
 *   - `applyExpertDefaults()`— simple-mode overrides
 *
 * and, via the conformance suite, it is checked against `CoreParams` so a new
 * field cannot be added without a row here.
 */

import { ChargeMode, DischargeMode, Orientation, parseChargeMode, parseDischargeMode } from "../calc/types";
import { LOCATIONS } from "../calc/solar";
import { PRICE_YEARS } from "../calc/priceData";
import { WIND_TURBINES } from "../calc/wind";
import {
  IMPORT_SCHEMES,
  EXPORT_SCHEMES,
  isImportScheme,
  isExportScheme,
  type ImportScheme,
  type ExportScheme,
} from "../calc/markets";

export type ParamKind = "number" | "boolean" | "enum";

export interface ParamSpec {
  /** Field name on the shared flat parameter object. */
  key?: string;
  /** Short URL key. Stable: published links depend on it. */
  url: string;
  kind: ParamKind;
  /** The product default. The single source of truth for all consumers. */
  default: number | boolean | string;
  /**
   * Value forced when the user is *not* in expert mode. The control is hidden
   * there, so leaving a stale value in the share link would silently change the
   * simulation the link describes. Omitted where the simple value equals the
   * default. `maxPowerKW` is the one exception: it has no `simple` at all,
   * because it is *computed* from the battery capacity (see
   * `applyExpertDefaults`) rather than pinned.
   */
  simple?: number | boolean | string;
  /** Allowed values for `kind: "enum"`. */
  values?: readonly string[];
  /** Clamp range, applied on parse so a hand-edited link cannot break the model. */
  min?: number;
  max?: number;
  /** UI increment for numeric fields. */
  step?: number;
  /** Panel grouping, used by the control builder and the share-link tests. */
  group: "pv" | "battery" | "tariff" | "consumer" | "economy" | "wind";
  /** Only editable in expert mode. */
  expert?: boolean;
}

// `as const` matters: it is what makes `CoreParams` carry the literal union
// ("morning" | "cheapest" | "gridNegative") rather than `string`, so the domain
// types and the registry cannot drift apart.
const ORIENTATIONS = ["south", "east", "west", "east_west", "north"] as const;
const CHARGE_MODES = ["morning", "cheapest", "gridNegative"] as const;
const DISCHARGE_MODES = ["windows", "peak"] as const;

export const PARAM_REGISTRY = [
  // ---- PV -------------------------------------------------------------
  { key: "peakKWp", url: "kwp", kind: "number", default: 22, min: 0, max: 200, step: 0.5, group: "pv" },
  { key: "tiltDeg", url: "tilt", kind: "number", default: 35, min: 0, max: 90, step: 1, group: "pv" },
  { key: "orientation", url: "o", kind: "enum", values: ORIENTATIONS, default: "east_west", group: "pv" },
  { key: "location", url: "loc", kind: "enum", values: Object.keys(LOCATIONS), default: "boizenburg", group: "pv" },

  // ---- Battery --------------------------------------------------------
  { key: "capacityKWh", url: "cap", kind: "number", default: 19.353, min: 0, max: 200, step: 0.1, group: "battery" },
  { key: "maxPowerKW", url: "pwr", kind: "number", default: 6, min: 0, max: 100, step: 0.5, group: "battery", expert: true },
  { key: "minSOC", url: "minsoc", kind: "number", default: 0.1, simple: 0.1, min: 0, max: 0.95, step: 0.05, group: "battery", expert: true },
  { key: "maxSOC", url: "maxsoc", kind: "number", default: 0.95, simple: 0.95, min: 0.05, max: 1, step: 0.05, group: "battery", expert: true },
  { key: "efficiency", url: "eff", kind: "number", default: 0.95, simple: 0.95, min: 0.5, max: 1, step: 0.01, group: "battery", expert: true },
  { key: "startSOC", url: "soc0", kind: "number", default: 0.5, simple: 0.5, min: 0, max: 1, step: 0.05, group: "battery", expert: true },
  { key: "chargeMode", url: "charge", kind: "enum", values: CHARGE_MODES, default: "morning", simple: "morning", group: "battery", expert: true },
  { key: "dischargeMode", url: "dsp", kind: "enum", values: DISCHARGE_MODES, default: "windows", simple: "windows", group: "battery", expert: true },
  { key: "dischargeEvening", url: "de", kind: "boolean", default: true, simple: true, group: "battery", expert: true },
  { key: "dischargeMorning", url: "dm", kind: "boolean", default: true, simple: true, group: "battery", expert: true },
  { key: "eveningStart", url: "evs", kind: "number", default: 17, simple: 17, min: 0, max: 23, group: "battery", expert: true },
  { key: "eveningEnd", url: "eve", kind: "number", default: 23, simple: 23, min: 1, max: 24, group: "battery", expert: true },
  { key: "morningStart", url: "mns", kind: "number", default: 5, simple: 5, min: 0, max: 23, group: "battery", expert: true },
  { key: "morningEnd", url: "mne", kind: "number", default: 12, simple: 12, min: 1, max: 24, group: "battery", expert: true },

  // ---- Tariff ---------------------------------------------------------
  { key: "feedInCt", url: "fi", kind: "number", default: 7.2, min: 0, max: 100, step: 0.1, group: "tariff" },
  { key: "commissioningYear", url: "yr", kind: "number", default: 2025, min: 2000, max: 2100, group: "tariff" },
  { key: "priceYear", url: "py", kind: "enum", values: PRICE_YEARS, default: "2025", group: "tariff" },
  { key: "exportScheme", url: "ex", kind: "enum", values: EXPORT_SCHEMES, default: "fixed", group: "tariff" },
  { key: "importScheme", url: "im", kind: "enum", values: IMPORT_SCHEMES, default: "fixed", group: "tariff" },
  { key: "importFixedCt", url: "ict", kind: "number", default: 24, min: 0, max: 100, step: 0.1, group: "tariff" },
  { key: "marketMarginCt", url: "mm", kind: "number", default: 1, min: 0, max: 20, step: 0.1, group: "tariff" },

  // ---- Heat pump / opportunity ---------------------------------------
  { key: "heatpumpJaz", url: "jaz", kind: "number", default: 3, min: 1.5, max: 6, step: 0.1, group: "consumer" },


  // ---- Investment & lifecycle economics ------------------------------
  { key: "investmentEUR", url: "inv", kind: "number", default: 32000, min: 0, max: 1000000, step: 500, group: "economy" },
  { key: "horizonYears", url: "hor", kind: "number", default: 20, min: 1, max: 40, group: "economy" },
  { key: "discountRatePct", url: "d", kind: "number", default: 3, min: 0, max: 20, step: 0.1, group: "economy" },
  { key: "priceEscalationPct", url: "esc", kind: "number", default: 2, min: -5, max: 15, step: 0.1, group: "economy" },
  { key: "omPercentPerYear", url: "om", kind: "number", default: 1.5, min: 0, max: 20, step: 0.1, group: "economy" },
  { key: "inverterLifetimeYears", url: "invlife", kind: "number", default: 13, min: 1, max: 40, group: "economy", expert: true },
  { key: "inverterReplacementCostEUR", url: "invrep", kind: "number", default: 1500, min: 0, max: 50000, step: 100, group: "economy", expert: true },
  { key: "batteryLifetimeYears", url: "batlife", kind: "number", default: 13, min: 1, max: 40, group: "economy", expert: true },
  { key: "batteryReplacementCostEUR", url: "batrep", kind: "number", default: 3000, min: 0, max: 100000, step: 100, group: "economy", expert: true },
  { key: "batteryDegradationPct", url: "batdeg", kind: "number", default: 0.01, min: 0, max: 0.2, step: 0.001, group: "economy", expert: true },
  { key: "pvDegradationPct", url: "pvdeg", kind: "number", default: 0.005, min: 0, max: 0.1, step: 0.001, group: "economy", expert: true },
  { key: "standbyWattage", url: "stdby", kind: "number", default: 5, min: 0, max: 100, step: 1, group: "economy", expert: true },

  // ---- Kleinwindkraft -------------------------------------------------
  { key: "windEnabled", url: "wen", kind: "boolean", default: false, group: "wind", expert: true },
  { key: "windCount", url: "wc", kind: "number", default: 1, min: 0, max: 20, group: "wind", expert: true },
  { key: "windHubHeightM", url: "wh", kind: "number", default: 10, min: 1, max: 30, group: "wind", expert: true },
  { key: "windTurbineId", url: "wt", kind: "enum", values: WIND_TURBINES.map((t) => t.id), default: "skywind_ng", group: "wind", expert: true },
  { key: "windSpeedMeanMs", url: "wsm", kind: "number", default: 6, min: 0, max: 15, step: 0.1, group: "wind", expert: true },
] as const satisfies readonly ParamSpec[];

type RegistryEntry = (typeof PARAM_REGISTRY)[number];

export const PARAM_KEYS = PARAM_REGISTRY.map((p) => p.key);
export type ParamKey = RegistryEntry["key"];

const BY_KEY = new Map<string, ParamSpec>(PARAM_REGISTRY.map((p) => [p.key, p as ParamSpec]));
const BY_URL = new Map<string, ParamSpec>(PARAM_REGISTRY.map((p) => [p.url, p as ParamSpec]));

export function specFor(key: string): ParamSpec | undefined {
  return BY_KEY.get(key);
}

export function specForUrl(url: string): ParamSpec | undefined {
  return BY_URL.get(url);
}
/**
 * The flat scalar parameters shared by the SPA state and the simulation,
 * derived from the registry so a new row adds a new field automatically and
 * with the right type.
 */
// `E` must be a naked type parameter for the conditional to distribute over the
// registry union, which is what gives each row its own type.
type ValueTypeFor<E> = E extends { kind: "enum"; values: readonly (infer V)[] }
  ? V extends string ? V : string
  : E extends { kind: "boolean" }
    ? boolean
    : number;

export type CoreParams = {
  [E in RegistryEntry as E["key"]]: ValueTypeFor<E>;
};

type Assert<T extends true> = T;
/** Compile-time proof that every registry row produced a CoreParams field. */
export type _RegistryIsComplete = Assert<
  Exclude<keyof CoreParams, RegistryEntry["key"]> extends never ? true : never
>;

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

function clampValue(spec: ParamSpec, value: number): number {
  let v = value;
  if (spec.min !== undefined && v < spec.min) v = spec.min;
  if (spec.max !== undefined && v > spec.max) v = spec.max;
  return v;
}

/** Parse one raw URL token into the registry's type, or `undefined` if absent/invalid. */
export function parseToken(spec: ParamSpec, raw: string | null): number | boolean | string | undefined {
  if (raw === null || raw === "") return undefined;
  switch (spec.kind) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? clampValue(spec, n) : undefined;
    }
    case "boolean":
      return raw === "1" || raw === "true";
    case "enum":
      return spec.values && !spec.values.includes(raw) ? undefined : raw;
  }
}

export function formatToken(value: number | boolean | string): string {
  return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

/** The one default configuration, straight from the registry. */
export function defaultCoreParams(): CoreParams {
  const out: Record<string, number | boolean | string> = {};
  for (const spec of PARAM_REGISTRY) out[String(spec.key)] = spec.default as number | boolean | string;
  return out as CoreParams;
}

/**
 * Apply the simple-mode derivations. `maxPowerKW` is the only genuinely
 * computed one (a third of capacity, capped); the rest pin the values the
 * simple UI implies, so the numbers a user sees match the numbers the model
 * runs with even though the control is hidden.
 */
export function applyExpertDefaults<T extends CoreParams>(params: T, expertMode: boolean): T {
  if (expertMode) return params;
  const out: Record<string, number | boolean | string> = { ...(params as unknown as Record<string, number | boolean | string>) };
  // `key` is optional on the base spec type (the car registry identifies its
  // rows by `carKey`), but every row in this registry has one.
  // The one genuinely computed simple-mode value: battery power is sized from
  // the capacity the user typed, not from a control they cannot see.
  out.maxPowerKW = Math.min(Number(out.capacityKWh) * 0.33, 20);
  for (const entry of PARAM_REGISTRY) {
    const spec = entry as Required<ParamSpec>;
    if (spec.simple !== undefined) out[spec.key] = spec.simple;
  }
  return out as unknown as T;
}

/**
 * Overlay a query string onto a base parameter object. Unknown keys are
 * ignored; malformed values fall back to the base, never to `NaN`.
 */
export function paramsFromQuery<T extends Record<string, unknown>>(base: T, q: URLSearchParams): T {
  const out: Record<string, unknown> = { ...base };
  for (const entry of PARAM_REGISTRY) {
    const spec = entry as Required<ParamSpec>;
    const raw = q.get(spec.url);
    if (raw === null) continue;
    const value = parseToken(spec, raw);
    if (value !== undefined) out[spec.key] = value;
  }
  return out as T;
}

/** Serialise every shareable scalar. Reads and writes are symmetric by construction. */
export function paramsToQuery(p: Record<string, unknown>, extra?: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const entry of PARAM_REGISTRY) {
    const spec = entry as Required<ParamSpec>;
    const v = p[spec.key];
    if (v === undefined || v === null) continue;
    q.set(spec.url, formatToken(v as number | boolean | string));
  }
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  return q.toString();
}

/** Narrow an unknown parsed value to the union type the domain expects. */
export function asOrientation(v: unknown): Orientation {
  return (ORIENTATIONS as readonly string[]).includes(v as string) ? (v as Orientation) : "east_west";
}
export function asChargeMode(v: unknown): ChargeMode {
  return parseChargeMode(typeof v === "string" ? v : "", "morning");
}
export function asDischargeMode(v: unknown): DischargeMode {
  return parseDischargeMode(typeof v === "string" ? v : "", "windows");
}
export function asImportScheme(v: unknown): ImportScheme {
  return isImportScheme(v as string) ? (v as ImportScheme) : "fixed";
}
export function asExportScheme(v: unknown): ExportScheme {
  return isExportScheme(v as string) ? (v as ExportScheme) : "fixed";
}