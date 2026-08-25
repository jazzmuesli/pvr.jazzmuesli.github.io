import { simulate } from "./calc/simulation";
import { computeRevenue, monthForStep } from "./calc/revenue";
import { generatePrices } from "./calc/priceModel";
import { STEPS_PER_DAY, SimResult } from "./calc/types";
import { buildControls } from "./ui/controls";
import { DEFAULT_STATE, toSimConfig } from "./ui/state";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderLegend,
  MonthlyChartDatum,
  HourlyChartDatum,
} from "./ui/charts";

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const state = { ...DEFAULT_STATE };
const prices = generatePrices();

const controlsHost = document.getElementById("controls") as HTMLElement;
const summaryHost = document.getElementById("summary") as HTMLElement;
const monthlyHost = document.getElementById("monthly") as HTMLElement;
const hourlyHost = document.getElementById("hourly") as HTMLElement;
const legendHost = document.getElementById("legend") as HTMLElement;
const monthTitle = document.getElementById("month-title") as HTMLElement;

let selectedMonth = 6; // July
let rafPending = false;

function hourlyProfile(result: SimResult, month: number): HourlyChartDatum[] {
  const buckets: {
    pv: number; solarExport: number; batteryExport: number; charge: number; priceSum: number; n: number;
  }[] = Array.from({ length: 24 }, () => ({ pv: 0, solarExport: 0, batteryExport: 0, charge: 0, priceSum: 0, n: 0 }));
  for (let i = 0; i < result.pv.length; i++) {
    if (monthForStep(i) !== month) continue;
    const h = Math.floor((i % STEPS_PER_DAY) / (STEPS_PER_DAY / 24));
    const b = buckets[h];
    b.pv += result.pv[i];
    b.solarExport += result.exportSolar[i];
    b.batteryExport += result.exportBattery[i];
    b.charge += result.chargeSolar[i] + result.chargeGrid[i];
    b.priceSum += result.price[i];
    b.n += 1;
  }
  // normalise to per-hour averages
  return buckets.map((b, h) => ({
    hour: h,
    pvKWh: b.pv / Math.max(1, b.n) * 4, // kWh per hour (15-min steps -> *4 to hourly avg)
    solarExportKWh: b.solarExport / Math.max(1, b.n) * 4,
    batteryExportKWh: b.batteryExport / Math.max(1, b.n) * 4,
    chargeKWh: b.charge / Math.max(1, b.n) * 4,
    avgPrice: b.n > 0 ? b.priceSum / b.n : 0,
  }));
}

function fmtEUR(v: number): string {
  return v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

function renderSummary(rev: ReturnType<typeof computeRevenue>, sim: SimResult): void {
  const cards: [string, string, string][] = [
    ["PV-Ertrag", `${Math.round(rev.totalPVKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Exportiert", `${Math.round(rev.totalExportKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Markt (netto)", fmtEUR(rev.netMarketEUR), "Spot + Prämie − Ladestrom"],
    ["Einspeisung", fmtEUR(rev.fixedValueEUR), `fixe Vergütung`],
    ["Differenz", `${rev.deltaEUR >= 0 ? "+" : ""}${fmtEUR(rev.deltaEUR)}`, "Markt − Einspeisung"],
    ["Ø Erlös", `${rev.vwapMarketEURperMWh.toFixed(1)} €/MWh`, "VWAP Export"],
    ["Aus Netz geladen", `${Math.round(rev.totalChargeGridKWh).toLocaleString("de-DE")} kWh`, "Batterie-Ladung"],
    ["Negativpreis-Stunden", `${countNonPositive(sim)}`, "kein Export dabei"],
  ];
  summaryHost.innerHTML = "";
  for (const [k, v, sub] of cards) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-val">${v}</div><div class="card-key">${k}</div><div class="card-sub">${sub}</div>`;
    summaryHost.appendChild(card);
  }
}

function countNonPositive(sim: SimResult): number {
  let n = 0;
  for (let i = 0; i < sim.price.length; i++) if (sim.price[i] <= 0) n++;
  return n;
}

function recompute(): void {
  const cfg = toSimConfig(state);
  const result = simulate({ ...cfg, prices });
  const rev = computeRevenue(result, cfg.tariff);

  renderSummary(rev, result);

  const monthly: MonthlyChartDatum[] = rev.monthly.map((r) => ({
    month: r.month,
    label: MONTH_LABELS[r.month - 1],
    pvKWh: r.pvKWh,
    exportKWh: r.exportKWh,
    marketValueEUR: r.marketValueEUR + r.premiumEUR - r.gridChargeCostEUR,
  }));
  renderMonthlyChart(monthlyHost, monthly, selectedMonth, (m) => {
    selectedMonth = m;
    renderHourly(result);
  });
  renderHourly(result);
}

function renderHourly(result: SimResult): void {
  const data = hourlyProfile(result, selectedMonth);
  monthTitle.textContent = `${MONTH_LABELS[selectedMonth - 1]} — Stundeverteilung`;
  renderHourlyChart(hourlyHost, data, MONTH_LABELS[selectedMonth - 1]);
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
