// Full-year prosumer dispatch: PV, battery, load and the grid.
//
// Per 15-minute step the energy balance is settled as:
//   1. PV first covers the local load (direct self-consumption).
//   2. Surplus PV charges the battery — but only in the hours the charge plan
//      selected (see `computeDispatchFlags`). At non-positive prices the grid
//      may additionally charge the battery for free.
//   3. Remaining PV is exported (curtailed at negative prices).
//   4. Any load not covered by PV is served by the battery, then the grid.
//   5. In the most expensive non-negative windows the battery additionally
//      discharges into the grid (Direktvermarktung / strategic export). Those
//      windows come either from the configured morning/evening clock ranges
//      ("windows") or from the single most expensive N-hour block of the day
//      ("peak", see `peakDischargeHours`).
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

function batteryActive(b: BatteryConfig): boolean {
  return b.capacityKWh > 0 && b.maxSOC > 0 && b.maxSOC > b.minSOC;
}

/**
 * Length of the daily peak-price discharge window in hours: `N = capacity /
 * maxPower`, i.e. the time the battery needs to hand back its whole nominal
 * capacity at full power. This is deliberately the *nominal* capacity and not
 * the usable `(maxSOC − minSOC) × capacity`: the SOC window is enforced by the
 * step loop anyway, and sizing the window on the usable energy would make a
 * battery that is never fully charged open a window it cannot fill.
 *
 * Clamped to a quarter hour (the resolution of the simulation) and to one day,
 * so a degenerate config can neither produce a zero-length nor a multi-day
 * window. Returns 0 when there is no usable battery at all.
 */
export function peakDischargeHours(b: BatteryConfig): number {
  if (!batteryActive(b)) return 0;
  const hours = b.capacityKWh / Math.max(0.1, b.maxPowerKW);
  return Math.min(24, Math.max(STEP_HOURS, hours));
}

/** `peakDischargeHours` expressed in 15-minute steps, ready for the flag arrays. */
function peakWindowSteps(b: BatteryConfig): number {
  const steps = Math.round(peakDischargeHours(b) * STEPS_PER_HOUR);
  return Math.max(1, Math.min(STEPS_PER_DAY, steps));
}

interface BlockFlags {
  discharge: Uint8Array;
  /** Discharge steps in which selling stored energy to the grid is legitimate:
   *  only where the discharge window carries no local load at all. Stored
   *  energy is never sold ahead of self-supply. */
  merchant: Uint8Array;
  /** Steps in which surplus generation may be stored in the battery. */
  charge: Uint8Array;
}

/**
 * Pre-compute which steps discharge to the grid: scan each day for the most
 * expensive, fully non-negative, hour-aligned window (sized to empty the
 * battery). Discharge blocks are aligned to whole hours so a battery never
 * both charges and discharges within the same hour.
 *
 * Two window strategies exist. `"windows"` (the default) searches only inside
 * the configured morning/evening clock ranges — a household habit. `"peak"`
 * ignores those ranges entirely and simply takes the most expensive
 * `capacityKWh / maxPowerKW` hours of the day wherever they are, which is what
 * a price-optimised battery does.
 *
 * `merchant` marks the steps of a window that carries no local load. Only
 * there may stored energy be sold to the grid. This replaces the previous
 * condition that required concurrent generation (`gen > 0`) for a grid sale:
 * that made a post-sunset sale impossible, which is exactly the window a
 * Direktvermarktung plant needs, and it silently pinned the battery at maxSOC
 * from dusk until sunrise. Requiring zero local load instead keeps a prosumer
 * battery reserved for self-supply (matching the measured Home Assistant
 * calibration in tests/calibration.test.ts) while letting a load-free merchant
 * plant sell through its peak-price window.
 */
export function computeDispatchFlags(
  battery: BatteryConfig,
  prices: Float64Array,
  load?: Float64Array,
  generation?: Float64Array,
): BlockFlags {
  const discharge = new Uint8Array(TOTAL_STEPS);
  const merchant = new Uint8Array(TOTAL_STEPS);
  const charge = new Uint8Array(TOTAL_STEPS);
  if (!batteryActive(battery)) return { discharge, merchant, charge };

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
    let loadKWh = 0;
    if (load) for (let k = 0; k < len; k++) loadKWh += load[from + k];
    if (loadKWh < 1e-9) for (let k = 0; k < len; k++) merchant[from + k] = 1;
  };

  const usableKWh = (battery.maxSOC - battery.minSOC) * battery.capacityKWh;
  const needHours = Math.max(
    1,
    Math.min(12, Math.ceil(usableKWh / Math.max(0.1, battery.maxPowerKW))),
  );

  if (battery.dischargeMode === "peak") {
    // Peak strategy: no clock window at all — release whatever the day's
    // `peakDischargeHours` priciest hours are, whenever they fall.
    for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
      markPeakHours(battery, prices, load, generation, d * STEPS_PER_DAY, discharge, merchant);
    }
  } else {
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
  }

  planChargeHours(battery, prices, load, generation, discharge, charge);
  return { discharge, merchant, charge };
}

