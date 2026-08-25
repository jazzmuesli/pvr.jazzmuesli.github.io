import { LOCATIONS } from "../calc/solar";
function slider(opts, state, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "control";
    const id = `ctl-${Math.random().toString(36).slice(2, 9)}`;
    const lab = document.createElement("label");
    lab.htmlFor = id;
    const fmt = opts.fmt ?? ((v) => String(v));
    const valSpan = document.createElement("span");
    valSpan.className = "val";
    const render = () => {
        valSpan.textContent = `${fmt(opts.get(state))}${opts.unit ?? ""}`;
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
    return wrap;
}
function selectControl(label, options, get, set, state, onChange) {
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
function checkbox(label, get, set, state, onChange) {
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
export function buildControls(host, state, onChange) {
    host.innerHTML = "";
    const section = (title) => {
        const h = document.createElement("h3");
        h.textContent = title;
        host.appendChild(h);
    };
    section("PV-Anlage");
    host.appendChild(slider({ label: "Peak-Leistung", min: 1, max: 50, step: 0.5, unit: " kWp", get: (s) => s.peakKWp, set: (s, v) => (s.peakKWp = v) }, state, onChange));
    host.appendChild(slider({ label: "Neigung", min: 0, max: 60, step: 1, unit: "°", get: (s) => s.tiltDeg, set: (s, v) => (s.tiltDeg = v) }, state, onChange));
    host.appendChild(selectControl("Ausrichtung", [
        { value: "south", label: "Süd" },
        { value: "east", label: "Ost" },
        { value: "west", label: "West" },
        { value: "east_west", label: "Ost + West" },
    ], (s) => s.orientation, (s, v) => (s.orientation = v), state, onChange));
    host.appendChild(selectControl("Standort", Object.entries(LOCATIONS).map(([k, v]) => ({ value: k, label: v.name })), (s) => s.location, (s, v) => (s.location = v), state, onChange));
    section("Batterie");
    host.appendChild(slider({ label: "Kapazität", min: 0, max: 40, step: 0.5, unit: " kWh", get: (s) => s.capacityKWh, set: (s, v) => (s.capacityKWh = v), fmt: (v) => v.toFixed(1) }, state, onChange));
    host.appendChild(slider({ label: "Max. Leistung", min: 1, max: 20, step: 0.5, unit: " kW", get: (s) => s.maxPowerKW, set: (s, v) => (s.maxPowerKW = v) }, state, onChange));
    host.appendChild(slider({ label: "Min. SOC", min: 0, max: 0.5, step: 0.05, unit: "", get: (s) => s.minSOC, set: (s, v) => (s.minSOC = v), fmt: (v) => `${Math.round(v * 100)}%` }, state, onChange));
    host.appendChild(slider({ label: "Max. SOC", min: 0.5, max: 1, step: 0.05, unit: "", get: (s) => s.maxSOC, set: (s, v) => (s.maxSOC = v), fmt: (v) => `${Math.round(v * 100)}%` }, state, onChange));
    host.appendChild(selectControl("Ladestrategie", [
        { value: "solar", label: "PV-Überschuss (morgens)" },
        { value: "lowPrice", label: "Günstigster Strom" },
    ], (s) => s.chargeMode, (s, v) => (s.chargeMode = v), state, onChange));
    host.appendChild(checkbox("Entladung abends (teures Fenster)", (s) => s.dischargeEvening, (s, v) => (s.dischargeEvening = v), state, onChange));
    host.appendChild(slider({ label: "Abend-Fenster von", min: 12, max: 22, step: 1, unit: " Uhr", get: (s) => s.eveningStart, set: (s, v) => (s.eveningStart = v) }, state, onChange));
    host.appendChild(slider({ label: "Abend-Fenster bis", min: 18, max: 24, step: 1, unit: " Uhr", get: (s) => s.eveningEnd, set: (s, v) => (s.eveningEnd = v) }, state, onChange));
    host.appendChild(checkbox("Entladung morgens (teures Fenster)", (s) => s.dischargeMorning, (s, v) => (s.dischargeMorning = v), state, onChange));
    host.appendChild(slider({ label: "Morgen-Fenster von", min: 0, max: 10, step: 1, unit: " Uhr", get: (s) => s.morningStart, set: (s, v) => (s.morningStart = v) }, state, onChange));
    host.appendChild(slider({ label: "Morgen-Fenster bis", min: 8, max: 14, step: 1, unit: " Uhr", get: (s) => s.morningEnd, set: (s, v) => (s.morningEnd = v) }, state, onChange));
    section("Vergütung");
    host.appendChild(slider({ label: "Einspeisevergütung", min: 0, max: 15, step: 0.1, unit: " ct/kWh", get: (s) => s.feedInCt, set: (s, v) => (s.feedInCt = v), fmt: (v) => v.toFixed(1) }, state, onChange));
    host.appendChild(slider({ label: "Marktprämie", min: 0, max: 10, step: 0.1, unit: " ct/kWh", get: (s) => s.premiumCt, set: (s, v) => (s.premiumCt = v), fmt: (v) => v.toFixed(1) }, state, onChange));
}
