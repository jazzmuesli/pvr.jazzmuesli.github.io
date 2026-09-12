import { runSimulation, SimReport, CO2_EMISSION_FACTORS, CO2_GAS_DIRECT, CO2_DIESEL } from "./calc/report";
import { DEFAULT_GAS_BOILER_EFFICIENCY, DEFAULT_GAS_POWERPLANT_EFFICIENCY } from "./calc/heatpumpGasSavings";
import { buildControls } from "./ui/controls";
import { DEFAULT_STATE, toSimParams } from "./ui/state";
import { writeUrl, deserializeState } from "./ui/url";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderScenarioChart,
  renderTariffCombinationChart,
  renderPieChart,
} from "./ui/charts";
import { t, monthAbbrevs, fmtEUR as i18nFmtEUR, getLocale, setLocale } from "./i18n";

function monthLabels(): string[] { return monthAbbrevs(); }

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
const gridMixTitle = document.getElementById("grid-mix-title") as HTMLElement;
const gridMixHint = document.getElementById("grid-mix-hint") as HTMLElement;
const gridMixBody = document.getElementById("grid-mix-body") as HTMLElement;
const co2Title = document.getElementById("co2-title") as HTMLElement;
const co2Hint = document.getElementById("co2-hint") as HTMLElement;
const co2Body = document.getElementById("co2-body") as HTMLElement;

let selectedMonth = 6; // July
let rafPending = false;
let report: SimReport | null = null;

function importSchemeLabel(): string {
  return state.importScheme === "fixed" ? t("import.label_fixed")
    : state.importScheme === "dynamic" ? t("import.label_dynamic")
    : t("import.label_dynamic14a");
}

const fmtEUR = i18nFmtEUR;

function renderSummary(r: SimReport): void {
  const s = r.summary;
  const eff = r.effectivePrice;
  const selfPct = s.totalLoadKWh > 0 ? (s.selfConsumptionKWh / s.totalLoadKWh) * 100 : 0;
  const expert = state.expertMode;
  const hasWind = s.totalWindKWh > 0;
  const hasPV = s.totalPVKWh > 0;
  const totalGenLabel = (hasPV && hasWind) ? t("summary.total_generation") : hasWind ? t("summary.wind_yield") : t("summary.pv_yield");
  const totalGenKWh = s.totalPVKWh + s.totalWindKWh;
  const totalGenSub = (hasPV && hasWind)
    ? `PV: ${Math.round(s.totalPVKWh).toLocaleString("de-DE")} kWh · WKA: ${Math.round(s.totalWindKWh).toLocaleString("de-DE")} kWh`
    : t("summary.per_year");
  const cards: [string, string, string, string][] = [
    [totalGenLabel, `${Math.round(totalGenKWh).toLocaleString("de-DE")} kWh`, totalGenSub, t("tooltip.pv_yield_calc")],
    [t("summary.consumption"), `${Math.round(s.totalLoadKWh).toLocaleString("de-DE")} kWh`, t("summary.per_year"), t("tooltip.consumption_calc")],
    [t("summary.self_consumption"), `${Math.round(s.selfConsumptionKWh).toLocaleString("de-DE")} kWh`, `${selfPct.toFixed(0)}% ${t("summary.of_consumption")}`, t("tooltip.self_consumption")],
    [t("summary.grid_import"), `${Math.round(s.totalImportKWh).toLocaleString("de-DE")} kWh`, "", t("tooltip.grid_import_calc")],
    [t("summary.export"), `${Math.round(s.totalExportKWh).toLocaleString("de-DE")} kWh`, t("summary.to_grid"), t("tooltip.export_calc")],
    [t("summary.net_balance"), `${s.netSelectedEUR >= 0 ? "+" : ""}${fmtEUR(s.netSelectedEUR)}`, t("summary.export_import"), t("tooltip.net_balance")],
    [t("summary.eff_price"), `${eff.overallCt.toFixed(1)} ct/kWh`, t("summary.netto"), t("tooltip.eff_price")],
    [t("summary.amortisation"), r.amortisation.paybackYears === Infinity ? "—" : `${r.amortisation.paybackYears.toFixed(1)} J.`, t("summary.annual_savings") + fmtEUR(r.amortisation.annualBenefitEUR), t("tooltip.amortisation")],
  ];
  if (expert) {
    cards.push(
      [t("summary.export_revenue"), fmtEUR(s.exportRevenueEUR), state.exportScheme === "market" ? t("summary.direct_marketing") : t("summary.fixed_feed_in"), t("tooltip.export_revenue")],
      [t("summary.grid_cost"), fmtEUR(s.importCostEUR), importSchemeLabel(), t("tooltip.grid_cost")],
      [t("summary.market_premium"), `${s.marktPraemieCt.toFixed(2)} ct/kWh`, `EEG ${state.commissioningYear}`, t("tooltip.marktpraemie")],
      [t("summary.eeg_reference"), `${s.referenceValueCt.toFixed(2)} ct/kWh`, t("summary.eeg_value"), t("tooltip.eeg_reference")],
      [t("summary.eff_price_household"), `${eff.byConsumer.household.toFixed(1)} ct/kWh`, "", t("tooltip.eff_price_household")],
      [t("summary.eff_price_heatpump"), `${eff.byConsumer.heatpump.toFixed(1)} ct/kWh`, "", t("tooltip.eff_price_heatpump")],
      [t("summary.eff_price_ev"), `${eff.byConsumer.ev.toFixed(1)} ct/kWh`, "", t("tooltip.eff_price_ev")],
      [t("summary.investment"), fmtEUR(r.amortisation.totalInvestmentEUR), "", t("tooltip.investment")],
      [t("summary.lcoe"), `${r.cashflow.lcoeCtPerKWh.toFixed(1)} ct/kWh`, "", t("tooltip.lcoe")],
    );
  }
  summaryHost.innerHTML = "";
  for (const [k, v, sub, tip] of cards) {
    const card = document.createElement("div");
    card.className = "card";
    if (tip) card.dataset.tooltip = tip;
    card.innerHTML = `<div class="card-val">${v}</div><div class="card-key">${k}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}`;
    summaryHost.appendChild(card);
  }
}

