// Revenue computation and tariff comparison.
//
// Compares market-based direct marketing (spot price + optional Marktprämie,
// minus any grid-charging cost) against a fixed feed-in tariff (Einspeisung).
import { STEPS_PER_DAY } from "./types";
import { SIM_YEAR } from "./types";
const DAYS = 365;
const dayMonth = new Array(DAYS);
{
    const base = new Date(Date.UTC(SIM_YEAR, 0, 1));
    for (let d = 0; d < DAYS; d++) {
        const dt = new Date(base.getTime() + d * 86400000);
        dayMonth[d] = dt.getUTCMonth() + 1;
    }
}
export function monthForStep(i) {
    return dayMonth[Math.floor(i / STEPS_PER_DAY)];
}
export function computeRevenue(result, tariff) {
    const n = result.exportTotal.length;
    let totalPV = 0;
    let totalExport = 0;
    let totalChargeGrid = 0;
    let marketValue = 0;
    let gridCost = 0;
    const monthly = [];
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
    for (let i = 0; i < n; i++) {
        const m = monthForStep(i) - 1;
        const exp = result.exportTotal[i];
        const price = result.price[i];
        const row = monthly[m];
        totalPV += result.pv[i];
        totalExport += exp;
        totalChargeGrid += result.chargeGrid[i];
        const stepValue = (exp * price) / 1000;
        marketValue += stepValue;
        const stepCost = (result.chargeGrid[i] * price) / 1000;
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
        row.premiumEUR += exp * tariff.marketPremiumEUR;
    }
    const premiumTotal = totalExport * tariff.marketPremiumEUR;
    const netMarket = marketValue + premiumTotal - gridCost;
    const fixedValue = totalExport * tariff.feedInEUR;
    const vwap = totalExport > 0 ? (marketValue / totalExport) * 1000 : 0;
    return {
        totalPVKWh: totalPV,
        totalExportKWh: totalExport,
        totalChargeGridKWh: totalChargeGrid,
        marketValueEUR: marketValue,
        gridChargeCostEUR: gridCost,
        premiumEUR: premiumTotal,
        netMarketEUR: netMarket,
        fixedValueEUR: fixedValue,
        deltaEUR: netMarket - fixedValue,
        vwapMarketEURperMWh: vwap,
        monthly,
    };
}
export { dayMonth };
