import { runSimulation, SimReport } from "./calc/report";
import { buildControls } from "./ui/controls";
import { DEFAULT_STATE, toSimParams } from "./ui/state";
import { writeUrl, deserializeState } from "./ui/url";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderScenarioChart,
  renderTariffCombinationChart,
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
const bwwpHost = document.getElementById("bwwp") as HTMLElement;
const bwwpBody = document.getElementById("bwwp-body") as HTMLElement;
const combosHost = document.getElementById("tarif-combos") as HTMLElement;
const combosBody = document.getElementById("tarif-combos-body") as HTMLElement;

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
  const expert = state.expertMode;
  const cards: [string, string, string][] = [
    ["PV-Ertrag", `${Math.round(s.totalPVKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Verbrauch", `${Math.round(s.totalLoadKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
    ["Eigenverbrauch", `${Math.round(s.selfConsumptionKWh).toLocaleString("de-DE")} kWh`, `${selfPct.toFixed(0)}% des Verbrauchs`],
    ["Netz-Import", `${Math.round(s.totalImportKWh).toLocaleString("de-DE")} kWh`, ""],
    ["Export", `${Math.round(s.totalExportKWh).toLocaleString("de-DE")} kWh`, "ins Netz"],
    ["Netto-Bilanz", `${s.netSelectedEUR >= 0 ? "+" : ""}${fmtEUR(s.netSelectedEUR)}`, "Export − Import"],
    ["Eff. Strompreis", `${eff.overallCt.toFixed(1)} ct/kWh`, "netto"],
    ["Amortisation", r.amortisation.paybackYears === Infinity ? "—" : `${r.amortisation.paybackYears.toFixed(1)} J.`, "Jahresersparnis " + fmtEUR(r.amortisation.annualBenefitEUR)],
  ];
  if (expert) {
    cards.push(
      ["Export-Erlös", fmtEUR(s.exportRevenueEUR), state.exportScheme === "market" ? "Direktvermarktung" : "Feste Vergütung"],
      ["Stromkosten", fmtEUR(s.importCostEUR), importSchemeLabel()],
      ["Marktprämie", `${s.marktPraemieCt.toFixed(2)} ct/kWh`, `EEG ${state.commissioningYear}`],
      ["EEG Referenz", `${s.referenceValueCt.toFixed(2)} ct/kWh`, "anzulegender Wert"],
      ["Eff. Preis Haushalt", `${eff.byConsumer.household.toFixed(1)} ct/kWh`, ""],
      ["Eff. Preis Wärmepumpe", `${eff.byConsumer.heatpump.toFixed(1)} ct/kWh`, ""],
      ["Eff. Preis E-Auto", `${eff.byConsumer.ev.toFixed(1)} ct/kWh`, ""],
      ["Investition", fmtEUR(r.amortisation.totalInvestmentEUR), ""],
    );
  }
  summaryHost.innerHTML = "";
  for (const [k, v, sub] of cards) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-val">${v}</div><div class="card-key">${k}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}`;
    summaryHost.appendChild(card);
  }
}

function renderHourly(): void {
  if (!report) return;
  const data = report.daily[selectedMonth - 1];
  monthTitle.textContent = `${MONTH_LABELS[selectedMonth - 1]} — Stundenverteilung`;
  renderHourlyChart(hourlyHost, data, MONTH_LABELS[selectedMonth - 1], state.capacityKWh);
}

/** One-line PV+battery coverage summary for a consumer (heat pump / EV).
 *  Shows the PV-covered share (% and kWh), the grid share, and the grid price:
 *  for a dynamic tariff this is the volume-weighted average of the import hours
 *  (label "Ø"), for a fixed tariff it is the fixed price. */
function coverageLine(
  cov:
    | {
        pvCoveredKWh: number;
        gridKWh: number;
        pvSharePct: number;
        gridPriceCt: number;
        effectiveCt: number;
        dynamic: boolean;
      }
    | undefined,
  _label: string,
): string {
  if (!cov) return "";
  const kwh = (v: number) => Math.round(v).toLocaleString("de-DE");
  const gridLabel = cov.dynamic ? "Ø dynamischer Netzpreis" : "fester Netzpreis";
  const gridSharePct = Math.max(0, 100 - cov.pvSharePct);
  return `
    <div class="heat-cov">
      <span class="cov-pv">PV+Speicher: <b>${cov.pvSharePct.toFixed(0)}%</b>
        (${kwh(cov.pvCoveredKWh)} kWh · 0 ct/kWh)</span>
      <span class="cov-grid">Netz: <b>${gridSharePct.toFixed(0)}%</b>
        (${kwh(cov.gridKWh)} kWh · ${gridLabel} ${cov.gridPriceCt.toFixed(1)} ct/kWh)</span>
      <span class="cov-eff">Effektiv: <b>${cov.effectiveCt.toFixed(1)} ct/kWh</b></span>
    </div>`;
}

function renderHeating(r: SimReport): void {  const h = r.opportunityCosts.heating;
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
    </div>${coverageLine(h.coverage, "Wärmepumpe")}`;
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
    </div>${coverageLine(c.coverage, "E-Auto")}`;
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

function renderBwwp(r: SimReport): void {
  const enabled = r.inputs.consumers.bwwp.enabled;
  const cov = r.effectivePrice.coverage?.bwwp;
  bwwpHost.style.display = enabled && cov && cov.consumptionKWh > 0 ? "" : "none";
  if (!enabled || !cov || cov.consumptionKWh <= 0) return;

  const dynamic = r.inputs.importScheme !== "fixed";
  const kwh = (v: number) => Math.round(v).toLocaleString("de-DE");
  const gridSharePct = Math.max(0, 100 - cov.pvSharePct);
  const gridLabel = dynamic ? "Ø dynamischer Netzpreis" : "fester Netzpreis";
  const covInfo = {
    pvCoveredKWh: cov.pvCoveredKWh,
    gridKWh: cov.gridKWh,
    pvSharePct: cov.pvSharePct,
    gridPriceCt: cov.gridPriceCt,
    effectiveCt: cov.effectiveCt,
    dynamic,
  };
  const head = `
    <div class="heat-head">
      <span>Brauchwasser: ${kwh(cov.consumptionKWh)} kWh Strom/Jahr (Mittags-PV-Block 11–15 Uhr)</span>
    </div>${coverageLine(covInfo, "Brauchwasser-WP")}`;
  const card = `
    <div class="card card-hl">
      <div class="card-val">${cov.pvSharePct.toFixed(0)}%<span class="card-unit"> PV</span></div>
      <div class="card-key">Brauchwasser-WP</div>
      <div class="card-sub">PV+Speicher ${kwh(cov.pvCoveredKWh)} kWh · 0 ct/kWh</div>
      <div class="card-sub">Netz ${kwh(cov.gridKWh)} kWh (${gridSharePct.toFixed(0)}%) · ${gridLabel} ${cov.gridPriceCt.toFixed(1)} ct/kWh</div>
      <div class="card-sub">Effektiver Preis ${cov.effectiveCt.toFixed(1)} ct/kWh</div>
    </div>`;
  bwwpBody.innerHTML = head + `<div class="summary">${card}</div>`;
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
  renderBwwp(report);
  renderTariffCombinations(report);
}

function renderTariffCombinations(r: SimReport): void {
  combosHost.style.display = "";
  const years = r.tariffCombinations.years.join(", ");
  combosBody.innerHTML =
    `<div class="hint">Import-Kosten & Export-Erlös je Tarifkombination, berechnet über die historischen Spot-Preisjahre ${years} ` +
    `(Volllast-Auslegung: PV-Erzeugung, Verbrauch und Batterie-Dispatch werden pro Jahr neu simuliert).</div>` +
    `<div class="combo-grid"></div>`;
  const grid = combosBody.querySelector(".combo-grid") as HTMLElement;
  for (const combo of r.tariffCombinations.combinations) {
    const cell = document.createElement("div");
    cell.className = "combo-cell";
    const title = document.createElement("h3");
    title.textContent = combo.label;
    const chart = document.createElement("div");
    cell.appendChild(title);
    cell.appendChild(chart);
    grid.appendChild(cell);
    renderTariffCombinationChart(chart, combo);
  }
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

// Mobile sidebar drawer: the sidebar is a slide-in overlay on small screens.
// Toggle it with the header button, close it via the backdrop, the Escape key,
// or automatically once the viewport grows back to desktop width.
const toggleBtn = document.getElementById("toggle-sidebar") as HTMLButtonElement | null;
const backdrop = document.getElementById("sidebar-backdrop");
function setSidebar(open: boolean): void {
  document.body.classList.toggle("sidebar-open", open);
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", String(open));
}
if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    setSidebar(!document.body.classList.contains("sidebar-open"));
  });
}
backdrop?.addEventListener("click", () => setSidebar(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setSidebar(false);
});
// If the window is resized to desktop width, drop the mobile drawer state.
window.addEventListener("resize", () => {
  if (window.innerWidth > 880) setSidebar(false);
});

// Excel export: generate a fully-formula workbook from the current report and
// download it client-side (no server round-trip).
const downloadBtn = document.getElementById("download-xlsx") as HTMLButtonElement | null;
if (downloadBtn) {
  downloadBtn.addEventListener("click", async () => {
    if (!report) return;
    const prev = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "⏳ Erzeuge…";
    try {
      const { downloadWorkbook } = await import("./export/workbook");
      await downloadWorkbook(report);
    } catch (err) {
      console.error("Excel-Export fehlgeschlagen:", err);
      alert("Excel-Export fehlgeschlagen. Details in der Konsole.");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = prev;
    }
  });
}