function renderHourly(): void {
  if (!report) return;
  const data = report.daily[selectedMonth - 1];
  monthTitle.textContent = `${monthLabels()[selectedMonth - 1]} — ${t("hourly.title")}`;
  renderHourlyChart(hourlyHost, data, monthLabels()[selectedMonth - 1], state.capacityKWh);
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
  const gridLabel = cov.dynamic ? t("coverage.grid_price_dynamic") : t("coverage.grid_price_fixed");
  const gridSharePct = Math.max(0, 100 - cov.pvSharePct);
  return `
    <div class="heat-cov">
      <span class="cov-pv">${t("coverage.pv_battery")} <b>${cov.pvSharePct.toFixed(0)}%</b>
        (${kwh(cov.pvCoveredKWh)} kWh · 0 ct/kWh)</span>
      <span class="cov-grid">${t("coverage.grid")} <b>${gridSharePct.toFixed(0)}%</b>
        (${kwh(cov.gridKWh)} kWh · ${gridLabel} ${cov.gridPriceCt.toFixed(1)} ct/kWh)</span>
      <span class="cov-eff">${t("coverage.effective")} <b>${cov.effectiveCt.toFixed(1)} ct/kWh</b></span>
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
    <div class="heat-head" data-tooltip="${t("tooltip.heating_jaz")}">
      <span>${t("heating.heatpump")}: ${Math.round(h.heatpumpElectricKWh).toLocaleString("de-DE")} kWh Strom →
      ${Math.round(h.usefulHeatKWh).toLocaleString("de-DE")} kWh Wärme (JAZ ${h.jaz})</span>
    </div>${coverageLine(h.coverage, "Wärmepumpe")}`;
  const cards = rows
    .map(({ a, highlight }) => {
      const delta =
        a.mode === "heatpump" ? "" :
        `<div class="card-sub">${a.deltaVsHeatpumpEUR > 0 ? "+" : ""}${fmt(a.deltaVsHeatpumpEUR)} ${t("opportunity.vs_hp")}</div>`;
      const tip = a.mode === "heatpump" ? t("tooltip.heating_jaz") :
        a.mode === "oil" ? t("tooltip.heating_jaz") : t("tooltip.heating_jaz");
      return `
      <div class="card${highlight ? " card-hl" : ""}" data-tooltip="${tip}">
        <div class="card-val">${fmt(a.totalEUR)}<span class="card-unit">/Jahr</span></div>
        <div class="card-key">${a.label}</div>
        <div class="card-sub">${t("opportunity.energy")} ${fmt(a.energyCostEUR)}${a.gridFeeEUR ? ` · ${t("opportunity.grid")} ${fmt(a.gridFeeEUR)}` : ""}</div>
        <div class="card-sub">${t("opportunity.chimney")} ${fmt(a.chimneySweepEUR)}${a.otherNebenkostenEUR ? ` · ${t("opportunity.other_costs")} ${fmt(a.otherNebenkostenEUR)}` : ""}</div>
        ${delta}
      </div>`;
    })
    .join("");

  // Gas savings card
  const gs = r.gasSavings;
  let gasSavingsHtml = "";
  if (gs) {
    const gasSavedPct = gs.gasDirectKWh > 0
      ? ((gs.gasSavedKWh / gs.gasDirectKWh) * 100).toFixed(0)
      : "0";
    const kwh = (v: number) => Math.round(v).toLocaleString("de-DE");
    gasSavingsHtml = `
      <div class="gas-savings">
        <div class="heat-head">
          <span>${t("heating.gas_savings")}</span>
        </div>
        <div class="summary">
          <div class="card card-hl" data-tooltip="${t("heating.gas_source_mix")}">
            <div class="card-val">${gasSavedPct}%</div>
            <div class="card-key">${t("heating.gas_saved_pct")}</div>
            <div class="card-sub">${kwh(gs.gasSavedKWh)} kWh ${t("heating.gas_saved")} · ${kwh(gs.co2SavedKg)} kg CO₂</div>
          </div>
          <div class="card">
            <div class="card-val">${kwh(gs.gasDirectKWh)} kWh</div>
            <div class="card-key">${t("heating.gas_direct")}</div>
            <div class="card-sub">Wärme ${kwh(gs.usefulHeatKWh)} kWh ÷ ${(DEFAULT_GAS_BOILER_EFFICIENCY * 100).toFixed(0)}% η</div>
          </div>
          <div class="card">
            <div class="card-val">${kwh(gs.gasForElectricityKWh)} kWh</div>
            <div class="card-key">${t("heating.gas_for_elec")}</div>
            <div class="card-sub">Strom ${kwh(gs.heatpumpElectricKWh)} kWh ÷ ${(DEFAULT_GAS_POWERPLANT_EFFICIENCY * 100).toFixed(0)}% η</div>
          </div>
        </div>
      </div>`;
  }

  heatingBody.innerHTML = head + `<div class="summary">${cards}</div>` + gasSavingsHtml + opportunityNote(r, "heating");
}

