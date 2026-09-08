// Gas savings calculation for heat pump vs. direct gas heating.
//
// Compares the gas consumption of two scenarios:
//  1. Heat pump: uses grid electricity (mixed sources) to deliver useful heat
//  2. Direct gas: burns natural gas in a condensing boiler for the same heat
//
// The "gas saved" depends on WHERE the heat pump's electricity comes from:
//  - Self-consumed PV (direct + battery): zero gas consumed → full gas savings
//  - Wind/solar grid import: zero gas consumed by the grid → full gas savings
//  - Gas power plants: burn gas at ~45% efficiency → partial gas savings
//  - Coal power plants: burn coal → no gas saved on the grid side
//
// With a battery + dynamic tariff, the heat pump shifts load to cheap hours
// with high renewable share, improving gas savings vs. a fixed tariff.

import { TOTAL_STEPS, monthOfStep } from "./types";
import {
  electricityMixForStep,
} from "./electricityMix";

// ---------------------------------------------------------------------------
// Default efficiency assumptions
// ---------------------------------------------------------------------------

/** Modern gas power plant efficiency (CCGT, German average). */
export const DEFAULT_GAS_POWERPLANT_EFFICIENCY = 0.45;

/** Condensing gas boiler efficiency. */
export const DEFAULT_GAS_BOILER_EFFICIENCY = 0.92;

/** Default Jahresarbeitszahl (JAZ) of the heat pump. */
export const DEFAULT_JAZ = 3.0;

/** Gas price in ct/kWh (for cost calculations). */
export const DEFAULT_GAS_PRICE_CT = 11;

export interface GasSavingsParams {
  /** Annual heat pump electricity consumption in kWh. */
  heatpumpElectricKWh: number;
  /** JAZ (Jahresarbeitszahl), default 3.0. */
  jaz: number;
  /** Gas power plant efficiency, default 0.45. */
  gasPowerplantEfficiency: number;
  /** Gas boiler efficiency, default 0.92. */
  gasBoilerEfficiency: number;
  /** Gas price in ct/kWh, default 11. */
  gasPriceCtPerKWh: number;
}

export const DEFAULT_GAS_SAVINGS_PARAMS: Omit<GasSavingsParams, "heatpumpElectricKWh"> = {
  jaz: DEFAULT_JAZ,
  gasPowerplantEfficiency: DEFAULT_GAS_POWERPLANT_EFFICIENCY,
  gasBoilerEfficiency: DEFAULT_GAS_BOILER_EFFICIENCY,
  gasPriceCtPerKWh: DEFAULT_GAS_PRICE_CT,
};

export interface GasSavingsBySource {
  windKWh: number;
  solarKWh: number;
  gasKWh: number;
  coalKWh: number;
  biomassKWh: number;
  hydroKWh: number;
  otherKWh: number;
}

export interface GasSavingsReport {
  heatpumpElectricKWh: number;
  jaz: number;
  usefulHeatKWh: number;
  gasDirectKWh: number;
  gasForElectricityKWh: number;
  gasSavedKWh: number;
  co2SavedKg: number;
  costSavedEUR: number;
  bySource: GasSavingsBySource;
  zeroGasSharePct: number;
  monthly: GasSavingsMonthlyRow[];
}

export interface GasSavingsMonthlyRow {
  month: number;
  electricKWh: number;
  usefulHeatKWh: number;
  gasDirectKWh: number;
  gasForElectricityKWh: number;
  gasSavedKWh: number;
  zeroGasSharePct: number;
}

/**
 * Calculate gas savings from using a heat pump instead of direct gas heating.
 *
 * When `gridImport` and `totalLoad` are provided (from the simulation result),
 * the function computes the per-consumer PV/grid split: the HP's load is
 * proportionally allocated between PV (self-consumed + battery) and grid.
 * PV-covered electricity burns zero gas on the grid, maximizing savings.
 * This correctly reflects load shifting with dynamic tariffs + battery.
 *
 * Without those arrays (fallback), the function uses the hourly grid mix
 * for the full HP load, which is less accurate but still valid.
 */
