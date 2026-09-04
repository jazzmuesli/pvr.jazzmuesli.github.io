import { AppState, Orientation } from "./state";
import { LOCATIONS } from "../calc/solar";
import { PRICE_YEARS } from "../calc/priceData";
import { feedInTariffCt } from "../calc/revenue";
import { TariffScheme } from "../calc/tariff";

interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  get: (s: AppState) => number;
  set: (s: AppState, v: number) => void;
  fmt?: (v: number) => string;
}

function slider(opts: SliderOpts, state: AppState, onChange: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "control";
  const id = `ctl-${Math.random().toString(36).slice(2, 9)}`;
  const lab = document.createElement("label");
  lab.htmlFor = id;
  const fmt = opts.fmt ?? ((v: number) => String(v));
  const valSpan = document.createElement("span");
  valSpan.className = "val";
  const render = () => {
    const v = opts.get(state);
    input.value = String(v);
    valSpan.textContent = `${fmt(v)}${opts.unit ?? ""}`;
  };
  const txt = document.createElement("span");
  txt.textContent = opts.label;
  lab.appendChild(txt);
  lab.appendChild(valSpan);
  const input = document.createElement("input");
  input.type = "range";
  input.id = id;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.get(state));
  input.addEventListener("input", () => {
    opts.set(state, parseFloat(input.value));
    render();
    onChange();
  });
  wrap.appendChild(lab);
  wrap.appendChild(input);
  render();
  (wrap as unknown as { sync: () => void }).sync = render;
  return wrap;
}

function selectControl(
  label: string,
  options: { value: string; label: string }[],
  get: (s: AppState) => string,
  set: (s: AppState, v: string) => void,
  state: AppState,
  onChange: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "control";
  const id = `ctl-${Math.random().toString(36).slice(2, 9)}`;
  const lab = document.createElement("label");
  lab.htmlFor = id;
  lab.textContent = label;
  const sel = document.createElement("select");
  sel.id = id;
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = get(state);
  sel.addEventListener("change", () => {
    set(state, sel.value);
    onChange();
  });
  wrap.appendChild(lab);
  wrap.appendChild(sel);
  return wrap;
}

function checkbox(
  label: string,
  get: (s: AppState) => boolean,
  set: (s: AppState, v: boolean) => void,
  state: AppState,
  onChange: () => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "control control-inline";
  const id = `ctl-${Math.random().toString(36).slice(2, 9)}`;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = get(state);
  input.addEventListener("change", () => {
    set(state, input.checked);
    onChange();
  });
  const lab = document.createElement("label");
  lab.htmlFor = id;
  lab.textContent = label;
  wrap.appendChild(input);
  wrap.appendChild(lab);
  return wrap;
}

