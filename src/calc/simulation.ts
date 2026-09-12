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
  const wind = config.wind ?? new Float64Array(TOTAL_STEPS);
  // Combined generation for battery dispatch (PV + Wind treated equally).
  const generation = new Float64Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) generation[i] = pv[i] + wind[i];

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
  let pvSOC = active ? b.startSOC * cap : 0;
  let windSOC = active ? b.startSOC * cap * 0 : 0; // wind-originated kWh in battery

  const loadArr = new Float64Array(TOTAL_STEPS);
  const socArr = new Float64Array(TOTAL_STEPS);
  const directUse = new Float64Array(TOTAL_STEPS);
  const directUseWind = new Float64Array(TOTAL_STEPS);
  const chargeSolar = new Float64Array(TOTAL_STEPS);
  const chargeWind = new Float64Array(TOTAL_STEPS);
  const chargeGrid = new Float64Array(TOTAL_STEPS);
  const dischargeToLoad = new Float64Array(TOTAL_STEPS);
  const dischargeToLoadPV = new Float64Array(TOTAL_STEPS);
  const dischargeToLoadWind = new Float64Array(TOTAL_STEPS);
  const exportSolar = new Float64Array(TOTAL_STEPS);
  const exportWind = new Float64Array(TOTAL_STEPS);
  const exportBattery = new Float64Array(TOTAL_STEPS);
  const gridImport = new Float64Array(TOTAL_STEPS);
  const exportTotal = new Float64Array(TOTAL_STEPS);

  const maxStepEnergy = b.maxPowerKW * STEP_HOURS;

  for (let i = 0; i < TOTAL_STEPS; i++) {
    let gen = generation[i];
    let pRemain = pv[i]; // track PV remainder for export split
    let wRemain = wind[i]; // track wind remainder for export split
    let L = load[i];
    const pr = price[i];

    if (!active) {
      // No battery: direct use + export; load deficit is grid import.
      const du = Math.min(gen, L);
      // Split direct use between PV and wind proportionally
      if (gen > 0) {
        directUse[i] = du * (pRemain / gen);
        directUseWind[i] = du * (wRemain / gen);
      }
      gen -= du;
      pRemain = Math.max(0, pRemain - du * (pRemain / (generation[i] || 1)));
      wRemain = Math.max(0, wRemain - du * (wRemain / (generation[i] || 1)));
      L -= du;
      if (gen > 0 && pr >= 0) {
        exportSolar[i] = pRemain;
        exportWind[i] = wRemain;
      }
      if (L > 0) gridImport[i] = L;
      loadArr[i] = load[i];
      socArr[i] = 0;
      exportTotal[i] = exportSolar[i] + exportWind[i];
      continue;
    }

    // Negative / free price: take from the grid (cheap) and store free energy.
    if (pr < 0) {
      const du = Math.min(gen, L);
      if (gen > 0) {
        directUse[i] = du * (pRemain / gen);
        directUseWind[i] = du * (wRemain / gen);
      }
      L -= du;
      if (L > 0) gridImport[i] = L;
      if (soc < maxSOCkWh) {
        const room = (maxSOCkWh - soc) / eff;
        const e = Math.min(maxStepEnergy, room);
        if (e > 0) {
          chargeGrid[i] = e;
          soc += e * eff;
        }
      }
      loadArr[i] = load[i];
      socArr[i] = soc;
      exportTotal[i] = exportSolar[i] + exportWind[i] + exportBattery[i];
      continue;
    }

    // 1) Direct self-consumption: generation covers load first.
    const du = Math.min(gen, L);
    if (gen > 0) {
      directUse[i] = du * (pRemain / gen);
      directUseWind[i] = du * (wRemain / gen);
    }
    gen -= du;
    pRemain = Math.max(0, pRemain - directUse[i]);
    wRemain = Math.max(0, wRemain - directUseWind[i]);
    L -= du;

    // 2) Charge battery from generation surplus.
    const discharging = flags.discharge[i] === 1;
    let charged = false;
    if (gen > 0 && soc < maxSOCkWh) {
      const chargeAllowed =
        b.chargeMode === "morning" || b.chargeMode === "gridNegative"
          ? true
          : b.chargeMode === "midday"
            ? Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR) >= MIDDAY_START &&
              Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR) < MIDDAY_END
            : false;
      if (chargeAllowed) {
        const room = (maxSOCkWh - soc) / eff;
        const e = Math.min(maxStepEnergy, room, gen);
        if (e > 0) {
          // Split charge between PV and wind proportionally
          const pvFrac = gen > 0 ? pRemain / gen : 0;
          const windFrac = gen > 0 ? wRemain / gen : 0;
          const pvCharge = e * pvFrac;
          const windCharge = e * windFrac;
          chargeSolar[i] = pvCharge;
          chargeWind[i] = windCharge;
          pRemain = Math.max(0, pRemain - pvCharge);
          wRemain = Math.max(0, wRemain - windCharge);
          gen -= e;
          soc += e * eff;
          pvSOC += pvCharge * eff;
          windSOC += windCharge * eff;
          charged = true;
        }
      }
    }

    // 3) Export remaining generation directly (price >= 0 here).
    if (gen > 0) {
      exportSolar[i] = pRemain;
      exportWind[i] = wRemain;
    }

    // 4) Cover remaining load from the battery, then the grid.
    if (L > 0 && soc > minSOCkWh) {
      const avail = soc - minSOCkWh;
      const e = Math.min(maxStepEnergy, avail, L);
      if (e > 0) {
        dischargeToLoad[i] = e;
        const totalSOC = pvSOC + windSOC;
        const pvFrac = totalSOC > 0 ? pvSOC / totalSOC : 0;
        const windFrac = totalSOC > 0 ? windSOC / totalSOC : 0;
        const pvPart = e * pvFrac;
        const windPart = e * windFrac;
        dischargeToLoadPV[i] = pvPart;
        dischargeToLoadWind[i] = windPart;
        soc -= e;
        pvSOC = Math.max(0, pvSOC - pvPart);
        windSOC = Math.max(0, windSOC - windPart);
        L -= e;
      }
    }
    if (L > 0) gridImport[i] = L;

    // 5) Strategic export: sell surplus battery energy.
    if (discharging && !charged && soc > minSOCkWh && gen > 0) {
      const maxAdd = maxStepEnergy - dischargeToLoad[i];
      if (maxAdd > 0) {
        const avail = soc - minSOCkWh;
        const e = Math.min(maxAdd, avail);
        if (e > 0) {
          exportBattery[i] = e;
          const totalSOC = pvSOC + windSOC;
          const pvFrac = totalSOC > 0 ? pvSOC / totalSOC : 0;
          const windFrac = totalSOC > 0 ? windSOC / totalSOC : 0;
          soc -= e;
          pvSOC = Math.max(0, pvSOC - e * pvFrac);
          windSOC = Math.max(0, windSOC - e * windFrac);
        }
      }
    }

    loadArr[i] = load[i];
    socArr[i] = soc;
    exportTotal[i] = exportSolar[i] + exportWind[i] + exportBattery[i];
  }

  return {
    pv,
    wind,
    generation,
    price,
    load: loadArr,
    soc: socArr,
    directUse,
    directUseWind,
    chargeSolar,
    chargeWind,
    chargeGrid,
    dischargeToLoad,
    dischargeToLoadPV,
    dischargeToLoadWind,
    exportSolar,
    exportWind,
    exportBattery,
    gridImport,
    exportTotal,
  };
}
