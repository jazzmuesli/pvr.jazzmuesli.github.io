// Battery dispatch + full-year simulation.
//
// Mirrors the strategy described in charge_shift.md / discharge_shift.md: the
// battery stores PV surplus (or grid energy at non-positive prices) and
// discharges into the most expensive, non-negative windows of the day. No
// energy is ever exported while the spot price is negative (it is curtailed).

import {
  STEPS_PER_DAY,
  TOTAL_STEPS,
  SimConfig,
  SimResult,
  BatteryConfig,
} from "./types";
import { pvProductionPerStep } from "./solar";
import { generatePrices } from "./priceModel";

const STEPS_PER_HOUR = STEPS_PER_DAY / 24;

/** PV-only charging window for the "midday" strategy (solar noon). */
const MIDDAY_START = 10;
const MIDDAY_END = 15;

function batteryActive(b: BatteryConfig): boolean {
  return b.capacityKWh > 0 && b.maxSOC > 0 && b.maxSOC > b.minSOC;
}

interface BlockFlags {
  discharge: Uint8Array;
  gridCharge: Uint8Array;
}

/**
 * Pre-compute which steps discharge / grid-charge, by scanning each day for the
 * best contiguous window (most expensive non-negative block for discharge,
 * every non-positive step for grid charging).
 */
export function computeDispatchFlags(battery: BatteryConfig, prices: Float64Array): BlockFlags {
  const discharge = new Uint8Array(TOTAL_STEPS);
  const gridCharge = new Uint8Array(TOTAL_STEPS);
  if (!batteryActive(battery)) return { discharge, gridCharge };

  const findBestBlock = (
    dayStart: number,
    startHour: number,
    endHour: number,
    blockHours: number,
    mode: "max" | "min",
    requireNonNeg: boolean,
  ): number[] => {
    const from = dayStart + Math.round(startHour * STEPS_PER_HOUR);
    const to = dayStart + Math.round(endHour * STEPS_PER_HOUR);
    const len = Math.max(1, Math.round(blockHours * STEPS_PER_HOUR));
    if (to - from < len) return [];
    let bestSum = mode === "max" ? -Infinity : Infinity;
    let bestStart = -1;
    for (let s = from; s + len <= to; s++) {
      if (requireNonNeg) {
        let ok = true;
        for (let k = 0; k < len; k++) if (prices[s + k] < 0) { ok = false; break; }
        if (!ok) continue;
      }
      let sum = 0;
      for (let k = 0; k < len; k++) sum += prices[s + k];
      if (mode === "max" ? sum > bestSum : sum < bestSum) {
        bestSum = sum;
        bestStart = s;
      }
    }
    if (bestStart < 0) return [];
    const block: number[] = [];
    for (let k = 0; k < len; k++) block.push(bestStart + k);
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
    if (battery.chargeMode === "gridNegative") {
      // Charge from the grid at every non-positive price step.
      for (let i = dayStart; i < dayStart + STEPS_PER_DAY; i++) {
        if (prices[i] <= 0) gridCharge[i] = 1;
      }
    }
  }
  return { discharge, gridCharge };
}

export function simulate(config: SimConfig): SimResult {
  const pv = pvProductionPerStep({
    peakKWp: config.pv.peakKWp,
    tiltDeg: config.pv.tiltDeg,
    orientation: config.pv.orientation,
    location: config.pv.location,
  });
  const price = config.prices ?? generatePrices();
  const b = config.battery;

  const flags = computeDispatchFlags(b, price);

  const active = batteryActive(b);
  const eff = b.efficiency;
  const cap = b.capacityKWh;
  const maxSOCkWh = b.maxSOC * cap;
  const minSOCkWh = b.minSOC * cap;
  let soc = active ? b.startSOC * cap : 0;

  const socArr = new Float64Array(TOTAL_STEPS);
  const exportSolar = new Float64Array(TOTAL_STEPS);
  const exportBattery = new Float64Array(TOTAL_STEPS);
  const chargeSolar = new Float64Array(TOTAL_STEPS);
  const chargeGrid = new Float64Array(TOTAL_STEPS);
  const exportTotal = new Float64Array(TOTAL_STEPS);

  for (let i = 0; i < TOTAL_STEPS; i++) {
    let p = pv[i];
    const pr = price[i];
    const hour = Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR);

    if (!active) {
      // No usable battery: export PV directly (curtail at non-positive prices).
      if (p > 0 && pr >= 0) exportSolar[i] = p;
      socArr[i] = 0;
      exportTotal[i] = exportSolar[i];
      continue;
    }

    // A step is either a charge step or a discharge step, never both — the
    // battery cannot charge and discharge at the same quarter hour.
    const discharging = flags.discharge[i] === 1;

    // 1) Charging from PV surplus.
    const pvChargeAllowed =
      !discharging &&
      (b.chargeMode === "morning" || b.chargeMode === "gridNegative"
        ? true
        : b.chargeMode === "midday"
          ? hour >= MIDDAY_START && hour < MIDDAY_END
          : false);
    if (pvChargeAllowed && p > 0 && soc < maxSOCkWh) {
      const room = (maxSOCkWh - soc) / eff;
      const c = Math.min(b.maxPowerKW, room, p);
      if (c > 0) {
        chargeSolar[i] = c;
        p -= c;
        soc += c * eff;
      }
    }

    // 2) Grid charging (gridNegative mode) during non-positive prices.
    if (!discharging && flags.gridCharge[i] && soc < maxSOCkWh) {
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
    if (p > 0 && pr >= 0) exportSolar[i] = p;

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
