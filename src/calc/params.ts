// Single source of truth for the *configuration surface* of the simulator.
//
// Historically every new parameter had to be added in four places that could
// (and did) drift apart:
//   * `SimParams` + `DEFAULT_SIM_PARAMS`   (the simulation contract)
//   * `simParamsFromQuery`                 (the `/api` wire format)
//   * `AppState` + `DEFAULT_STATE`         (the UI model)
//   * `serializeState`/`deserializeState`  (the shared-link wire format)
//
// Adding a parameter meant touching ~7 files on average, and the two wire
// formats had already silently diverged (a shared link lost the car settings,
// the heat-pump JAZ and the Direktvermarkter margin). This module collapses the
// *wiring* into one declarative table of fields, so a new parameter is one
// entry here plus its default. The web formats are then derived, not hand-coded.
//
// The fields describe *where* a value lives (a dotted path) and how it is
// encoded. Defaults stay with the consumer (`DEFAULT_SIM_PARAMS`,
// `DEFAULT_STATE`) so the same schema can serve both without forcing one set of
// defaults on the other.

import { parseChargeMode, parseDischargeMode } from "./types";

export type ParamKind = "num" | "bool" | "str";

/** Normalisation applied to a raw string value before it is stored. */
export type ParamTransform = "chargeMode" | "dischargeMode";

export interface ParamField {
  /** Dotted path into the target object, e.g. `consumers.ev.annualKWh`. */
  path: string;
  /** Query-string key, e.g. `ek`. */
  key: string;
  kind: ParamKind;
  /** Optional enum normaliser (unknown values fall back to the current value). */
  transform?: ParamTransform;
}

/**
 * Every scalar / nested field of the configuration, in the order used for the
 * shared-link URL. Consumers, producers and markets may each contribute fields;
 * they are kept together here so the codec stays a pure description.
 */
export const SIM_PARAM_FIELDS: readonly ParamField[] = [
  // PV (producer)
  { path: "peakKWp", key: "kwp", kind: "num" },
  { path: "tiltDeg", key: "tilt", kind: "num" },
  { path: "orientation", key: "o", kind: "str" },
  { path: "location", key: "loc", kind: "str" },
  // Battery
  { path: "capacityKWh", key: "cap", kind: "num" },
  { path: "maxPowerKW", key: "pwr", kind: "num" },
  { path: "minSOC", key: "minsoc", kind: "num" },
  { path: "maxSOC", key: "maxsoc", kind: "num" },
  { path: "efficiency", key: "eff", kind: "num" },
  { path: "startSOC", key: "soc0", kind: "num" },
  { path: "chargeMode", key: "charge", kind: "str", transform: "chargeMode" },
  { path: "dischargeMode", key: "dsp", kind: "str", transform: "dischargeMode" },
  { path: "dischargeEvening", key: "de", kind: "bool" },
  { path: "dischargeMorning", key: "dm", kind: "bool" },
  { path: "eveningStart", key: "evs", kind: "num" },
  { path: "eveningEnd", key: "eve", kind: "num" },
  { path: "morningStart", key: "mns", kind: "num" },
  { path: "morningEnd", key: "mne", kind: "num" },
  // Tariff / markets
  { path: "feedInCt", key: "fi", kind: "num" },
  { path: "commissioningYear", key: "yr", kind: "num" },
  { path: "priceYear", key: "py", kind: "str" },
  { path: "exportScheme", key: "ex", kind: "str" },
  { path: "importScheme", key: "im", kind: "str" },
  { path: "importFixedCt", key: "ict", kind: "num" },
  { path: "marketMarginCt", key: "mm", kind: "num" },
  // Investment + lifecycle economics
  { path: "investmentEUR", key: "inv", kind: "num" },
  { path: "horizonYears", key: "hor", kind: "num" },
  { path: "discountRatePct", key: "d", kind: "num" },
  { path: "priceEscalationPct", key: "esc", kind: "num" },
  { path: "omPercentPerYear", key: "om", kind: "num" },
  { path: "inverterLifetimeYears", key: "invlife", kind: "num" },
  { path: "inverterReplacementCostEUR", key: "invrep", kind: "num" },
  { path: "batteryLifetimeYears", key: "batlife", kind: "num" },
  { path: "batteryReplacementCostEUR", key: "batrep", kind: "num" },
  { path: "batteryDegradationPct", key: "batdeg", kind: "num" },
  { path: "pvDegradationPct", key: "pvdeg", kind: "num" },
  { path: "standbyWattage", key: "stdby", kind: "num" },
  // Heating
  { path: "heatpumpJaz", key: "jaz", kind: "num" },
  { path: "heatpumpElectricCt", key: "wpc", kind: "num" },
  // Consumers
  { path: "consumers.household.enabled", key: "hh", kind: "bool" },
  { path: "consumers.household.annualKWh", key: "hk", kind: "num" },
  { path: "consumers.heatpump.enabled", key: "wp", kind: "bool" },
  { path: "consumers.heatpump.annualKWh", key: "wk", kind: "num" },
  { path: "consumers.bwwp.enabled", key: "bw", kind: "bool" },
  { path: "consumers.bwwp.annualKWh", key: "bwk", kind: "num" },
  { path: "consumers.ev.enabled", key: "ev", kind: "bool" },
  { path: "consumers.ev.annualKWh", key: "ek", kind: "num" },
  { path: "consumers.ev.pvShare", key: "es", kind: "num" },
  // Car / mobility (opportunity costs)
  { path: "car.annualKm", key: "km", kind: "num" },
  { path: "car.evKwhPer100km", key: "ev100", kind: "num" },
  { path: "car.evElectricCtPerKwh", key: "ec", kind: "num" },
  { path: "car.evMaintenanceCtPerKm", key: "evmaint", kind: "num" },
  { path: "car.evVehicleTaxEUR", key: "evtax", kind: "num" },
  { path: "car.evOtherNebenkostenEUR", key: "evother", kind: "num" },
  { path: "car.dieselLPer100km", key: "dl100", kind: "num" },
  { path: "car.dieselEurPerL", key: "dl", kind: "num" },
  { path: "car.dieselMaintenanceCtPerKm", key: "dmaint", kind: "num" },
  { path: "car.dieselVehicleTaxEUR", key: "dtax", kind: "num" },
  { path: "car.dieselOtherNebenkostenEUR", key: "dother", kind: "num" },
  // Kleinstwindkraft (producer)
  { path: "windEnabled", key: "wen", kind: "bool" },
  { path: "windCount", key: "wc", kind: "num" },
  { path: "windHubHeightM", key: "wh", kind: "num" },
  { path: "windTurbineId", key: "wt", kind: "str" },
  { path: "windSpeedMeanMs", key: "wsm", kind: "num" },
];

