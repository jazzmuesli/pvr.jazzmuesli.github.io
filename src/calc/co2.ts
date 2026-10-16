// CO₂ and electricity-mix analysis, extracted from the report orchestrator.
//
// Two related concerns live here:
//   * `computeGridMix` — the fuel mix of the electricity actually imported from
//     the grid (overall / heat pump / a hypothetical no-PV case).
//   * `computeCo2Analysis` — the emissions of seven scenarios that isolate the
//     contributions of PV, the EV and the heat pump.
//
// Both depend only on the simulated dispatch, the consumer loads and the
// opportunity-cost money figures, so they are pure functions of those inputs.

import { TOTAL_STEPS, SimResult } from "./types";
import { ConsumerLoads, annualSum } from "./consumers";
import { electricityMixForStep } from "./electricityMix";
import { DEFAULT_GAS_BOILER_EFFICIENCY } from "./heatpumpGasSavings";
import { OpportunityCosts } from "./opportunity";
import type { GridMix, GridMixShares, Co2Analysis, Co2Scenario } from "./reportModel";
import type { SimParams } from "./simParams";

/**
 * Emission factors in kg CO₂ per kWh of *electricity generated* (not per kWh
 * of primary fuel). Calibrated so that the modelled German grid mix
 * (`electricityMix.ts`) yields an annual average intensity of ≈ 0.39 kg/kWh,
 * matching the official German grid figure for 2023 (Umweltbundesamt: ~0.38 kg
 * CO₂/kWh, trending down). Earlier values used *fuel* factors (gas ≈ 1.0),
 * which over-counted electricity emissions by ~40 %.
 *
 * Note: the "coal" bucket in the mix model is a residual that absorbs all
 * remaining dispatchable/fossil generation (lignite + hard coal + gas peaks +
 * imports), so its factor (0.62) is a blended value between hard coal (~0.82)
 * and cleaner dispatchable sources rather than pure lignite (~1.0).
 */
export const CO2_EMISSION_FACTORS: GridMixShares = {
  wind: 0.011,   // lifecycle (turbine manufacture + O&M)
  solar: 0.045,  // lifecycle (module manufacture)
  gas: 0.38,     // CCGT electricity output (~0.35–0.40 kg/kWh_el)
  coal: 0.62,    // blended residual fossil/dispatchable bucket
  biomass: 0.23, // lifecycle for biomass electricity
  hydro: 0.006,  // lifecycle
  other: 0.35,   // waste incineration, geothermal, misc.
};

/**
 * CO2 emission factor for natural gas burned directly for heating, on a
 * well-to-burner basis. Direct combustion is ≈ 0.201 kg CO₂/kWh; adding the
 * ~15–20 % upstream (extraction, transport, methane leakage, in CO₂-equiv.)
 * gives ≈ 0.24 kg CO₂/kWh — consistent with the well-to-wheel diesel factor.
 */
export const CO2_GAS_DIRECT = 0.24; // kg CO₂/kWh (German gas, well-to-burner)

/**
 * CO2 emission factor for diesel on a *well-to-wheel* basis, **per litre of
 * fuel** (the physically meaningful unit, since a car burns litres, not the
 * EV's kWh). Tank-to-wheel combustion is ≈ 2.64 kg CO₂/litre; adding the ~20 %
 * upstream well-to-tank emissions (extraction, refining, transport) gives
 * ≈ 3.17 kg CO₂/litre.
 *
 * NOTE: diesel CO2 must be computed from the diesel car's *own* consumption
 * (litres/100 km, ~5.5 l), NOT from the EV's 17 kWh/100 km. A diesel burns
 * ~55 kWh of chemical energy per 100 km, so charging the diesel with the EV's
 * 17 kWh/100 km silently erased the drivetrain-efficiency gap and made the EV
 * look dirtier than diesel — which is physically wrong.
 */
export const CO2_DIESEL_PER_L = 3.17; // kg CO₂/litre diesel (well-to-wheel)

