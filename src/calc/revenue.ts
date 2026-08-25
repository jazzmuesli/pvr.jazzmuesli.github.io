// Economics: revenue from exported electricity and cost of imported electricity,
// under the two axes the user wants to compare:
//   Export: feste Einspeisevergütung  vs  Direktvermarktung (spot + Marktprämie)
//   Import: feste Stromtarife          vs  dynamic (Tibber)  vs  dynamic + §14a/3
//
// Self-consumed PV (covers the local load) is not exported, so it earns no
// export revenue — instead it avoids import cost, already reflected in the
// grid-import accounting below.

import { STEPS_PER_DAY, SimResult, monthOfStep, RevenueSummary } from "./types";
import { SIM_YEAR } from "./types";
import { importPriceCtPerKWh, TariffScheme, City } from "./tariff";

const DAYS = 365;
const dayMonth = new Array<number>(DAYS);
{
  const base = new Date(Date.UTC(SIM_YEAR, 0, 1));
  for (let d = 0; d < DAYS; d++) {
    const dt = new Date(base.getTime() + d * 86400000);
    dayMonth[d] = dt.getUTCMonth() + 1;
  }
}

const EEG_ANZULEGENDER: Record<number, { le10: number; ge10le40: number; gt40: number }> = {
  2023: { le10: 8.6, ge10le40: 7.5, gt40: 6.2 },
  2024: { le10: 8.51, ge10le40: 7.43, gt40: 6.14 },
  2025: { le10: 8.34, ge10le40: 7.27, gt40: 6.03 },
  2026: { le10: 8.18, ge10le40: 7.13, gt40: 5.9 },
};
const FESTER_SPREAD = 0.4;

function blendedRate(r: { le10: number; ge10le40: number; gt40: number }, peakKWp: number): number {
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
}

export interface MonthlyEcon {
  month: number; pvKWh: number; loadKWh: number; selfConsumptionKWh: number;
  importKWh: number; exportKWh: number; marketValueEUR: number; premiumEUR: number;
  exportRevenueMarketEUR: number; exportRevenueFixedEUR: number;
  importCostFixedEUR: number; importCostDynamicEUR: number; importCost14aEUR: number; netSelectedEUR: number;
}
export interface TypicalDayPoint {
  month: number; hour: number; pvKWh: number; loadKWh: number; selfUseKWh: number; importKWh: number; exportKWh: number;
}
export interface EconomicsSummary {
  totalPVKWh: number; totalLoadKWh: number; selfConsumptionKWh: number;
  totalExportKWh: number; totalImportKWh: number;
  exportRevenueMarketEUR: number; exportRevenueFixedEUR: number; premiumEUR: number;
  referenceValueCt: number; marktPraemieCt: number;
  importCostFixedEUR: number; importCostDynamicEUR: number; importCost14aEUR: number;
  netSelectedEUR: number; monthly: MonthlyEcon[]; typicalDay: TypicalDayPoint[];
}

