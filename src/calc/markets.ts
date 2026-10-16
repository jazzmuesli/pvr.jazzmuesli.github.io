/**
 * Markets: how electricity is bought and sold, as data rather than as
 * `if`/`switch` chains.
 *
 * Adding a fourth import scheme (a Tibber-like product, a § 14a variant, a
 * heat-pump tariff, an hourly PPA) used to mean editing every ternary chain in
 * the codebase. There were ten of them, plus three parallel fields on
 * `EconomicsSummary` (`importCostFixedEUR` / `importCostDynamicEUR` /
 * `importCost14aEUR`) that every consumer had to know about by name.
 *
 * That structure is exactly how the scenario-comparison chart came to be
 * wrong: `scenarioVariants` priced all four of its rows with the *base* import
 * scheme because there was no table to index into, only a chain to copy. With a
 * table, a new scheme is one row and every consumer picks it up for free.
 */

import type { City } from "./tariff";
import { importPriceArray } from "./tariff";

export type ImportScheme = "fixed" | "dynamic" | "dynamic14a";
export type ExportScheme = "fixed" | "market";

export const IMPORT_SCHEMES: readonly ImportScheme[] = ["fixed", "dynamic", "dynamic14a"];
export const EXPORT_SCHEMES: readonly ExportScheme[] = ["fixed", "market"];

export interface MarketDef {
  key: string;
  /** Stable i18n key; the display label never lives in the domain. */
  labelKey: string;
}

/**
 * Import schemes, in presentation order. The per-step price of each is a
 * function of (spot price, step index, city, fixed tariff), so a scheme only
 * ever needs its price rule — never a new branch anywhere else.
 */
export const IMPORT_MARKETS: readonly MarketDef[] = [
  { key: "fixed", labelKey: "import.label_fixed" },
  { key: "dynamic", labelKey: "import.label_dynamic" },
  { key: "dynamic14a", labelKey: "import.label_14a" },
];

export const EXPORT_MARKETS: readonly MarketDef[] = [
  { key: "fixed", labelKey: "export.label_fixed" },
  { key: "market", labelKey: "export.label_market" },
];

export function isImportScheme(v: string): v is ImportScheme {
  return (IMPORT_SCHEMES as readonly string[]).includes(v);
}
export function isExportScheme(v: string): v is ExportScheme {
  return (EXPORT_SCHEMES as readonly string[]).includes(v);
}

/** Cost of the imported energy under every import scheme, in one pass. */
export function importCostByScheme(
  gridImport: Float64Array,
  price: Float64Array,
  city: City,
  fixedCt: number,
): Record<ImportScheme, number> {
  const costs: Record<ImportScheme, number> = { fixed: 0, dynamic: 0, dynamic14a: 0 };
  const prices: Record<ImportScheme, Float64Array> = {
    fixed: importPriceArray("fixed", city, price, fixedCt),
    dynamic: importPriceArray("dynamic", city, price, fixedCt),
    dynamic14a: importPriceArray("dynamic14a", city, price, fixedCt),
  };
  for (let i = 0; i < gridImport.length; i++) {
    costs.fixed += (gridImport[i] * prices.fixed[i]) / 100;
    costs.dynamic += (gridImport[i] * prices.dynamic[i]) / 100;
    costs.dynamic14a += (gridImport[i] * prices.dynamic14a[i]) / 100;
  }
  return costs;
}

/** Pick the cost for one scheme out of the table produced above. */
export function importCostFor(
  costs: Record<ImportScheme, number>,
  scheme: ImportScheme,
): number {
  return costs[scheme];
}

/** Every (export, import) pair the report compares. Derived, not written. */
export interface TariffCombination {
  key: string;
  exportScheme: ExportScheme;
  importScheme: ImportScheme;
}

export const TARIFF_COMBINATIONS: readonly TariffCombination[] = [
  { key: "fixed_fixed", exportScheme: "fixed", importScheme: "fixed" },
  { key: "market_fixed", exportScheme: "market", importScheme: "fixed" },
  { key: "market_dynamic", exportScheme: "market", importScheme: "dynamic" },
  { key: "market_dynamic14a", exportScheme: "market", importScheme: "dynamic14a" },
];

/**
 * The four scenario-chart rows. Also derived from the scheme lists, so a new
 * scheme shows up here without anyone remembering to add a bar.
 */
export const SCENARIO_VARIANTS: readonly TariffCombination[] = [
  { key: "fixed_fixed", exportScheme: "fixed", importScheme: "fixed" },
  { key: "market_fixed", exportScheme: "market", importScheme: "fixed" },
  { key: "fixed_dynamic", exportScheme: "fixed", importScheme: "dynamic" },
  { key: "fixed_dynamic14a", exportScheme: "fixed", importScheme: "dynamic14a" },
];