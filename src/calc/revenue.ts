// Revenue computation and tariff comparison, including the EEG Marktprämie.
//
// Under German EEG "Direktvermarktung" the operator receives the spot price
// plus a sliding market premium (Marktprämie). The premium is set so that, on
// average, the operator earns the law-defined reference value (anzulegender
// Wert) for their system size and commissioning year:
//
//   Marktprämie = max(0, anzulegender Wert − erzielter Marktwert)
//
// i.e. the premium depends on the price actually achieved (the user's hunch
// was right). The operator therefore always earns at least the reference value
// and keeps any upside when spot prices exceed it.

import { STEPS_PER_DAY, SimResult, TariffConfig, MonthlyRow, RevenueSummary } from "./types";
import { SIM_YEAR } from "./types";

const DAYS = 365;
const dayMonth = new Array<number>(DAYS);
{
  const base = new Date(Date.UTC(SIM_YEAR, 0, 1));
  for (let d = 0; d < DAYS; d++) {
    const dt = new Date(base.getTime() + d * 86400000);
    dayMonth[d] = dt.getUTCMonth() + 1;
  }
}

// EEG 2023 "anzulegender Wert" (Teileinspeisung / Überschuss), in ct/kWh,
// gültig im Juni des jeweiligen Inbetriebnahmejahres.
//  - 2023: keine Degression (EEG-Novelle), Wert konstant über das Jahr.
//  - ab 1.2.2024: halbjährliche Degression −1 % (je 1.2. und 1.8.).
//  - Der feste Vergütungssatz (Einspeisung ohne Direktvermarktung) ist der
//    anzulegende Wert abzüglich 0,4 ct/kWh (§ 53 EEG).
// Quelle: Bundesnetzagentur / BSW-Übersicht "Vergütungen für PV nach EEG 2023".
const EEG_ANZULEGENDER: Record<number, { le10: number; ge10le40: number; gt40: number }> = {
  2023: { le10: 8.60, ge10le40: 7.50, gt40: 6.20 },
  2024: { le10: 8.51, ge10le40: 7.43, gt40: 6.14 },
  2025: { le10: 8.34, ge10le40: 7.27, gt40: 6.03 },
  2026: { le10: 8.18, ge10le40: 7.13, gt40: 5.90 },
};

/** Abzug für den festen Vergütungssatz gegenüber dem anzulegenden Wert (§ 53 EEG). */
const FESTER_SPREAD = 0.4;

function blendedRate(r: { le10: number; ge10le40: number; gt40: number }, peakKWp: number): number {
  let remaining = peakKWp;
  let val = 0;
  if (remaining > 0) {
    const a = Math.min(remaining, 10);
    val += a * r.le10;
    remaining -= a;
  }
  if (remaining > 0) {
    const a = Math.min(remaining, 30);
    val += a * r.ge10le40;
    remaining -= a;
  }
  if (remaining > 0) {
    val += remaining * r.gt40;
  }
  return val / peakKWp;
}

/** EEG-Referenzwert (anzulegender Wert) in ct/kWh – die Untergrenze, die die
 *  Marktprämie zum Ausgleich des Marktwerts garantiert. */
export function referenceValueCt(year: number, peakKWp: number): number {
  const t = EEG_ANZULEGENDER[year] ?? EEG_ANZULEGENDER[2025];
  return blendedRate(t, peakKWp);
}

/** Fester Einspeisevergütungssatz (ct/kWh) für Anlagen ohne Direktvermarktung. */
export function feedInTariffCt(year: number, peakKWp: number): number {
  return referenceValueCt(year, peakKWp) - FESTER_SPREAD;
}

export function monthForStep(i: number): number {
  return dayMonth[Math.floor(i / STEPS_PER_DAY)];
}

export function computeRevenue(result: SimResult, tariff: TariffConfig, peakKWp: number): RevenueSummary {
  const n = result.exportTotal.length;
  const refCt = referenceValueCt(tariff.commissioningYear, peakKWp);

  const monthly: MonthlyRow[] = [];
  for (let m = 1; m <= 12; m++) {
    monthly.push({
      month: m,
      pvKWh: 0,
      exportSolarKWh: 0,
      exportBatteryKWh: 0,
      chargeSolarKWh: 0,
      chargeGridKWh: 0,
      exportKWh: 0,
      marketValueEUR: 0,
      gridChargeCostEUR: 0,
      fixedValueEUR: 0,
      premiumEUR: 0,
    });
  }

  let totalPV = 0;
  let totalExport = 0;
  let totalChargeGrid = 0;
  let marketValue = 0;
  let gridCost = 0;
  let premiumTotal = 0;

  for (let i = 0; i < n; i++) {
    const m = monthForStep(i) - 1;
    const exp = result.exportTotal[i];
    const price = result.price[i];
    const row = monthly[m];

    totalPV += result.pv[i];
    totalExport += exp;
    totalChargeGrid += result.chargeGrid[i];
    const stepValue = (exp * price) / 1000;
    const stepCost = (result.chargeGrid[i] * price) / 1000;
    marketValue += stepValue;
    gridCost += stepCost;

    row.pvKWh += result.pv[i];
    row.exportSolarKWh += result.exportSolar[i];
    row.exportBatteryKWh += result.exportBattery[i];
    row.chargeSolarKWh += result.chargeSolar[i];
    row.chargeGridKWh += result.chargeGrid[i];
    row.exportKWh += exp;
    row.marketValueEUR += stepValue;
    row.gridChargeCostEUR += stepCost;
    row.fixedValueEUR += exp * tariff.feedInEUR;
  }

  // Per-month Marktprämie from the month's achieved VWAP.
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
    totalPVKWh: totalPV,
    totalExportKWh: totalExport,
    totalChargeGridKWh: totalChargeGrid,
    marketValueEUR: marketValue,
    gridChargeCostEUR: gridCost,
    premiumEUR: premiumTotal,
    referenceValueCt: refCt,
    marktPraemieCt,
    netMarketEUR: netMarket,
    fixedValueEUR: fixedValue,
    deltaEUR: netMarket - fixedValue,
    vwapMarketEURperMWh: vwap,
    monthly,
  };
}

export { dayMonth };