/** UI-only fields that are not part of `SimParams` but live in `AppState`. */
export const UI_ONLY_FIELDS: readonly ParamField[] = [
  { path: "expertMode", key: "expert", kind: "bool" },
];

export const ALL_PARAM_FIELDS: readonly ParamField[] = [...UI_ONLY_FIELDS, ...SIM_PARAM_FIELDS];

// ---- generic access --------------------------------------------------------

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
  return cur;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function decode(field: ParamField, raw: string, current: unknown): unknown {
  switch (field.kind) {
    case "num": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : current;
    }
    case "bool":
      return raw === "1" || raw === "true";
    case "str": {
      if (field.transform === "chargeMode") {
        return parseChargeMode(raw, current as ReturnType<typeof parseChargeMode>);
      }
      if (field.transform === "dischargeMode") {
        return parseDischargeMode(raw, current as ReturnType<typeof parseDischargeMode>);
      }
      return raw;
    }
  }
}

function encode(field: ParamField, value: unknown): string | null {
  switch (field.kind) {
    case "num": {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : null;
    }
    case "bool":
      return value ? "1" : "0";
    case "str":
      return value === undefined || value === null ? null : String(value);
  }
}

/**
 * Parse a query string into a *new* object shaped like `base`, starting from a
 * deep clone of `base` so the caller's defaults are never mutated. Missing or
 * empty keys keep the base value.
 */
export function parseParams<T extends object>(
  base: T,
  q: URLSearchParams,
  fields: readonly ParamField[] = SIM_PARAM_FIELDS,
): T {
  const out = deepClone(base) as Record<string, unknown>;
  for (const field of fields) {
    const raw = q.get(field.key);
    if (raw === null || raw === "") continue;
    setPath(out, field.path, decode(field, raw, getPath(out, field.path)));
  }
  return out as T;
}

/** Serialise a configuration object to a query string via the shared schema. */
export function serializeParams(
  obj: object,
  fields: readonly ParamField[] = SIM_PARAM_FIELDS,
): URLSearchParams {
  const out = new URLSearchParams();
  for (const field of fields) {
    const v = getPath(obj as Record<string, unknown>, field.path);
    if (v === undefined || v === null) continue;
    const s = encode(field, v);
    if (s !== null) out.set(field.key, s);
  }
  return out;
}
