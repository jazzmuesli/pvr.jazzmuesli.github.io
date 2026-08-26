import { runSimulation, SimReport } from "./calc/report";
import { buildControls } from "./ui/controls";
import { DEFAULT_STATE, toSimParams } from "./ui/state";
import { writeUrl, deserializeState } from "./ui/url";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderScenarioChart,
} from "./ui/charts";

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// Initialise from a shared URL if present; otherwise use the defaults.
const params = new URLSearchParams(location.search);
const state = params.toString() ? deserializeState(params.toString()) : { ...DEFAULT_STATE };

const controlsHost = document.getElementById("controls") as HTMLElement;
const summaryHost = document.getElementById("summary") as HTMLElement;
const monthlyHost = document.getElementById("monthly") as HTMLElement;
const hourlyHost = document.getElementById("hourly") as HTMLElement;
const monthTitle = document.getElementById("month-title") as HTMLElement;
const scenarioHost = document.getElementById("scenario") as HTMLElement;
const heatingHost = document.getElementById("heating") as HTMLElement;
const heatingBody = document.getElementById("heating-body") as HTMLElement;
const carHost = document.getElementById("car") as HTMLElement;
const carBody = document.getElementById("car-body") as HTMLElement;

let selectedMonth = 6; // July
let rafPending = false;
let report: SimReport | null = null;

function importSchemeLabel(): string {
  return state.importScheme === "fixed" ? "fester Tarif"
    : state.importScheme === "dynamic" ? "dynamisch (Spot)"
    : "dynamisch + §14a/3";
}

function fmtEUR(v: number): string {
  return v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}

