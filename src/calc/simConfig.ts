// Map the flat `SimParams` configuration onto the engine's `SimConfig`.
//
// This is the single adapter between "what the user/API configured" and "what
// the dispatch engine consumes". Keeping it separate from the report
// orchestrator means the engine-facing shape can evolve (new producers, new
// storage) without dragging report assembly along.

import { SimConfig } from "./types";
import { getYearPrices } from "./priceData";
import { totalLoad } from "./consumers";
import { windProductionPerStep, WIND_TURBINE_MAP, DEFAULT_WIND_TURBINE, WIND_LOCATIONS } from "./wind";
import type { SimParams } from "./simParams";

/**
 * Build the engine config. Wind production is derived here (rather than inside
 * the engine) so the report — and later additional producers — can be added
 * without touching the dispatch core.
 */
export function toSimConfig(p: SimParams): SimConfig {
  const hasBattery = p.capacityKWh > 0;
  let wind: Float64Array | undefined;
  if (p.windEnabled && p.windCount > 0) {
    const baseLoc = WIND_LOCATIONS[p.location] ?? WIND_LOCATIONS.hamburg;
    const loc = { ...baseLoc, annualMeanWindMs: p.windSpeedMeanMs };
    const turbine = WIND_TURBINE_MAP[p.windTurbineId] ?? DEFAULT_WIND_TURBINE;
    wind = windProductionPerStep(turbine, loc, p.windHubHeightM);
    if (p.windCount > 1) {
      for (let i = 0; i < wind.length; i++) wind[i] *= p.windCount;
    }
  }
  return {
    pv: {
      peakKWp: p.peakKWp,
      tiltDeg: p.tiltDeg,
      orientation: p.orientation,
      location: p.location,
    },
    battery: {
      capacityKWh: hasBattery ? p.capacityKWh : 0,
      maxPowerKW: hasBattery ? p.maxPowerKW : 0,
      minSOC: hasBattery ? p.minSOC : 0,
      maxSOC: hasBattery ? p.maxSOC : 0,
      efficiency: hasBattery ? p.efficiency : 0,
      startSOC: hasBattery ? p.startSOC : 0,
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
    wind,
    prices: getYearPrices(p.priceYear),
    load: totalLoad(p.consumers),
  };
}