/**
 * Mark the `peakDischargeHours` most expensive hours of one day as the
 * discharge window.
 *
 * The window is ranked by mean spot price over the whole 24 hours, not inside
 * any clock range — on a day whose price peak lands at 06:30 or at 21:45 the
 * battery should still be there. Hours with a negative mean price are never
 * candidates: releasing stored energy while the market pays you to *consume*
 * is a guaranteed loss, and it is also where the charge plan wants to put the
 * battery. Ties break towards the earlier hour so the plan is deterministic.
 *
 * A fractional N (40 kWh at 14.5 kW is 2.76 h, not a whole number of hours) is
 * honoured at the 15-minute resolution of the simulation: whole hours are taken
 * while the budget lasts and the last one is truncated to the quarter hours
 * that still fit.
 *
 * `firstEnergyHour` is the first hour of the day in which the battery can hold
 * anything at all — the first hour with own surplus, or (when the grid is
 * allowed to charge it for free) the first negative-price hour. Hours before
 * that are skipped *without* spending the window budget. Without this guard a
 * cheap 03:00 hour would swallow the whole budget on energy the battery does
 * not have yet, and the genuine evening peak would be left with nothing.
 */
function markPeakHours(
  battery: BatteryConfig,
  prices: Float64Array,
  load: Float64Array | undefined,
  generation: Float64Array | undefined,
  dayStart: number,
  discharge: Uint8Array,
  merchant: Uint8Array,
): void {
  // Without a generation series there is no basis for a feasibility guard, so
  // the plan stays a pure price ranking (unit tests call the helper directly).
  const hasTrace = generation !== undefined || battery.chargeMode === "gridNegative";
  let firstEnergyHour = hasTrace ? 24 : 0;

  const hourPrice = new Float64Array(24);
  const hourLoad = new Float64Array(24);
  const candidates: number[] = [];
  for (let h = 0; h < 24; h++) {
    const from = dayStart + h * STEPS_PER_HOUR;
    let sumPrice = 0;
    let sumLoad = 0;
    let surplus = 0;
    for (let k = 0; k < STEPS_PER_HOUR; k++) {
      sumPrice += prices[from + k];
      if (load) sumLoad += load[from + k];
      if (generation) surplus += generation[from + k] - (load ? load[from + k] : 0);
    }
    hourPrice[h] = sumPrice / STEPS_PER_HOUR;
    hourLoad[h] = sumLoad;
    const canStore = (generation ? surplus > 1e-9 : false) ||
      (battery.chargeMode === "gridNegative" && hourPrice[h] < 0);
    if (canStore && h < firstEnergyHour) firstEnergyHour = h;
    // Only a non-negative price is worth releasing stored energy for.
    if (hourPrice[h] >= 0) candidates.push(h);
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => hourPrice[b] - hourPrice[a] || a - b);

  let budget = peakWindowSteps(battery);
  for (const h of candidates) {
    if (budget <= 0) break;
    if (h < firstEnergyHour) continue;
    const from = dayStart + h * STEPS_PER_HOUR;
    const take = Math.min(budget, STEPS_PER_HOUR);
    // Same merchant rule as the clock windows: only a load-free hour may sell
    // stored energy to the grid; with demand in the hour the battery is
    // reserved for self-supply.
    const isMerchant = hourLoad[h] < 1e-9;
    for (let k = 0; k < take; k++) {
      discharge[from + k] = 1;
      if (isMerchant) merchant[from + k] = 1;
    }
    budget -= take;
  }
}

/**
 * Decide in which hours surplus generation may be stored.
 *
 * Storing a surplus kWh costs the spot price of that hour — the energy could
 * have been exported instead — so the profit of a charge/discharge cycle is
 * `price(discharge) − price(charge) / efficiency`. Storing everything as early
 * as it appears therefore locks in only the *earliest* available spread; the
 * battery would have earned more by waiting for the cheapest surplus hours and
 * then discharging into the expensive window. That is exactly what the
 * `cheapest` mode does: per day it ranks the hours that actually have surplus
 * by price and opens the charge window on the cheapest ones, adding further
 * hours only until the battery is full (or the day's surplus is used up).
 *
 * Hours reserved for a discharge block are never charge candidates, which
 * keeps charging and discharging mutually exclusive on the day plan. Negative
 * prices rank cheapest, so a negative-price trough is always absorbed first —
 * that surplus would otherwise be curtailed.
 */
