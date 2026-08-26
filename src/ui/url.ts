// Shareable-URL support: serialize the full AppState into the query string so a
// configuration can be shared via a link, and parse it back on load. Missing
// fields fall back to DEFAULT_STATE (we always merge, never replace).

import { AppState, DEFAULT_STATE } from "./state";

function num(p: URLSearchParams, k: string, set: (v: number) => void): void {
  const v = p.get(k);
  if (v !== null && v.trim() !== "" && !Number.isNaN(Number(v))) set(Number(v));
}
function str(p: URLSearchParams, k: string, set: (v: string) => void): void {
  const v = p.get(k);
  if (v !== null) set(v);
}
function bool(p: URLSearchParams, k: string, set: (v: boolean) => void): void {
  const v = p.get(k);
  if (v !== null) set(v === "1" || v === "true");
}

export function serializeState(s: AppState): string {
  const p = new URLSearchParams();
  p.set("kwp", String(s.peakKWp));
  p.set("tilt", String(s.tiltDeg));
  p.set("o", s.orientation);
  p.set("loc", s.location);
  p.set("cap", String(s.capacityKWh));
  p.set("pwr", String(s.maxPowerKW));
  p.set("minsoc", String(s.minSOC));
  p.set("maxsoc", String(s.maxSOC));
  p.set("eff", String(s.efficiency));
  p.set("soc0", String(s.startSOC));
  p.set("charge", s.chargeMode);
  p.set("de", s.dischargeEvening ? "1" : "0");
  p.set("dm", s.dischargeMorning ? "1" : "0");
  p.set("evs", String(s.eveningStart));
  p.set("eve", String(s.eveningEnd));
  p.set("mns", String(s.morningStart));
  p.set("mne", String(s.morningEnd));
  p.set("fi", String(s.feedInCt));
  p.set("yr", String(s.commissioningYear));
  p.set("py", s.priceYear);
  p.set("hh", s.consumers.household.enabled ? "1" : "0");
  p.set("hk", String(s.consumers.household.annualKWh));
  p.set("wp", s.consumers.heatpump.enabled ? "1" : "0");
  p.set("wk", String(s.consumers.heatpump.annualKWh));
  p.set("bw", s.consumers.bwwp.enabled ? "1" : "0");
  p.set("ev", s.consumers.ev.enabled ? "1" : "0");
  p.set("ek", String(s.consumers.ev.annualKWh));
  p.set("es", String(s.consumers.ev.pvShare));
  p.set("ex", s.exportScheme);
  p.set("im", s.importScheme);
  p.set("ict", String(s.importFixedCt));
  return p.toString();
}

export function deserializeState(qs: string): AppState {
  const s: AppState = {
    ...DEFAULT_STATE,
    consumers: {
      household: { ...DEFAULT_STATE.consumers.household },
      heatpump: { ...DEFAULT_STATE.consumers.heatpump },
      bwwp: { ...DEFAULT_STATE.consumers.bwwp },
      ev: { ...DEFAULT_STATE.consumers.ev },
    },
  };
  const p = new URLSearchParams(qs);
  num(p, "kwp", (v) => (s.peakKWp = v));
  num(p, "tilt", (v) => (s.tiltDeg = v));
  str(p, "o", (v) => (s.orientation = v as AppState["orientation"]));
  str(p, "loc", (v) => (s.location = v));
  num(p, "cap", (v) => (s.capacityKWh = v));
  num(p, "pwr", (v) => (s.maxPowerKW = v));
  num(p, "minsoc", (v) => (s.minSOC = v));
  num(p, "maxsoc", (v) => (s.maxSOC = v));
  num(p, "eff", (v) => (s.efficiency = v));
  num(p, "soc0", (v) => (s.startSOC = v));
  str(p, "charge", (v) => (s.chargeMode = v as AppState["chargeMode"]));
  bool(p, "de", (v) => (s.dischargeEvening = v));
  bool(p, "dm", (v) => (s.dischargeMorning = v));
  num(p, "evs", (v) => (s.eveningStart = v));
  num(p, "eve", (v) => (s.eveningEnd = v));
  num(p, "mns", (v) => (s.morningStart = v));
  num(p, "mne", (v) => (s.morningEnd = v));
  num(p, "fi", (v) => (s.feedInCt = v));
  num(p, "yr", (v) => (s.commissioningYear = v));
  str(p, "py", (v) => (s.priceYear = v));
  bool(p, "hh", (v) => (s.consumers.household.enabled = v));
  num(p, "hk", (v) => (s.consumers.household.annualKWh = v));
  bool(p, "wp", (v) => (s.consumers.heatpump.enabled = v));
  num(p, "wk", (v) => (s.consumers.heatpump.annualKWh = v));
  bool(p, "bw", (v) => (s.consumers.bwwp.enabled = v));
  bool(p, "ev", (v) => (s.consumers.ev.enabled = v));
  num(p, "ek", (v) => (s.consumers.ev.annualKWh = v));
  num(p, "es", (v) => (s.consumers.ev.pvShare = v));
  str(p, "ex", (v) => (s.exportScheme = v as AppState["exportScheme"]));
  str(p, "im", (v) => (s.importScheme = v as AppState["importScheme"]));
  num(p, "ict", (v) => (s.importFixedCt = v));
  return s;
}

export function writeUrl(s: AppState): void {
  const qs = serializeState(s);
  const url = `${location.pathname}?${qs}`;
  history.replaceState(null, "", url);
}
