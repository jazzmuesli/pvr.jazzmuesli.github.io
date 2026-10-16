// Report-level data-transfer types.
//
// These are the JSON shapes the report exposes to the UI and the `/api`
// endpoint (the engine's own `SimResult` lives in `types.ts`). They are kept in
// one place so the aggregation, CO2, tariff and scenario modules can depend on
// the shape without depending on the orchestrator.

import type { ConsumerKey } from "./consumers";

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
  windKWh: number;
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
  importScheme: "fixed" | "dynamic" | "dynamic14a";
  years: TariffComboYear[];
}

export interface TariffCombinationReport {
  years: string[];
  combinations: TariffCombination[];
}

// ---- Grid mix --------------------------------------------------------------

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

// ---- CO2 scenarios ---------------------------------------------------------

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
  baseline: Co2Scenario;
  plusPv: Co2Scenario;
  plusEv: Co2Scenario;
  plusEvPv: Co2Scenario;
  plusEvWp: Co2Scenario;
  evWpNoPv: Co2Scenario;
  wpDieselGrid: Co2Scenario;
}

// ---- Summary ---------------------------------------------------------------

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

export interface OpportunityInvestment {
  pvPaybackYears: number;
  discountedPvPaybackYears: number;
  heatingSavingEUR: number;
  financeableHeatpumpEUR: number | null;
  carSavingEUR: number;
  financeableEvEUR: number | null;
}

/** Re-export so report consumers do not need a second import. */
export type { ConsumerKey };
