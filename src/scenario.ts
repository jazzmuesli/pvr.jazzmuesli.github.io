// Shared "scenario" model used by both the interactive wizard and the chatbot
// advisor. Everything here is pure and runs client-side (no network) so it can
// be unit-tested without a server. A `Scenario` is the minimal, human-friendly
// description of a PV setup; it is expanded into the low-level `SimParams`
// that `runSimulation` understands.
//
// The model is fully numeric: PV size, orientation, battery capacity/power and
// investment are first-class numbers, so *any* size is supported. The `pv` enum
// is only a convenience preset (the wizard buttons / example offers); it mirrors
// the numeric fields but does not restrict them.

import {
  runSimulation,
  SimReport,
  SimParams,
  DEFAULT_SIM_PARAMS,
} from "./calc/report";

export type PVSize = "none" | "balcony" | "10" | "20";
export type Battery = "off" | "on";
export type Orientation = "south" | "east" | "west" | "east_west";

export interface Scenario {
  /** Household annual consumption in kWh (the standard lastprofile base). */
  consumptionKWh: number;
  /** Import working price in ct/kWh. */
  priceCt: number;
  /** City key understood by the simulation (e.g. "boizenburg"). */
  location: string;
  /** Selected preset (none/balcony/10/20) — UI convenience only. */
  pv: PVSize;
  /** PV peak power in kWp (authoritative). */
  peakKWp: number;
  /** Module orientation. */
  orientation: Orientation;
  battery: Battery;
  /** Battery usable capacity in kWh (authoritative; 0 when off). */
  capacityKWh: number;
  /** Battery max power in kW (authoritative). */
  maxPowerKW: number;
  /** Total investment in EUR (PV + battery). */
  investmentEUR: number;
  heatpump: boolean;
  heatpumpKWh: number;
  ev: boolean;
  evKWh: number;
  bwwp: boolean;
}

export const TILT_DEG = 35;
export const FEED_IN_CT = 7.2;
export const COMMISSIONING_YEAR = 2025;
export const PRICE_YEAR = "2025";

export function defaultScenario(): Scenario {
  return {
    consumptionKWh: 2500,
    priceCt: 30,
    location: "boizenburg",
    pv: "10",
    peakKWp: 10,
    orientation: "south",
    battery: "off",
    capacityKWh: 0,
    maxPowerKW: 0,
    investmentEUR: 7000,
    heatpump: false,
    heatpumpKWh: 3500,
    ev: false,
    evKWh: 2000,
    bwwp: false,
  };
}

// --- preset hardware spec (for the example buttons / offers) ---------------
export interface PVSpec {
  kwp: number;
  orientation: Orientation;
  capacityKWh: number;
  maxPowerKW: number;
  investmentEUR: number;
}

export function pvPreset(pv: PVSize): PVSpec {
  switch (pv) {
    case "none":
      return { kwp: 0, orientation: "south", capacityKWh: 0, maxPowerKW: 0, investmentEUR: 0 };
    case "balcony":
      return { kwp: 0.8, orientation: "south", capacityKWh: 2, maxPowerKW: 1, investmentEUR: 300 };
    case "10":
      return { kwp: 10, orientation: "south", capacityKWh: 10, maxPowerKW: 5, investmentEUR: 7000 };
    case "20":
      return { kwp: 20, orientation: "east_west", capacityKWh: 15, maxPowerKW: 8, investmentEUR: 28000 };
  }
}

/** Effective hardware spec derived from the (authoritative) numeric fields. */
export function spec(s: Scenario): PVSpec {
  const bat = s.battery === "on";
  return {
    kwp: s.peakKWp,
    orientation: s.orientation,
    capacityKWh: bat ? s.capacityKWh : 0,
    maxPowerKW: bat ? s.maxPowerKW : 0,
    investmentEUR: s.investmentEUR,
  };
}

