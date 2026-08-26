// Import electricity tariff pricing (EUR/kWh) for the three schemes the user
// wants to compare:
//   - "fixed"       : a constant rate (e.g. 24 ct/kWh), independent of spot.
//   - "dynamic"     : spot price + city Netzentgelt + taxes/margin (Tibber-style).
//   - "dynamic14a"  : like dynamic, but the Netzentgelt follows § 14a EnWG
//                     Modul 3 (a time-varying grid fee): cheaper at night
//                     (Niedriglasttarif) and more expensive in winter evening
//                     peaks (Hochtarif). Shifting load into the cheap window
//                     saves money.
//
// City Netzentgelte: Boizenburg uses the real VBE 2026 price sheet
// (preise-strom-nne-vbe-ab-01-01-2026.pdf). Other cities use illustrative
// 2025 levels. All figures in ct/kWh.

import { monthOfStep, hourOfStep } from "./types";

export type TariffScheme = "fixed" | "dynamic" | "dynamic14a";
export type City = "Hamburg" | "Muenchen" | "Berlin" | "Koeln" | "Boizenburg";

export const CITIES: City[] = ["Hamburg", "Muenchen", "Berlin", "Koeln", "Boizenburg"];

// Standard (flat, Modul 1) Netzentgelt per city, ct/kWh.
// Real 2026 figures (ns Arbeitspreis, netto) from Verivox Verbraucheratlas /
// Stromvermittlung: Hamburg 11,80; Bayern (München) 8,63; Berlin 8,55;
// NRW (Köln) 9,73; Mecklenburg-Vorpommern (Boizenburg) 7,23.
// Boizenburg uses the user's VBE price sheet (Modul 1 = 7,50 ct/kWh).
export const NET_ENTGELT_CT: Record<City, number> = {
  Hamburg: 11.8,
  Muenchen: 8.63,
  Berlin: 8.55,
  Koeln: 9.73,
  Boizenburg: 7.5,
};

// Map a PV location key (see solar.LOCATIONS) to its Netzentgelt city.
const LOCATION_TO_CITY: Record<string, City> = {
  hamburg: "Hamburg",
  berlin: "Berlin",
  munich: "Muenchen",
  cologne: "Koeln",
  boizenburg: "Boizenburg",
};
export function cityForLocation(loc: string): City {
  return LOCATION_TO_CITY[loc] ?? "Hamburg";
}

// Fixed, non-spot components of a dynamic tariff (ct/kWh).
export const STROMSTEUER_CT = 2.05; // electricity tax
export const KONZESSION_CT = 1.1; // concession fee
export const MESSUNG_CT = 0.5; // metering
export const MARGIN_CT = 1.5; // provider margin / sales / other

/** Default fixed retail rate (ct/kWh), the user's "for example 24 ct". */
export const DEFAULT_FIXED_CT = 24;

// § 14a Modul 3 (VBE Boizenburg, real 2026 values).
const MODUL3_NIEDRIGLAST_CT = 2.25; // 00:00–05:00 all year
const MODUL3_HOCHTARIF_CT = 12.85; // 18:00–20:00 in Q1 & Q4
// For cities without published Modul 3 data we approximate around their base
// Netzentgelt: Niedriglast = 30 %, Hochtarif = 170 % of the flat rate.
const MODUL3_NIEDRIGLAST_FACTOR = 0.3;
const MODUL3_HOCHTARIF_FACTOR = 1.7;

function quarterOfStep(stepIndex: number): number {
  const m = monthOfStep(stepIndex);
  return Math.floor((m - 1) / 3) + 1;
}

/**
 * § 14a Modul 3 time-varying Netzentgelt (ct/kWh) for one step.
 *  - Niedriglasttarif (cheap) during 00:00–05:00 all year.
 *  - Hochtarif (expensive) during 18:00–20:00 in Q1 (Jan–Mar) and Q4 (Oct–Dec).
 *  - Standardlasttarif (base rate) otherwise.
 */
export function modul3NetzentgeltCt(city: City, stepIndex: number): number {
  const base = NET_ENTGELT_CT[city];
  const h = hourOfStep(stepIndex);
  const q = quarterOfStep(stepIndex);
  if (h >= 0 && h < 5) {
    return city === "Boizenburg" ? MODUL3_NIEDRIGLAST_CT : base * MODUL3_NIEDRIGLAST_FACTOR;
  }
  if ((q === 1 || q === 4) && h >= 18 && h < 20) {
    return city === "Boizenburg" ? MODUL3_HOCHTARIF_CT : base * MODUL3_HOCHTARIF_FACTOR;
  }
  return base;
}

/**
 * Import price in ct/kWh for one step.
 * @param spotCt spot price in ct/kWh (= EUR/MWh * 0.1)
 * @param fixedCt constant rate for the "fixed" scheme
 */
export function importPriceCtPerKWh(
  scheme: TariffScheme,
  city: City,
  spotCt: number,
  stepIndex: number,
  fixedCt: number = DEFAULT_FIXED_CT,
): number {
  if (scheme === "fixed") return fixedCt;
  const net = scheme === "dynamic14a" ? modul3NetzentgeltCt(city, stepIndex) : NET_ENTGELT_CT[city];
  const adders = STROMSTEUER_CT + KONZESSION_CT + MESSUNG_CT + MARGIN_CT;
  return spotCt + net + adders;
}

/** Full import-price array (ct/kWh) for a whole year of spot prices. */
export function importPriceArray(
  scheme: TariffScheme,
  city: City,
  spotEURperMWh: Float64Array,
  fixedCt: number = DEFAULT_FIXED_CT,
): Float64Array {
  const out = new Float64Array(spotEURperMWh.length);
  for (let i = 0; i < out.length; i++) {
    const spotCt = spotEURperMWh[i] * 0.1; // EUR/MWh -> ct/kWh
    out[i] = importPriceCtPerKWh(scheme, city, spotCt, i, fixedCt);
  }
  return out;
}
