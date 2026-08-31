// Full-year prosumer dispatch: PV, battery, load and the grid.
//
// Per 15-minute step the energy balance is settled as:
//   1. PV first covers the local load (direct self-consumption).
//   2. Surplus PV charges the battery (or, at non-positive prices, the grid
//      charges the battery for free).
//   3. Remaining PV is exported (curtailed at negative prices).
//   4. Any load not covered by PV is served by the battery, then the grid.
//   5. In the most expensive non-negative windows the battery additionally
//      discharges into the grid (Direktvermarktung / strategic export).
//
// The battery never charges and discharges in the same quarter hour: a step
// that has PV surplus charges; a step with a load deficit (or a strategic
// export window) discharges. At negative prices it only charges from the grid.

import {
  STEPS_PER_DAY,
  TOTAL_STEPS,
  STEPS_PER_HOUR,
  SimConfig,
  SimResult,
  BatteryConfig,
} from "./types";
import { pvProductionPerStep } from "./solar";
import { generatePrices } from "./priceModel";

const STEP_HOURS = 1 / STEPS_PER_HOUR;

/** PV-only charging window for the "midday" strategy (solar noon). */
const MIDDAY_START = 10;
const MIDDAY_END = 15;

function batteryActive(b: BatteryConfig): boolean {
  return b.capacityKWh > 0 && b.maxSOC > 0 && b.maxSOC > b.minSOC;
}

interface BlockFlags {
  discharge: Uint8Array;
}

/**
 * Pre-compute which steps discharge to the grid: scan each day for the most
 * expensive, fully non-negative, hour-aligned window (sized to empty the
 * battery). Discharge blocks are aligned to whole hours so a battery never
 * both charges and discharges within the same hour.
 */
export function computeDispatchFlags(battery: BatteryConfig, prices: Float64Array): BlockFlags {
  const discharge = new Uint8Array(TOTAL_STEPS);
  if (!batteryActive(battery)) return { discharge };

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

  const usableKWh = (battery.maxSOC - battery.minSOC) * battery.capacityKWh;
  const needHours = Math.max(
    1,
    Math.min(12, Math.ceil(usableKWh / Math.max(0.1, battery.maxPowerKW))),
  );

  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    if (battery.dischargeEvening) {
      const searchEnd = Math.min(24, Math.max(battery.eveningEnd, battery.eveningStart + needHours));
      const len = Math.min(needHours, Math.max(1, searchEnd - battery.eveningStart));
      markBestHourBlock(dayStart, battery.eveningStart, searchEnd, len);
    }
    if (battery.dischargeMorning) {
      markBestHourBlock(dayStart, battery.morningStart, battery.morningEnd, 1);
    }
  }
  return { discharge };
}