/**
 * Legacy per-kWh diesel factor, kept for the UI tooltip only. Diesel's lower
 * heating value is ≈ 9.8 kWh/litre, so 3.17 kg/L ÷ 9.8 kWh/L ≈ 0.32 kg/kWh.
 */
export const CO2_DIESEL = CO2_DIESEL_PER_L / 9.8; // ≈ 0.323 kg CO₂/kWh diesel

/** Gas heating: useful heat / boiler efficiency. */
export const GAS_HEAT_KWH_PER_KWH_USEFUL = 1 / DEFAULT_GAS_BOILER_EFFICIENCY; // ~1.087

function normalizeShares(shares: GridMixShares, total: number): GridMixShares {
  if (total <= 0) return { wind: 0, solar: 0, gas: 0, coal: 0, biomass: 0, hydro: 0, other: 0 };
  const s = 1 / total;
  return {
    wind: shares.wind * s,
    solar: shares.solar * s,
    gas: shares.gas * s,
    coal: shares.coal * s,
    biomass: shares.biomass * s,
    hydro: shares.hydro * s,
    other: shares.other * s,
  };
}

export function computeGridMix(loads: ConsumerLoads, result: SimResult): GridMix {
  const totalLoad = result.load;

  // --- Overall grid mix: weighted by grid import per step ---
  let overallW = { wind: 0, solar: 0, gas: 0, coal: 0, biomass: 0, hydro: 0, other: 0 };
  let overallTotal = 0;

  // --- HP grid mix: proportional HP share × grid import ---
  let hpW = { wind: 0, solar: 0, gas: 0, coal: 0, biomass: 0, hydro: 0, other: 0 };
  let hpTotal = 0;

  // --- Without PV/battery: all load is grid, weighted by hourly mix ---
  let noPvW = { wind: 0, solar: 0, gas: 0, coal: 0, biomass: 0, hydro: 0, other: 0 };
  let noPvTotal = 0;

  for (let i = 0; i < TOTAL_STEPS; i++) {
    const mix = electricityMixForStep(i);
    const gi = result.gridImport[i];
    const tl = totalLoad[i];

    // Overall
    if (gi > 0) {
      overallW.wind += gi * mix.wind;
      overallW.solar += gi * mix.solar;
      overallW.gas += gi * mix.gas;
      overallW.coal += gi * mix.coal;
      overallW.biomass += gi * mix.biomass;
      overallW.hydro += gi * mix.hydro;
      overallW.other += gi * mix.other;
      overallTotal += gi;
    }

    // HP (proportional allocation)
    const hpLoad = loads.heatpump[i];
    if (hpLoad > 0 && tl > 0) {
      const hpGrid = hpLoad * (gi / tl);
      hpW.wind += hpGrid * mix.wind;
      hpW.solar += hpGrid * mix.solar;
      hpW.gas += hpGrid * mix.gas;
      hpW.coal += hpGrid * mix.coal;
      hpW.biomass += hpGrid * mix.biomass;
      hpW.hydro += hpGrid * mix.hydro;
      hpW.other += hpGrid * mix.other;
      hpTotal += hpGrid;
    }

    // Without PV/battery: entire load is grid-imported
    if (tl > 0) {
      noPvW.wind += tl * mix.wind;
      noPvW.solar += tl * mix.solar;
      noPvW.gas += tl * mix.gas;
      noPvW.coal += tl * mix.coal;
      noPvW.biomass += tl * mix.biomass;
      noPvW.hydro += tl * mix.hydro;
      noPvW.other += tl * mix.other;
      noPvTotal += tl;
    }
  }

  return {
    heatpump: normalizeShares(hpW, hpTotal),
    overall: normalizeShares(overallW, overallTotal),
    withoutPv: normalizeShares(noPvW, noPvTotal),
  };
}