export function scenarioToSimParams(s: Scenario): SimParams {
  const sp = spec(s);
  const p: SimParams = {
    ...DEFAULT_SIM_PARAMS,
    peakKWp: sp.kwp,
    tiltDeg: TILT_DEG,
    orientation: sp.orientation,
    location: s.location,
    capacityKWh: sp.capacityKWh,
    maxPowerKW: sp.maxPowerKW,
    minSOC: 0.1,
    maxSOC: 0.95,
    efficiency: 0.95,
    startSOC: 0.5,
    chargeMode: "morning",
    dischargeEvening: true,
    dischargeMorning: true,
    eveningStart: 17,
    eveningEnd: 23,
    morningStart: 5,
    morningEnd: 12,
    feedInCt: FEED_IN_CT,
    commissioningYear: COMMISSIONING_YEAR,
    priceYear: PRICE_YEAR,
    consumers: {
      household: { enabled: true, annualKWh: s.consumptionKWh },
      heatpump: { enabled: s.heatpump, annualKWh: s.heatpumpKWh },
      bwwp: { enabled: s.bwwp },
      ev: { enabled: s.ev, annualKWh: s.evKWh, pvShare: 0.8 },
    },
    exportScheme: "fixed",
    importScheme: "fixed",
    importFixedCt: s.priceCt,
    investmentEUR: sp.investmentEUR,
  };
  return p;
}

export function runScenario(s: Scenario): SimReport {
  return runSimulation(scenarioToSimParams(s));
}

// --- query-string serialisation (compatible with index.html) --------------
export function scenarioToQuery(s: Scenario): URLSearchParams {
  const sp = spec(s);
  const q = new URLSearchParams();
  q.set("kwp", String(sp.kwp));
  q.set("tilt", String(TILT_DEG));
  q.set("o", sp.orientation);
  q.set("loc", s.location);
  q.set("cap", String(sp.capacityKWh));
  q.set("pwr", String(sp.maxPowerKW));
  q.set("minsoc", "0.1");
  q.set("maxsoc", "0.95");
  q.set("eff", "0.95");
  q.set("soc0", "0.5");
  q.set("charge", "morning");
  q.set("de", "1");
  q.set("dm", "1");
  q.set("evs", "17");
  q.set("eve", "23");
  q.set("mns", "5");
  q.set("mne", "12");
  q.set("fi", String(FEED_IN_CT));
  q.set("yr", String(COMMISSIONING_YEAR));
  q.set("py", PRICE_YEAR);
  q.set("hh", "1");
  q.set("hk", String(s.consumptionKWh));
  q.set("wp", s.heatpump ? "1" : "0");
  q.set("wk", String(s.heatpumpKWh));
  q.set("bw", s.bwwp ? "1" : "0");
  q.set("ev", s.ev ? "1" : "0");
  q.set("ek", String(s.evKWh));
  q.set("es", "0.8");
  q.set("ex", "fixed");
  q.set("im", "fixed");
  q.set("ict", String(s.priceCt));
  q.set("inv", String(sp.investmentEUR));
  return q;
}

export function appUrl(s: Scenario): string {
  return `/index.html?${scenarioToQuery(s).toString()}`;
}

