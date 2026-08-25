// Battery dispatch + full-year simulation.
//
// Mirrors the strategy described in charge_shift.md / discharge_shift.md: the
// battery stores PV surplus (or grid energy at low prices) and discharges into
// the most expensive, non-negative windows of the day. No energy is ever
// exported while the spot price is negative (it is curtailed / skipped).
import { STEPS_PER_DAY, TOTAL_STEPS, } from "./types";
import { pvProductionPerStep } from "./solar";
import { generatePrices } from "./priceModel";
const STEPS_PER_HOUR = STEPS_PER_DAY / 24;
/**
 * Pre-compute which steps discharge / grid-charge, by scanning each day for the
 * best contiguous window (most expensive non-negative block for discharge,
 * cheapest block for grid charging).
 */
export function computeDispatchFlags(battery, prices) {
    const discharge = new Uint8Array(TOTAL_STEPS);
    const gridCharge = new Uint8Array(TOTAL_STEPS);
    const findBestBlock = (dayStart, startHour, endHour, blockHours, mode, requireNonNeg) => {
        const from = dayStart + Math.round(startHour * STEPS_PER_HOUR);
        const to = dayStart + Math.round(endHour * STEPS_PER_HOUR);
        const len = Math.max(1, Math.round(blockHours * STEPS_PER_HOUR));
        if (to - from < len)
            return [];
        let bestSum = mode === "max" ? -Infinity : Infinity;
        let bestStart = -1;
        for (let s = from; s + len <= to; s++) {
            if (requireNonNeg) {
                let ok = true;
                for (let k = 0; k < len; k++)
                    if (prices[s + k] < 0) {
                        ok = false;
                        break;
                    }
                if (!ok)
                    continue;
            }
            let sum = 0;
            for (let k = 0; k < len; k++)
                sum += prices[s + k];
            if (mode === "max" ? sum > bestSum : sum < bestSum) {
                bestSum = sum;
                bestStart = s;
            }
        }
        if (bestStart < 0)
            return [];
        const block = [];
        for (let k = 0; k < len; k++)
            block.push(bestStart + k);
        return block;
    };
    for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
        const dayStart = d * STEPS_PER_DAY;
        if (battery.dischargeEvening) {
            for (const s of findBestBlock(dayStart, battery.eveningStart, battery.eveningEnd, 2, "max", true))
                discharge[s] = 1;
        }
        if (battery.dischargeMorning) {
            for (const s of findBestBlock(dayStart, battery.morningStart, battery.morningEnd, 1, "max", true))
                discharge[s] = 1;
        }
        if (battery.chargeMode === "lowPrice") {
            for (const s of findBestBlock(dayStart, 0, 24, 4, "min", false))
                gridCharge[s] = 1;
        }
    }
    return { discharge, gridCharge };
}
export function simulate(config) {
    const pv = pvProductionPerStep({
        peakKWp: config.pv.peakKWp,
        tiltDeg: config.pv.tiltDeg,
        orientation: config.pv.orientation,
        location: config.pv.location,
    });
    const price = config.prices ?? generatePrices();
    const b = config.battery;
    const flags = computeDispatchFlags(b, price);
    const eff = b.efficiency;
    const cap = b.capacityKWh;
    const maxSOCkWh = b.maxSOC * cap;
    const minSOCkWh = b.minSOC * cap;
    let soc = b.startSOC * cap;
    const socArr = new Float64Array(TOTAL_STEPS);
    const exportSolar = new Float64Array(TOTAL_STEPS);
    const exportBattery = new Float64Array(TOTAL_STEPS);
    const chargeSolar = new Float64Array(TOTAL_STEPS);
    const chargeGrid = new Float64Array(TOTAL_STEPS);
    const exportTotal = new Float64Array(TOTAL_STEPS);
    for (let i = 0; i < TOTAL_STEPS; i++) {
        let p = pv[i];
        const pr = price[i];
        // 1) Charging from PV surplus (solar mode only).
        if (b.chargeMode === "solar" && p > 0 && soc < maxSOCkWh) {
            const room = (maxSOCkWh - soc) / eff;
            const c = Math.min(b.maxPowerKW, room, p);
            if (c > 0) {
                chargeSolar[i] = c;
                p -= c;
                soc += c * eff;
            }
        }
        // 2) Grid charging (lowPrice mode) during cheapest windows.
        if (flags.gridCharge[i] && soc < maxSOCkWh) {
            const room = (maxSOCkWh - soc) / eff;
            const c = Math.min(b.maxPowerKW, room);
            if (c > 0) {
                chargeGrid[i] = c;
                soc += c * eff;
            }
        }
        // 3) Discharge into the expensive non-negative window.
        if (flags.discharge[i] && soc > minSOCkWh) {
            const avail = soc - minSOCkWh;
            const d = Math.min(b.maxPowerKW, avail);
            if (d > 0 && pr >= 0) {
                exportBattery[i] = d;
                soc -= d;
            }
        }
        // 4) Export remaining PV directly (curtail at non-positive prices).
        if (p > 0) {
            if (pr >= 0)
                exportSolar[i] = p;
        }
        socArr[i] = soc;
        exportTotal[i] = exportSolar[i] + exportBattery[i];
    }
    return {
        pv,
        price,
        soc: socArr,
        exportSolar,
        exportBattery,
        chargeSolar,
        chargeGrid,
        exportTotal,
    };
}