export function computeGasSavings(
  heatpumpLoadPerStep: Float64Array,
  params: GasSavingsParams,
  gridImport?: Float64Array,
  totalLoad?: Float64Array,
): GasSavingsReport {
  const { jaz, gasPowerplantEfficiency, gasBoilerEfficiency, gasPriceCtPerKWh } = params;

  const hasDispatch = gridImport != null && totalLoad != null;

  // Useful heat per step = electricity × JAZ
  const usefulHeatPerStep = new Float64Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) {
    usefulHeatPerStep[i] = heatpumpLoadPerStep[i] * jaz;
  }

  // Gas needed per step for direct boiler: usefulHeat / boilerEfficiency
  const gasDirectPerStep = new Float64Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) {
    gasDirectPerStep[i] = usefulHeatPerStep[i] / gasBoilerEfficiency;
  }

  // Gas burned by power plants per step for the HP's GRID-IMPORTED electricity.
  const gasForElecPerStep = new Float64Array(TOTAL_STEPS);
  const bySource: GasSavingsBySource = { windKWh: 0, solarKWh: 0, gasKWh: 0, coalKWh: 0, biomassKWh: 0, hydroKWh: 0, otherKWh: 0 };

  // Monthly accumulators
  const monthlyElectric = new Array(12).fill(0);
  const monthlyUsefulHeat = new Array(12).fill(0);
  const monthlyGasDirect = new Array(12).fill(0);
  const monthlyGasForElec = new Array(12).fill(0);
  const monthlyZeroGas = new Array(12).fill(0);

  for (let i = 0; i < TOTAL_STEPS; i++) {
    const hpLoad = heatpumpLoadPerStep[i];
    const m = monthOfStep(i) - 1;

    // Determine the HP's grid-imported electricity for this step.
    // With dispatch info: proportional allocation (HP share of total load × grid import)
    // Without: assume full load is grid-imported (conservative fallback)
    let hpGridKWh = hpLoad;
    if (hasDispatch && totalLoad![i] > 0) {
      const hpShare = hpLoad / totalLoad![i];
      hpGridKWh = hpShare * gridImport![i];
    }
    // PV-covered = total HP load - grid imported (self-consumed PV + battery)
    const hpPvKWh = hpLoad - hpGridKWh;

    const mix = electricityMixForStep(i);

    // Gas burned by gas power plants for the HP's grid-imported electricity
    const gasElec = (hpGridKWh * mix.gas) / gasPowerplantEfficiency;
    gasForElecPerStep[i] = gasElec;

    // PV-covered electricity: zero gas burned on the grid → full gas savings
    // Each kWh of PV electricity displaces jaz/boilerEff kWh of gas.
    bySource.solarKWh += hpPvKWh * (jaz / gasBoilerEfficiency);

    // Grid-imported electricity: use the hourly mix to allocate by source
    bySource.windKWh += hpGridKWh * mix.wind * (jaz / gasBoilerEfficiency);
    bySource.gasKWh += hpGridKWh * mix.gas * (jaz / gasBoilerEfficiency - 1 / gasPowerplantEfficiency);
    bySource.coalKWh += hpGridKWh * mix.coal * (jaz / gasBoilerEfficiency);
    bySource.biomassKWh += hpGridKWh * mix.biomass * (jaz / gasBoilerEfficiency);
    bySource.hydroKWh += hpGridKWh * mix.hydro * (jaz / gasBoilerEfficiency);
    bySource.otherKWh += hpGridKWh * mix.other * (jaz / gasBoilerEfficiency);

    // Monthly
    monthlyElectric[m] += hpLoad;
    monthlyUsefulHeat[m] += usefulHeatPerStep[i];
    monthlyGasDirect[m] += gasDirectPerStep[i];
    monthlyGasForElec[m] += gasElec;
    monthlyZeroGas[m] += hpPvKWh + hpGridKWh * (mix.wind + mix.biomass + mix.hydro + mix.other);
  }

  // Totals
  const totalElectricKWh = monthlyElectric.reduce((a, b) => a + b, 0);
  const totalUsefulHeatKWh = monthlyUsefulHeat.reduce((a, b) => a + b, 0);
  const totalGasDirectKWh = monthlyGasDirect.reduce((a, b) => a + b, 0);
  const totalGasForElecKWh = monthlyGasForElec.reduce((a, b) => a + b, 0);
  const totalGasSavedKWh = totalGasDirectKWh - totalGasForElecKWh;

  const co2SavedKg = totalGasSavedKWh * 0.201;
  const costSavedEUR = (totalGasSavedKWh * gasPriceCtPerKWh) / 100;

  // Monthly rows
  const monthly: GasSavingsMonthlyRow[] = [];
  for (let m = 0; m < 12; m++) {
    const zeroGasShare = monthlyElectric[m] > 0
      ? (monthlyZeroGas[m] / monthlyElectric[m]) * 100
      : 0;
    monthly.push({
      month: m + 1,
      electricKWh: round2(monthlyElectric[m]),
      usefulHeatKWh: round2(monthlyUsefulHeat[m]),
      gasDirectKWh: round2(monthlyGasDirect[m]),
      gasForElectricityKWh: round2(monthlyGasForElec[m]),
      gasSavedKWh: round2(monthlyGasDirect[m] - monthlyGasForElec[m]),
      zeroGasSharePct: round2(zeroGasShare),
    });
  }

  const zeroGasSharePct = totalElectricKWh > 0
    ? round2((monthlyZeroGas.reduce((a, b) => a + b, 0) / totalElectricKWh) * 100)
    : 0;

  return {
    heatpumpElectricKWh: round2(totalElectricKWh),
    jaz,
    usefulHeatKWh: round2(totalUsefulHeatKWh),
    gasDirectKWh: round2(totalGasDirectKWh),
    gasForElectricityKWh: round2(totalGasForElecKWh),
    gasSavedKWh: round2(totalGasSavedKWh),
    co2SavedKg: round2(co2SavedKg),
    costSavedEUR: round2(costSavedEUR),
    bySource: {
      windKWh: round2(bySource.windKWh),
      solarKWh: round2(bySource.solarKWh),
      gasKWh: round2(bySource.gasKWh),
      coalKWh: round2(bySource.coalKWh),
      biomassKWh: round2(bySource.biomassKWh),
      hydroKWh: round2(bySource.hydroKWh),
      otherKWh: round2(bySource.otherKWh),
    },
    zeroGasSharePct,
    monthly,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