export function computeCo2Analysis(
  p: SimParams,
  loads: ConsumerLoads,
  result: SimResult,
  gridMix: GridMix,
  opportunityCosts: OpportunityCosts,
): Co2Analysis {
  const hpEnabled = p.consumers.heatpump.enabled;
  const evEnabled = p.consumers.ev.enabled;
  const hpKWh = hpEnabled ? p.consumers.heatpump.annualKWh : 0;
  const jaz = p.heatpumpJaz;
  const evKWh = evEnabled ? p.consumers.ev.annualKWh : 0;
  // Annual distance for the car comparison. When the EV is enabled, the
  // opportunity module derives the distance from the EV's annual kWh
  // (kWh × 100 / kWh-per-100km); the CO2 scenarios must use the SAME distance
  // so the diesel baseline and the EV replacement cover identical km. Falling
  // back to the raw param only when the EV is disabled.
  const annualKm = evEnabled && evKWh > 0
    ? Math.round((evKWh * 100) / p.car.evKwhPer100km)
    : p.car.annualKm;

  const sum = (arr: Float64Array) => annualSum(arr);

  // Household load (always present)
  const householdKWh = sum(loads.household);

  // Gas heating: useful heat / boiler efficiency
  const usefulHeatKWh = hpKWh * jaz;
  const gasForHeatKWh = usefulHeatKWh / DEFAULT_GAS_BOILER_EFFICIENCY;
  const gasHeatCo2Kg = gasForHeatKWh * CO2_GAS_DIRECT;

  // Diesel car: annual km × litres per 100 km × emission factor per litre.
  const dieselLitres = annualKm * p.car.dieselLPer100km / 100;
  const dieselCo2Kg = dieselLitres * CO2_DIESEL_PER_L;

  // Grid electricity CO2: use the actual grid import from simulation
  // weighted by the hourly mix (per-step integration for accuracy)
  const computeGridCo2 = (gridImportArr: Float64Array): number => {
    let co2 = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const gi = gridImportArr[i];
      if (gi <= 0) continue;
      const mix = electricityMixForStep(i);
      co2 += gi * (
        mix.wind * CO2_EMISSION_FACTORS.wind +
        mix.solar * CO2_EMISSION_FACTORS.solar +
        mix.gas * CO2_EMISSION_FACTORS.gas +
        mix.coal * CO2_EMISSION_FACTORS.coal +
        mix.biomass * CO2_EMISSION_FACTORS.biomass +
        mix.hydro * CO2_EMISSION_FACTORS.hydro +
        mix.other * CO2_EMISSION_FACTORS.other
      );
    }
    return co2;
  };

  // PV+Wind self-consumption: how much of the generation covers load directly.
  // Cap at total generation to avoid phantom self-consumption from initial battery SOC.
  const totalGenerationCO2 = sum(result.pv) + sum(result.wind);
  const selfConsumptionKWh = Math.min(
    totalGenerationCO2,
    sum(result.directUse) + sum(result.directUseWind) + sum(result.dischargeToLoadPV) + sum(result.dischargeToLoadWind),
  );

  // How much of the PV self-consumption is attributable to the *household*
  // (i.e. usable in the gas-heating scenarios that have no heat pump). We cap
  // it at the household demand so PV can never "save" more than the household
  // actually consumes.
  const householdPvKWh = Math.min(selfConsumptionKWh, householdKWh);

  // Grid-import money savings from PV, per €/kWh of the import tariff. Used to
  // credit the PV scenarios with the electricity cost they avoid.
  const importCtPerKWh = p.importScheme === "fixed"
    ? p.importFixedCt
    : (opportunityCosts.heating.coverage?.gridPriceCt ?? p.importFixedCt);
  const importEurPerKWh = importCtPerKWh / 100;

  // Money components from the (already-correct) opportunity-cost module.
  const gasHeatCostEUR = hpEnabled ? opportunityCosts.heating.gas.totalEUR : 0;
  const hpHeatCostEUR = hpEnabled ? opportunityCosts.heating.heatpump.totalEUR : 0;
  const dieselCostEUR = evEnabled ? opportunityCosts.car.diesel.totalEUR : 0;
  const evCostEUR = evEnabled ? opportunityCosts.car.ev.totalEUR : 0;

  // --- Scenario 1: Baseline — diesel car + gas heating + grid (no PV) -------
  const baselineGridKWh = householdKWh;
  const baselineGridCo2 = computeGridCo2_fromKWh(baselineGridKWh);
  const baseline = makeScenario(
    "Basis: Diesel + Gas + Netz",
    gasHeatCo2Kg,
    baselineGridCo2,
    dieselCo2Kg,
    0, 0, 0,
  );
  baseline.savedEUR = 0;

  // --- Scenario 2: + PV — diesel + gas + PV covers household deficit --------
  const pvHouseholdGridKWh = Math.max(0, householdKWh - householdPvKWh);
  const pvGridCo2 = computeGridCo2_fromKWh(pvHouseholdGridKWh);
  const plusPv = makeScenario(
    "+ PV: Diesel + Gas + PV",
    gasHeatCo2Kg,
    pvGridCo2,
    dieselCo2Kg,
    0,
    0,                           // gas unchanged vs. baseline → 0 saved
    householdPvKWh,              // grid kWh saved by PV
  );
  plusPv.savedEUR = Math.round(householdPvKWh * importEurPerKWh);

  // --- Scenario 3: + EV — EV replaces diesel; gas heating; grid (no PV) -----
  const evGridKWh = householdKWh + evKWh;
  const evGridCo2 = computeGridCo2_fromKWh(evGridKWh);
  const plusEv = makeScenario(
    "+ E-Auto: EV + Gas + Netz",
    gasHeatCo2Kg,
    evGridCo2,
    0,                            // no diesel
    0,
    0,                            // gas unchanged vs. baseline → 0 saved
    0,
  );
  plusEv.savedEUR = Math.round(dieselCostEUR - evCostEUR);

  // --- Scenario 4: + EV + PV — EV + gas + PV --------------------------------
  const evPvGridKWh = Math.max(0, householdKWh - householdPvKWh) + evKWh;
  const evPvGridCo2 = computeGridCo2_fromKWh(evPvGridKWh);
  const plusEvPv = makeScenario(
    "+ E-Auto + PV: EV + Gas + PV",
    gasHeatCo2Kg,
    evPvGridCo2,
    0,
    0,
    0,                            // gas unchanged vs. baseline → 0 saved
    householdPvKWh,
  );
  plusEvPv.savedEUR = Math.round((dieselCostEUR - evCostEUR) + householdPvKWh * importEurPerKWh);

  // --- Scenario 5: + EV + WP — EV + WP + PV (the fully-electrified config) ---
  const fullElectricGridCo2 = computeGridCo2(result.gridImport);
  const plusEvWp = makeScenario(
    "+ E-Auto + WP: EV + WP + PV",
    0,                            // no gas heating — heat is electric
    fullElectricGridCo2,
    0,
    hpEnabled ? gasForHeatKWh : 0, // gas avoided by the heat pump
    0,
    0,
  );
  plusEvWp.savedEUR = Math.round(
    (dieselCostEUR - evCostEUR) + (gasHeatCostEUR - hpHeatCostEUR),
  );

  // --- Scenario 6: + EV + WP but NO PV — everything from the grid -----------
  const evWpNoPvGridKWh = householdKWh + hpKWh + evKWh;
  const evWpNoPvGridCo2 = computeGridCo2_fromKWh(evWpNoPvGridKWh);
  const evWpNoPv = makeScenario(
    "+ E-Auto + WP ohne PV: alles Netz",
    0,                             // no gas heating — heat is electric
    evWpNoPvGridCo2,
    0,                             // no diesel
    hpEnabled ? gasForHeatKWh : 0, // gas avoided by the heat pump
    0,
    0,
  );
  const evWpNoPvHpCostEUR = (hpKWh * importCtPerKWh) / 100;
  const evWpNoPvElectricityCostEUR = evEnabled ? (evKWh * importCtPerKWh) / 100 : 0;
  const evNonElectricityCostEUR = evEnabled
    ? (annualKm * p.car.evMaintenanceCtPerKm) / 100 +
      p.car.evVehicleTaxEUR +
      p.car.evOtherNebenkostenEUR
    : 0;
  const evWpNoPvEvFullCostEUR = evWpNoPvElectricityCostEUR + evNonElectricityCostEUR;
  evWpNoPv.savedEUR = Math.round(
    (dieselCostEUR - evWpNoPvEvFullCostEUR) + (gasHeatCostEUR - evWpNoPvHpCostEUR),
  );

  // --- Scenario 7: + WP but diesel car + grid (no PV, no EV) ----------------
  const wpDieselGridKWh = householdKWh + hpKWh;
  const wpDieselGridCo2 = computeGridCo2_fromKWh(wpDieselGridKWh);
  const wpDieselGrid = makeScenario(
    "+ WP, Diesel + Netz (ohne PV)",
    0,                             // no gas heating — heat is electric
    wpDieselGridCo2,
    dieselCo2Kg,                   // still driving diesel
    hpEnabled ? gasForHeatKWh : 0, // gas avoided by the heat pump
    0,
    0,
  );
  const wpDieselGridHpCostEUR = (hpKWh * importCtPerKWh) / 100;
  wpDieselGrid.savedEUR = Math.round(gasHeatCostEUR - wpDieselGridHpCostEUR);

  // CO2 savings vs. baseline for every scenario.
  setCo2Saved(baseline, baseline);
  setCo2Saved(plusPv, baseline);
  setCo2Saved(plusEv, baseline);
  setCo2Saved(plusEvPv, baseline);
  setCo2Saved(plusEvWp, baseline);
  setCo2Saved(evWpNoPv, baseline);
  setCo2Saved(wpDieselGrid, baseline);

  return { baseline, plusPv, plusEv, plusEvPv, plusEvWp, evWpNoPv, wpDieselGrid };

  function makeScenario(
    label: string,
    heatingCo2: number,
    elecCo2: number,
    carCo2: number,
    gasSavedKWh: number,
    _gasUsedKWh: number,
    _gridSavedKWh: number,
  ): Co2Scenario {
    const total = heatingCo2 + elecCo2 + carCo2;
    return {
      label,
      co2Kg: Math.round(total),
      co2Tonnes: Math.round(total / 10) / 100,
      heatingCo2Kg: Math.round(heatingCo2),
      electricityCo2Kg: Math.round(elecCo2),
      carCo2Kg: Math.round(carCo2),
      gasSavedKWh: Math.round(gasSavedKWh),
      co2SavedKg: 0,
      savedEUR: 0,
    };
  }

  function setCo2Saved(s: Co2Scenario, base: Co2Scenario): void {
    s.co2SavedKg = Math.round(base.co2Kg - s.co2Kg);
  }

  function computeGridCo2_fromKWh(totalGridKWh: number): number {
    // Use the withoutPv mix (average grid intensity)
    const avgCo2 = gridMix.withoutPv.wind * CO2_EMISSION_FACTORS.wind +
      gridMix.withoutPv.solar * CO2_EMISSION_FACTORS.solar +
      gridMix.withoutPv.gas * CO2_EMISSION_FACTORS.gas +
      gridMix.withoutPv.coal * CO2_EMISSION_FACTORS.coal +
      gridMix.withoutPv.biomass * CO2_EMISSION_FACTORS.biomass +
      gridMix.withoutPv.hydro * CO2_EMISSION_FACTORS.hydro +
      gridMix.withoutPv.other * CO2_EMISSION_FACTORS.other;
    return totalGridKWh * avgCo2;
  }
}