export function scenarioFromQuery(qs: string): Scenario {
  const q = new URLSearchParams(qs);
  const num = (k: string, d: number) => {
    const v = q.get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (k: string) => q.get(k) === "1" || q.get(k) === "true";
  const s = defaultScenario();
  s.consumptionKWh = num("hk", s.consumptionKWh);
  s.priceCt = num("ict", s.priceCt);
  const loc = q.get("loc");
  if (loc) s.location = loc;
  const kwp = num("kwp", NaN);
  if (Number.isFinite(kwp)) {
    s.peakKWp = kwp;
    s.pv = kwp >= 19 ? "20" : kwp >= 9 ? "10" : kwp >= 0.5 ? "balcony" : "none";
  }
  const o = q.get("o");
  if (o === "south" || o === "east" || o === "west" || o === "east_west") s.orientation = o;
  const cap = num("cap", NaN);
  if (Number.isFinite(cap) && cap > 0) {
    s.battery = "on";
    s.capacityKWh = cap;
  } else {
    s.battery = "off";
    s.capacityKWh = 0;
  }
  s.maxPowerKW = num("pwr", s.maxPowerKW);
  s.investmentEUR = num("inv", s.investmentEUR);
  s.heatpump = bool("wp");
  s.heatpumpKWh = num("wk", s.heatpumpKWh);
  s.ev = bool("ev");
  s.evKWh = num("ek", s.evKWh);
  s.bwwp = bool("bw");
  return s;
}

// --- offer helpers (used by the advisor) ----------------------------------
export type OfferKind = "balkon" | "10kw" | "10kwBattery";

export function applyOffer(s: Scenario, kind: OfferKind): Scenario {
  const pv = kind === "balkon" ? "balcony" : "10";
  const base = pvPreset(pv);
  const out: Scenario = {
    ...s,
    pv,
    peakKWp: base.kwp,
    orientation: base.orientation,
    battery: "off",
    capacityKWh: 0,
    maxPowerKW: 0,
    investmentEUR: base.investmentEUR,
  };
  if (kind === "10kwBattery") {
    out.battery = "on";
    out.capacityKWh = base.capacityKWh;
    out.maxPowerKW = base.maxPowerKW;
    out.investmentEUR = base.investmentEUR + (base.kwp >= 19 ? 12000 : 3000);
  }
  return out;
}

export function pvLabel(s: Scenario): string {
  if (s.peakKWp <= 0) return "Kein PV (Basis)";
  if (s.peakKWp < 1) return `Balkonkraftwerk ${Math.round(s.peakKWp * 1000)} Wp`;
  const ort = s.orientation === "east_west" ? "Ost/West" : s.orientation === "south" ? "Süd" : s.orientation;
  return `${s.peakKWp} kWp (${ort})`;
}

export interface ScenarioMetrics {
  pvKWh: number;
  selfKWh: number;
  selfPct: number;
  importKWh: number;
  exportKWh: number;
  netEUR: number;
  savingsEUR: number;
  amortYears: number;
  investmentEUR: number;
  effCt: number;
}

/** Compute the economics of a scenario, including savings vs. a no-PV baseline. */
export function computeMetrics(s: Scenario): ScenarioMetrics {
  const rep = runScenario(s);
  const base = runScenario({ ...s, pv: "none", peakKWp: 0, battery: "off", capacityKWh: 0, maxPowerKW: 0, investmentEUR: 0 });
  const baselineCost = (base.summary.totalLoadKWh * s.priceCt) / 100;
  const netCost = rep.summary.importCostEUR - rep.summary.exportRevenueEUR;
  const savings = baselineCost - netCost;
  return {
    pvKWh: rep.summary.totalPVKWh,
    selfKWh: rep.summary.selfConsumptionKWh,
    selfPct: rep.summary.totalPVKWh > 0 ? (rep.summary.selfConsumptionKWh / rep.summary.totalPVKWh) * 100 : 0,
    importKWh: rep.summary.totalImportKWh,
    exportKWh: rep.summary.totalExportKWh,
    netEUR: rep.summary.netSelectedEUR,
    savingsEUR: savings,
    amortYears: rep.amortisation.paybackYears,
    investmentEUR: spec(s).investmentEUR,
    effCt: rep.effectivePrice.overallCt,
  };
}

export function consumerSummary(s: Scenario): string {
  const parts: string[] = [`Haushalt ${s.consumptionKWh} kWh`];
  if (s.heatpump) parts.push(`Wärmepumpe ${s.heatpumpKWh} kWh`);
  if (s.ev) parts.push(`E-Auto ${s.evKWh} kWh`);
  if (s.bwwp) parts.push(`Brauchwasser-WP ~400 kWh`);
  return parts.join(", ");
}
