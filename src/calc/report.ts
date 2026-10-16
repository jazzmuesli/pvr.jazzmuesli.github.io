// Single entry point for the whole economic simulation.
//
// `runSimulation(params)` takes a flat `SimParams` object and returns a
// complete `SimReport` (JSON-serialisable): the amortisation, per-month and
// per-hour/day energy and money flows, the scheme comparison, and the
// effective procurement price. This is what the UI uses and what the
// `/api?...` endpoint returns.

import { simulate } from "./simulation";
import { computeEconomics, monthForStep, EconOptions } from "./revenue";
import { getYearPrices, PRICE_YEARS } from "./priceData";
import { monthOfStep, hourOfStep, STEPS_PER_DAY, TOTAL_STEPS, SimConfig, SimResult } from "./types";
import { cityForLocation, importPriceArray, TariffScheme } from "./tariff";
import {
  loadByConsumer,
  ConsumerLoads,
  ConsumerConfig,
  annualSum,
  totalLoad,
} from "./consumers";
import { effectiveNetPrice, EffectivePrice } from "./vwap";
import { computeAmortisation, Amortisation } from "./amortisation";
import { computeCashflow, CashflowAnalysis, CashflowInput } from "./cashflow";
import {
  HeatingParams,
  DEFAULT_HEATING_PARAMS,
} from "./heating";
import {
  DEFAULT_CAR_PARAMS,
  CarParams,
} from "./car";
import {
  computeOpportunityCosts,
  OpportunityCosts,
} from "./opportunity";
import {
  computeGasSavings,
  GasSavingsReport,
  DEFAULT_GAS_SAVINGS_PARAMS,
  DEFAULT_GAS_BOILER_EFFICIENCY,
} from "./heatpumpGasSavings";
import { electricityMixForStep } from "./electricityMix";
import {
  CoreParams,
  defaultCoreParams,
  paramsFromQuery,
  asOrientation,
  asChargeMode,
  asDischargeMode,
  asExportScheme,
  asImportScheme,
} from "../domain/params";
import { consumerParamsFromQuery, carParamsFromQuery } from "../domain/consumers";
import { DEFAULT_CONSUMERS } from "./consumers";
import { windProductionPerStep, WIND_TURBINE_MAP, DEFAULT_WIND_TURBINE, WIND_LOCATIONS } from "./wind";

// ---- Domain types shared with the UI ----------------------------------------

export type ConsumerKey = "household" | "heatpump" | "bwwp" | "ev";
export const CONSUMER_ORDER: ConsumerKey[] = ["household", "heatpump", "bwwp", "ev"];

export interface ConsumerBreakdown {
  household: number;
  heatpump: number;
  bwwp: number;
  ev: number;
}

export interface MonthlyChartDatum {
  /** 1-based month. The display label belongs to the i18n layer, not here —
   *  this field used to carry hard-coded German abbreviations, so an English
   *  user saw "Mär/Mai/Okt/Dez" on the monthly chart while the hourly chart
   *  beside it was correctly translated. */
  month: number;
  /** ISO-ish key (`"jan"`, `"feb"`, …) for looking the label up in the
   *  translation catalogue. */
  monthKey: string;
  pvKWh: number;
  windKWh: number;
  load: ConsumerBreakdown;
  totalLoadKWh: number;
  selfConsumptionKWh: number;
  /**
   * Grid import that served a load this month (kWh). Together with
   * `selfConsumptionKWh` this closes the month's energy balance exactly:
   * `selfConsumptionKWh + importKWh === totalLoadKWh`. It is what the charts
   * draw and what the Excel export reproduces.
   */
  importKWh: number;
  /** Metered import, i.e. what the import tariff is charged on (kWh). */
  meteredImportKWh: number;
  /** Of which bought to charge the battery and stored (kWh). */
  gridChargedKWh: number;
  exportKWh: number;
  netEUR: number;
}

export interface DayChartDatum {
  hour: number;
  pvKWh: number;
  windKWh: number;
  load: ConsumerBreakdown;
  totalLoadKWh: number;
  selfUseKWh: number;
  /** Grid import that served a load this hour (kWh); `selfUse + import = load`. */
  importKWh: number;
  /** Metered grid import for this hour (kWh), including battery purchases. */
  meteredImportKWh: number;
  /** Of which bought to charge the battery (kWh). */
  gridChargedKWh: number;
  exportKWh: number;
  avgPrice: number;
  socKWh: number;
}

export interface ScenarioDatum {
  /** Stable identifier so callers never have to match on the display label. */
  key: string;
  label: string;
  exportScheme: "fixed" | "market";
  importScheme: "fixed" | "dynamic" | "dynamic14a";
  netEUR: number;
  exportEUR: number;
  importEUR: number;
}

// ---- Tariff combinations over historical price years -----------------------
// For each relevant combination of export/import tariff scheme the import cost,
// export revenue and net balance are recomputed for every historical price
// year (2023–2026) by re-running the full dispatch with that year's spot
// prices (the battery's strategic discharge and the volumes depend on prices).

export interface TariffComboYear {
  year: string;
  exportEUR: number;
  importEUR: number;
  netEUR: number;
  exportKWh: number;
  importKWh: number;
}

export interface TariffCombination {
  key: string;
  label: string;
  exportScheme: "fixed" | "market";
  importScheme: TariffScheme;
  years: TariffComboYear[];
}

