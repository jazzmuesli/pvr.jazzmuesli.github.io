// The market catalogue: which import and export schemes the app knows about,
// how they are labelled, and the comparison matrices the report renders.
//
// The pricing *mechanics* live in `tariff.ts` / `revenue.ts`; this module is the
// single place that enumerates the markets themselves. Previously the scheme
// lists were duplicated across `report.ts` (scenario variants + tariff combos),
// `revenue.ts` (which cost/revenue columns exist) and the UI dropdowns, so a new
// market meant hunting for every list. Registering a scheme here makes it
// discoverable in one place.

import { TariffScheme } from "./tariff";

/** Export market: fixed feed-in tariff vs. direct marketing (Marktprämie). */
export type ExportScheme = "fixed" | "market";
/** Import market: kept as an alias so callers read intent, not the pricing type. */
export type ImportScheme = TariffScheme;

export interface SchemeSpec<T extends string> {
  id: T;
  /** Human-readable (German) label shown in tables and charts. */
  label: string;
  /** Short label for compact UI (dropdowns, legends). */
  shortLabel: string;
}

export const EXPORT_SCHEMES: SchemeSpec<ExportScheme>[] = [
  { id: "fixed", label: "Feste Einspeisung (§ 14a/2)", shortLabel: "Feste Einspeisung" },
  { id: "market", label: "Direktvermarktung (Marktprämie)", shortLabel: "Direktvermarktung" },
];

export const IMPORT_SCHEMES: SchemeSpec<ImportScheme>[] = [
  { id: "fixed", label: "Fester Bezug", shortLabel: "Fest" },
  { id: "dynamic", label: "Dynamischer Bezug (spotbasiert)", shortLabel: "Dynamisch" },
  { id: "dynamic14a", label: "Dynamisch + § 14a/3", shortLabel: "Dynamisch §14a" },
];

/**
 * One row of a scheme comparison: a label plus the coupling of an export and an
 * import scheme. Both the scenario bar chart and the tariff-combination table
 * are expressed as lists of these, so they stay in lock-step.
 */
export interface SchemeVariant {
  label: string;
  exportScheme: ExportScheme;
  importScheme: ImportScheme;
}

/** The four variants shown in the "Vergleich der Abrechnungsschemen" chart. */
export const SCENARIO_VARIANTS: SchemeVariant[] = [
  { label: "Feste Einspeisung (§ 14a/2)", exportScheme: "fixed", importScheme: "fixed" },
  { label: "Direktvermarktung (Marktprämie)", exportScheme: "market", importScheme: "fixed" },
  { label: "Dynamischer Bezug (spotbasiert)", exportScheme: "fixed", importScheme: "dynamic" },
  { label: "Dynamisch + § 14a/3", exportScheme: "fixed", importScheme: "dynamic14a" },
];

/**
 * The comparison table of export/import combinations, each re-priced for every
 * historical spot-price year. Two of them are Direktvermarktung (market) export;
 * the others use the fixed feed-in tariff.
 */
export interface SchemeCombo extends SchemeVariant {
  /** Stable key used by the UI to address the row. */
  key: string;
}

export const TARIFF_COMBOS: SchemeCombo[] = [
  { key: "fixed_fixed", label: "Feste Einspeisung & fester Bezug", exportScheme: "fixed", importScheme: "fixed" },
  { key: "market_fixed", label: "Direktvermarktung & fester Bezug", exportScheme: "market", importScheme: "fixed" },
  { key: "market_dynamic", label: "Direktvermarktung & dynamischer Bezug (Tibber)", exportScheme: "market", importScheme: "dynamic" },
  { key: "market_dynamic14a", label: "Direktvermarktung & dynamisch + §14a/3", exportScheme: "market", importScheme: "dynamic14a" },
];
