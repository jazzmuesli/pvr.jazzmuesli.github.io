/**
 * The consumer and car parameter groups, as registries.
 *
 * These two groups are nested objects rather than flat scalars, but they had
 * the same disease: hand-written URL keys in `ui/url.ts` and again in
 * `calc/report.ts`, hand-written defaults in three places, and no route by
 * which adding a fifth consumer or a new car input could avoid touching the
 * URL codec, the control panel, the chatbot schema and the Excel export.
 *
 * The table below is the seam. Adding a consumer is now one row here plus its
 * load profile in `calc/consumers.ts`; the URL keys, defaults and round-trip
 * tests follow automatically, and `tests/conformance.test.ts` fails until the
 * report, the charts and the workbook know about it.
 */

import type { ConsumerConfig } from "../calc/consumers";
import { DEFAULT_CAR_PARAMS, type CarParams } from "../calc/car";
import { parseToken, formatToken, type ParamSpec } from "./params";

export interface ConsumerSpec extends ParamSpec {
  /** Field name on `ConsumerConfig` — the spec's identity. */
  key: string;
  /** Two-letter URL prefix, so consumer keys cannot collide with scalars. */
  urlPrefix: string;
  /** The i18n key for this consumer's colour / legend entry. */
  labelKey: string;
  /** Chart colour, allocated once so every chart agrees. */
  color: string;
}

/**
 * The consumer registry.
 *
 * `report.ts`, `consumers.ts`, `ui/charts.ts` and the Excel workbook all read
 * the set of consumers from here instead of hard-coding `household`, `heatpump`,
 * `bwwp`, `ev` in twenty files.
 */
export const CONSUMER_SPECS: readonly ConsumerSpec[] = [
  {
    key: "household", urlPrefix: "h", labelKey: "consumer.household", color: "#0ea5e9",
    url: "hh", kind: "boolean", default: true, group: "consumer",
  },
  {
    key: "heatpump", urlPrefix: "w", labelKey: "consumer.heatpump", color: "#ef4444",
    url: "wp", kind: "boolean", default: true, group: "consumer",
  },
  {
    key: "bwwp", urlPrefix: "bw", labelKey: "consumer.bwwp", color: "#f59e0b",
    url: "bw", kind: "boolean", default: true, group: "consumer",
  },
  {
    key: "ev", urlPrefix: "e", labelKey: "consumer.ev", color: "#8b5cf6",
    url: "ev", kind: "boolean", default: true, group: "consumer",
  },
];

export const CONSUMER_KEYS: readonly string[] = CONSUMER_SPECS.map((c) => c.key);

/** URL key for a consumer's `enabled` flag. */
export function consumerEnabledUrl(spec: ConsumerSpec): string {
  return spec.key === "household" ? spec.url : spec.url;
}

/** URL key for a consumer's annual consumption. */
export function consumerKwhUrl(spec: ConsumerSpec): string {
  return `${spec.urlPrefix}k`;
}

export function consumerParamsToQuery(consumers: ConsumerConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of CONSUMER_SPECS) {
    const c = (consumers as unknown as Record<string, { enabled: boolean; annualKWh?: number; pvShare?: number }>)[spec.key];
    if (!c) continue;
    out[consumerEnabledUrl(spec)] = formatToken(c.enabled);
    if (c.annualKWh !== undefined) out[consumerKwhUrl(spec)] = formatToken(c.annualKWh);
    if (c.pvShare !== undefined) out[`${spec.urlPrefix}s`] = formatToken(c.pvShare);
  }
  return out;
}

export function consumerParamsFromQuery(base: ConsumerConfig, q: URLSearchParams): ConsumerConfig {
  const out = { ...base } as ConsumerConfig;
  for (const spec of CONSUMER_SPECS) {
    const target = (out as unknown as Record<string, { enabled: boolean; annualKWh?: number; pvShare?: number }>)[spec.key];
    if (!target) continue;
    const enabled = parseToken({ kind: "boolean", url: spec.url, key: spec.key, default: true, group: "consumer" }, q.get(spec.url));
    if (enabled !== undefined) target.enabled = enabled as boolean;
    const kwh = parseToken({ kind: "number", url: consumerKwhUrl(spec), key: `${spec.key}KWh`, default: target.annualKWh ?? 0, group: "consumer" }, q.get(consumerKwhUrl(spec)));
    if (kwh !== undefined) target.annualKWh = kwh as number;
    if (target.pvShare !== undefined) {
      const share = parseToken({ kind: "number", url: `${spec.urlPrefix}s`, key: `${spec.key}Share`, default: target.pvShare, group: "consumer" }, q.get(`${spec.urlPrefix}s`));
      if (share !== undefined) target.pvShare = share as number;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------

export interface CarSpec extends ParamSpec {
  /** Field on `CarParams` — the spec's identity. */
  carKey: keyof CarParams;
}

export const CAR_SPECS = [
  { carKey: "annualKm", url: "km", kind: "number", default: DEFAULT_CAR_PARAMS.annualKm, min: 0, group: "consumer" },
  { carKey: "dieselEurPerL", url: "dl", kind: "number", default: DEFAULT_CAR_PARAMS.dieselEurPerL, min: 0, group: "consumer" },
  { carKey: "evElectricCtPerKwh", url: "ec", kind: "number", default: DEFAULT_CAR_PARAMS.evElectricCtPerKwh, min: 0, group: "consumer" },
] as const satisfies readonly CarSpec[];

export function carParamsToQuery(car: CarParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of CAR_SPECS) out[spec.url] = formatToken(car[spec.carKey] as number);
  return out;
}

export function carParamsFromQuery(base: CarParams, q: URLSearchParams): CarParams {
  const out = { ...base };
  for (const spec of CAR_SPECS) {
    const v = parseToken(spec, q.get(spec.url));
    if (v !== undefined) (out as Record<string, number>)[spec.carKey as string] = v as number;
  }
  return out;
}