export interface TariffCombinationReport {
  years: string[];
  combinations: TariffCombination[];
}

// ---- Input parameters ------------------------------------------------------

/**
 * The simulation's input contract.
 *
 * Every scalar is inherited from the registry in `domain/params.ts`, so this
 * type cannot drift from the defaults, the URL keys or the SPA state. Only the
 * nested groups are declared here.
 */
export interface SimParams extends CoreParams {
  // Consumers (registry: domain/consumers.ts)
  consumers: ConsumerConfig;
  // Opportunity-cost comparison inputs (heating + EV vs. diesel).
  car: CarParams;
  /**
   * The heat pump's electricity price in ct/kWh. A heat pump is a grid
   * consumer, so this is simply the import tariff — which is why it is derived
   * in the codec rather than listed in the registry. An explicit `wpc` override
   * still wins, for callers who model a dedicated heat-pump tariff.
   */
  heatpumpElectricCt: number;
}

/**
 * The one default configuration.
 *
 * This used to be a second, hand-maintained copy of the defaults which
 * disagreed with the SPA's on eight fields, so `/api?` and the app answered
 * "what does this system cost" with two different systems. There is one now.
 */
export function defaultSimParams(): SimParams {
  const core = defaultCoreParams();
  return {
    ...core,
    consumers: JSON.parse(JSON.stringify(DEFAULT_CONSUMERS)) as ConsumerConfig,
    car: { ...DEFAULT_CAR_PARAMS },
    heatpumpElectricCt: core.importFixedCt,
  };
}

export const DEFAULT_SIM_PARAMS: SimParams = defaultSimParams();

/**
 * Parse URL-style query parameters into SimParams. The scalar list, the keys
 * and the defaults all come from the registry, so this reader and the
 * share-link writer in `ui/url.ts` cannot disagree about what exists.
 */
export function simParamsFromQuery(q: URLSearchParams): SimParams {
  const base = defaultSimParams();
  const scalars = paramsFromQuery(base as unknown as Record<string, unknown>, q);
  const p = { ...base, ...(scalars as CoreParams) } as SimParams;
  p.orientation = asOrientation(p.orientation);
  p.chargeMode = asChargeMode(p.chargeMode);
  p.dischargeMode = asDischargeMode(p.dischargeMode);
  p.exportScheme = asExportScheme(p.exportScheme);
  p.importScheme = asImportScheme(p.importScheme);
  p.consumers = consumerParamsFromQuery(base.consumers, q);
  p.car = carParamsFromQuery(base.car, q);
  const wpc = Number(q.get("wpc"));
  p.heatpumpElectricCt = q.get("wpc") !== null && Number.isFinite(wpc) ? wpc : p.importFixedCt;
  return p;
}

// ---- Investment auto-estimator (TODO 2.3) -----------------------------------
// `investmentEUR` stays the authoritative figure, but this estimator provides a
// realistic *default* derived from system size, without re-introducing the old
// amortisation artifact (the saving side now carries the real battery costs).
// PV costs are slightly degressive with size; battery at ~€/kWh.

export const DEFAULT_COST_PER_KWP = 1300; // €/kWp (degressive as size grows)
export const DEFAULT_COST_PER_KWH = 300; // €/kWh battery

/** Estimate a realistic all-in system investment from PV and battery size. */
export function estimateInvestmentEUR(
  peakKWp: number,
  capacityKWh: number,
  costPerKWp = DEFAULT_COST_PER_KWP,
  costPerKWh = DEFAULT_COST_PER_KWH,
): number {
  const pvCost = peakKWp * costPerKWp * degressionFactor(peakKWp);
  const batteryCost = capacityKWh * costPerKWh;
  return Math.round(pvCost + batteryCost);
}

// Slight degression: larger arrays get a marginally lower €/kWp.
function degressionFactor(kWp: number): number {
  if (kWp <= 10) return 1;
  if (kWp >= 30) return 0.9;
  return 1 - (kWp - 10) * 0.005;
}

// ---- Report ----------------------------------------------------------------

export interface GridMixShares {
  wind: number;
  solar: number;
  gas: number;
  coal: number;
  biomass: number;
  hydro: number;
  other: number;
}

export interface GridMix {
  /** Grid-import mix for the heat pump (PV-shifted). */
  heatpump: GridMixShares;
  /** Grid-import mix for all consumers combined. */
  overall: GridMixShares;
  /** Hypothetical mix without any PV/battery (100% grid). */
  withoutPv: GridMixShares;
}

// ---- CO2 scenarios ----------------------------------------------------------

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
// Every CO2 emission factor now lives in `co2.ts`. These names stay re-exported
// here because they are part of this module's public surface, but there is now
// exactly one definition of each number -- and one place to change it.
export {
  CO2_EMISSION_FACTORS,
  CO2_GAS_DIRECT,
  CO2_DIESEL,
  CO2_DIESEL_PER_LITRE,
  co2ForGasKWh,
  co2Intensity,
} from "./co2";

// Local aliases so the bodies below read unchanged.
import {
  CO2_GAS_DIRECT as GAS_DIRECT,
  CO2_DIESEL_PER_LITRE as DIESEL_PER_LITRE,
  co2Intensity,
} from "./co2";

