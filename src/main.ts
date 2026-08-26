import { simulate } from "./calc/simulation";
import { computeEconomics, monthForStep, EconOptions } from "./calc/revenue";
import { getYearPrices } from "./calc/priceData";
import { STEPS_PER_DAY, SimResult } from "./calc/types";
import { cityForLocation } from "./calc/tariff";
import { loadByConsumer } from "./calc/consumers";
import { importPriceArray } from "./calc/tariff";
import { effectiveNetPrice } from "./calc/vwap";
import { computeAmortisation } from "./calc/amortisation";
import { buildControls } from "./ui/controls";
import { DEFAULT_STATE, toSimConfig } from "./ui/state";
import { writeUrl, deserializeState } from "./ui/url";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderLegend,
  renderScenarioChart,
  DayChartDatum,
} from "./ui/charts";

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// Initialise from a shared URL if present; otherwise use the defaults.
const params = new URLSearchParams(location.search);
const state = params.toString() ? deserializeState(params.toString()) : { ...DEFAULT_STATE };

const controlsHost = document.getElementById("controls") as HTMLElement;
const summaryHost = document.getElementById("summary") as HTMLElement;
const monthlyHost = document.getElementById("monthly") as HTMLElement;
const hourlyHost = document.getElementById("hourly") as HTMLElement;
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
    importCity: cityForLocation(state.location),
    importFixedCt: state.importFixedCt,
  };
}

function hourlyProfile(result: SimResult, month: number): DayChartDatum[] {
  const buckets: {
    pv: number; load: number; selfUse: number; imp: number; exp: number; priceSum: number; socSum: number; n: number;
  }[] = Array.from({ length: 24 }, () => ({ pv: 0, load: 0, selfUse: 0, imp: 0, exp: 0, priceSum: 0, socSum: 0, n: 0 }));
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
    b.socSum += result.soc[i];
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
    socKWh: b.n > 0 ? b.socSum / b.n : 0,
  }));
}

function fmtEUR(v: number): string {
  return v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

function renderSummary(
  econ: ReturnType<typeof computeEconomics>,
  eff: { overallCt: number; byConsumer: Record<string, number> },
  amort: ReturnType<typeof computeAmortisation>,
): void {
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
    ["Eff. Strompreis (netto)", `${eff.overallCt.toFixed(1)} ct/kWh`, "Netto = (Import − Export) / Verbrauch"],
    ["Eff. Preis Haushalt", `${eff.byConsumer.household.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Eff. Preis Wärmepumpe", `${eff.byConsumer.heatpump.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Eff. Preis Brauchw.-WP", `${eff.byConsumer.bwwp.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Eff. Preis E-Auto", `${eff.byConsumer.ev.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Investition (PV+Speicher)", fmtEUR(amort.totalInvestmentEUR), `PV ${Math.round(amort.pvInvestmentEUR).toLocaleString("de-DE")} € (${Math.round(state.pvCostPerKWp)} €/kWp) · Speicher ${Math.round(amort.batteryInvestmentEUR).toLocaleString("de-DE")} € (${Math.round(state.batteryCostPerKWh)} €/kWh)`],
    ["Jahresersparnis", fmtEUR(amort.annualBenefitEUR), "ggü. Volleinspeisung aus dem Netz"],
    ["Amortisation", amort.paybackYears === Infinity ? "—" : `${amort.paybackYears.toFixed(1)} Jahre`, "einfache Amortisation"],
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
    { label: "Fest + Fest", exportScheme: "fixed", importScheme: "fixed" },
    { label: "DV + Fest", exportScheme: "market", importScheme: "fixed" },
    { label: "DV + Dyn", exportScheme: "market", importScheme: "dynamic" },
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

  const city = cityForLocation(state.location);
  const impPrices = importPriceArray(state.importScheme, city, prices, state.importFixedCt);
  const loads = loadByConsumer(state.consumers);
  const exportEUR = state.exportScheme === "market" ? econ.exportRevenueMarketEUR : econ.exportRevenueFixedEUR;
  const eff = effectiveNetPrice(loads, result.load, result.gridImport, impPrices, exportEUR);

  let baselineCostEUR = 0;
  for (let i = 0; i < result.load.length; i++) baselineCostEUR += (result.load[i] * impPrices[i]) / 100;
  const amort = computeAmortisation({
    peakKWp: state.peakKWp,
    capacityKWh: state.capacityKWh,
    baselineCostEUR,
    systemNetEUR: econ.netSelectedEUR,
    pvCostPerKWp: state.pvCostPerKWp,
    batteryCostPerKWh: state.batteryCostPerKWh,
  });

  renderSummary(econ, eff, amort);

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
  });
  renderHourly(result);
  renderScenario(result);
}

function renderHourly(result: SimResult): void {
  const data = hourlyProfile(result, selectedMonth);
  monthTitle.textContent = `${MONTH_LABELS[selectedMonth - 1]} — Stundenverteilung`;
  renderHourlyChart(hourlyHost, data, MONTH_LABELS[selectedMonth - 1], state.capacityKWh);
}

function scheduleRecompute(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    recompute();
  });
}

const onChange = (): void => {
  writeUrl(state);
  scheduleRecompute();
};

buildControls(controlsHost, state, onChange);
renderLegend(legendHost);
writeUrl(state);
recompute();