export function buildControls(host: HTMLElement, state: AppState, onChange: () => void): void {
  host.innerHTML = "";
  let feedInSync: (() => void) | undefined;

  const expert = state.expertMode;

  const section = (title: string) => {
    const h = document.createElement("h3");
    h.textContent = title;
    host.appendChild(h);
  };

  // Expert toggle
  const expWrap = document.createElement("div");
  expWrap.className = "control control-inline expert-toggle";
  const expId = `ctl-expert`;
  const expInput = document.createElement("input");
  expInput.type = "checkbox";
  expInput.id = expId;
  expInput.checked = expert;
  expInput.addEventListener("change", () => {
    state.expertMode = expInput.checked;
    buildControls(host, state, onChange);
    onChange();
  });
  const expLab = document.createElement("label");
  expLab.htmlFor = expId;
  expLab.textContent = "Experte";
  expWrap.appendChild(expInput);
  expWrap.appendChild(expLab);
  host.appendChild(expWrap);

  section("Investition");
  host.appendChild(
    slider({ label: "Gesamtinvestition", min: 100, max: 80000, step: 100, unit: " €", get: (s) => s.investmentEUR, set: (s, v) => (s.investmentEUR = v), fmt: (v) => `${Math.round(v).toLocaleString("de-DE")} €` }, state, onChange),
  );

  section("PV-Anlage");
  host.appendChild(
    slider({ label: "Peak-Leistung", min: 0.4, max: 50, step: 0.1, unit: " kWp", get: (s) => s.peakKWp, set: (s, v) => { s.peakKWp = v; s.feedInCt = feedInTariffCt(s.commissioningYear, s.peakKWp); feedInSync?.(); }, fmt: (v) => v.toFixed(1) }, state, onChange),
  );
  host.appendChild(
    slider({ label: "Neigung", min: 0, max: 60, step: 1, unit: "°", get: (s) => s.tiltDeg, set: (s, v) => (s.tiltDeg = v) }, state, onChange),
  );
  host.appendChild(
    selectControl(
      "Ausrichtung",
      [
        { value: "south", label: "Süd" },
        { value: "east", label: "Ost" },
        { value: "west", label: "West" },
        { value: "east_west", label: "Ost + West" },
        { value: "north", label: "Nord" },
      ],
      (s) => s.orientation,
      (s, v) => (s.orientation = v as Orientation),
      state,
      onChange,
    ),
  );
  host.appendChild(
    selectControl(
      "Standort",
      Object.entries(LOCATIONS).map(([k, v]) => ({ value: k, label: v.name })),
      (s) => s.location,
      (s, v) => (s.location = v),
      state,
      onChange,
    ),
  );

  section("Batterie");
  host.appendChild(
    slider({ label: "Kapazität", min: 0, max: 40, step: 0.5, unit: " kWh", get: (s) => s.capacityKWh, set: (s, v) => (s.capacityKWh = v), fmt: (v) => v.toFixed(1) }, state, onChange),
  );
  if (expert) {
    host.appendChild(
      slider({ label: "Max. Leistung", min: 1, max: 20, step: 0.5, unit: " kW", get: (s) => s.maxPowerKW, set: (s, v) => (s.maxPowerKW = v) }, state, onChange),
    );
    host.appendChild(
      slider({ label: "Min. SOC", min: 0, max: 0.5, step: 0.05, unit: "", get: (s) => s.minSOC, set: (s, v) => (s.minSOC = v), fmt: (v) => `${Math.round(v * 100)}%` }, state, onChange),
    );
    host.appendChild(
      slider({ label: "Max. SOC", min: 0.5, max: 1, step: 0.05, unit: "", get: (s) => s.maxSOC, set: (s, v) => (s.maxSOC = v), fmt: (v) => `${Math.round(v * 100)}%` }, state, onChange),
    );
    host.appendChild(
      selectControl(
        "Ladestrategie",
        [
          { value: "morning", label: "Morgens (PV-Überschuss)" },
          { value: "midday", label: "Mittags (nur PV)" },
          { value: "gridNegative", label: "Billiger Strom (PV + Netz bei Negativpreis)" },
        ],
        (s) => s.chargeMode,
        (s, v) => (s.chargeMode = v as "morning" | "midday" | "gridNegative"),
        state,
        onChange,
      ),
    );
    host.appendChild(checkbox("Entladung abends", (s) => s.dischargeEvening, (s, v) => (s.dischargeEvening = v), state, onChange));
    host.appendChild(
      slider({ label: "Abend-Fenster von", min: 12, max: 22, step: 1, unit: " Uhr", get: (s) => s.eveningStart, set: (s, v) => (s.eveningStart = v) }, state, onChange),
    );
    host.appendChild(
      slider({ label: "Abend-Fenster bis", min: 18, max: 24, step: 1, unit: " Uhr", get: (s) => s.eveningEnd, set: (s, v) => (s.eveningEnd = v) }, state, onChange),
    );
    host.appendChild(checkbox("Entladung morgens", (s) => s.dischargeMorning, (s, v) => (s.dischargeMorning = v), state, onChange));
    host.appendChild(
      slider({ label: "Morgen-Fenster von", min: 0, max: 10, step: 1, unit: " Uhr", get: (s) => s.morningStart, set: (s, v) => (s.morningStart = v) }, state, onChange),
    );
    host.appendChild(
      slider({ label: "Morgen-Fenster bis", min: 8, max: 14, step: 1, unit: " Uhr", get: (s) => s.morningEnd, set: (s, v) => (s.morningEnd = v) }, state, onChange),
    );
  }

  section("Verbraucher");
  host.appendChild(checkbox("Haushalt", (s) => s.consumers.household.enabled, (s, v) => (s.consumers.household.enabled = v), state, onChange));
  host.appendChild(
    slider({ label: "Verbrauch", min: 1000, max: 6000, step: 100, unit: " kWh", get: (s) => s.consumers.household.annualKWh, set: (s, v) => (s.consumers.household.annualKWh = v) }, state, onChange),
  );
  host.appendChild(checkbox("Wärmepumpe", (s) => s.consumers.heatpump.enabled, (s, v) => { s.consumers.heatpump.enabled = v; buildControls(host, state, onChange); }, state, onChange));
  if (state.consumers.heatpump.enabled) {
    host.appendChild(
      slider({ label: "  Verbrauch", min: 1000, max: 10000, step: 100, unit: " kWh", get: (s) => s.consumers.heatpump.annualKWh, set: (s, v) => (s.consumers.heatpump.annualKWh = v) }, state, onChange),
    );
    if (expert) {
      host.appendChild(
        slider({ label: "  JAZ", min: 1.5, max: 5, step: 0.1, unit: "", get: (s) => s.heatpumpJaz, set: (s, v) => (s.heatpumpJaz = v), fmt: (v) => v.toFixed(1) }, state, onChange),
      );
    }
  }
  host.appendChild(checkbox("Brauchwasser-WP", (s) => s.consumers.bwwp.enabled, (s, v) => { s.consumers.bwwp.enabled = v; buildControls(host, state, onChange); }, state, onChange));
  if (state.consumers.bwwp.enabled) {
    host.appendChild(
      slider({ label: "  Verbrauch", min: 100, max: 1500, step: 20, unit: " kWh", get: (s) => s.consumers.bwwp.annualKWh ?? 480, set: (s, v) => (s.consumers.bwwp.annualKWh = v) }, state, onChange),
    );
  }
  host.appendChild(checkbox("E-Auto", (s) => s.consumers.ev.enabled, (s, v) => { s.consumers.ev.enabled = v; buildControls(host, state, onChange); }, state, onChange));
  if (state.consumers.ev.enabled) {
    host.appendChild(
      slider({ label: "  Verbrauch", min: 500, max: 5000, step: 100, unit: " kWh", get: (s) => s.consumers.ev.annualKWh, set: (s, v) => (s.consumers.ev.annualKWh = v) }, state, onChange),
    );
    host.appendChild(
      slider({ label: "  PV-Anteil", min: 0, max: 1, step: 0.05, unit: "", get: (s) => s.consumers.ev.pvShare, set: (s, v) => (s.consumers.ev.pvShare = v), fmt: (v) => `${Math.round(v * 100)}%` }, state, onChange),
    );
  }

  section("Vergütung");
  const feedInSlider = slider({ label: "Einspeisevergütung", min: 0, max: 15, step: 0.1, unit: " ct/kWh", get: (s) => s.feedInCt, set: (s, v) => (s.feedInCt = v), fmt: (v) => v.toFixed(1) }, state, onChange);
  host.appendChild(feedInSlider);
  feedInSync = (feedInSlider as unknown as { sync: () => void }).sync;
  host.appendChild(
    selectControl(
      "Inbetriebnahme-Jahr",
      [
        { value: "2023", label: "2023" },
        { value: "2024", label: "2024" },
        { value: "2025", label: "2025" },
        { value: "2026", label: "2026" },
      ],
      (s) => String(s.commissioningYear),
      (s, v) => { s.commissioningYear = parseInt(v, 10); s.feedInCt = feedInTariffCt(s.commissioningYear, s.peakKWp); feedInSync?.(); },
      state,
      onChange,
    ),
  );

  section("Einspeisung");
  host.appendChild(
    selectControl(
      "Modell",
      [
        { value: "market", label: "Direktvermarktung (Spot + Marktprämie)" },
        { value: "fixed", label: "Feste Einspeisevergütung" },
      ],
      (s) => s.exportScheme,
      (s, v) => (s.exportScheme = v as "fixed" | "market"),
      state,
      onChange,
    ),
  );

  section("Stromtarif");
  host.appendChild(
    selectControl(
      "Tarifmodell",
      [
        { value: "fixed", label: "Fester Arbeitspreis" },
        { value: "dynamic", label: "Dynamisch (Spot)" },
        { value: "dynamic14a", label: "Dynamisch + §14a/3" },
      ],
      (s) => s.importScheme,
      (s, v) => (s.importScheme = v as TariffScheme),
      state,
      onChange,
    ),
  );
  host.appendChild(
    slider({ label: "Arbeitspreis", min: 15, max: 45, step: 0.5, unit: " ct/kWh", get: (s) => s.importFixedCt, set: (s, v) => (s.importFixedCt = v), fmt: (v) => v.toFixed(1) }, state, onChange),
  );
  if (expert) {
    host.appendChild(
      selectControl(
        "Spotmarkt-Jahr",
        PRICE_YEARS.map((y) => ({ value: y, label: y })),
        (s) => String(s.priceYear),
        (s, v) => (s.priceYear = v),
        state,
        onChange,
      ),
    );
  }
}