/** Gas heating: useful heat / boiler efficiency. */
export const GAS_HEAT_KWH_PER_KWH_USEFUL = 1 / DEFAULT_GAS_BOILER_EFFICIENCY; // ~1.087

export interface Co2Scenario {
  label: string;
  co2Kg: number;
  co2Tonnes: number;
  heatingCo2Kg: number;
  electricityCo2Kg: number;
  carCo2Kg: number;
  /** Gas saved vs. baseline (kWh). */
  gasSavedKWh: number;
  /** CO2 saved vs. baseline (kg). */
  co2SavedKg: number;
  /** Money saved vs. baseline (EUR). */
  savedEUR: number;
}

export interface Co2Analysis {
  /** Scenario 1: Baseline — diesel car + gas heating + grid only. */
  baseline: Co2Scenario;
  /** Scenario 2: + PV — diesel + gas + PV (grid deficit). */
  plusPv: Co2Scenario;
  /** Scenario 3: + EV — EV replaces diesel + gas heating + grid. */
  plusEv: Co2Scenario;
  /** Scenario 4: + EV + PV — EV + gas + PV. */
  plusEvPv: Co2Scenario;
  /** Scenario 5: + EV + WP — EV + WP + PV (current config). */
  plusEvWp: Co2Scenario;
  /** Scenario 6: + EV + WP, but NO PV — everything (household + HP + EV) from
   *  the grid. Isolates the electrification benefit from the PV benefit. */
  evWpNoPv: Co2Scenario;
  /** Scenario 7: + WP but diesel car + grid (no PV, no EV) — heat is a heat
   *  pump on grid electricity, mobility is still diesel. */
  wpDieselGrid: Co2Scenario;
}

export interface SimReport {
  inputs: SimParams;
  summary: SimSummary;
  amortisation: Amortisation;
  cashflow: CashflowAnalysis;
  effectivePrice: EffectivePrice;
  monthly: MonthlyChartDatum[];
  /** Daily profile for every month: daily[month-1][hour]. */
  daily: DayChartDatum[][];
  scenario: ScenarioDatum[];
  /** Tariff combinations (export/import scheme pairs) evaluated for every
   *  historical price year 2023–2026. */
  tariffCombinations: TariffCombinationReport;
  /** Opportunity-cost comparison: heating (heat pump vs. oil vs. gas) and
   *  mobility (EV vs. diesel), for the same useful heat / annual distance. */
  opportunityCosts: OpportunityCosts;
  /** What the annual saving can finance: tied to the PV payback horizon. */
  opportunityInvestment: OpportunityInvestment;
  /** Gas savings analysis: HP electricity vs. direct gas heating. */
  gasSavings: GasSavingsReport | null;
  /** Electricity mix for grid-imported electricity. */
  gridMix: GridMix;
  /** CO2 analysis across multiple scenarios. */
  co2Analysis: Co2Analysis;
}

export interface OpportunityInvestment {
  /** PV simple payback (years); may be Infinity when there is no PV benefit. */
  pvPaybackYears: number;
  /** PV discounted payback (years); may be Infinity when there is no PV benefit. */
  discountedPvPaybackYears: number;
  /** Heat pump vs. gas: annual saving (€). */
  heatingSavingEUR: number;
  /** Investment a heat pump could be financed with over the PV payback (€), or null if N/A. */
  financeableHeatpumpEUR: number | null;
  /** EV vs. diesel: annual saving (€). */
  carSavingEUR: number;
  /** Investment an EV could be financed with over the PV payback (€), or null if N/A. */
  financeableEvEUR: number | null;
}

export interface SimSummary {
  totalPVKWh: number;
  totalWindKWh: number;
  totalLoadKWh: number;
  selfConsumptionKWh: number;
  totalExportKWh: number;
  /**
   * Metered grid import (kWh) — what the import tariff is charged on, and the
   * figure the whole cashflow model is priced from.
   */
  totalImportKWh: number;
  /**
   * Grid import that served a load (kWh). Metered import, minus what went
   * straight into the battery, plus what came back out of it to serve a load.
   * Together with `selfConsumptionKWh` this closes the annual energy balance
   * exactly: `selfConsumptionKWh + loadImportKWh === totalLoadKWh`.
   *
   * The two differ only when the battery is charged from the grid, and the
   * difference is worth publishing rather than hiding in a residual — the
   * residual used to swallow it silently.
   */
  loadImportKWh: number;
  /** Portion of the metered import that went straight into the battery (kWh). */
  gridChargedKWh: number;
  exportRevenueEUR: number;
  importCostEUR: number;
  netSelectedEUR: number;
  marktPraemieCt: number;
  referenceValueCt: number;
  /** Self-consumption rate: Eigenverbrauch / Erzeugung (%). */
  selfConsumptionRatePct: number;
  /** Self-sufficiency (Autarkiegrad): Eigenverbrauch / Gesamtlast (%). */
  selfSufficiencyPct: number;
}

/**
 * Translate the flat public parameter set into the engine's `SimConfig`.
 *
 * Exported so that tests (and any future consumer) can drive the raw dispatch
 * without re-implementing this wiring. It used to be private, which is why a
 * dozen test files each grew their own hand-rolled copy of `runSimulation`'s
 * setup — and each of those copies could drift from the real one.
 */
