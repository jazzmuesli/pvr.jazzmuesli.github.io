/**
 * The SPA's application state.
 *
 * `AppState` is `CoreParams` plus the two nested parameter groups (`consumers`
 * and `car`) plus one UI flag. There is no second list of scalars, and no
 * second list of defaults: both come from `domain/params.ts`.
 */

import { DischargeMode, SimConfig } from "../calc/types";
import { LOCATIONS, DEFAULT_LOCATION } from "../calc/solar";
import { ConsumerConfig, totalLoad, DEFAULT_CONSUMERS } from "../calc/consumers";
import { TariffScheme } from "../calc/tariff";
import { SimParams } from "../calc/report";
import { CarParams, DEFAULT_CAR_PARAMS } from "../calc/car";
import {
  CoreParams,
  defaultCoreParams,
  applyExpertDefaults,
  asChargeMode,
  asDischargeMode,
  asExportScheme,
  asImportScheme,
  asOrientation,
} from "../domain/params";

export type Orientation = CoreParams["orientation"];
export type ImportScheme = TariffScheme;

export interface AppState extends CoreParams {
  /** Not part of the simulation; drives which controls are visible. */
  expertMode: boolean;
  consumers: ConsumerConfig;
  car: CarParams;
}

/** The one default configuration. `/api?` with no query returns exactly this. */
export const DEFAULT_STATE: AppState = {
  ...defaultCoreParams(),
  expertMode: false,
  consumers: JSON.parse(JSON.stringify(DEFAULT_CONSUMERS)) as ConsumerConfig,
  car: { ...DEFAULT_CAR_PARAMS },
};

/** Rehydrate a parsed object (URL, storage) into a complete, well-typed state. */
export function coerceState(raw: Record<string, unknown>): AppState {
  const base = DEFAULT_STATE;
  const state: AppState = { ...base, consumers: { ...base.consumers }, car: { ...base.car } };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "consumers" || key === "car") continue;
    if (key === "expertMode") {
      state.expertMode = value === true || value === "1" || value === "true";
      continue;
    }
    if (!(key in base)) continue;
    switch (key) {
      case "orientation":
        state.orientation = asOrientation(value);
        break;
      case "chargeMode":
        state.chargeMode = asChargeMode(value);
        break;
      case "dischargeMode":
        state.dischargeMode = asDischargeMode(value);
        break;
      case "importScheme":
        state.importScheme = asImportScheme(value);
        break;
      case "exportScheme":
        state.exportScheme = asExportScheme(value);
        break;
      case "dischargeEvening":
      case "dischargeMorning":
      case "windEnabled":
        (state as unknown as Record<string, unknown>)[key] = value === true || value === "1" || value === "true";
        break;
      default: {
        // Only numeric fields are coerced; enums and free strings (`priceYear`,
        // `windTurbineId`, `location`) must survive as the strings they are.
        if (typeof value === "string" && typeof base[key as keyof AppState] === "number") {
          const n = Number(value);
          if (Number.isFinite(n)) (state as unknown as Record<string, unknown>)[key] = n;
        } else if (typeof base[key as keyof AppState] === "string") {
          (state as unknown as Record<string, unknown>)[key] = String(value);
        } else if (typeof value === "number") {
          (state as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  return state;
}

/**
 * Map the UI state onto the pure simulation parameters.
 *
 * Two things happen here and nowhere else:
 *  1. the simple-mode derivations (see `applyExpertDefaults`), and
 *  2. the one genuinely derived simulation input — the heat pump's electricity
 *     price, which is the import tariff, because a heat pump is just a grid
 *     consumer. `SimParams.heatpumpElectricCt` stays available for API callers
 *     who set it explicitly.
 */
export function toSimParams(s: AppState): SimParams {
  const core = applyExpertDefaults(s, s.expertMode);
  const { expertMode: _expertMode, ...rest } = core;
  return {
    ...rest,
    orientation: asOrientation(rest.orientation),
    chargeMode: asChargeMode(rest.chargeMode),
    dischargeMode: asDischargeMode(rest.dischargeMode),
    exportScheme: asExportScheme(rest.exportScheme),
    importScheme: asImportScheme(rest.importScheme),
    consumers: s.consumers,
    // The opportunity-cost module compares the EV against diesel over the same
    // distance, so when the EV is on, the distance comes from its energy use
    // (kWh x 100 / kWh-per-100km) rather than from a separate input.
    car: {
      ...s.car,
      annualKm: s.consumers.ev.enabled && s.consumers.ev.annualKWh > 0
        ? Math.round((s.consumers.ev.annualKWh * 100) / s.car.evKwhPer100km)
        : s.car.annualKm,
    },
    heatpumpElectricCt: s.importFixedCt,
  };
}

/** Convenience for the control panel's live hints. */
export function toSimConfig(s: AppState): SimConfig {
  const p = toSimParams(s);
  const hasBattery = p.capacityKWh > 0;
  return {
    pv: {
      peakKWp: p.peakKWp,
      tiltDeg: p.tiltDeg,
      orientation: p.orientation,
      location: p.location in LOCATIONS ? p.location : DEFAULT_LOCATION,
    },
    battery: {
      capacityKWh: p.capacityKWh,
      maxPowerKW: p.maxPowerKW,
      minSOC: p.minSOC,
      maxSOC: p.maxSOC,
      efficiency: p.efficiency,
      startSOC: p.startSOC,
      chargeMode: p.chargeMode,
      dischargeMode: p.dischargeMode,
      dischargeEvening: hasBattery && p.dischargeEvening,
      dischargeMorning: hasBattery && p.dischargeMorning,
      eveningStart: p.eveningStart,
      eveningEnd: p.eveningEnd,
      morningStart: p.morningStart,
      morningEnd: p.morningEnd,
    },
    tariff: {
      feedInEUR: p.feedInCt / 100,
      commissioningYear: p.commissioningYear,
    },
    load: totalLoad(p.consumers),
  };
}

export type { DischargeMode };