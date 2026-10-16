// Tariff combinations over historical price years.
//
// For each combination of export/import scheme in the market catalogue the
// import cost, export revenue and net balance are recomputed for every
// historical price year by re-running the full dispatch with that year's spot
// prices (the battery's strategic discharge and the volumes depend on prices).

import { simulate } from "./simulation";
import { computeEconomics, EconOptions } from "./revenue";
import { getYearPrices, PRICE_YEARS } from "./priceData";
import { cityForLocation } from "./tariff";
import { toSimConfig } from "./simConfig";
import { round2 } from "./util";
import { TARIFF_COMBOS } from "./markets";
import type { TariffCombinationReport } from "./reportModel";
import type { SimParams } from "./simParams";

export function computeTariffCombinations(p: SimParams): TariffCombinationReport {
  const city = cityForLocation(p.location);
  const econOpts: EconOptions = {
    commissioningYear: p.commissioningYear,
    peakKWp: p.peakKWp,
    exportScheme: "market",
    feedInCt: p.feedInCt,
    importScheme: "fixed",
    importCity: city,
    importFixedCt: p.importFixedCt,
    marketMarginCt: p.marketMarginCt,
  };
  // One full dispatch per historical price year (volumes + cost differ by year).
  const yearRuns = PRICE_YEARS.map((year) => {
    const cfg = toSimConfig(p);
    cfg.prices = getYearPrices(year);
    const result = simulate(cfg);
    const econ = computeEconomics(result, econOpts);
    return {
      year,
      exportKWh: econ.totalExportKWh,
      importKWh: econ.totalImportKWh,
      exportRevFixed: econ.exportRevenueFixedEUR,
      exportRevMarket: econ.exportRevenueMarketEUR,
      importFixed: econ.importCostFixedEUR,
      importDynamic: econ.importCostDynamicEUR,
      import14a: econ.importCost14aEUR,
    };
  });
  const combinations = TARIFF_COMBOS.map((c) => {
    const years = yearRuns.map((r) => {
      const exportEUR = c.exportScheme === "market" ? r.exportRevMarket : r.exportRevFixed;
      const importEUR =
        c.importScheme === "fixed" ? r.importFixed
        : c.importScheme === "dynamic" ? r.importDynamic
        : r.import14a;
      return {
        year: r.year,
        exportEUR: round2(exportEUR),
        importEUR: round2(importEUR),
        netEUR: round2(exportEUR - importEUR),
        exportKWh: r.exportKWh,
        importKWh: r.importKWh,
      };
    });
    return { ...c, years };
  });
  return { years: PRICE_YEARS, combinations };
}