export function toSimConfig(p: SimParams): SimConfig {
  const hasBattery = p.capacityKWh > 0;
  // Compute wind production if enabled.
  let wind: Float64Array | undefined;
  if (p.windEnabled && p.windCount > 0) {
    const baseLoc = WIND_LOCATIONS[p.location] ?? WIND_LOCATIONS.hamburg;
    const loc = { ...baseLoc, annualMeanWindMs: p.windSpeedMeanMs };
    const turbine = WIND_TURBINE_MAP[p.windTurbineId] ?? DEFAULT_WIND_TURBINE;
    wind = windProductionPerStep(turbine, loc, p.windHubHeightM);
    // Scale by number of turbines.
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

function monthlyConsumerSums(loads: ConsumerLoads): ConsumerBreakdown[] {
  const keys = CONSUMER_ORDER;
  const out: ConsumerBreakdown[] = Array.from({ length: 12 }, () => ({ household: 0, heatpump: 0, bwwp: 0, ev: 0 }));
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const m = monthOfStep(i) - 1;
    for (const k of keys) out[m][k] += loads[k][i];
  }
  return out;
}

interface DayAccumulator {
  hour: number;
  pvKWh: number;
  windKWh: number;
  load: ConsumerBreakdown;
  selfUseKWh: number;
  importKWh: number;
  meteredImportKWh: number;
  gridChargedKWh: number;
  exportKWh: number;
  avgPrice: number;
  socKWh: number;
  count: number;
}

function emptyDay(hour: number): DayAccumulator {
  return {
    hour,
    pvKWh: 0,
    windKWh: 0,
    load: { household: 0, heatpump: 0, bwwp: 0, ev: 0 },
    selfUseKWh: 0,
    importKWh: 0,
    meteredImportKWh: 0,
    gridChargedKWh: 0,
    exportKWh: 0,
    avgPrice: 0,
    socKWh: 0,
    count: 0,
  };
}

function dailyAll(result: SimResult, loads: ConsumerLoads): DayChartDatum[][] {
  const data: DayAccumulator[][] = Array.from({ length: 12 }, () =>
    Array.from({ length: 24 }, (_, h) => emptyDay(h)),
  );
  for (let i = 0; i < result.pv.length; i++) {
    const m = monthOfStep(i) - 1;
    const h = hourOfStep(i);
    const d = data[m][h];
    d.pvKWh += result.pv[i];
    d.windKWh += result.wind[i];
    d.load.household += loads.household[i];
    d.load.heatpump += loads.heatpump[i];
    d.load.bwwp += loads.bwwp[i];
    d.load.ev += loads.ev[i];
    d.selfUseKWh += result.directUse[i] + result.directUseWind[i] + result.dischargeToLoadPV[i] + result.dischargeToLoadWind[i];
    d.importKWh += result.gridImport[i] - result.chargeGrid[i] + result.dischargeToLoadGrid[i];
    d.meteredImportKWh += result.gridImport[i];
    d.gridChargedKWh += result.chargeGrid[i];
    d.exportKWh += result.exportTotal[i];
    d.avgPrice += result.price[i];
    d.socKWh += result.soc[i];
    d.count += 1;
  }
  const stepsPerHour = STEPS_PER_DAY / 24;
  return data.map((month) =>
    month.map((d) => {
      const n = d.count || 1;
      const load: ConsumerBreakdown = {
        household: (d.load.household / n) * stepsPerHour,
        heatpump: (d.load.heatpump / n) * stepsPerHour,
        bwwp: (d.load.bwwp / n) * stepsPerHour,
        ev: (d.load.ev / n) * stepsPerHour,
      };
      return {
        hour: d.hour,
        pvKWh: (d.pvKWh / n) * stepsPerHour,
        windKWh: (d.windKWh / n) * stepsPerHour,
        load,
        totalLoadKWh: load.household + load.heatpump + load.bwwp + load.ev,
        selfUseKWh: (d.selfUseKWh / n) * stepsPerHour,
        importKWh: (d.importKWh / n) * stepsPerHour,
        meteredImportKWh: (d.meteredImportKWh / n) * stepsPerHour,
        gridChargedKWh: (d.gridChargedKWh / n) * stepsPerHour,
        exportKWh: (d.exportKWh / n) * stepsPerHour,
        avgPrice: d.avgPrice / n,
        socKWh: d.socKWh / n,
      };
    }),
  );
}

/**
 * The four export/import scheme combinations the scenario chart compares.
 *
 * This used to carry its own hand-rolled import-cost loop that always used the
 * *base* import scheme, so all four bars showed the fixed-tariff number under
 * four different labels. `computeEconomics` already prices all three import
 * schemes and the selected net in a single pass over the same dispatch, so the
 * variants now simply read those numbers — one implementation, not two.
 */
export const SCENARIO_VARIANTS: {
  key: string;
  label: string;
  exportScheme: "fixed" | "market";
  importScheme: SimParams["importScheme"];
}[] = [
  { key: "fixed_fixed", label: "Feste Einspeisung (§ 14a/2)", exportScheme: "fixed", importScheme: "fixed" },
  { key: "market_fixed", label: "Direktvermarktung (Marktprämie)", exportScheme: "market", importScheme: "fixed" },
  { key: "fixed_dynamic", label: "Dynamischer Bezug (spotbasiert)", exportScheme: "fixed", importScheme: "dynamic" },
  { key: "fixed_dynamic14a", label: "Dynamisch + § 14a/3", exportScheme: "fixed", importScheme: "dynamic14a" },
];

function scenarioVariants(result: SimResult, base: SimParams): ScenarioDatum[] {
  return SCENARIO_VARIANTS.map((v) => {
    const econ = computeEconomics(result, {
      commissioningYear: base.commissioningYear,
      peakKWp: base.peakKWp,
      exportScheme: v.exportScheme,
      feedInCt: base.feedInCt,
      importScheme: v.importScheme,
      importCity: cityForLocation(base.location),
      importFixedCt: base.importFixedCt,
      marketMarginCt: base.marketMarginCt,
    });
    const exportEUR = v.exportScheme === "market" ? econ.exportRevenueMarketEUR : econ.exportRevenueFixedEUR;
    const importEUR =
      v.importScheme === "fixed" ? econ.importCostFixedEUR
      : v.importScheme === "dynamic" ? econ.importCostDynamicEUR
      : econ.importCost14aEUR;
    return {
      key: v.key,
      label: v.label,
      exportScheme: v.exportScheme,
      importScheme: v.importScheme,
      netEUR: exportEUR - importEUR,
      exportEUR,
      importEUR,
    };
  });
}

// The four tariff combinations the user wants to compare. Two of them are
// Direktvermarktung (market) export, the others use the fixed feed-in tariff.
const TARIFF_COMBOS: { key: string; label: string; exportScheme: "fixed" | "market"; importScheme: TariffScheme }[] = [
  { key: "fixed_fixed", label: "Feste Einspeisung & fester Bezug", exportScheme: "fixed", importScheme: "fixed" },
  { key: "market_fixed", label: "Direktvermarktung & fester Bezug", exportScheme: "market", importScheme: "fixed" },
  { key: "market_dynamic", label: "Direktvermarktung & dynamischer Bezug (Tibber)", exportScheme: "market", importScheme: "dynamic" },
  { key: "market_dynamic14a", label: "Direktvermarktung & dynamisch + §14a/3", exportScheme: "market", importScheme: "dynamic14a" },
];

function computeTariffCombinations(p: SimParams): TariffCombinationReport {
  const city = cityForLocation(p.location);
  const econOpts: EconOptions = {
    commissioningYear: p.commissioningYear,
    peakKWp: p.peakKWp,
    exportScheme: "market",
    feedInCt: p.feedInCt,
    importScheme: "fixed",
    importCity: city,
    importFixedCt: p.importFixedCt,
    marketMarginCt: p.marketMarginCt,
  };
  // One full dispatch per historical price year (volumes + cost differ by year).
  const yearRuns = PRICE_YEARS.map((year) => {
    const cfg = toSimConfig(p);
    cfg.prices = getYearPrices(year);
    const result = simulate(cfg);
    const econ = computeEconomics(result, econOpts);
    return {
      year,
      exportKWh: econ.totalExportKWh,
      importKWh: econ.totalImportKWh,
      exportRevFixed: econ.exportRevenueFixedEUR,
      exportRevMarket: econ.exportRevenueMarketEUR,
      importFixed: econ.importCostFixedEUR,
      importDynamic: econ.importCostDynamicEUR,
      import14a: econ.importCost14aEUR,
    };
  });
  const combinations = TARIFF_COMBOS.map((c) => {
    const years = yearRuns.map((r) => {
      const exportEUR = c.exportScheme === "market" ? r.exportRevMarket : r.exportRevFixed;
      const importEUR =
        c.importScheme === "fixed" ? r.importFixed
        : c.importScheme === "dynamic" ? r.importDynamic
        : r.import14a;
      return {
        year: r.year,
        exportEUR: round2(exportEUR),
        importEUR: round2(importEUR),
        netEUR: round2(exportEUR - importEUR),
        exportKWh: r.exportKWh,
        importKWh: r.importKWh,
      };
    });
    return { ...c, years };
  });
  return { years: PRICE_YEARS, combinations };
}

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

function computeGridMix(
  loads: ConsumerLoads,
  result: SimResult,
): GridMix {
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

function computeCo2Analysis(
  p: SimParams,
  loads: ConsumerLoads,
  result: SimResult,
  gridMix: GridMix,
  opportunityCosts: OpportunityCosts,
): Co2Analysis {
  const hpEnabled = p.consumers.heatpump.enabled;
  const evEnabled = p.consumers.ev.enabled;
  // The heat pump's *dispatched* load, which — when the BWWP is disabled —
  // also carries the hot-water demand. Using `p.consumers.heatpump.annualKWh`
  // here instead understated the gas the heat pump replaced by 9.6 % and made
  // this module disagree with `computeGasSavings`, which reads the same load.
  const hpKWh = annualSum(loads.heatpump);
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
  const gasHeatCo2Kg = gasForHeatKWh * GAS_DIRECT;

  // Diesel car: annual km × litres per 100 km × emission factor per litre.
  // Uses the diesel car's OWN consumption (p.car.dieselLPer100km, ~5.5 l), not
  // the EV's kWh/100 km, so the drivetrain-efficiency gap is preserved and the
  // EV comes out cleaner than diesel even on grid electricity.
  const dieselLitres = annualKm * p.car.dieselLPer100km / 100;
  const dieselCo2Kg = dieselLitres * DIESEL_PER_LITRE;

  // Grid electricity CO2: use the actual grid import from simulation
  // weighted by the hourly mix (per-step integration for accuracy)
  const computeGridCo2 = (gridImportArr: Float64Array): number => {
    let co2 = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const gi = gridImportArr[i];
      if (gi <= 0) continue;
      co2 += gi * co2Intensity(electricityMixForStep(i));
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
  // Electricity in this scenario is ONLY the household (heat comes from gas,
  // the car is diesel). Adding the heat-pump electricity here would double-
  // count the heating (once as gas, once as electricity).
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
  // Only the household is electric here; PV reduces that household grid draw.
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
  // Money saved: PV self-consumption × import price.
  plusPv.savedEUR = Math.round(householdPvKWh * importEurPerKWh);

  // --- Scenario 3: + EV — EV replaces diesel; gas heating; grid (no PV) -----
  // Electricity = household + EV. Heat is still gas.
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
  // Money saved: diesel running cost − EV running cost (from opportunity module).
  plusEv.savedEUR = Math.round(dieselCostEUR - evCostEUR);

  // --- Scenario 4: + EV + PV — EV + gas + PV --------------------------------
  // Electricity = household + EV; PV offsets the household part.
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
  // Here the heat pump IS the heating, so its electricity is legitimately part
  // of the grid load. Use the actual simulated grid import (household + HP + EV,
  // PV-shifted) for the electricity CO2.
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
  // Money saved vs. baseline: diesel→EV saving + gas→heat-pump saving. The heat
  // pump's own electricity cost is already inside hpHeatCostEUR (and PV lowers
  // it via the coverage-adjusted price used by the opportunity module).
  plusEvWp.savedEUR = Math.round(
    (dieselCostEUR - evCostEUR) + (gasHeatCostEUR - hpHeatCostEUR),
  );

  // --- Scenario 6: + EV + WP but NO PV — everything from the grid -----------
  // Same fully-electrified end-state as scenario 5 (EV + heat pump, no gas, no
  // diesel), but WITHOUT any PV: household + heat-pump + EV electricity is all
  // drawn from the grid. This isolates how much of scenario 5's benefit comes
  // from electrification vs. from the PV system. Uses the average grid
  // intensity (withoutPv mix) on the full electric load.
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
  // Money saved vs. baseline: diesel→EV + gas→heat-pump savings. Without PV the
  // HP and EV run 100% on grid electricity at the full tariff, so we must NOT
  // use the PV-adjusted opportunity costs (which already credit self-consumption).
  // The EV cost includes maintenance/tax/insurance — only the electricity part changes.
  const evWpNoPvHpCostEUR = (hpKWh * importCtPerKWh) / 100;
  const evWpNoPvElectricityCostEUR = evEnabled ? (evKWh * importCtPerKWh) / 100 : 0;
  // Non-electricity EV cost: maintenance + vehicle tax + insurance (unchanged regardless of PV).
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
  // Heat is a heat pump on grid electricity (gas avoided), but mobility is
  // still diesel. No PV. Electricity = household + heat pump from the grid.
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
  // Money saved vs. baseline: only the gas→heat-pump saving (car unchanged).
  // Must subtract the HP's grid electricity cost (full tariff, no PV).
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
    // Average grid intensity, from the all-grid (no PV) mix.
    return totalGridKWh * co2Intensity(gridMix.withoutPv);
  }
}

export function runSimulation(p: SimParams): SimReport {
  const result = simulate(toSimConfig(p));
  const city = cityForLocation(p.location);
  const prices = getYearPrices(p.priceYear);
  const econ = computeEconomics(result, {
    commissioningYear: p.commissioningYear,
    peakKWp: p.peakKWp,
    exportScheme: p.exportScheme,
    feedInCt: p.feedInCt,
    importScheme: p.importScheme,
    importCity: city,
    importFixedCt: p.importFixedCt,
    marketMarginCt: p.marketMarginCt,
  } as EconOptions);

  const loads = loadByConsumer(p.consumers);
  const imp = importPriceArray(p.importScheme, city, prices, p.importFixedCt);

  // Baseline: cost of importing the entire load at the chosen tariff.
  let baselineCostEUR = 0;
  // Actual grid-import cost (only the portion drawn from the grid).
  let importCostEUR = 0;
  for (let i = 0; i < result.load.length; i++) {
    baselineCostEUR += (result.load[i] * imp[i]) / 100;
    importCostEUR += (result.gridImport[i] * imp[i]) / 100;
  }
  const exportEUR = p.exportScheme === "market" ? econ.exportRevenueMarketEUR : econ.exportRevenueFixedEUR;
  const effectivePrice = effectiveNetPrice(loads, result.load, result.gridImport, imp, exportEUR);
  const amortisation = computeAmortisation({
    baselineCostEUR,
    systemNetEUR: econ.netSelectedEUR,
    investmentEUR: p.investmentEUR,
  });

  // Monthly aggregation.
  const monthlySums = monthlyConsumerSums(loads);
  const monthly: MonthlyChartDatum[] = econ.monthly.map((r, i) => {
    const s = monthlySums[i];
    return {
      month: i + 1,
      monthKey: MONTH_KEYS[i],
      pvKWh: r.pvKWh,
      windKWh: r.windKWh,
      load: { household: s.household, heatpump: s.heatpump, bwwp: s.bwwp, ev: s.ev },
      totalLoadKWh: r.loadKWh,
      selfConsumptionKWh: r.selfConsumptionKWh,
      // Straight from the dispatch, not a residual. The old residual
      // (load − self-consumption) silently disagreed with the daily chart and
      // with the tariff table, and hid both the grid-charged battery energy
      // and the state of charge the battery inherited at 00:00.
      importKWh: r.loadImportKWh,
      meteredImportKWh: r.importKWh,
      gridChargedKWh: r.gridChargedKWh,
      exportKWh: r.exportKWh,
      netEUR: r.netSelectedEUR,
    };
  });

  const daily = dailyAll(result, loads);
  const scenario = scenarioVariants(result, p);

  // Heating cost comparison (heat pump vs. heating oil vs. gas) for the same
  // useful heat output. The heat pump's electricity consumption is taken from
  // the heat-pump consumer (0 when disabled → report shows the fossil options
  // as the baseline at zero heat-pump cost).
  const heatingParams: HeatingParams = {
    ...DEFAULT_HEATING_PARAMS,
    heatpumpElectricKWh: p.consumers.heatpump.enabled ? p.consumers.heatpump.annualKWh : 0,
    jaz: p.heatpumpJaz,
    // The heat pump is a grid consumer, so it pays the PV-aware *effective*
    // price of its own imports (the simulation's `byConsumer.heatpump`). This
    // makes the comparison react to every PV/battery input: a bigger battery
    // raises PV self-consumption and lowers the heat pump's effective price.
    heatpumpElectricCt: p.consumers.heatpump.enabled ? effectivePrice.byConsumer.heatpump : p.heatpumpElectricCt,
  };

  // The EV comparison is driven by the *actual* inputs the user sets:
  //   - the EV charges at the PV-aware effective price of its own imports
  //     (`byConsumer.ev`), so a bigger battery / more PV also cheapens driving;
  //   - the annual distance is back-computed from the E-Auto electricity
  //     consumption (kWh) the user entered, using the EV's kWh/100 km.
  const evKWh = p.consumers.ev.enabled ? p.consumers.ev.annualKWh : 0;
  const evCt = p.consumers.ev.enabled ? effectivePrice.byConsumer.ev : p.importFixedCt;
  const carParams: CarParams = {
    ...p.car,
    evElectricCtPerKwh: evCt,
    annualKm: p.consumers.ev.enabled && evKWh > 0 ? Math.round((evKWh * 100) / p.car.evKwhPer100km) : 0,
  };

  // Opportunity-cost comparison (heating + EV vs. diesel) — the single shared
  // function used by both the `/api` endpoint and the client UI.
  const opportunityCosts = computeOpportunityCosts({
    heating: heatingParams,
    car: carParams,
  });

  // Attach the PV+battery coverage split (how much of each consumer's load is
  // served from own solar vs. the grid, and at what grid price). For a dynamic
  // tariff the grid price is the volume-weighted average of the import hours —
  // naturally cheaper for the EV, which charges mostly at night.
  const dynamicImport = p.importScheme !== "fixed";
  if (p.consumers.heatpump.enabled && effectivePrice.coverage.heatpump) {
    const c = effectivePrice.coverage.heatpump;
    opportunityCosts.heating.coverage = {
      pvCoveredKWh: round2(c.pvCoveredKWh),
      gridKWh: round2(c.gridKWh),
      pvSharePct: round2(c.pvSharePct),
      gridPriceCt: round2(c.gridPriceCt),
      effectiveCt: round2(c.effectiveCt),
      dynamic: dynamicImport,
    };
  }
  if (p.consumers.ev.enabled && effectivePrice.coverage.ev) {
    const c = effectivePrice.coverage.ev;
    opportunityCosts.car.coverage = {
      pvCoveredKWh: round2(c.pvCoveredKWh),
      gridKWh: round2(c.gridKWh),
      pvSharePct: round2(c.pvSharePct),
      gridPriceCt: round2(c.gridPriceCt),
      effectiveCt: round2(c.effectiveCt),
      dynamic: dynamicImport,
    };
  }

  // ---- Grid mix + CO2 scenario analysis ------------------------------------
  // gridMix: weighted electricity mix for grid-imported electricity
  // (heatpump/overall/withoutPv). co2Analysis uses opportunityCosts for money.
  const gridMix = computeGridMix(loads, result);
  const co2Analysis = computeCo2Analysis(p, loads, result, gridMix, opportunityCosts);

  // Calculate multi-year cashflow analysis
  const cashflowInput: CashflowInput = {
    annualBenefitEUR: amortisation.annualBenefitEUR,
    annualPVKWh: annualSum(result.pv),
    investmentEUR: p.investmentEUR,
    peakKWp: p.peakKWp,
    capacityKWh: p.capacityKWh,
    feedInCt: p.feedInCt,
    importPriceCt: p.importFixedCt,
    horizonYears: p.horizonYears,
    discountRatePct: p.discountRatePct,
    priceEscalationPct: p.priceEscalationPct,
    omPercentPerYear: p.omPercentPerYear,
    inverterLifetimeYears: p.inverterLifetimeYears,
    inverterReplacementCostEUR: p.inverterReplacementCostEUR,
    batteryLifetimeYears: p.batteryLifetimeYears,
    batteryReplacementCostEUR: p.batteryReplacementCostEUR,
    batteryDegradationPct: p.batteryDegradationPct,
    pvDegradationPct: p.pvDegradationPct,
    standbyWattage: p.standbyWattage,
    omInflationPct: p.priceEscalationPct,
  };
  const cashflow = computeCashflow(cashflowInput);

  // Tie the fossil-vs-electric decision to the PV economics: the annual saving
  // can finance a heat pump / EV over the PV's discounted investment horizon.
  // The "financeable budget" is the present value of the annual saving over the
  // full analysis horizon (Barwert) — consistent with how the PV itself is
  // appraised (TODO 6.1).
  const discountedPaybackYears = cashflow.discountedPaybackYears;
  const heatingSavingEUR = opportunityCosts.heating.gas.totalEUR - opportunityCosts.heating.heatpump.totalEUR;
  const carSavingEUR = opportunityCosts.car.diesel.totalEUR - opportunityCosts.car.ev.totalEUR;
  const financeable = (savingEUR: number): number | null =>
    amortisation.annualBenefitEUR > 0 && savingEUR > 0
      ? calculatePresentValueOfSavings(savingEUR, p.discountRatePct, p.horizonYears)
      : null;
  const opportunityInvestment = {
    pvPaybackYears: amortisation.paybackYears, // Keep simple payback for backward compatibility
    discountedPvPaybackYears: discountedPaybackYears,
    heatingSavingEUR: round2(heatingSavingEUR),
    financeableHeatpumpEUR: financeable(heatingSavingEUR),
    carSavingEUR: round2(carSavingEUR),
    financeableEvEUR: financeable(carSavingEUR),
  };

  // Every annual total below is read out of `econ`, which summed them in the
  // same single pass that produced the monthly rows. The report used to
  // re-derive them from a second, independent sweep, and define grid import as
  // the residual load − self-consumption, which disagreed with the dispatch
  // whenever the battery charged from the grid.
  const totalPVKWh = econ.totalPVKWh;
  const totalWindKWh = annualSum(result.wind);
  const totalGenerationKWh = totalPVKWh + totalWindKWh;
  const totalLoadKWh = econ.totalLoadKWh;
  const selfConsumptionKWh = econ.selfConsumptionKWh;
  const totalImportKWh = econ.totalImportKWh;
  const gridChargedKWh = econ.totalChargeGridKWh;

  // Gas savings analysis: compare heat pump electricity vs. direct gas heating.
  // Pass the simulation dispatch (gridImport, totalLoad) so the HP's PV/grid
  // split is correctly computed per step — this reflects load shifting with
  // dynamic tariffs and battery storage.
  const gasSavings = p.consumers.heatpump.enabled
    ? computeGasSavings(loads.heatpump, {
        heatpumpElectricKWh: p.consumers.heatpump.annualKWh,
        jaz: p.heatpumpJaz,
        gasPowerplantEfficiency: DEFAULT_GAS_SAVINGS_PARAMS.gasPowerplantEfficiency,
        gasBoilerEfficiency: DEFAULT_GAS_SAVINGS_PARAMS.gasBoilerEfficiency,
        gasPriceCtPerKWh: DEFAULT_GAS_SAVINGS_PARAMS.gasPriceCtPerKWh,
      }, result.gridImport, result.load)
    : null;

  // ---- Grid mix computation ------------------------------------------------
  // Compute the weighted electricity mix for grid-imported electricity:
  //  - heatpump: HP's grid import (proportional allocation, PV-shifted)
  //  - overall:  total grid import across all consumers
  //  - withoutPv: hypothetical no-PV/battery scenario (100% grid)

  const summary: SimSummary = {
    totalPVKWh,
    totalWindKWh,
    totalLoadKWh,
    selfConsumptionKWh,
    totalExportKWh: econ.totalExportKWh,
    totalImportKWh,
    loadImportKWh: econ.totalLoadImportKWh,
    gridChargedKWh,
    exportRevenueEUR: exportEUR,
    importCostEUR,
    netSelectedEUR: econ.netSelectedEUR,
    marktPraemieCt: econ.marktPraemieCt,
    referenceValueCt: econ.referenceValueCt,
    selfConsumptionRatePct: totalGenerationKWh > 0 ? (selfConsumptionKWh / totalGenerationKWh) * 100 : 0,
    selfSufficiencyPct: totalLoadKWh > 0 ? (selfConsumptionKWh / totalLoadKWh) * 100 : 0,
  };

  return {
    inputs: p,
    summary,
    amortisation,
    cashflow,
    effectivePrice,
    monthly,
    daily,
    scenario,
    tariffCombinations: computeTariffCombinations(p),
    opportunityCosts,
    opportunityInvestment,
    gasSavings,
    gridMix,
    co2Analysis,
  };
}

function calculatePresentValueOfSavings(
  annualSavingEUR: number,
  discountRatePct: number,
  years: number
): number {
  if (annualSavingEUR <= 0 || years <= 0 || discountRatePct < 0) {
    return 0;
  }
  
  const discountRate = discountRatePct / 100;
  let presentValue = 0;
  
  for (let year = 1; year <= years; year++) {
    const discountFactor = Math.pow(1 + discountRate, year);
    presentValue += annualSavingEUR / discountFactor;
  }
  
  return round2(presentValue);
}

/** Translation keys for the twelve months. Paired with `i18n`'s `month.*`. */
const MONTH_KEYS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

// Re-export so consumers do not need to import the underlying modules.
export { monthForStep };

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
