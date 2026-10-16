import { SimConfig } from "../calc/types";
import { LOCATIONS, DEFAULT_LOCATION } from "../calc/solar";
import { totalLoad } from "../calc/consumers";
import { SimParams, DEFAULT_SIM_PARAMS } from "../calc/report";
import { DEFAULT_CAR_PARAMS } from "../calc/car";

export type Orientation = "south" | "east" | "west" | "east_west";

/**
 * The UI state is the simulation configuration plus the presentation-only
 * `expertMode` flag. Deriving it from `SimParams` means the two models can no
 * longer drift: a new simulation parameter is automatically part of the UI
 * state too, and only needs a control and (optionally) a shared-link entry.
 *
 * `orientation` is narrowed to the orientations the wizard exposes (the engine
 * accepts `north` as well, for callers of the API).
 */
export interface AppState extends Omit<SimParams, "orientation"> {
  expertMode: boolean;
  orientation: Orientation;
}

/**
 * UI defaults. Built from `DEFAULT_SIM_PARAMS` so the browser and the engine
 * agree on every field that is not explicitly overridden here (the UI ships a
 * larger example system than the bare engine default).
 */
export const DEFAULT_STATE: AppState = {
  ...DEFAULT_SIM_PARAMS,
  expertMode: false,
  peakKWp: 22,
  orientation: "east_west",
  location: "boizenburg",
  capacityKWh: 19.353,
  maxPowerKW: 6,
  maxSOC: 0.95,
  dischargeMorning: true,
  eveningEnd: 23,
  morningStart: 5,
  morningEnd: 12,
  windSpeedMeanMs: 6.0,
  // Fresh nested objects so the UI defaults never alias the engine defaults.
  consumers: {
    household: { ...DEFAULT_SIM_PARAMS.consumers.household },
    heatpump: { ...DEFAULT_SIM_PARAMS.consumers.heatpump },
    bwwp: { ...DEFAULT_SIM_PARAMS.consumers.bwwp },
    ev: { ...DEFAULT_SIM_PARAMS.consumers.ev },
  },
  car: { ...DEFAULT_CAR_PARAMS },
};

/** Map the UI state onto the pure simulation parameters. */
export function toSimParams(s: AppState): SimParams {
  // In simple mode the battery is described by capacity alone; the expert mode
  // exposes every knob. Either way the mapping is a spread plus the overrides,
  // so a new field needs no change here.
  const { expertMode, ...base } = s;
  const cap = s.capacityKWh;
  return {
    ...base,
    maxPowerKW: expertMode ? s.maxPowerKW : Math.min(cap * 0.33, 20),
    minSOC: expertMode ? s.minSOC : 0.1,
    maxSOC: expertMode ? s.maxSOC : 0.95,
    efficiency: expertMode ? s.efficiency : 0.95,
    startSOC: expertMode ? s.startSOC : 0.5,
    chargeMode: expertMode ? s.chargeMode : "morning",
    dischargeMode: expertMode ? s.dischargeMode : "windows",
    dischargeEvening: expertMode ? s.dischargeEvening : true,
    dischargeMorning: expertMode ? s.dischargeMorning : true,
    eveningStart: expertMode ? s.eveningStart : 17,
    eveningEnd: expertMode ? s.eveningEnd : 23,
    morningStart: expertMode ? s.morningStart : 5,
    morningEnd: expertMode ? s.morningEnd : 12,
    // The heat pump pays the household tariff unless the expert sets a WP rate.
    heatpumpElectricCt: s.importFixedCt,
    car: { ...s.car },
  };
}

export function toSimConfig(s: AppState): SimConfig {
  const hasBattery = s.capacityKWh > 0;
  return {
    pv: {
      peakKWp: s.peakKWp,
      tiltDeg: s.tiltDeg,
      orientation: s.orientation,
      location: s.location in LOCATIONS ? s.location : DEFAULT_LOCATION,
    },
    battery: {
      capacityKWh: s.capacityKWh,
      maxPowerKW: s.maxPowerKW,
      minSOC: s.minSOC,
      maxSOC: s.maxSOC,
      efficiency: s.efficiency,
      startSOC: s.startSOC,
      chargeMode: s.chargeMode,
      dischargeMode: s.dischargeMode,
      dischargeEvening: hasBattery && s.dischargeEvening,
      dischargeMorning: hasBattery && s.dischargeMorning,
      eveningStart: s.eveningStart,
      eveningEnd: s.eveningEnd,
      morningStart: s.morningStart,
      morningEnd: s.morningEnd,
    },
    tariff: {
      feedInEUR: s.feedInCt / 100,
      commissioningYear: s.commissioningYear,
    },
    load: totalLoad(s.consumers),
  };
}
