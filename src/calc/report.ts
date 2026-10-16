// Single entry point for the whole economic simulation.
//
// `runSimulation(params)` takes a flat `SimParams` object and returns a
// complete `SimReport` (JSON-serialisable): the amortisation, per-month and
// per-hour/day energy and money flows, the scheme comparison, and the
// effective procurement price. This is what the UI uses and what the
// `/api?...` endpoint returns.
//
// The heavy lifting lives in focused modules — the dispatch engine
// (`simulation.ts`), the economics (`revenue.ts`), the chart aggregation
// (`charts.ts`), the CO₂ analysis (`co2.ts`) and the market comparison
// (`scenarios.ts`, `tariffCombinations.ts`). This file only wires them together
// and re-exports the public surface so callers keep importing from one place.

import { simulate } from "./simulation";
import { computeEconomics, monthForStep, EconOptions } from "./revenue";
import { getYearPrices } from "./priceData";
import { SimParams, DEFAULT_SIM_PARAMS } from "./simParams";
import { parseParams } from "./params";
import { cityForLocation, importPriceArray } from "./tariff";
import { loadByConsumer, annualSum } from "./consumers";
import { effectiveNetPrice, EffectivePrice } from "./vwap";
import { computeAmortisation, Amortisation } from "./amortisation";
import { computeCashflow, CashflowAnalysis, CashflowInput } from "./cashflow";
import { HeatingParams, DEFAULT_HEATING_PARAMS } from "./heating";
import { CarParams } from "./car";
import { computeOpportunityCosts, OpportunityCosts } from "./opportunity";
import {
  computeGasSavings,
  GasSavingsReport,
  DEFAULT_GAS_SAVINGS_PARAMS,
} from "./heatpumpGasSavings";
import { toSimConfig } from "./simConfig";
import { monthlyConsumerSums, dailyAll } from "./charts";
import { scenarioVariants } from "./scenarios";
import { computeTariffCombinations } from "./tariffCombinations";
import { computeGridMix, computeCo2Analysis } from "./co2";
import { round2 } from "./util";
import type {
  GridMix,
  Co2Analysis,
  MonthlyChartDatum,
  DayChartDatum,
  ScenarioDatum,
  TariffCombinationReport,
  SimSummary,
  OpportunityInvestment,
} from "./reportModel";

// ---- Re-exports: the public surface stays importable from `./report` --------

export type { SimParams } from "./simParams";
export { DEFAULT_SIM_PARAMS } from "./simParams";
export type { ConsumerKey } from "./consumers";
export { CONSUMER_ORDER } from "./consumers";
export type {
  ConsumerBreakdown,
  MonthlyChartDatum,
  DayChartDatum,
  ScenarioDatum,
  TariffComboYear,
  TariffCombination,
  TariffCombinationReport,
  GridMixShares,
  GridMix,
  Co2Scenario,
  Co2Analysis,
  SimSummary,
  OpportunityInvestment,
} from "./reportModel";
export {
  CO2_EMISSION_FACTORS,
  CO2_GAS_DIRECT,
  CO2_DIESEL_PER_L,
  CO2_DIESEL,
  GAS_HEAT_KWH_PER_KWH_USEFUL,
} from "./co2";

// ---- Config parsing --------------------------------------------------------

// Parse URL-style query parameters into SimParams. Mirrors the names used by
// the SPA URL so the same link works for the `/api` endpoint and the app. The
// field table lives in `./params` so the two wire formats cannot drift.
export function simParamsFromQuery(q: URLSearchParams): SimParams {
  const p = parseParams(DEFAULT_SIM_PARAMS, q);
  // The heat pump pays the household Strompreis (import tariff) by default;
  // an explicit `wpc` override (its own cheaper WP tariff) still wins when the
  // key is present in the query string.
  if (q.get("wpc") === null || q.get("wpc") === "") p.heatpumpElectricCt = p.importFixedCt;
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
  const gasSavings = p.consumers.heatpump.enabled
    ? computeGasSavings(loads.heatpump, {
        heatpumpElectricKWh: p.consumers.heatpump.annualKWh,
        jaz: p.heatpumpJaz,
        gasPowerplantEfficiency: DEFAULT_GAS_SAVINGS_PARAMS.gasPowerplantEfficiency,
        gasBoilerEfficiency: DEFAULT_GAS_SAVINGS_PARAMS.gasBoilerEfficiency,
        gasPriceCtPerKWh: DEFAULT_GAS_SAVINGS_PARAMS.gasPriceCtPerKWh,
      }, result.gridImport, result.load)
    : null;

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
