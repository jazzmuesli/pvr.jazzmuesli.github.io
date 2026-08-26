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
  // Heating: JAZ of the heat pump and its electricity price (for the
  // fossil-fuelled alternative cost comparison in `heating`).
  heatpumpJaz: number;
  heatpumpElectricCt: number;
  // Opportunity-cost comparison inputs (heating + EV vs. diesel). The defaults
  // are realistic for a German household; the heat-pump electricity comes from
  // the heat-pump consumer above.
  car: CarParams;
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
  consumers: {
    household: { enabled: true, annualKWh: 2400 },
    heatpump: { enabled: true, annualKWh: 6500 },
    bwwp: { enabled: true },
    ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
  },
  exportScheme: "fixed",
  importScheme: "fixed",
  importFixedCt: 24,
  investmentEUR: 32000,
  heatpumpJaz: 3,
  heatpumpElectricCt: 24,
  car: { ...DEFAULT_CAR_PARAMS },
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
  p.consumers.ev.enabled = str("ev", p.consumers.ev.enabled ? "1" : "0") === "1";
  p.consumers.ev.annualKWh = num("ek", p.consumers.ev.annualKWh);
  p.consumers.ev.pvShare = num("es", p.consumers.ev.pvShare);
  p.exportScheme = (str("ex", p.exportScheme) as SimParams["exportScheme"]) ?? p.exportScheme;
  p.importScheme = (str("im", p.importScheme) as SimParams["importScheme"]) ?? p.importScheme;
  p.importFixedCt = num("ict", p.importFixedCt);
  p.investmentEUR = num("inv", p.investmentEUR);
  p.heatpumpJaz = num("jaz", p.heatpumpJaz);
  // The heat pump pays the Strompreis by default; an explicit `wpc` override
  // (its own cheaper WP tariff) still wins if present in the query string.
  p.heatpumpElectricCt = q.get("wpc") !== null ? num("wpc", p.heatpumpElectricCt) : p.importFixedCt;
  // Opportunity-cost (EV vs. diesel) inputs.
  p.car.annualKm = num("km", p.car.annualKm);
  p.car.dieselEurPerL = num("dl", p.car.dieselEurPerL);
  p.car.evElectricCtPerKwh = num("ec", p.car.evElectricCtPerKwh);
  return p;
}

// ---- Report ----------------------------------------------------------------

export interface SimReport {
  inputs: SimParams;
  summary: SimSummary;
  amortisation: Amortisation;
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
}

export interface OpportunityInvestment {
  /** PV simple payback (years); may be Infinity when there is no PV benefit. */
  pvPaybackYears: number;
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
  totalLoadKWh: number;
  selfConsumptionKWh: number;
  totalExportKWh: number;
  totalImportKWh: number;
  exportRevenueEUR: number;
  importCostEUR: number;
  netSelectedEUR: number;
  marktPraemieCt: number;
  referenceValueCt: number;
}

function toSimConfig(p: SimParams): SimConfig {
  const hasBattery = p.capacityKWh > 0;
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
    d.selfUseKWh += result.directUse[i] + result.dischargeToLoad[i];
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
      load: { household: s.household, heatpump: s.heatpump, bwwp: s.bwwp, ev: s.ev },
      totalLoadKWh: r.loadKWh,
      selfConsumptionKWh: r.importKWh > 0 ? r.loadKWh - r.importKWh : r.loadKWh,
      importKWh: r.importKWh,
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
    annualKm: evKWh > 0 ? Math.round((evKWh * 100) / p.car.evKwhPer100km) : p.car.annualKm,
  };

  // Opportunity-cost comparison (heating + EV vs. diesel) — the single shared
  // function used by both the `/api` endpoint and the client UI.
  const opportunityCosts = computeOpportunityCosts({
    heating: heatingParams,
    car: carParams,
  });

  // Tie the fossil-vs-electric decision to the PV economics: the annual saving
  // can finance a heat pump / EV over the PV's own payback horizon.
  const pvPaybackYears = amortisation.paybackYears;
  const heatingSavingEUR = opportunityCosts.heating.gas.totalEUR - opportunityCosts.heating.heatpump.totalEUR;
  const carSavingEUR = opportunityCosts.car.diesel.totalEUR - opportunityCosts.car.ev.totalEUR;
  const financeable = (savingEUR: number): number | null =>
    Number.isFinite(pvPaybackYears) && savingEUR > 0 ? round2(savingEUR * pvPaybackYears) : null;
  const opportunityInvestment = {
    pvPaybackYears,
    heatingSavingEUR: round2(heatingSavingEUR),
    financeableHeatpumpEUR: financeable(heatingSavingEUR),
    carSavingEUR: round2(carSavingEUR),
    financeableEvEUR: financeable(carSavingEUR),
  };

  const summary: SimSummary = {
    totalPVKWh: annualSum(result.pv),
    totalLoadKWh: annualSum(result.load),
    selfConsumptionKWh: annualSum(result.directUse) + annualSum(result.dischargeToLoad),
    totalExportKWh: annualSum(result.exportTotal),
    totalImportKWh: annualSum(result.gridImport),
    exportRevenueEUR: exportEUR,
    importCostEUR,
    netSelectedEUR: econ.netSelectedEUR,
    marktPraemieCt: econ.marktPraemieCt,
    referenceValueCt: econ.referenceValueCt,
  };

  return {
    inputs: p,
    summary,
    amortisation,
    effectivePrice,
    monthly,
    daily,
    scenario,
    tariffCombinations: computeTariffCombinations(p),
    opportunityCosts,
    opportunityInvestment,
  };
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