export function computeEconomics(result: SimResult, opts: EconOptions): EconomicsSummary {
  const n = result.pv.length;
  const refCt = referenceValueCt(opts.commissioningYear, opts.peakKWp);
  const spotCt = (i: number) => result.price[i] * 0.1;

  const monthly: MonthlyEcon[] = [];
  for (let m = 1; m <= 12; m++) monthly.push({
    month: m, pvKWh: 0, loadKWh: 0, selfConsumptionKWh: 0, importKWh: 0, exportKWh: 0,
    marketValueEUR: 0, premiumEUR: 0, exportRevenueMarketEUR: 0, exportRevenueFixedEUR: 0,
    importCostFixedEUR: 0, importCostDynamicEUR: 0, importCost14aEUR: 0, netSelectedEUR: 0,
  });

  let totalPV = 0, totalLoad = 0, selfConsumption = 0, totalExport = 0, totalImport = 0;
  let marketValue = 0, premiumTotal = 0, exportRevFixed = 0;
  let importCostFixed = 0, importCostDynamic = 0, importCost14a = 0;

  for (let i = 0; i < n; i++) {
    const row = monthly[monthForStep(i) - 1];
    const exp = result.exportTotal[i];
    const imp = result.gridImport[i];
    const sc = result.directUse[i] + result.dischargeToLoad[i];

    totalPV += result.pv[i]; totalLoad += result.load[i]; selfConsumption += sc;
    totalExport += exp; totalImport += imp;

    const stepMarket = (exp * result.price[i]) / 1000;
    const stepFixed = exp * (opts.feedInCt / 100);
    marketValue += stepMarket; exportRevFixed += stepFixed;

    const ipFixed = opts.importFixedCt / 100;
    const ipDyn = importPriceCtPerKWh("dynamic", opts.importCity, spotCt(i), i, opts.importFixedCt) / 100;
    const ip14 = importPriceCtPerKWh("dynamic14a", opts.importCity, spotCt(i), i, opts.importFixedCt) / 100;
    const sImpF = imp * ipFixed, sImpD = imp * ipDyn, sImp14 = imp * ip14;
    importCostFixed += sImpF; importCostDynamic += sImpD; importCost14a += sImp14;

    row.pvKWh += result.pv[i]; row.loadKWh += result.load[i]; row.selfConsumptionKWh += sc;
    row.importKWh += imp; row.exportKWh += exp; row.marketValueEUR += stepMarket;
    row.exportRevenueFixedEUR += stepFixed; row.importCostFixedEUR += sImpF;
    row.importCostDynamicEUR += sImpD; row.importCost14aEUR += sImp14;
  }

  for (const row of monthly) {
    let marktPraemieCt = 0;
    if (row.exportKWh > 0) {
      const vwapCt = (row.marketValueEUR / row.exportKWh) * 1000 * 0.1;
      marktPraemieCt = Math.max(0, refCt - vwapCt);
    }
    row.premiumEUR = (row.exportKWh * marktPraemieCt) / 100;
    premiumTotal += row.premiumEUR;
    row.exportRevenueMarketEUR = row.marketValueEUR + row.premiumEUR;
    const selCost = opts.importScheme === "fixed" ? row.importCostFixedEUR
      : opts.importScheme === "dynamic" ? row.importCostDynamicEUR : row.importCost14aEUR;
    row.netSelectedEUR = row.exportRevenueMarketEUR - selCost;
  }

  const exportRevMarket = marketValue + premiumTotal;
  const netSelected = (opts.exportScheme === "market" ? exportRevMarket : exportRevFixed) -
    (opts.importScheme === "fixed" ? importCostFixed
      : opts.importScheme === "dynamic" ? importCostDynamic : importCost14a);

  const vwap = totalExport > 0 ? (marketValue / totalExport) * 1000 : 0;
  const marktPraemieCt = Math.max(0, refCt - vwap * 0.1);

  const typicalDay: TypicalDayPoint[] = [];
  const acc = new Map<string, { pv: number; load: number; sc: number; imp: number; exp: number }>();
  for (let i = 0; i < n; i++) {
    const m = monthForStep(i);
    const h = Math.floor((i % STEPS_PER_DAY) / (STEPS_PER_DAY / 24));
    const key = `${m}-${h}`;
    const a = acc.get(key) ?? { pv: 0, load: 0, sc: 0, imp: 0, exp: 0 };
    a.pv += result.pv[i]; a.load += result.load[i]; a.sc += result.directUse[i] + result.dischargeToLoad[i];
    a.imp += result.gridImport[i]; a.exp += result.exportTotal[i];
    acc.set(key, a);
  }
  for (let m = 1; m <= 12; m++) {
    const days = new Date(SIM_YEAR, m, 0).getDate();
    for (let h = 0; h < 24; h++) {
      const a = acc.get(`${m}-${h}`) ?? { pv: 0, load: 0, sc: 0, imp: 0, exp: 0 };
      typicalDay.push({
        month: m, hour: h, pvKWh: a.pv / days, loadKWh: a.load / days,
        selfUseKWh: a.sc / days, importKWh: a.imp / days, exportKWh: a.exp / days,
      });
    }
  }

  return {
    totalPVKWh: totalPV, totalLoadKWh: totalLoad, selfConsumptionKWh: selfConsumption,
    totalExportKWh: totalExport, totalImportKWh: totalImport,
    exportRevenueMarketEUR: exportRevMarket, exportRevenueFixedEUR: exportRevFixed, premiumEUR: premiumTotal,
    referenceValueCt: refCt, marktPraemieCt,
    importCostFixedEUR: importCostFixed, importCostDynamicEUR: importCostDynamic, importCost14aEUR: importCost14a,
    netSelectedEUR: netSelected, monthly, typicalDay,
  };
}

