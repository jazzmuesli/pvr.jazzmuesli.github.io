import { simulate } from "./calc/simulation";
import { computeEconomics, feedInTariffCt, monthForStep, EconOptions } from "./calc/revenue";
import { getYearPrices } from "./calc/priceData";
import { STEPS_PER_DAY, SimResult } from "./calc/types";
import { buildControls } from "./ui/controls";
import { DEFAULT_STATE, toSimConfig } from "./ui/state";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderTypicalDayChart,
  renderLegend,
  renderScenarioChart,
  DayChartDatum,
} from "./ui/charts";

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const state = { ...DEFAULT_STATE };
state.feedInCt = feedInTariffCt(state.commissioningYear, state.peakKWp);

const controlsHost = document.getElementById("controls") as HTMLElement;
const summaryHost = document.getElementById("summary") as HTMLElement;
const monthlyHost = document.getElementById("monthly") as HTMLElement;
const hourlyHost = document.getElementById("hourly") as HTMLElement;
const typicalHost = document.getElementById("typical") as HTMLElement;
const legendHost = document.getElementById("legend") as HTMLElement;
const monthTitle = document.getElementById("month-title") as HTMLElement;
const scenarioHost = document.getElementById("scenario") as HTMLElement;

let selectedMonth = 6; // July
let rafPending = false;

function baseOpts(): EconOptions {
  return {
    commissioningYear: state.commissioningYear,
    peakKWp: state.peakKWp,
    exportScheme: state.exportScheme,
    feedInCt: state.feedInCt,
    importScheme: state.importScheme,
    importCity: state.importCity,
    importFixedCt: state.importFixedCt,
  };
}

function hourlyProfile(result: SimResult, month: number): DayChartDatum[] {
  const buckets: {
    pv: number; load: number; selfUse: number; imp: number; exp: number; priceSum: number; n: number;
  }[] = Array.from({ length: 24 }, () => ({ pv: 0, load: 0, selfUse: 0, imp: 0, exp: 0, priceSum: 0, n: 0 }));
  for (let i = 0; i < result.pv.length; i++) {
    const m = monthForStep(i);
    if (m !== month) continue;
    const h = Math.floor((i % STEPS_PER_DAY) / (STEPS_PER_DAY / 24));
    const b = buckets[h];
    b.pv += result.pv[i];
    b.load += result.load[i];
    b.selfUse += result.directUse[i] + result.dischargeToLoad[i];
    b.imp += result.gridImport[i];
    b.exp += result.exportTotal[i];
    b.priceSum += result.price[i];
    b.n += 1;
  }
  return buckets.map((b, h) => ({
    hour: h,
    pvKWh: (b.pv / Math.max(1, b.n)) * 4,
    loadKWh: (b.load / Math.max(1, b.n)) * 4,
    selfUseKWh: (b.selfUse / Math.max(1, b.n)) * 4,
    importKWh: (b.imp / Math.max(1, b.n)) * 4,
    exportKWh: (b.exp / Math.max(1, b.n)) * 4,
    avgPrice: b.n > 0 ? b.priceSum / b.n : 0,
  }));
}

function typicalDayProfile(econ: ReturnType<typeof computeEconomics>, month: number): DayChartDatum[] {
  return econ.typicalDay.filter((d) => d.month === month).map((d) => ({
    hour: d.hour,
    pvKWh: d.pvKWh,
    loadKWh: d.loadKWh,
    selfUseKWh: d.selfUseKWh,
    importKWh: d.importKWh,
    exportKWh: d.exportKWh,
    avgPrice: 0,
  }));
}

