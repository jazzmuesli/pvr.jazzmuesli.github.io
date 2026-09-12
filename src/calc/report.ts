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
import { monthOfStep, hourOfStep, STEPS_PER_DAY, TOTAL_STEPS, SimConfig, SimResult, Orientation } from "./types";
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
  month: number;
  label: string;
  pvKWh: number;
  windKWh: number;
  load: ConsumerBreakdown;
  totalLoadKWh: number;
  selfConsumptionKWh: number;
  importKWh: number;
  exportKWh: number;
  netEUR: number;
}

export interface DayChartDatum {
  hour: number;
  pvKWh: number;
  load: ConsumerBreakdown;
  totalLoadKWh: number;
  selfUseKWh: number;
  importKWh: number;
  exportKWh: number;
  avgPrice: number;
  socKWh: number;
}

export interface ScenarioDatum {
  label: string;
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

export interface SimParams {
  // PV
  peakKWp: number;
  tiltDeg: number;
  orientation: Orientation;
  location: string;
  // Battery
  capacityKWh: number;
  maxPowerKW: number;
  minSOC: number;
  maxSOC: number;
  efficiency: number;
  startSOC: number;
  chargeMode: "morning" | "midday" | "gridNegative";
  dischargeEvening: boolean;
  dischargeMorning: boolean;
  eveningStart: number;
  eveningEnd: number;
  morningStart: number;
  morningEnd: number;
  // Tariff
  feedInCt: number;
  commissioningYear: number;
  priceYear: string;
  // Consumers
  consumers: ConsumerConfig;
  // Export / import scheme
  exportScheme: "fixed" | "market";
  importScheme: "fixed" | "dynamic" | "dynamic14a";
  importFixedCt: number;
  // Cost — a single total, independent of kWp / kWh size.
  investmentEUR: number;
  // Economic parameters
  horizonYears: number;           // Analysis period (default 20)
  discountRatePct: number;        // Discount rate for NPV (default 3%)
  priceEscalationPct: number;     // Electricity price escalation (default 2%)
  omPercentPerYear: number;       // O&M as % of investment/year (default 1.5%)
  inverterLifetimeYears: number;  // Inverter lifespan (default 13)
  inverterReplacementCostEUR: number; // Inverter replacement cost (default 1500)
  batteryLifetimeYears: number;   // Battery lifespan (default 13)
  batteryReplacementCostEUR: number; // Battery replacement cost (default 300 * capacityKWh)
  batteryDegradationPct: number;  // Annual battery degradation (default 0.01 = 1%)
  pvDegradationPct: number;       // Annual PV degradation (default 0.005 = 0.5%)
  standbyWattage: number;         // Battery standby consumption (default 5W)
  // Heating: JAZ of the heat pump and its electricity price (for the
  // fossil-fuelled alternative cost comparison in `heating`).
  heatpumpJaz: number;
  heatpumpElectricCt: number;
  // Opportunity-cost comparison inputs (heating + EV vs. diesel). The defaults
  // are realistic for a German household; the heat-pump electricity comes from
  // the heat-pump consumer above.
  car: CarParams;
  // Direktvermarkter-Marge in ct/kWh (only applied when exportScheme === "market").
  marketMarginCt: number;
  // Kleinwindkraftanlage (Expert-Modus)
  windEnabled: boolean;
  windCount: number;
  windHubHeightM: number;
  windTurbineId: string;
  windSpeedMeanMs: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  peakKWp: 10,
  tiltDeg: 35,
  orientation: "south",
  location: "hamburg",
  capacityKWh: 10,
  maxPowerKW: 5,
  minSOC: 0.1,
  maxSOC: 0.9,
  efficiency: 0.95,
  startSOC: 0.5,
  chargeMode: "morning",
  dischargeEvening: true,
  dischargeMorning: false,
  eveningStart: 17,
  eveningEnd: 21,
  morningStart: 6,
  morningEnd: 9,
  feedInCt: 7.2,
  commissioningYear: 2025,
  priceYear: "2025",
  // Economic parameters
  horizonYears: 20,
  discountRatePct: 3,
  priceEscalationPct: 2,
  omPercentPerYear: 1.5,
  inverterLifetimeYears: 13,
  inverterReplacementCostEUR: 1500,
  batteryLifetimeYears: 13,
  batteryReplacementCostEUR: 3000,
  batteryDegradationPct: 0.01,
  pvDegradationPct: 0.005,
  standbyWattage: 5,
  // Consumers
  consumers: {
    household: { enabled: true, annualKWh: 2400 },
    heatpump: { enabled: true, annualKWh: 5000 },
    bwwp: { enabled: true, annualKWh: 480 },
    ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
  },
  exportScheme: "fixed",
  importScheme: "fixed",
  importFixedCt: 24,
  investmentEUR: 32000,
  // Heating: JAZ of the heat pump and its electricity price (for the
  // fossil-fuelled alternative cost comparison in `heating`).
  heatpumpJaz: 3,
  heatpumpElectricCt: 24,
  // Opportunity-cost comparison inputs (heating + EV vs. diesel). The defaults
  // are realistic for a German household; the heat-pump electricity comes from
  // the heat-pump consumer above.
  car: { ...DEFAULT_CAR_PARAMS },
  marketMarginCt: 1,
  windEnabled: false,
  windCount: 1,
  windHubHeightM: 10,
  windTurbineId: "skywind_ng",
  windSpeedMeanMs: 4.8,
};

// Parse URL-style query parameters into SimParams. Mirrors the names used by
// the SPA URL so the same link works for the `/api` endpoint and the app.
export function simParamsFromQuery(q: URLSearchParams): SimParams {
  const p = { ...DEFAULT_SIM_PARAMS };
  const num = (key: string, def: number) => {
    const v = q.get(key);
    if (v === null || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const str = (key: string, def: string) => {
    const v = q.get(key);
    return v === null || v === "" ? def : v;
  };
  p.peakKWp = num("kwp", p.peakKWp);
  p.tiltDeg = num("tilt", p.tiltDeg);
  p.orientation = (str("o", p.orientation) as Orientation) ?? p.orientation;
  p.location = str("loc", p.location);
  p.capacityKWh = num("cap", p.capacityKWh);
  p.maxPowerKW = num("pwr", p.maxPowerKW);
  p.minSOC = num("minsoc", p.minSOC);
  p.maxSOC = num("maxsoc", p.maxSOC);
  p.efficiency = num("eff", p.efficiency);
  p.startSOC = num("soc0", p.startSOC);
  p.chargeMode = (str("charge", p.chargeMode) as SimParams["chargeMode"]) ?? p.chargeMode;
  p.dischargeEvening = str("de", p.dischargeEvening ? "1" : "0") === "1";
  p.dischargeMorning = str("dm", p.dischargeMorning ? "1" : "0") === "1";
  p.eveningStart = num("evs", p.eveningStart);
  p.eveningEnd = num("eve", p.eveningEnd);
  p.morningStart = num("mns", p.morningStart);
  p.morningEnd = num("mne", p.morningEnd);
  p.feedInCt = num("fi", p.feedInCt);
  p.commissioningYear = num("yr", p.commissioningYear);
  p.priceYear = str("py", p.priceYear);
  p.consumers.household.enabled = str("hh", p.consumers.household.enabled ? "1" : "0") === "1";
  p.consumers.household.annualKWh = num("hk", p.consumers.household.annualKWh);
  p.consumers.heatpump.enabled = str("wp", p.consumers.heatpump.enabled ? "1" : "0") === "1";
  p.consumers.heatpump.annualKWh = num("wk", p.consumers.heatpump.annualKWh);
  p.consumers.bwwp.enabled = str("bw", p.consumers.bwwp.enabled ? "1" : "0") === "1";
  p.consumers.bwwp.annualKWh = num("bwk", p.consumers.bwwp.annualKWh ?? 480);
  p.consumers.ev.enabled = str("ev", p.consumers.ev.enabled ? "1" : "0") === "1";
  p.consumers.ev.annualKWh = num("ek", p.consumers.ev.annualKWh);
  p.consumers.ev.pvShare = num("es", p.consumers.ev.pvShare);
  p.exportScheme = (str("ex", p.exportScheme) as SimParams["exportScheme"]) ?? p.exportScheme;
  p.importScheme = (str("im", p.importScheme) as SimParams["importScheme"]) ?? p.importScheme;
  p.importFixedCt = num("ict", p.importFixedCt);
  p.investmentEUR = num("inv", p.investmentEUR);
  // Economic / lifecycle-cashflow parameters.
  p.horizonYears = num("hor", p.horizonYears);
  p.discountRatePct = num("d", p.discountRatePct);
  p.priceEscalationPct = num("esc", p.priceEscalationPct);
  p.omPercentPerYear = num("om", p.omPercentPerYear);
  p.inverterLifetimeYears = num("invlife", p.inverterLifetimeYears);
  p.inverterReplacementCostEUR = num("invrep", p.inverterReplacementCostEUR);
  p.batteryLifetimeYears = num("batlife", p.batteryLifetimeYears);
  p.batteryReplacementCostEUR = num("batrep", p.batteryReplacementCostEUR);
  p.batteryDegradationPct = num("batdeg", p.batteryDegradationPct);
  p.pvDegradationPct = num("pvdeg", p.pvDegradationPct);
  p.standbyWattage = num("stdby", p.standbyWattage);
  p.heatpumpJaz = num("jaz", p.heatpumpJaz);
  // The heat pump pays the Strompreis by default; an explicit `wpc` override
  // (its own cheaper WP tariff) still wins if present in the query string.
  p.heatpumpElectricCt = q.get("wpc") !== null ? num("wpc", p.heatpumpElectricCt) : p.importFixedCt;
  // Opportunity-cost (EV vs. diesel) inputs.
  p.car.annualKm = num("km", p.car.annualKm);
  p.car.dieselEurPerL = num("dl", p.car.dieselEurPerL);
  p.car.evElectricCtPerKwh = num("ec", p.car.evElectricCtPerKwh);
  // Direktvermarkter-Marge.
  p.marketMarginCt = num("mm", p.marketMarginCt);
  // Kleinwindkraftanlage.
  p.windEnabled = str("wen", p.windEnabled ? "1" : "0") === "1";
  p.windCount = num("wc", p.windCount);
  p.windHubHeightM = num("wh", p.windHubHeightM);
  p.windTurbineId = str("wt", p.windTurbineId);
  p.windSpeedMeanMs = num("wsm", p.windSpeedMeanMs);
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
  totalImportKWh: number;
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

function toSimConfig(p: SimParams): SimConfig {
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
  load: ConsumerBreakdown;
  selfUseKWh: number;
  importKWh: number;
  exportKWh: number;
  avgPrice: number;
  socKWh: number;
  count: number;
}

function emptyDay(hour: number): DayAccumulator {
  return {
    hour,
    pvKWh: 0,
    load: { household: 0, heatpump: 0, bwwp: 0, ev: 0 },
    selfUseKWh: 0,
    importKWh: 0,
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
    d.load.household += loads.household[i];
    d.load.heatpump += loads.heatpump[i];
    d.load.bwwp += loads.bwwp[i];
    d.load.ev += loads.ev[i];
    d.selfUseKWh += result.directUse[i] + result.directUseWind[i] + result.dischargeToLoadPV[i] + result.dischargeToLoadWind[i];
    d.importKWh += result.gridImport[i];
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
        load,
        totalLoadKWh: load.household + load.heatpump + load.bwwp + load.ev,
        selfUseKWh: (d.selfUseKWh / n) * stepsPerHour,
        importKWh: (d.importKWh / n) * stepsPerHour,
        exportKWh: (d.exportKWh / n) * stepsPerHour,
        avgPrice: d.avgPrice / n,
        socKWh: d.socKWh / n,
      };
    }),
  );
}

function scenarioVariants(
  result: SimResult,
  base: SimParams,
  city: ReturnType<typeof cityForLocation>,
  prices: ReturnType<typeof getYearPrices>,
): ScenarioDatum[] {
  const variants: { label: string; exportScheme: "fixed" | "market"; importScheme: SimParams["importScheme"] }[] = [
    { label: "Feste Einspeisung (§ 14a/2)", exportScheme: "fixed", importScheme: "fixed" },
    { label: "Direktvermarktung (Marktprämie)", exportScheme: "market", importScheme: "fixed" },
    { label: "Dynamischer Bezug (spotbasiert)", exportScheme: "fixed", importScheme: "dynamic" },
    { label: "Dynamisch + § 14a/3", exportScheme: "fixed", importScheme: "dynamic14a" },
  ];
  const imp = importPriceArray(base.importScheme, city, prices, base.importFixedCt);
  return variants.map((v) => {
    const econ = computeEconomics(result, {
      commissioningYear: base.commissioningYear,
      peakKWp: base.peakKWp,
      exportScheme: v.exportScheme,
      feedInCt: base.feedInCt,
      importScheme: v.importScheme,
      importCity: city,
      importFixedCt: base.importFixedCt,
      marketMarginCt: base.marketMarginCt,
    });
    const exportEUR = v.exportScheme === "market" ? econ.exportRevenueMarketEUR : econ.exportRevenueFixedEUR;
    let importEUR = 0;
    for (let i = 0; i < result.load.length; i++) importEUR += (result.gridImport[i] * imp[i]) / 100;
    return {
      label: v.label,
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
  // Uses the diesel car's OWN consumption (p.car.dieselLPer100km, ~5.5 l), not
  // the EV's kWh/100 km, so the drivetrain-efficiency gap is preserved and the
  // EV comes out cleaner than diesel even on grid electricity.
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
      label: MONTH_LABELS[i],
      pvKWh: r.pvKWh,
      windKWh: r.windKWh,
      load: { household: s.household, heatpump: s.heatpump, bwwp: s.bwwp, ev: s.ev },
      totalLoadKWh: r.loadKWh,
      selfConsumptionKWh: r.selfConsumptionKWh,
      importKWh: r.loadKWh - r.selfConsumptionKWh,
      exportKWh: r.exportKWh,
      netEUR: r.netSelectedEUR,
    };
  });

  const daily = dailyAll(result, loads);
  const scenario = scenarioVariants(result, p, city, prices);

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
    // makes the comparison react to every PV/battery slider: a bigger battery
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

  const totalPVKWh = annualSum(result.pv);
  const totalWindKWh = annualSum(result.wind);
  const totalGenerationKWh = totalPVKWh + totalWindKWh;
  const totalLoadKWh = annualSum(result.load);
  // Self-consumption = all generation that covers load (direct + battery-discharged).
  // Cap at total generation to avoid phantom self-consumption from initial battery SOC.
  const selfConsumptionKWh = Math.min(
    totalGenerationKWh,
    annualSum(result.directUse) + annualSum(result.directUseWind) + annualSum(result.dischargeToLoadPV) + annualSum(result.dischargeToLoadWind),
  );
  // Netz-Import is the residual so that Eigenverbrauch + Netz-Import = Verbrauch.
  // This includes both direct grid import and grid-charged battery discharge.
  const totalImportKWh = Math.max(0, totalLoadKWh - selfConsumptionKWh);

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
    totalExportKWh: annualSum(result.exportTotal),
    totalImportKWh,
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

const MONTH_LABELS = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
];

// Re-export so consumers do not need to import the underlying modules.
export { monthForStep };

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