// ---------------------------------------------------------------------------
// Legacy export-only comparison (kept for the existing domain tests). Computes
// the Direktvermarktung (spot + Marktprämie) vs feste Einspeisevergütung value
// of the exported energy.
// ---------------------------------------------------------------------------
export function computeRevenue(result: SimResult, tariff: { feedInEUR: number; commissioningYear: number }, peakKWp: number): RevenueSummary {
  const refCt = referenceValueCt(tariff.commissioningYear, peakKWp);
  const monthly: RevenueSummary["monthly"] = [];
  for (let m = 1; m <= 12; m++) {
    monthly.push({
      month: m, pvKWh: 0, exportSolarKWh: 0, exportBatteryKWh: 0, chargeSolarKWh: 0, chargeGridKWh: 0,
      exportKWh: 0, marketValueEUR: 0, gridChargeCostEUR: 0, fixedValueEUR: 0, premiumEUR: 0,
    });
  }
  let totalPV = 0, totalExport = 0, totalChargeGrid = 0, marketValue = 0, gridCost = 0, premiumTotal = 0;
  for (let i = 0; i < result.exportTotal.length; i++) {
    const m = monthForStep(i) - 1;
    const exp = result.exportTotal[i];
    const row = monthly[m];
    totalPV += result.pv[i]; totalExport += exp; totalChargeGrid += result.chargeGrid[i];
    const stepValue = (exp * result.price[i]) / 1000;
    const stepCost = (result.chargeGrid[i] * result.price[i]) / 1000;
    marketValue += stepValue; gridCost += stepCost;
    row.pvKWh += result.pv[i]; row.exportSolarKWh += result.exportSolar[i];
    row.exportBatteryKWh += result.exportBattery[i]; row.chargeSolarKWh += result.chargeSolar[i];
    row.chargeGridKWh += result.chargeGrid[i]; row.exportKWh += exp;
    row.marketValueEUR += stepValue; row.gridChargeCostEUR += stepCost;
    row.fixedValueEUR += exp * tariff.feedInEUR;
  }
  for (const row of monthly) {
    let marktPraemieCt = 0;
    if (row.exportKWh > 0) {
      const vwapCt = (row.marketValueEUR / row.exportKWh) * 1000 * 0.1;
      marktPraemieCt = Math.max(0, refCt - vwapCt);
    }
    row.premiumEUR = (row.exportKWh * marktPraemieCt) / 100;
    premiumTotal += row.premiumEUR;
  }
  const vwap = totalExport > 0 ? (marketValue / totalExport) * 1000 : 0;
  const vwapCt = vwap * 0.1;
  const marktPraemieCt = Math.max(0, refCt - vwapCt);
  const netMarket = marketValue + premiumTotal - gridCost;
  const fixedValue = totalExport * tariff.feedInEUR;
  return {
    totalPVKWh: totalPV, totalExportKWh: totalExport, totalChargeGridKWh: totalChargeGrid,
    marketValueEUR: marketValue, gridChargeCostEUR: gridCost, premiumEUR: premiumTotal,
    referenceValueCt: refCt, marktPraemieCt, netMarketEUR: netMarket,
    fixedValueEUR: fixedValue, deltaEUR: netMarket - fixedValue,
    vwapMarketEURperMWh: vwap, monthly,
  };
}
