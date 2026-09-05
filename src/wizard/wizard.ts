// Interactive wizard UI. Builds the scenario controls from the shared store,
// recomputes the simulation client-side (no API calls) and keeps the URL in
// sync so configurations are shareable and compatible with index.html.

import { t, monthAbbrevs, fmtEUR as i18nFmtEUR } from "../i18n";
import { Store } from "../store";
import {
  Scenario,
  runScenario,
  scenarioToQuery,
  pvLabel,
  pvPreset,
  spec,
  computeMetrics,
} from "../scenario";
import { SimReport } from "../calc/report";
import {
  renderMonthlyChart,
  renderHourlyChart,
  renderScenarioChart,
} from "../ui/charts";

export interface WizardOptions {
  store: Store<Scenario>;
  sidebar: HTMLElement;
  summary: HTMLElement;
  monthly: HTMLElement;
  hourPanel: HTMLElement;
  hourTitle: HTMLElement;
  hourly: HTMLElement;
  scenarioEl: HTMLElement;
}

function monthLabels(): string[] { return monthAbbrevs(); }
const STANDARD_KWH = (n: number) => 1500 + (n - 1) * 1000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") e.className = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

const fmtEUR = i18nFmtEUR;

export function initWizard(opts: WizardOptions): void {
  const { store } = opts;
  let selectedMonth = 6;
  let rafPending = false;

  // ---- build controls -------------------------------------------------------
  const personsWrap = el("div", { class: "persons" });
  for (let n = 1; n <= 6; n++) {
    const b = el("button", { class: "seg-btn", "data-n": String(n) }, [String(n)]);
    b.addEventListener("click", () => {
      store.setState({ consumptionKWh: STANDARD_KWH(n) });
    });
    personsWrap.append(b);
  }

  const hk = el("input", { type: "range", id: "hk", min: "500", max: "9000", step: "100" }) as HTMLInputElement;
  hk.addEventListener("input", () => store.setState({ consumptionKWh: Number(hk.value) }));
  const hkVal = el("span", { class: "val" }, ["2500"]);

  const ict = el("input", { type: "range", id: "ict", min: "1", max: "50", step: "0.1" }) as HTMLInputElement;
  ict.addEventListener("input", () => store.setState({ priceCt: Number(ict.value) }));
  const ictVal = el("span", { class: "val" }, ["30"]);

  const loc = el("select", { id: "loc" }) as HTMLSelectElement;
  for (const c of ["boizenburg", "hamburg", "berlin", "koeln", "muenchen"]) {
    loc.append(el("option", { value: c }, [c[0].toUpperCase() + c.slice(1)]));
  }
  loc.addEventListener("change", () => store.setState({ location: loc.value }));

  const mkToggle = (id: string, label: string, sub: string, key: keyof Scenario) => {
    const input = el("input", { type: "checkbox", id }) as HTMLInputElement;
    input.addEventListener("change", () => store.setState({ [key]: input.checked } as Partial<Scenario>));
    const wrap = el("div", { class: "toggle-row" }, [
      el("div", {}, [el("div", { class: "lbl" }, [label]), el("div", { class: "sub" }, [sub])]),
      el("label", { class: "switch" }, [input, el("span", { class: "track" }), el("span", { class: "knob" })]),
    ]);
    return { input, wrap };
  };
  const wpToggle = mkToggle("wp", t("wizard.heatpump_label"), t("wizard.heatpump_sub"), "heatpump");
  const evToggle = mkToggle("ev", t("wizard.ev_label"), t("wizard.ev_sub"), "ev");
  const bwToggle = mkToggle("bw", t("wizard.bwwp_label"), t("wizard.bwwp_sub"), "bwwp");

  const pvSeg = el("div", { class: "seg", id: "pv-seg" });
  const pvButtons: Record<string, HTMLButtonElement> = {};
  for (const [val, label, sub] of [
    ["none", t("wizard.pv_none"), t("wizard.pv_none_sub")],
    ["balcony", t("wizard.pv_balkon"), t("wizard.pv_balkon_sub")],
    ["10", t("wizard.pv_10kw"), t("wizard.pv_10kw_sub")],
    ["20", t("wizard.pv_20kw"), t("wizard.pv_20kw_sub")],
  ] as [Scenario["pv"], string, string][]) {
    const b = el("button", { class: "seg-btn", "data-pv": val }, [el("span", { class: "t" }, [label]), el("span", { class: "s" }, [sub])]) as HTMLButtonElement;
    b.addEventListener("click", () => {
      const p = pvPreset(val);
      store.setState({
        pv: val,
        peakKWp: p.kwp,
        orientation: p.orientation,
        battery: "off",
        capacityKWh: 0,
        maxPowerKW: 0,
        investmentEUR: p.investmentEUR,
      });
    });
    pvSeg.append(b);
    pvButtons[val] = b;
  }

  const batSeg = el("div", { class: "seg", id: "bat-seg" });
  const batButtons: Record<string, HTMLButtonElement> = {};
  for (const [val, label, sub] of [
    ["off", t("wizard.battery_none"), t("wizard.battery_none_sub")],
    ["on", t("wizard.battery_with"), t("wizard.battery_with_sub")],
  ] as [Scenario["battery"], string, string][]) {
    const b = el("button", { class: "seg-btn", "data-bat": val }, [el("span", { class: "t" }, [label]), el("span", { class: "s" }, [sub])]) as HTMLButtonElement;
    b.addEventListener("click", () => {
      const cur = store.getState();
      if (val === "on") {
        const cap = cur.capacityKWh > 0 ? cur.capacityKWh : cur.peakKWp >= 19 ? 15 : cur.peakKWp >= 9 ? 10 : 2;
        const pwr = cur.maxPowerKW > 0 ? cur.maxPowerKW : cur.peakKWp >= 19 ? 8 : cur.peakKWp >= 9 ? 5 : 1;
        const addon = cur.peakKWp >= 19 ? 12000 : cur.peakKWp >= 9 ? 3000 : 1500;
        store.setState({
          battery: "on",
          capacityKWh: cap,
          maxPowerKW: pwr,
          investmentEUR: cur.investmentEUR + (cur.capacityKWh > 0 ? 0 : addon),
        });
      } else {
        const addon = cur.peakKWp >= 19 ? 12000 : cur.peakKWp >= 9 ? 3000 : 1500;
        store.setState({
          battery: "off",
          capacityKWh: 0,
          maxPowerKW: 0,
          investmentEUR: Math.max(0, cur.investmentEUR - (cur.capacityKWh > 0 ? addon : 0)),
        });
      }
    });
    batSeg.append(b);
    batButtons[val] = b;
  }

  const reco = el("div", { class: "reco", id: "pv-reco" });

  // assemble sidebar
  opts.sidebar.append(
    step(1, t("wizard.step_household"), t("wizard.step_household_desc"), [
      field(t("wizard.step_persons"), personsWrap),
      sliderField(t("wizard.step_consumption"), hk, hkVal, "kWh"),
      sliderField(t("wizard.step_price"), ict, ictVal, "ct/kWh"),
      field(t("wizard.step_location"), loc),
    ]),
    step(2, t("wizard.step_consumers"), t("wizard.step_consumers_desc"), [wpToggle.wrap, evToggle.wrap, bwToggle.wrap]),
    step(3, t("wizard.step_pv"), t("wizard.step_pv_desc"), [pvSeg, reco]),
    step(4, t("wizard.step_battery"), t("wizard.step_battery_desc"), [batSeg]),
  );

  function step(num: number, title: string, desc: string, rows: HTMLElement[]): HTMLElement {
    return el("div", { class: "step" }, [
      el("h3", {}, [el("span", { class: "step-num" }, [String(num)]), title]),
      el("div", { class: "desc" }, [desc]),
      ...rows,
    ]);
  }
  function field(label: string, control: HTMLElement): HTMLElement {
    return el("div", { class: "control" }, [el("label", {}, [label]), control]);
  }
  function sliderField(labelText: string, input: HTMLElement, valSpan: HTMLElement, unit: string): HTMLElement {
    return el("div", { class: "control" }, [
      el("label", {}, [`${labelText} `, valSpan, ` ${unit}`]),
      input,
    ]);
  }

  // ---- sync + recompute -----------------------------------------------------
  function syncControls(s: Scenario): void {
    personsWrap.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
      const n = Number(b.dataset.n);
      const expected = STANDARD_KWH(n);
      b.classList.toggle("active", s.consumptionKWh === expected && n === personsFor(s.consumptionKWh));
    });
    hk.value = String(s.consumptionKWh);
    ict.value = String(s.priceCt);
    hkVal.textContent = String(s.consumptionKWh);
    ictVal.textContent = String(s.priceCt);
    loc.value = s.location;
    wpToggle.input.checked = s.heatpump;
    evToggle.input.checked = s.ev;
    bwToggle.input.checked = s.bwwp;
    for (const v of Object.keys(pvButtons)) {
      const preset = pvPreset(v as Scenario["pv"]);
      pvButtons[v].classList.toggle("active", v === s.pv && Math.abs(s.peakKWp - preset.kwp) < 0.01);
    }
    for (const v of Object.keys(batButtons)) batButtons[v].classList.toggle("active", v === s.battery);
    reco.textContent =
      s.pv === "none"
        ? t("wizard.rec_baseline")
        : `${pvLabel(s)} — ${s.battery === "on" ? t("wizard.rec_with") : t("wizard.rec_without")} ${t("wizard.rec_battery")}`;
  }

  function personsFor(kwh: number): number {
    for (let n = 1; n <= 6; n++) if (STANDARD_KWH(n) === kwh) return n;
    return 0;
  }

  function renderSummary(s: Scenario): void {
    const m = computeMetrics(s);
    const cards: [string, string, string][] = [
      [t("wizard.sum_pv_yield"), `${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh`, t("wizard.sum_per_year")],
      [t("wizard.sum_self_use"), `${Math.round(m.selfKWh).toLocaleString("de-DE")} kWh`, `${m.selfPct.toFixed(0)} % ${t("wizard.sum_self_pv")}`],
      [t("wizard.sum_grid_import"), `${Math.round(m.importKWh).toLocaleString("de-DE")} kWh`, t("wizard.sum_per_year")],
      [t("wizard.sum_netto"), `${m.netEUR >= 0 ? "+" : ""}${fmtEUR(m.netEUR)}`, t("wizard.sum_per_year")],
      [t("wizard.sum_savings"), m.savingsEUR > 0 ? fmtEUR(m.savingsEUR) : "—", t("wizard.sum_per_year")],
      [t("wizard.sum_amortisation"), m.investmentEUR > 0 && Number.isFinite(m.amortYears) ? `${m.amortYears.toFixed(1)} J.` : "—", `Inv. ${fmtEUR(m.investmentEUR)}`],
      [t("wizard.sum_eff_price"), `${m.effCt.toFixed(1)} ct`, t("wizard.sum_weighted")],
    ];
    opts.summary.innerHTML = "";
    for (const [k, v, sub] of cards) {
      opts.summary.append(
        el("div", { class: "card" }, [
          el("div", { class: `card-val ${m.netEUR >= 0 ? "pos" : "neg"}` }, [v]),
          el("div", { class: "card-key" }, [k]),
          el("div", { class: "card-sub" }, [sub]),
        ]),
      );
    }
  }

  function renderHourly(): void {
    const s = store.getState();
    if (s.pv === "none") {
      opts.hourPanel.style.display = "none";
      return;
    }
    opts.hourPanel.style.display = "block";
    const rep = runSimulationCache();
    const data = rep.daily[selectedMonth - 1];
    opts.hourTitle.textContent = `${t("wizard.hourly_detail")} ${monthLabels()[selectedMonth - 1]}`;
    const socMax = spec(s).capacityKWh;
    renderHourlyChart(opts.hourly, data, monthLabels()[selectedMonth - 1], socMax);
  }

  let cachedReport: ReturnType<typeof runScenario> | null = null;
  function runSimulationCache() {
    if (!cachedReport) cachedReport = runScenario(store.getState());
    return cachedReport;
  }

  function recompute(): void {
    const s = store.getState();
    cachedReport = null;
    const rep = runScenario(s);
    renderSummary(s);
    renderMonthlyChart(opts.monthly, rep.monthly, selectedMonth, (m) => {
      selectedMonth = m;
      renderHourly();
    });
    renderHourly();
    renderScenarioChart(opts.scenarioEl, rep.scenario);
    renderOpportunity(rep);
    const url = `${location.pathname}?${scenarioToQuery(s).toString()}`;
    history.replaceState(null, "", url);
  }

  function renderOpportunity(r: SimReport): void {
    const host = document.getElementById("opportunity") as HTMLElement | null;
    const body = document.getElementById("opportunity-body") as HTMLElement | null;
    if (!host || !body) return;
    const oc = r.opportunityCosts;
    host.style.display = oc.heating.heatpumpElectricKWh > 0 || oc.car.annualKm > 0 ? "" : "none";

    const fmt = (v: number) => `${Math.round(v).toLocaleString("de-DE")} €`;
    let html = "";

    if (oc.heating.heatpumpElectricKWh > 0) {
      const h = oc.heating;
      const rows = [
        { a: h.heatpump, hl: true, d: "" },
        { a: h.oil, hl: false, d: `${h.oil.deltaVsHeatpumpEUR > 0 ? "+" : ""}${fmt(h.oil.deltaVsHeatpumpEUR)} ${t("opportunity.vs_hp")}` },
        { a: h.gas, hl: false, d: `${h.gas.deltaVsHeatpumpEUR > 0 ? "+" : ""}${fmt(h.gas.deltaVsHeatpumpEUR)} ${t("opportunity.vs_hp")}` },
      ];
      html += `<div class="heat-head">${t("heating.heatpump")}: ${Math.round(h.heatpumpElectricKWh).toLocaleString("de-DE")} kWh → ${Math.round(h.usefulHeatKWh).toLocaleString("de-DE")} kWh Wärme (JAZ ${h.jaz})</div>`;
      html += `<div class="summary">` + rows.map(({ a, hl, d }) => `
        <div class="card${hl ? " card-hl" : ""}">
          <div class="card-val">${fmt(a.totalEUR)}<span class="card-unit">/J.</span></div>
          <div class="card-key">${a.label}</div>
          <div class="card-sub">${t("opportunity.energy")} ${fmt(a.energyCostEUR)}${a.gridFeeEUR ? ` · ${t("opportunity.grid")} ${fmt(a.gridFeeEUR)}` : ""}</div>
          <div class="card-sub">${t("opportunity.chimney")} ${fmt(a.chimneySweepEUR)}${a.otherNebenkostenEUR ? ` · ${t("opportunity.other_costs")} ${fmt(a.otherNebenkostenEUR)}` : ""}</div>
          ${d ? `<div class="card-sub">${d}</div>` : ""}
        </div>`).join("") + `</div>`;
      html += opportunityNote(r, "heating");
    }

    if (oc.car.annualKm > 0) {
      const c = oc.car;
      const rows = [
        { a: c.ev, hl: true, d: "" },
        { a: c.diesel, hl: false, d: `${c.diesel.deltaVsEvEUR > 0 ? "+" : ""}${fmt(c.diesel.deltaVsEvEUR)} ${t("opportunity.vs_ev")}` },
      ];
      html += `<div class="heat-head">${t("car.comparison")} ${Math.round(c.annualKm).toLocaleString("de-DE")} km/${t("car.per_year")}</div>`;
      html += `<div class="summary">` + rows.map(({ a, hl, d }) => `
        <div class="card${hl ? " card-hl" : ""}">
          <div class="card-val">${fmt(a.totalEUR)}<span class="card-unit">/J.</span></div>
          <div class="card-key">${a.label}</div>
          <div class="card-sub">${t("opportunity.energy")} ${fmt(a.energyCostEUR)}${a.mode === "ev" ? ` · ${Math.round(a.primaryEnergy)} kWh` : ` · ${Math.round(a.primaryEnergy)} L`}</div>
          <div class="card-sub">${t("opportunity.maintenance")} ${fmt(a.maintenanceEUR)} · ${t("opportunity.tax")} ${fmt(a.vehicleTaxEUR)}</div>
          ${d ? `<div class="card-sub">${d}</div>` : ""}
        </div>`).join("") + `</div>`;
      html += opportunityNote(r, "car");
    }

    body.innerHTML = html;
  }

  /** Footer line tying the annual saving to the PV payback horizon. */
  function opportunityNote(r: SimReport, kind: "heating" | "car"): string {
    const inv = r.opportunityInvestment;
    const saving = kind === "heating" ? inv.heatingSavingEUR : inv.carSavingEUR;
    const financeable = kind === "heating" ? inv.financeableHeatpumpEUR : inv.financeableEvEUR;
    const label = kind === "heating" ? "Gas" : "Diesel";
    if (financeable == null) return "";
    return `<div class="heat-foot">${t("opportunity.savings")} ${label}: ${fmtEUR(saving)}${t("opportunity.per_year_finance")} ${inv.pvPaybackYears.toFixed(1)} ${t("opportunity.years_pv")} ${fmtEUR(financeable)}</div>`;
  }

  function scheduleRecompute(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      recompute();
    });
  }

  // ---- highlight controls that just changed -------------------------------
  const FIELD_ELS: Record<string, HTMLElement[]> = {
    consumptionKWh: [hk],
    priceCt: [ict],
    location: [loc],
    pv: [pvSeg],
    battery: [batSeg],
    heatpump: [wpToggle.wrap],
    heatpumpKWh: [wpToggle.wrap],
    ev: [evToggle.wrap],
    evKWh: [evToggle.wrap],
    bwwp: [bwToggle.wrap],
  };
  const TRACKED: (keyof Scenario)[] = [
    "consumptionKWh",
    "priceCt",
    "location",
    "pv",
    "battery",
    "heatpump",
    "heatpumpKWh",
    "ev",
    "evKWh",
    "bwwp",
  ];
  function flashEl(e: HTMLElement): void {
    e.classList.remove("flash");
    void e.offsetWidth; // restart the animation if it is already running
    e.classList.add("flash");
  }
  function flashChanges(prev: Scenario, next: Scenario): void {
    for (const k of TRACKED) {
      if (prev[k] !== next[k]) (FIELD_ELS[k] ?? []).forEach(flashEl);
    }
  }

  let prevScenario: Scenario = store.getState();

  store.subscribe((s) => {
    flashChanges(prevScenario, s);
    prevScenario = s;
    syncControls(s);
    scheduleRecompute();
  });

  syncControls(prevScenario);
  recompute();
}