function fmtEUR(v: number): string {
  return v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

function renderSummary(econ: ReturnType<typeof computeEconomics>): void {
  const exportEUR = state.exportScheme === "market" ? econ.exportRevenueMarketEUR : econ.exportRevenueFixedEUR;
  const importEUR = state.importScheme === "fixed" ? econ.importCostFixedEUR
    : state.importScheme === "dynamic" ? econ.importCostDynamicEUR : econ.importCost14aEUR;
  const selfPct = econ.totalLoadKWh > 0 ? (econ.selfConsumptionKWh / econ.totalLoadKWh) * 100 : 0;
  const cards: [string, string, string][] = [
    ["PV-Ertrag", `${Math.round(econ.totalPVKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Verbrauch", `${Math.round(econ.totalLoadKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Eigenverbrauch", `${Math.round(econ.selfConsumptionKWh).toLocaleString("de-DE")} kWh`, `${selfPct.toFixed(0)} % des Verbrauchs`],
    ["Netz-Import", `${Math.round(econ.totalImportKWh).toLocaleString("de-DE")} kWh`, "Batterie + Verbrauch"],
    ["Export", `${Math.round(econ.totalExportKWh).toLocaleString("de-DE")} kWh`, "ins Netz"],
    ["Export-Erlös", fmtEUR(exportEUR), state.exportScheme === "market" ? "Direktvermarktung" : "Feste Vergütung"],
    ["Stromkosten", fmtEUR(importEUR), state.importScheme === "fixed" ? "fester Tarif" : state.importScheme === "dynamic" ? "dynamisch" : "dynamisch + §14a/3"],
    ["Netto-Bilanz", `${econ.netSelectedEUR >= 0 ? "+" : ""}${fmtEUR(econ.netSelectedEUR)}`, "Export − Import"],
    ["Marktprämie", `${econ.marktPraemieCt.toFixed(2)} ct/kWh`, `EEG ${state.commissioningYear}`],
    ["EEG Referenz", `${econ.referenceValueCt.toFixed(2)} ct/kWh`, "anzulegender Wert"],
  ];
  summaryHost.innerHTML = "";
  for (const [k, v, sub] of cards) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-val">${v}</div><div class="card-key">${k}</div><div class="card-sub">${sub}</div>`;
    summaryHost.appendChild(card);
  }
}

function renderScenario(result: SimResult): void {
  const variants: { label: string; exportScheme: "fixed" | "market"; importScheme: "fixed" | "dynamic" | "dynamic14a" }[] = [
    { label: "Feste Einsp.\n+ Fest", exportScheme: "fixed", importScheme: "fixed" },
    { label: "DV + Fest", exportScheme: "market", importScheme: "fixed" },
    { label: "DV + Dynam.", exportScheme: "market", importScheme: "dynamic" },
    { label: "DV + §14a/3", exportScheme: "market", importScheme: "dynamic14a" },
  ];
  const data = variants.map((v) => {
    const e = computeEconomics(result, { ...baseOpts(), exportScheme: v.exportScheme, importScheme: v.importScheme });
    const exportEUR = v.exportScheme === "fixed" ? e.exportRevenueFixedEUR : e.exportRevenueMarketEUR;
    const importEUR = v.importScheme === "fixed" ? e.importCostFixedEUR
      : v.importScheme === "dynamic" ? e.importCostDynamicEUR : e.importCost14aEUR;
    return { label: v.label, netEUR: exportEUR - importEUR, exportEUR, importEUR };
  });
  renderScenarioChart(scenarioHost, data);
}

function recompute(): void {
  const cfg = toSimConfig(state);
  const prices = getYearPrices(state.priceYear);
  const result = simulate({ ...cfg, prices });
  const econ = computeEconomics(result, baseOpts());

  renderSummary(econ);

  const monthly = econ.monthly.map((r) => ({
    month: r.month,
    label: MONTH_LABELS[r.month - 1],
    pvKWh: r.pvKWh,
    selfConsumptionKWh: r.selfConsumptionKWh,
    importKWh: r.importKWh,
    exportKWh: r.exportKWh,
    netEUR: r.netSelectedEUR,
  }));
  renderMonthlyChart(monthlyHost, monthly, selectedMonth, (m) => {
    selectedMonth = m;
    renderHourly(result);
    renderTypical(econ);
  });
  renderHourly(result);
  renderTypical(econ);
  renderScenario(result);
}

function renderHourly(result: SimResult): void {
  const data = hourlyProfile(result, selectedMonth);
  monthTitle.textContent = `${MONTH_LABELS[selectedMonth - 1]} — Stundenverteilung`;
  renderHourlyChart(hourlyHost, data, MONTH_LABELS[selectedMonth - 1]);
}

function renderTypical(econ: ReturnType<typeof computeEconomics>): void {
  const data = typicalDayProfile(econ, selectedMonth);
  renderTypicalDayChart(typicalHost, data, MONTH_LABELS[selectedMonth - 1]);
}

function scheduleRecompute(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    recompute();
  });
}

buildControls(controlsHost, state, scheduleRecompute);
renderLegend(legendHost);
recompute();
