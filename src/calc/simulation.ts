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
const STEP_HOURS = STEPS_PER_HOUR > 0 ? 1 / STEPS_PER_HOUR : 0.25;

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
 * every non-positive step for grid charging). Discharge blocks are aligned to
 * whole hours so a battery never both charges and discharges within the same
 * hour.
 */
export function computeDispatchFlags(battery: BatteryConfig, prices: Float64Array): BlockFlags {
  const discharge = new Uint8Array(TOTAL_STEPS);
  const gridCharge = new Uint8Array(TOTAL_STEPS);
  if (!batteryActive(battery)) return { discharge, gridCharge };

  // Mark the most expensive `blockHours`-long, fully non-negative, hour-aligned
  // window that fits inside [startHour, endHour) of this day.
  const markBestHourBlock = (
    dayStart: number,
    startHour: number,
    endHour: number,
    blockHours: number,
  ): void => {
    const len = blockHours * STEPS_PER_HOUR;
    let bestSum = -Infinity;
    let bestHour = -1;
    for (let h = startHour; h + blockHours <= endHour; h++) {
      const from = dayStart + h * STEPS_PER_HOUR;
      let ok = true;
      for (let k = 0; k < len; k++) if (prices[from + k] < 0) { ok = false; break; }
      if (!ok) continue;
      let sum = 0;
      for (let k = 0; k < len; k++) sum += prices[from + k];
      if (sum > bestSum) {
        bestSum = sum;
        bestHour = h;
      }
    }
    if (bestHour < 0) return;
    const from = dayStart + bestHour * STEPS_PER_HOUR;
    for (let k = 0; k < len; k++) discharge[from + k] = 1;
  };

  // Hours of discharge needed to empty the battery at its max power. The
  // evening window is sized to this so the stored energy is actually used
  // (e.g. 40 kWh / 5 kW ≈ 8 h), instead of a fixed short block.
  const usableKWh = (battery.maxSOC - battery.minSOC) * battery.capacityKWh;
  const needHours = Math.max(
    1,
    Math.min(12, Math.ceil(usableKWh / Math.max(0.1, battery.maxPowerKW))),
  );

  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    if (battery.dischargeEvening) {
      // Search a post-sunset window long enough to actually empty the battery
      // (default evening end may be too short for large batteries).
      const searchEnd = Math.min(24, Math.max(battery.eveningEnd, battery.eveningStart + needHours));
      const len = Math.min(needHours, Math.max(1, searchEnd - battery.eveningStart));
      markBestHourBlock(dayStart, battery.eveningStart, searchEnd, len);
    }
    if (battery.dischargeMorning) {
      markBestHourBlock(dayStart, battery.morningStart, battery.morningEnd, 1);
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
    const maxStepEnergy = b.maxPowerKW * STEP_HOURS; // kWh the battery can move per 15-min step

    // 1) Charging from PV surplus. p is already energy (kWh) for this step.
    const pvChargeAllowed =
      !discharging &&
      (b.chargeMode === "morning" || b.chargeMode === "gridNegative"
        ? true
        : b.chargeMode === "midday"
          ? hour >= MIDDAY_START && hour < MIDDAY_END
          : false);
    if (pvChargeAllowed && p > 0 && soc < maxSOCkWh) {
      const room = (maxSOCkWh - soc) / eff; // kWh of stored energy still available
      const e = Math.min(maxStepEnergy, room, p);
      if (e > 0) {
        chargeSolar[i] = e;
        p -= e;
        soc += e * eff;
      }
    }

    // 2) Grid charging (gridNegative mode) during non-positive prices.
    if (!discharging && flags.gridCharge[i] && soc < maxSOCkWh) {
      const room = (maxSOCkWh - soc) / eff;
      const e = Math.min(maxStepEnergy, room);
      if (e > 0) {
        chargeGrid[i] = e;
        soc += e * eff;
      }
    }

    // 3) Discharge into the expensive non-negative window.
    if (flags.discharge[i] && soc > minSOCkWh) {
      const avail = soc - minSOCkWh;
      const e = Math.min(maxStepEnergy, avail);
      if (e > 0 && pr >= 0) {
        exportBattery[i] = e;
        soc -= e;
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