function renderSummary(r: SimReport): void {
  const s = r.summary;
  const eff = r.effectivePrice;
  const selfPct = s.totalLoadKWh > 0 ? (s.selfConsumptionKWh / s.totalLoadKWh) * 100 : 0;
  const cards: [string, string, string][] = [
    ["PV-Ertrag", `${Math.round(s.totalPVKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Verbrauch", `${Math.round(s.totalLoadKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Eigenverbrauch", `${Math.round(s.selfConsumptionKWh).toLocaleString("de-DE")} kWh`, `${selfPct.toFixed(0)} % des Verbrauchs`],
    ["Netz-Import", `${Math.round(s.totalImportKWh).toLocaleString("de-DE")} kWh`, "Batterie + Verbrauch"],
    ["Export", `${Math.round(s.totalExportKWh).toLocaleString("de-DE")} kWh`, "ins Netz"],
    ["Export-Erlös", fmtEUR(s.exportRevenueEUR), state.exportScheme === "market" ? "Direktvermarktung" : "Feste Vergütung"],
    ["Stromkosten", fmtEUR(s.importCostEUR), importSchemeLabel()],
    ["Netto-Bilanz", `${s.netSelectedEUR >= 0 ? "+" : ""}${fmtEUR(s.netSelectedEUR)}`, "Export − Import"],
    ["Marktprämie", `${s.marktPraemieCt.toFixed(2)} ct/kWh`, `EEG ${state.commissioningYear}`],
    ["EEG Referenz", `${s.referenceValueCt.toFixed(2)} ct/kWh`, "anzulegender Wert"],
    ["Eff. Strompreis (netto)", `${eff.overallCt.toFixed(1)} ct/kWh`, "Netto = (Import − Export) / Verbrauch"],
    ["Eff. Preis Haushalt", `${eff.byConsumer.household.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Eff. Preis Wärmepumpe", `${eff.byConsumer.heatpump.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Eff. Preis Brauchw.-WP", `${eff.byConsumer.bwwp.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Eff. Preis E-Auto", `${eff.byConsumer.ev.toFixed(1)} ct/kWh`, "nur Bezug (ohne Export)"],
    ["Investition (gesamt)", fmtEUR(r.amortisation.totalInvestmentEUR), "einmalige Gesamtinvestition"],
    ["Jahresersparnis", fmtEUR(r.amortisation.annualBenefitEUR), "ggü. Volleinspeisung aus dem Netz"],
    ["Amortisation", r.amortisation.paybackYears === Infinity ? "—" : `${r.amortisation.paybackYears.toFixed(1)} Jahre`, "einfache Amortisation"],
  ];
  summaryHost.innerHTML = "";
  for (const [k, v, sub] of cards) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-val">${v}</div><div class="card-key">${k}</div><div class="card-sub">${sub}</div>`;
    summaryHost.appendChild(card);
  }
}

function renderHourly(): void {
  if (!report) return;
  const data = report.daily[selectedMonth - 1];
  monthTitle.textContent = `${MONTH_LABELS[selectedMonth - 1]} — Stundenverteilung`;
  renderHourlyChart(hourlyHost, data, MONTH_LABELS[selectedMonth - 1], state.capacityKWh);
}

function renderHeating(r: SimReport): void {
  const h = r.opportunityCosts.heating;
  heatingHost.style.display = h.heatpumpElectricKWh > 0 ? "" : "none";
  if (h.heatpumpElectricKWh <= 0) return;

  const fmt = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const rows: { a: typeof h.heatpump; highlight: boolean }[] = [
    { a: h.heatpump, highlight: true },
    { a: h.oil, highlight: false },
    { a: h.gas, highlight: false },
  ];
  const head = `
    <div class="heat-head">
      <span>Wärmepumpe: ${Math.round(h.heatpumpElectricKWh).toLocaleString("de-DE")} kWh Strom →
      ${Math.round(h.usefulHeatKWh).toLocaleString("de-DE")} kWh Wärme (JAZ ${h.jaz})</span>
    </div>`;
  const cards = rows
    .map(({ a, highlight }) => {
      const delta =
        a.mode === "heatpump" ? "" :
        `<div class="card-sub">${a.deltaVsHeatpumpEUR > 0 ? "+" : ""}${fmt(a.deltaVsHeatpumpEUR)} ggü. Wärmepumpe</div>`;
      return `
      <div class="card${highlight ? " card-hl" : ""}">
        <div class="card-val">${fmt(a.totalEUR)}<span class="card-unit">/Jahr</span></div>
        <div class="card-key">${a.label}</div>
        <div class="card-sub">Energie ${fmt(a.energyCostEUR)}${a.gridFeeEUR ? ` · Netz ${fmt(a.gridFeeEUR)}` : ""}</div>
        <div class="card-sub">Schornsteinfeger ${fmt(a.chimneySweepEUR)}${a.otherNebenkostenEUR ? ` · Nebenk. ${fmt(a.otherNebenkostenEUR)}` : ""}</div>
        ${delta}
      </div>`;
    })
    .join("");
  heatingBody.innerHTML = head + `<div class="summary">${cards}</div>` + opportunityNote(r, "heating");
}

/** Footer line that ties the annual saving to the PV payback horizon. */
function opportunityNote(r: SimReport, kind: "heating" | "car"): string {
  const inv = r.opportunityInvestment;
  const saving = kind === "heating" ? inv.heatingSavingEUR : inv.carSavingEUR;
  const financeable = kind === "heating" ? inv.financeableHeatpumpEUR : inv.financeableEvEUR;
  const label = kind === "heating" ? "Gas" : "Diesel";
  if (financeable == null) return "";
  const fmt = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  return `<div class="heat-foot">Ersparnis ggü. ${label}: ${fmt(saving)}/Jahr · finanzierbar in ${inv.pvPaybackYears.toFixed(1)} J. (PV-Amortisation): ${fmt(financeable)}</div>`;
}

function renderOpportunityCar(r: SimReport): void {
  const c = r.opportunityCosts.car;
  carHost.style.display = c.annualKm > 0 ? "" : "none";
  if (c.annualKm <= 0) return;

  const fmt = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const fmtKm = (v: number) => v.toLocaleString("de-DE") + " km";
  const rows: { a: typeof c.ev; highlight: boolean }[] = [
    { a: c.ev, highlight: true },
    { a: c.diesel, highlight: false },
  ];
  const head = `
    <div class="heat-head">
      <span>E-Auto vs. Diesel: ${fmtKm(c.annualKm)} pro Jahr</span>
    </div>`;
  const cards = rows
    .map(({ a, highlight }) => {
      const delta =
        a.mode === "ev" ? "" :
        `<div class="card-sub">${a.deltaVsEvEUR > 0 ? "+" : ""}${fmt(a.deltaVsEvEUR)} ggü. E-Auto</div>`;
      return `
      <div class="card${highlight ? " card-hl" : ""}">
        <div class="card-val">${fmt(a.totalEUR)}<span class="card-unit">/Jahr</span></div>
        <div class="card-key">${a.label}</div>
        <div class="card-sub">Energie ${fmt(a.energyCostEUR)}${a.mode === "ev" ? ` · ${Math.round(a.primaryEnergy)} kWh` : ` · ${Math.round(a.primaryEnergy)} L`}</div>
        <div class="card-sub">Wartung ${fmt(a.maintenanceEUR)} · Steuer ${fmt(a.vehicleTaxEUR)} · Nebenk. ${fmt(a.otherNebenkostenEUR)}</div>
        ${delta}
      </div>`;
    })
    .join("");
  carBody.innerHTML = head + `<div class="summary">${cards}</div>` + opportunityNote(r, "car");
}

function recompute(): void {
  report = runSimulation(toSimParams(state));

  renderSummary(report);
  renderMonthlyChart(monthlyHost, report.monthly, selectedMonth, (m) => {
    selectedMonth = m;
    renderHourly();
  });
  renderHourly();
  renderScenarioChart(scenarioHost, report.scenario);
  renderHeating(report);
  renderOpportunityCar(report);
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
writeUrl(state);
recompute();
