// Interactive wizard UI. Builds the scenario controls from the shared store,
// recomputes the simulation client-side (no API calls) and keeps the URL in
// sync so configurations are shareable and compatible with index.html.

import { Store } from "../store";
import {
  Scenario,
  runScenario,
  scenarioToQuery,
  pvLabel,
  computeMetrics,
} from "../scenario";
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

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
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

function fmtEUR(v: number): string {
  return `${Math.round(v).toLocaleString("de-DE")} €`;
}

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

  const ict = el("input", { type: "range", id: "ict", min: "15", max: "50", step: "0.5" }) as HTMLInputElement;
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
  const wpToggle = mkToggle("wp", "Wärmepumpe", "~5.000 kWh/Jahr", "heatpump");
  const evToggle = mkToggle("ev", "E-Auto", "~2.000 kWh/Jahr (80% PV)", "ev");
  const bwToggle = mkToggle("bw", "Brauchwasser-WP", "~400 kWh/Jahr", "bwwp");

  const pvSeg = el("div", { class: "seg", id: "pv-seg" });
  const pvButtons: Record<string, HTMLButtonElement> = {};
  for (const [val, t, s] of [
    ["none", "Kein PV", "Basis"],
    ["balcony", "Balkonkraftwerk", "800 Wp · Süd"],
    ["10", "10 kWp", "Süd · 35°"],
    ["20", "20 kWp", "Ost/West · 35°"],
  ] as [Scenario["pv"], string, string][]) {
    const b = el("button", { class: "seg-btn", "data-pv": val }, [el("span", { class: "t" }, [t]), el("span", { class: "s" }, [s])]) as HTMLButtonElement;
    b.addEventListener("click", () => store.setState({ pv: val }));
    pvSeg.append(b);
    pvButtons[val] = b;
  }

  const batSeg = el("div", { class: "seg", id: "bat-seg" });
  const batButtons: Record<string, HTMLButtonElement> = {};
  for (const [val, t, s] of [
    ["off", "Ohne Speicher", "einfach"],
    ["on", "Mit Speicher", "mehr Eigenverbrauch"],
  ] as [Scenario["battery"], string, string][]) {
    const b = el("button", { class: "seg-btn", "data-bat": val }, [el("span", { class: "t" }, [t]), el("span", { class: "s" }, [s])]) as HTMLButtonElement;
    b.addEventListener("click", () => store.setState({ battery: val }));
    batSeg.append(b);
    batButtons[val] = b;
  }

  const reco = el("div", { class: "reco", id: "pv-reco" });

  // assemble sidebar
  opts.sidebar.append(
    step(1, "Haushalt & Strompreis", "Personenanzahl setzt das Standard-Lastprofil (1 → 1.500 … 2 → 2.500 kWh).", [
      field("Personen im Haushalt", personsWrap),
      sliderField("Jahresverbrauch Haushalt", hk, hkVal, "kWh"),
      sliderField("Strompreis", ict, ictVal, "ct/kWh"),
      field("Ort", loc),
    ]),
    step(2, "Weitere Verbraucher", "Optional — erhöht den Eigenverbrauch.", [wpToggle.wrap, evToggle.wrap, bwToggle.wrap]),
    step(3, "PV-Anlage wählen", "Vom Balkonkraftwerk bis Volldach.", [pvSeg, reco]),
    step(4, "Speicher", "Hebt den Eigenverbrauch.", [batSeg]),
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
    for (const v of Object.keys(pvButtons)) pvButtons[v].classList.toggle("active", v === s.pv);
    for (const v of Object.keys(batButtons)) batButtons[v].classList.toggle("active", v === s.battery);
    reco.textContent =
      s.pv === "none"
        ? "Ausgangspunkt: deine reinen Bezugskosten."
        : `${pvLabel(s)} — ${s.battery === "on" ? "mit" : "ohne"} Speicher.`;
  }

  function personsFor(kwh: number): number {
    for (let n = 1; n <= 6; n++) if (STANDARD_KWH(n) === kwh) return n;
    return 0;
  }

  function renderSummary(s: Scenario): void {
    const rep = runScenario(s);
    const m = computeMetrics(s);
    const cards: [string, string, string][] = [
      ["PV-Ertrag", `${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
      ["Eigenverbrauch", `${Math.round(m.selfKWh).toLocaleString("de-DE")} kWh`, `${m.selfPct.toFixed(0)} % des PV`],
      ["Netz-Import", `${Math.round(m.importKWh).toLocaleString("de-DE")} kWh`, "pro Jahr"],
      ["Netto (Export−Import)", `${m.netEUR >= 0 ? "+" : ""}${fmtEUR(m.netEUR)}`, "pro Jahr"],
      ["Ersparnis ggü. Basis", m.savingsEUR > 0 ? fmtEUR(m.savingsEUR) : "—", "pro Jahr"],
      ["Amortisation", m.investmentEUR > 0 && Number.isFinite(m.amortYears) ? `${m.amortYears.toFixed(1)} J.` : "—", `Inv. ${fmtEUR(m.investmentEUR)}`],
      ["Eff. Strompreis", `${m.effCt.toFixed(1)} ct`, "gewichteter Ø"],
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
    opts.hourTitle.textContent = `Stundendetail — ${MONTH_LABELS[selectedMonth - 1]}`;
    const socMax = s.battery === "on" ? (s.pv === "10" ? 10 : s.pv === "20" ? 15 : 2) : 0;
    renderHourlyChart(opts.hourly, data, MONTH_LABELS[selectedMonth - 1], socMax);
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
    const url = `${location.pathname}?${scenarioToQuery(s).toString()}`;
    history.replaceState(null, "", url);
  }

  function scheduleRecompute(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      recompute();
    });
  }

  store.subscribe((s) => {
    syncControls(s);
    scheduleRecompute();
  });

  syncControls(store.getState());
  recompute();
}