function renderGridMix(r: SimReport): void {
  const gm = r.gridMix;
  gridMixTitle.textContent = t("gridmix.title");
  gridMixHint.textContent = t("gridmix.hint");

  const fmtPct = (v: number) => (v * 100).toFixed(1) + "%";
  const hpGas = gm.heatpump.gas;
  const overallGas = gm.overall.gas;
  const noPvGas = gm.withoutPv.gas;

  let html = "";

  // HP pie chart
  if (r.inputs.consumers.heatpump.enabled) {
    html += `<div class="pie-chart-card">
      <div class="pie-chart-card-title">${t("gridmix.heatpump")}</div>
      <div class="pie-chart-card-hint">${t("gridmix.heatpump_hint")}</div>
      <div class="pie-chart-card-body"></div>
      <div class="pie-chart-card-footer" data-tooltip="Gas → ${CO2_EMISSION_FACTORS.gas * 1000} g CO₂/kWh Strom · Erdgas-Heizkessel → ${CO2_GAS_DIRECT * 1000} g CO₂/kWh Wärme">${t("gridmix.gas_share")}: <strong>${fmtPct(hpGas)}</strong></div>
    </div>`;
  }

  // Overall pie chart
  html += `<div class="pie-chart-card">
    <div class="pie-chart-card-title">${t("gridmix.overall")}</div>
    <div class="pie-chart-card-hint">${t("gridmix.overall_hint")}</div>
    <div class="pie-chart-card-body"></div>
    <div class="pie-chart-card-footer" data-tooltip="Gas → ${CO2_EMISSION_FACTORS.gas * 1000} g CO₂/kWh Strom">${t("gridmix.gas_share")}: <strong>${fmtPct(overallGas)}</strong></div>
  </div>`;

  // Without PV pie chart
  html += `<div class="pie-chart-card">
    <div class="pie-chart-card-title">${t("gridmix.without_pv")}</div>
    <div class="pie-chart-card-hint">${t("gridmix.without_pv_hint")}</div>
    <div class="pie-chart-card-body"></div>
    <div class="pie-chart-card-footer" data-tooltip="Gas → ${CO2_EMISSION_FACTORS.gas * 1000} g CO₂/kWh Strom">${t("gridmix.gas_share")}: <strong>${fmtPct(noPvGas)}</strong></div>
  </div>`;

  gridMixBody.innerHTML = html;

  // Render pie charts into their containers
  const bodies = gridMixBody.querySelectorAll(".pie-chart-card-body");
  let idx = 0;
  if (r.inputs.consumers.heatpump.enabled) {
    renderPieChart(bodies[idx] as HTMLElement, gm.heatpump);
    idx++;
  }
  renderPieChart(bodies[idx] as HTMLElement, gm.overall);
  idx++;
  renderPieChart(bodies[idx] as HTMLElement, gm.withoutPv);
}

