// The scheme-comparison chart: re-price the *same* simulated dispatch under
// every export/import combination in the market catalogue.

import { SimResult } from "./types";
import { computeEconomics } from "./revenue";
import { cityForLocation, importPriceArray } from "./tariff";
import { getYearPrices } from "./priceData";
import { SCENARIO_VARIANTS } from "./markets";
import type { ScenarioDatum } from "./reportModel";
import type { SimParams } from "./simParams";

export function scenarioVariants(
  result: SimResult,
  base: SimParams,
  city: ReturnType<typeof cityForLocation>,
  prices: ReturnType<typeof getYearPrices>,
): ScenarioDatum[] {
  const imp = importPriceArray(base.importScheme, city, prices, base.importFixedCt);
  return SCENARIO_VARIANTS.map((v) => {
    const econ = computeEconomics(result, {
      commissioningYear: base.commissioningYear,
      peakKWp: base.peakKWp,
      exportScheme: v.exportScheme,
      feedInCt: base.feedInCt,
      importScheme: v.importScheme,
      importCity: city,
      importFixedCt: base.importFixedCt,
      marketMarginCt: base.marketMarginCt,
    });
    const exportEUR = v.exportScheme === "market" ? econ.exportRevenueMarketEUR : econ.exportRevenueFixedEUR;
    let importEUR = 0;
    for (let i = 0; i < result.load.length; i++) importEUR += (result.gridImport[i] * imp[i]) / 100;
    return {
      label: v.label,
      netEUR: exportEUR - importEUR,
      exportEUR,
      importEUR,
    };
  });
}