export function simulate(config: SimConfig): SimResult {
  const pv = pvProductionPerStep({
    peakKWp: config.pv.peakKWp,
    tiltDeg: config.pv.tiltDeg,
    orientation: config.pv.orientation,
    location: config.pv.location,
  });
  const price = config.prices ?? generatePrices();
  const load = config.load ?? new Float64Array(TOTAL_STEPS);
  const b = config.battery;
  const flags = computeDispatchFlags(b, price);

  const active = batteryActive(b);
  const eff = b.efficiency;
  const cap = b.capacityKWh;
  const maxSOCkWh = b.maxSOC * cap;
  const minSOCkWh = b.minSOC * cap;
  let soc = active ? b.startSOC * cap : 0;
  let pvSOC = active ? b.startSOC * cap : 0; // PV-originated kWh in battery

  const loadArr = new Float64Array(TOTAL_STEPS);
  const socArr = new Float64Array(TOTAL_STEPS);
  const directUse = new Float64Array(TOTAL_STEPS);
  const chargeSolar = new Float64Array(TOTAL_STEPS);
  const chargeGrid = new Float64Array(TOTAL_STEPS);
  const dischargeToLoad = new Float64Array(TOTAL_STEPS);
  const dischargeToLoadPV = new Float64Array(TOTAL_STEPS);
  const exportSolar = new Float64Array(TOTAL_STEPS);
  const exportBattery = new Float64Array(TOTAL_STEPS);
  const gridImport = new Float64Array(TOTAL_STEPS);
  const exportTotal = new Float64Array(TOTAL_STEPS);

  const maxStepEnergy = b.maxPowerKW * STEP_HOURS;

  for (let i = 0; i < TOTAL_STEPS; i++) {
    let p = pv[i];
    let L = load[i];
    const pr = price[i];

    if (!active) {
      // No battery: direct use + export; load deficit is grid import.
      const du = Math.min(p, L);
      directUse[i] = du;
      p -= du;
      L -= du;
      if (p > 0 && pr >= 0) exportSolar[i] = p;
      if (L > 0) gridImport[i] = L;
      loadArr[i] = load[i];
      socArr[i] = 0;
      exportTotal[i] = exportSolar[i];
      continue;
    }

    // Negative / free price: take from the grid (cheap) and store free energy.
    if (pr < 0) {
      directUse[i] = Math.min(p, L);
      L -= directUse[i];
      if (L > 0) gridImport[i] = L;
      if (soc < maxSOCkWh) {
        const room = (maxSOCkWh - soc) / eff;
        const e = Math.min(maxStepEnergy, room);
        if (e > 0) {
          chargeGrid[i] = e;
          soc += e * eff;
          // Grid-charged energy is NOT counted as PV; pvSOC stays unchanged.
        }
      }
      loadArr[i] = load[i];
      socArr[i] = soc;
      exportTotal[i] = exportSolar[i] + exportBattery[i];
      continue;
    }

    // 1) Direct self-consumption: PV covers load first.
    const du = Math.min(p, L);
    directUse[i] = du;
    p -= du;
    L -= du;

    // 2) Charge battery from PV surplus (no charge while a strategic export
    //    discharge is scheduled this step — keeps charge/discharge mutually
    //    exclusive within a quarter hour).
    const discharging = flags.discharge[i] === 1;
    let charged = false;
    // Charge from PV surplus whenever it exists (free energy is always worth
    // storing) — this must NOT be blocked by the discharge-window flag, or a
    // "discharge in the morning" window would prevent the battery from soaking
    // up morning PV. Only grid-based charging is restricted to non-discharge
    // windows (see step 1).
    if (p > 0 && soc < maxSOCkWh) {
      const pvChargeAllowed =
        b.chargeMode === "morning" || b.chargeMode === "gridNegative"
          ? true
          : b.chargeMode === "midday"
            ? Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR) >= MIDDAY_START &&
              Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR) < MIDDAY_END
            : false;
      if (pvChargeAllowed) {
        const room = (maxSOCkWh - soc) / eff;
        const e = Math.min(maxStepEnergy, room, p);
        if (e > 0) {
          chargeSolar[i] = e;
          p -= e;
          soc += e * eff;
          pvSOC += e * eff;
          charged = true;
        }
      }
    }

    // 3) Export remaining PV directly (price >= 0 here).
    if (p > 0) exportSolar[i] = p;

    // 4) Cover remaining load from the battery whenever it has charge, then
    //    the grid. A self-consumption battery should serve *any* load deficit
    //    (not just inside fixed windows): exported PV is worth only the feed-in
    //    rate while grid import costs the full retail rate, so storing PV and
    //    discharging it against load is always the better arbitrage.
    if (L > 0 && soc > minSOCkWh) {
      const avail = soc - minSOCkWh;
      const e = Math.min(maxStepEnergy, avail, L);
      if (e > 0) {
        dischargeToLoad[i] = e;
        soc -= e;
        // Only the PV-originated fraction counts as self-consumption.
        const pvFrac = soc > 0 ? pvSOC / soc : 0;
        const pvPart = e * Math.min(1, pvFrac);
        dischargeToLoadPV[i] = pvPart;
        pvSOC = Math.max(0, pvSOC - pvPart);
        L -= e;
      }
    }
    if (L > 0) gridImport[i] = L;

    // 5) Strategic export: sell surplus battery energy whenever the spot is
    //    positive. A daily-cycling battery cannot store energy long-term, so
    //    unused surplus would otherwise be curtailed — exporting it (plus the
    //    EEG Marktprämie when the export VWAP is low) always beats wasting it.
    //    The profitable arbitrage is: discharge to cover load in expensive
    //    windows (step 4) and recharge from the grid when the spot is low or
    //    negative, so selling stored energy at a high spot while buying it
    //    back cheaply is exactly what we want.
    if (discharging && !charged && soc > minSOCkWh && p > 0) {
      const maxAdd = maxStepEnergy - dischargeToLoad[i];
      if (maxAdd > 0) {
        const avail = soc - minSOCkWh;
        const e = Math.min(maxAdd, avail);
        if (e > 0) {
          exportBattery[i] = e;
          soc -= e;
          // Strategic export also drains PV proportionally.
          const pvFrac = soc > 0 ? pvSOC / soc : 0;
          pvSOC = Math.max(0, pvSOC - e * Math.min(1, pvFrac));
        }
      }
    }

    loadArr[i] = load[i];
    socArr[i] = soc;
    exportTotal[i] = exportSolar[i] + exportBattery[i];
  }

  return {
    pv,
    price,
    load: loadArr,
    soc: socArr,
    directUse,
    chargeSolar,
    chargeGrid,
    dischargeToLoad,
    dischargeToLoadPV,
    exportSolar,
    exportBattery,
    gridImport,
    exportTotal,
  };
}