function renderCo2(r: SimReport): void {
  const c = r.co2Analysis;
  co2Title.textContent = t("co2.title");
  co2Hint.textContent = t("co2.hint");

  // Main progression: each step adds one technology layer
  const mainSteps = [c.baseline, c.plusPv, c.plusEv, c.plusEvPv, c.plusEvWp];
  // Alternatives: no-PV variants that show electrification without own generation
  const altSteps = [c.wpDieselGrid, c.evWpNoPv];
  const scenarios = [...mainSteps, ...altSteps];
  const maxCo2 = Math.max(...scenarios.map((s) => s.co2Kg), 1);

  const fmt = (v: number) => v.toLocaleString("de-DE");
  const fmtT = (v: number) => (v / 1000).toFixed(1);
  const fmtEur = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

  // CO2 per kWh factors for tooltips
  const factorRows = Object.entries(CO2_EMISSION_FACTORS)
    .filter(([, v]) => v > 0)
    .map(([src, factor]) => `${src}: ${(factor * 1000).toFixed(0)} g CO₂/kWh`)
    .join(" · ");

  let html = `<div class="co2-steps">`;

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const pct = (s.co2Kg / maxCo2) * 100;
    const isBest = s.co2Kg === Math.min(...scenarios.map((x) => x.co2Kg));
    const isFirst = i === 0;
    const isMain = i < mainSteps.length;
    const isAlt = !isMain;

    // Incremental delta vs. previous step in the main progression
    let deltaLabel = "";
    if (!isFirst && isMain) {
      const prev = mainSteps[i - 1];
      if (prev) {
        const deltaCo2 = prev.co2Kg - s.co2Kg;
        if (deltaCo2 > 0) {
          deltaLabel = ` ▸ −${fmt(deltaCo2)} kg`;
        }
      }
    }

    // Separator before alternative scenarios
    if (isAlt && i === mainSteps.length) {
      html += `<div class="co2-step-separator"><span>${t("co2.alternatives_label") || "Ohne PV (Alternativen):"}</span></div>`;
    }

    const stepNum = isMain && !isFirst ? `<span class="co2-step-num">${i}</span>` : "";
    const hlClass = isBest ? " co2-step-hl" : "";
    const altClass = isAlt ? " co2-step-alt" : "";

    html += `
      <div class="co2-step${hlClass}${altClass}">
        <div class="co2-step-header">
          <div class="co2-step-label">${stepNum}${s.label}</div>
          <div class="co2-step-total">
            ${fmtT(s.co2Kg)} t <span class="co2-sub">(${fmt(s.co2Kg)} kg)</span>
          </div>
        </div>
        <div class="co2-bar-wrap">
          <div class="co2-bar" style="width:${pct}%"></div>
        </div>
        <div class="co2-breakdown">
          <span class="co2-tag co2-tag-heat" data-tooltip="${CO2_GAS_DIRECT * 1000} g CO₂/kWh (Erdgas-Heizkessel)">${t("co2.heating")}: ${fmt(s.heatingCo2Kg)} kg</span>
          <span class="co2-tag co2-tag-elec" data-tooltip="${factorRows}">${t("co2.electricity")}: ${fmt(s.electricityCo2Kg)} kg</span>
          <span class="co2-tag co2-tag-car" data-tooltip="${CO2_DIESEL * 1000} g CO₂/kWh Diesel">${t("co2.car")}: ${fmt(s.carCo2Kg)} kg</span>
        </div>
        ${!isFirst ? `
        <div class="co2-saved">
          <span class="co2-saved-item co2-saved-co2">−${fmt(s.co2SavedKg)} kg CO₂${deltaLabel}</span>
          <span class="co2-saved-item co2-saved-gas">${s.gasSavedKWh > 0 ? "−" + fmt(s.gasSavedKWh) + " kWh Gas" : ""}</span>
          <span class="co2-saved-item co2-saved-eur">${s.savedEUR > 0 ? "−" + fmtEur(s.savedEUR) : ""}</span>
        </div>` : ""}
      </div>`;
  }
  html += `</div>`;

  co2Body.innerHTML = html;
}