function planChargeHours(
  battery: BatteryConfig,
  prices: Float64Array,
  load: Float64Array | undefined,
  generation: Float64Array | undefined,
  discharge: Uint8Array,
  charge: Uint8Array,
): void {
  if (battery.chargeMode === "morning" || battery.chargeMode === "gridNegative") {
    // Store every kWh of own surplus the moment it appears.
    charge.fill(1);
    return;
  }

  const stepEnergy = battery.maxPowerKW * STEP_HOURS;
  const perHourCap = stepEnergy * STEPS_PER_HOUR;
  const roomKWh =
    ((battery.maxSOC - battery.minSOC) * battery.capacityKWh) / Math.max(0.01, battery.efficiency);

  // Without a generation series (unit tests calling the flag helper directly)
  // treat every hour as a candidate so the plan stays a pure price ranking.
  const hourPrice = new Float64Array(24);
  const hourSurplus = new Float64Array(24);
  const blocked = new Uint8Array(24);

  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    const dayStart = d * STEPS_PER_DAY;
    let daySurplus = 0;
    for (let h = 0; h < 24; h++) {
      const from = dayStart + h * STEPS_PER_HOUR;
      let sumP = 0;
      let surplus = 0;
      let isBlocked = 0;
      for (let k = 0; k < STEPS_PER_HOUR; k++) {
        const idx = from + k;
        sumP += prices[idx];
        if (generation) surplus += Math.max(0, generation[idx] - (load ? load[idx] : 0));
        if (discharge[idx]) isBlocked = 1;
      }
      hourPrice[h] = sumP / STEPS_PER_HOUR;
      hourSurplus[h] = generation ? surplus : Infinity;
      blocked[h] = isBlocked;
      daySurplus += hourSurplus[h];
    }

    const wantKWh = Math.min(roomKWh, daySurplus);
    if (!(wantKWh > 1e-9)) continue;

    const candidates: number[] = [];
    for (let h = 0; h < 24; h++) if (hourSurplus[h] > 1e-9 && !blocked[h]) candidates.push(h);
    candidates.sort((a, b) => hourPrice[a] - hourPrice[b] || a - b);

    let taken = 0;
    for (const h of candidates) {
      if (taken >= wantKWh - 1e-9) break;
      const from = dayStart + h * STEPS_PER_HOUR;
      for (let k = 0; k < STEPS_PER_HOUR; k++) charge[from + k] = 1;
      taken += Math.min(hourSurplus[h], perHourCap);
    }
  }
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
  const flags = computeDispatchFlags(b, price, load, generation);

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

      let gridImpVal = L > 0 ? L : 0;

      // 2) Charge battery from generation surplus first if allowed.
      if (flags.charge[i] === 1 && gen > 0 && soc < maxSOCkWh) {
        const room = (maxSOCkWh - soc) / eff;
        const e = Math.min(maxStepEnergy, room, gen);
        if (e > 0) {
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
        }
      }

      // 3) Charge battery from grid if chargeMode is gridNegative and there's still room.
      if (b.chargeMode === "gridNegative" && soc < maxSOCkWh) {
        const room = (maxSOCkWh - soc) / eff;
        const e = Math.min(maxStepEnergy, room);
        if (e > 0) {
          chargeGrid[i] = e;
          soc += e * eff;
          gridImpVal += e;
        }
      }

      gridImport[i] = gridImpVal;

      // 4) Export remaining generation. At negative prices, any remaining generation is curtailed (not exported).
      // exportSolar and exportWind remain 0.

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

    // 2) Charge battery from generation surplus (in the planned charge hours).
    const discharging = flags.discharge[i] === 1;
    let charged = false;
    if (flags.charge[i] === 1 && gen > 0 && soc < maxSOCkWh) {
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

    // 3) Export remaining generation directly (price >= 0 here).
    if (gen > 0) {
      exportSolar[i] = pRemain;
      exportWind[i] = wRemain;
    }

    // 4) Cover remaining load from the battery, then the grid. Note that this
    //    is deliberately *not* gated on the discharge window: covering own
    //    load is worth the full import price in every hour, so a charged
    //    battery always prefers self-supply over a grid import. The window
    //    from step 5 governs only the discretionary use — selling stored
    //    energy into the grid — which is what actually depends on the spot
    //    price and therefore what "peak" vs "windows" is about.
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

    // 5) Strategic export: sell stored battery energy into the grid. Allowed
    //    only in a load-free (merchant) discharge window -- never in a window
    //    that still has local demand to cover.
    // Either there is concurrent generation (a prosumer with coincident PV
    // surplus — the historical, calibration-verified path) or the discharge
    // window carries no local load at all, so the stored energy is genuinely
    // surplus and may be sold even after sunset. The second case is a
    // Direktvermarktung plant with no own consumption.
    const sellable = gen > 0 || flags.merchant[i] === 1;
    if (discharging && !charged && sellable && soc > minSOCkWh) {
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
