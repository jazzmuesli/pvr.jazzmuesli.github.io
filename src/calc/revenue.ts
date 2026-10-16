// Economics: revenue from exported electricity and cost of imported electricity,
// under the two axes the user wants to compare:
//   Export: feste Einspeisevergütung  vs  Direktvermarktung (spot + Marktprämie)
//   Import: feste Stromtarife          vs  dynamic (Tibber)  vs  dynamic + §14a/3
//
// Self-consumed PV (covers the local load) is not exported, so it earns no
// export revenue — instead it avoids import cost, already reflected in the
// grid-import accounting below.

import { SimResult, monthOfStep } from "./types";
import { importPriceCtPerKWh, TariffScheme, City } from "./tariff";

const EEG_ANZULEGENDER: Record<number, { le10: number; ge10le40: number; gt40: number }> = {
  2023: { le10: 8.6, ge10le40: 7.5, gt40: 6.2 },
  2024: { le10: 8.51, ge10le40: 7.43, gt40: 6.14 },
  2025: { le10: 8.34, ge10le40: 7.27, gt40: 6.03 },
  2026: { le10: 8.18, ge10le40: 7.13, gt40: 5.9 },
};
const FESTER_SPREAD = 0.4;

function blendedRate(r: { le10: number; ge10le40: number; gt40: number }, peakKWp: number): number {
  if (peakKWp <= 0) return r.le10; // fallback for wind-only (no PV kWp)
  let remaining = peakKWp;
  let val = 0;
  if (remaining > 0) { const a = Math.min(remaining, 10); val += a * r.le10; remaining -= a; }
  if (remaining > 0) { const a = Math.min(remaining, 30); val += a * r.ge10le40; remaining -= a; }
  if (remaining > 0) val += remaining * r.gt40;
  return val / peakKWp;
}

export function referenceValueCt(year: number, peakKWp: number): number {
  const t = EEG_ANZULEGENDER[year] ?? EEG_ANZULEGENDER[2025];
  return blendedRate(t, peakKWp);
}
export function feedInTariffCt(year: number, peakKWp: number): number {
  return referenceValueCt(year, peakKWp) - FESTER_SPREAD;
}
export function monthForStep(i: number): number { return monthOfStep(i); }

export interface EconOptions {
  commissioningYear: number;
  peakKWp: number;
  exportScheme: "fixed" | "market";
  feedInCt: number;
  importScheme: TariffScheme;
  importCity: City;
  importFixedCt: number;
  /** Direktvermarkter-Marge in ct/kWh, only applied when exportScheme === "market". */
  marketMarginCt?: number;
}

export interface MonthlyEcon {
  month: number; pvKWh: number; windKWh: number; loadKWh: number; selfConsumptionKWh: number;
  importKWh: number; gridChargedKWh: number; loadImportKWh: number; exportKWh: number; marketValueEUR: number; premiumEUR: number;
  exportRevenueMarketEUR: number; exportRevenueFixedEUR: number;
  importCostFixedEUR: number; importCostDynamicEUR: number; importCost14aEUR: number; netSelectedEUR: number;
}
export interface EconomicsSummary {
  totalPVKWh: number; totalLoadKWh: number; selfConsumptionKWh: number;
  totalExportKWh: number; totalImportKWh: number; totalChargeGridKWh: number; totalLoadImportKWh: number;
  exportRevenueMarketEUR: number; exportRevenueFixedEUR: number; premiumEUR: number;
  referenceValueCt: number; marktPraemieCt: number;
  importCostFixedEUR: number; importCostDynamicEUR: number; importCost14aEUR: number;
  netSelectedEUR: number; monthly: MonthlyEcon[];
}