/** Footer line that ties the annual saving to the PV payback horizon. */
function opportunityNote(r: SimReport, kind: "heating" | "car"): string {
  const inv = r.opportunityInvestment;
  const saving = kind === "heating" ? inv.heatingSavingEUR : inv.carSavingEUR;
  const financeable = kind === "heating" ? inv.financeableHeatpumpEUR : inv.financeableEvEUR;
  const label = kind === "heating" ? "Gas" : "Diesel";
  if (financeable == null) return "";
  const fmt = (v: number) => v.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const tip = t("opportunity.financeable_hint");
  return `<div class="heat-foot" data-tooltip="${tip}">${t("opportunity.savings")} ${label}: ${fmt(saving)}${t("opportunity.per_year_finance")} (${inv.pvPaybackYears.toFixed(1)} ${t("opportunity.years_pv")} ${fmt(financeable)})</div>`;
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
      <span>${t("car.comparison")} ${fmtKm(c.annualKm)} ${t("car.per_year")}</span>
    </div>${coverageLine(c.coverage, "E-Auto")}`;
  const cards = rows
    .map(({ a, highlight }) => {
      const delta =
        a.mode === "ev" ? "" :
        `<div class="card-sub">${a.deltaVsEvEUR > 0 ? "+" : ""}${fmt(a.deltaVsEvEUR)} ${t("opportunity.vs_ev")}</div>`;
      const tip = a.mode === "ev" ? t("tooltip.car_ev_price") : t("tooltip.car_diesel_saving");
      return `
      <div class="card${highlight ? " card-hl" : ""}" data-tooltip="${tip}">
        <div class="card-val">${fmt(a.totalEUR)}<span class="card-unit">/Jahr</span></div>
        <div class="card-key">${a.label}</div>
        <div class="card-sub">${t("opportunity.energy")} ${fmt(a.energyCostEUR)}${a.mode === "ev" ? ` · ${Math.round(a.primaryEnergy)} kWh` : ` · ${Math.round(a.primaryEnergy)} L`}</div>
        <div class="card-sub">${t("opportunity.maintenance")} ${fmt(a.maintenanceEUR)} · ${t("opportunity.tax")} ${fmt(a.vehicleTaxEUR)} · ${t("opportunity.other_costs")} ${fmt(a.otherNebenkostenEUR)}</div>
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
    <div class="heat-head" data-tooltip="${t("tooltip.bwwp_midday")}">
      <span>${t("bwwp.electricity")} ${kwh(cov.consumptionKWh)} ${t("bwwp.pv_block")}</span>
    </div>${coverageLine(covInfo, "Brauchwasser-Wärmepumpe")}`;
  const card = `
    <div class="card card-hl" data-tooltip="${t("tooltip.dhw_hp")}">
      <div class="card-val">${cov.pvSharePct.toFixed(0)}%<span class="card-unit"> PV</span></div>
      <div class="card-key">Brauchwasser-Wärmepumpe</div>
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
  renderGridMix(report);
  renderCo2(report);
  renderOpportunityCar(report);
  renderBwwp(report);
  renderTariffCombinations(report);
}

function renderTariffCombinations(r: SimReport): void {
  combosHost.style.display = "";
  const years = r.tariffCombinations.years.join(", ");
  combosBody.innerHTML =
    `<div class="hint">${t("tariff.hint").replace(/\.$/, "")} ${years} ` +
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

// ---------- Localize static HTML text ----------------------------------------
function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setAttr(id: string, attr: string, val: string): void {
  const el = document.getElementById(id);
  if (el) el.setAttribute(attr, val);
}

function relocalize(): void {
  document.documentElement.lang = getLocale();
  document.title = t("ui.title");
  setText("toggle-sidebar", t("ui.sidebar_toggle"));
  setAttr("toggle-sidebar", "title", t("ui.sidebar_toggle_title"));
  const h1 = document.querySelector(".topbar h1");
  if (h1) h1.textContent = t("ui.title");
  const subtitle = document.querySelector(".topbar p");
  if (subtitle) subtitle.textContent = t("ui.subtitle");
  setText("download-xlsx", t("ui.excel_button"));
  setAttr("download-xlsx", "title", t("ui.excel_button_title"));
  const panelH2s = document.querySelectorAll(".panel h2");
  if (panelH2s[0]) panelH2s[0].textContent = t("chart.monthly.title");
  if (panelH2s[1]) panelH2s[1].textContent = t("hourly.title");
  if (panelH2s[2]) panelH2s[2].textContent = t("scenario.title");
  if (panelH2s[3]) panelH2s[3].textContent = t("tariff.title");
  const panelHints = document.querySelectorAll(".panel .hint");
  if (panelHints[0]) panelHints[0].textContent = t("chart.monthly.hint");
  if (panelHints[2]) panelHints[2].textContent = t("scenario.hint");
  if (panelHints[3]) panelHints[3].textContent = t("tariff.hint");
  const heatingH2 = document.querySelector("#heating h2");
  if (heatingH2) heatingH2.textContent = t("heating.title");
  const heatingHint = document.querySelector("#heating .hint");
  if (heatingHint) heatingHint.textContent = t("heating.hint");
  const bwwpH2 = document.querySelector("#bwwp h2");
  if (bwwpH2) bwwpH2.textContent = t("bwwp.title");
  const bwwpHint = document.querySelector("#bwwp .hint");
  if (bwwpHint) bwwpHint.textContent = t("bwwp.hint");
  const carH2 = document.querySelector("#car h2");
  if (carH2) carH2.textContent = t("car.title");
  const carHint = document.querySelector("#car .hint");
  if (carHint) carHint.textContent = t("car.hint");
}
relocalize();

// ---------- Language toggle ---------------------------------------------------
const langDe = document.getElementById("lang-de") as HTMLButtonElement | null;
const langEn = document.getElementById("lang-en") as HTMLButtonElement | null;

function updateLangButtons(): void {
  const locale = getLocale();
  if (langDe) {
    langDe.classList.toggle("active", locale === "de");
    langDe.setAttribute("aria-pressed", String(locale === "de"));
  }
  if (langEn) {
    langEn.classList.toggle("active", locale === "en");
    langEn.setAttribute("aria-pressed", String(locale === "en"));
  }
}
updateLangButtons();

function switchLocale(locale: "de" | "en"): void {
  if (getLocale() === locale) return;
  setLocale(locale);
  updateLangButtons();
  relocalize();
  buildControls(controlsHost, state, onChange);
  recompute();
}

if (langDe) langDe.addEventListener("click", () => switchLocale("de"));
if (langEn) langEn.addEventListener("click", () => switchLocale("en"));

// Excel export: generate a fully-formula workbook from the current report and
// download it client-side (no server round-trip).
const downloadBtn = document.getElementById("download-xlsx") as HTMLButtonElement | null;
if (downloadBtn) {
  downloadBtn.addEventListener("click", async () => {
    if (!report) return;
    const prev = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = t("ui.excel_loading");
    try {
      const { downloadWorkbook } = await import("./export/workbook");
      await downloadWorkbook(report);
    } catch (err) {
      console.error(t("ui.excel_error"), err);
      alert(t("ui.excel_error"));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = prev;
    }
  });
}