export function computeEconomics(result: SimResult, opts: EconOptions): EconomicsSummary {
  const n = result.pv.length;
  const refCt = referenceValueCt(opts.commissioningYear, opts.peakKWp);
  const spotCt = (i: number) => result.price[i] * 0.1;

  const monthly: MonthlyEcon[] = [];
  for (let m = 1; m <= 12; m++) monthly.push({
    month: m, pvKWh: 0, windKWh: 0, loadKWh: 0, selfConsumptionKWh: 0, importKWh: 0, gridChargedKWh: 0, loadImportKWh: 0, exportKWh: 0,
    marketValueEUR: 0, premiumEUR: 0, exportRevenueMarketEUR: 0, exportRevenueFixedEUR: 0,
    importCostFixedEUR: 0, importCostDynamicEUR: 0, importCost14aEUR: 0, netSelectedEUR: 0,
    pvMarketValueEUR: 0,
  } as MonthlyEcon & { pvMarketValueEUR: number });

  let totalPV = 0, totalLoad = 0, selfConsumption = 0, totalExport = 0, totalImport = 0, totalChargeGrid = 0;
  let totalLoadImport = 0;
  let marketValue = 0, premiumTotal = 0, exportRevFixed = 0, pvMarketValueTotal = 0;
  let importCostFixed = 0, importCostDynamic = 0, importCost14a = 0;

  for (let i = 0; i < n; i++) {
    const row = monthly[monthForStep(i) - 1];
    const exp = result.exportTotal[i];
    const imp = result.gridImport[i];
    const sc = result.directUse[i] + result.directUseWind[i] + result.dischargeToLoadPV[i] + result.dischargeToLoadWind[i];

    totalPV += result.pv[i]; totalLoad += result.load[i]; selfConsumption += sc;
    totalExport += exp; totalImport += imp; totalChargeGrid += result.chargeGrid[i];
    totalLoadImport += imp - result.chargeGrid[i] + result.dischargeToLoadGrid[i];

    const stepMarket = (exp * result.price[i]) / 1000;
    const stepFixed = exp * (opts.feedInCt / 100);
    marketValue += stepMarket; exportRevFixed += stepFixed;
    // Value of *generated* PV at the spot price — used to derive the monthly
    // solar market value (Monatsmarktwert Solar), the EEG reference for the
    // Marktprämie. This is fleet-wide by definition, so it is based on
    // production, NOT on this plant's (battery-shifted) export timing.
    pvMarketValueTotal += (result.pv[i] * result.price[i]) / 1000;
    (row as MonthlyEcon & { pvMarketValueEUR: number }).pvMarketValueEUR += (result.pv[i] * result.price[i]) / 1000;

    const ipFixed = opts.importFixedCt / 100;
    const ipDyn = importPriceCtPerKWh("dynamic", opts.importCity, spotCt(i), i, opts.importFixedCt) / 100;
    const ip14 = importPriceCtPerKWh("dynamic14a", opts.importCity, spotCt(i), i, opts.importFixedCt) / 100;
    const sImpF = imp * ipFixed, sImpD = imp * ipDyn, sImp14 = imp * ip14;
    importCostFixed += sImpF; importCostDynamic += sImpD; importCost14a += sImp14;

    row.pvKWh += result.pv[i]; row.windKWh += result.wind[i]; row.loadKWh += result.load[i]; row.selfConsumptionKWh += sc;
    row.importKWh += imp; row.gridChargedKWh += result.chargeGrid[i];
    // Import that actually served a load: metered import, minus what went
    // straight into storage, plus what came back out of storage to serve one.
    row.loadImportKWh += imp - result.chargeGrid[i] + result.dischargeToLoadGrid[i];
    row.exportKWh += exp; row.marketValueEUR += stepMarket;
    row.exportRevenueFixedEUR += stepFixed; row.importCostFixedEUR += sImpF;
    row.importCostDynamicEUR += sImpD; row.importCost14aEUR += sImp14;
  }

  for (const row of monthly) {
    // EEG Marktprämie (§ 23a EEG 2023): MP = max(0, anzulegender Wert −
    // Monatsmarktwert Solar). The Monatsmarktwert is the *fleet-wide* monthly
    // market value of solar generation (production-weighted spot average), the
    // SAME reference for every plant — it does NOT depend on how this plant
    // times its exports. We approximate it by the PV-production-weighted spot
    // average for the month. This correctly lets a battery that shifts exports
    // into high-price windows keep its higher captured spot price on top of the
    // (unchanged) premium, instead of having the premium eaten away.
    const pvMv = (row as MonthlyEcon & { pvMarketValueEUR: number }).pvMarketValueEUR;
    let marktPraemieCt = 0;
    if (row.pvKWh > 0) {
      const mwSolarCt = (pvMv / row.pvKWh) * 1000 * 0.1; // EUR/kWh → ct/kWh
      marktPraemieCt = Math.max(0, refCt - mwSolarCt);
    }
    row.premiumEUR = (row.exportKWh * marktPraemieCt) / 100;
    premiumTotal += row.premiumEUR;
    row.exportRevenueMarketEUR = row.marketValueEUR + row.premiumEUR;
    // Apply Direktvermarkter-Marge (only for market export scheme).
    if (opts.exportScheme === "market" && (opts.marketMarginCt ?? 0) > 0) {
      const marginEUR = (row.exportKWh * (opts.marketMarginCt ?? 0)) / 100;
      row.exportRevenueMarketEUR -= marginEUR;
    }
    const selCost = opts.importScheme === "fixed" ? row.importCostFixedEUR
      : opts.importScheme === "dynamic" ? row.importCostDynamicEUR : row.importCost14aEUR;
    const selExport = opts.exportScheme === "fixed" ? row.exportRevenueFixedEUR : row.exportRevenueMarketEUR;
    row.netSelectedEUR = selExport - selCost;
  }

  const exportRevMarketGross = marketValue + premiumTotal;
  // Apply Direktvermarkter-Marge to the annual market export revenue.
  const annualMarginEUR = opts.exportScheme === "market" ? (totalExport * (opts.marketMarginCt ?? 0)) / 100 : 0;
  const exportRevMarket = exportRevMarketGross - annualMarginEUR;
  const netSelected = (opts.exportScheme === "market" ? exportRevMarket : exportRevFixed) -
    (opts.importScheme === "fixed" ? importCostFixed
      : opts.importScheme === "dynamic" ? importCostDynamic : importCost14a);
  // Reported blended Marktprämie: based on the annual PV-production-weighted
  // solar market value (Monatsmarktwert-Äquivalent), consistent with the
  // monthly premium above.
  const mwSolarAnnualCt = totalPV > 0 ? (pvMarketValueTotal / totalPV) * 1000 * 0.1 : 0;
  const marktPraemieCt = Math.max(0, refCt - mwSolarAnnualCt);

  return {
    totalPVKWh: totalPV, totalLoadKWh: totalLoad, selfConsumptionKWh: selfConsumption,
    totalExportKWh: totalExport, totalImportKWh: totalImport, totalChargeGridKWh: totalChargeGrid,
    totalLoadImportKWh: totalLoadImport,
    exportRevenueMarketEUR: exportRevMarket, exportRevenueFixedEUR: exportRevFixed, premiumEUR: premiumTotal,
    referenceValueCt: refCt, marktPraemieCt,
    importCostFixedEUR: importCostFixed, importCostDynamicEUR: importCostDynamic, importCost14aEUR: importCost14a,
    netSelectedEUR: netSelected, monthly,
  };
}
