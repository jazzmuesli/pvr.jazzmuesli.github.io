// Core domain types and shared constants for the PV/battery simulator.

/** Number of 15-minute steps per day. */
export const STEPS_PER_DAY = 96;
/** Step duration in hours (15 minutes). */
export const STEP_HOURS = STEPS_PER_DAY / 24; // 0.25
/** Default simulated year: a non-leap year so the grid is exactly 365 days. */
export const SIM_YEAR = 2023;
/** Total number of steps in the simulated year. */
export const TOTAL_STEPS = 365 * STEPS_PER_DAY;

/** Number of 15-minute steps per hour. */
export const STEPS_PER_HOUR = STEPS_PER_DAY / 24;

/**
 * The one calendar. `monthOfStep`, the annual load profiles, the wind
 * climatology and anything that re-integrates the 12 typical-day cells all
 * used to keep their own copy — four arrays of the same twelve integers, which
 * is the kind of duplication that survives exactly until one of them is wrong.
 */
export const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Total days in the simulated (non-leap) year. */
export const TOTAL_DAYS = 365;

/** 1-based month index for each day of the year (365 entries). */
const DAY_MONTH: Uint8Array = (() => {
  const out = new Uint8Array(TOTAL_DAYS);
  const base = Date.UTC(SIM_YEAR, 0, 1);
  for (let d = 0; d < TOTAL_DAYS; d++) {
    out[d] = new Date(base + d * 86400000).getUTCMonth() + 1;
  }
  return out;
})();

/**
 * 1-based month (1..12) for a given 15-minute step index.
 *
 * Backed by a lookup table rather than constructing two `Date`s per call: this
 * sits on the hottest path in the program and is invoked on the order of a
 * million times per report.
 */
export function monthOfStep(i: number): number {
  return DAY_MONTH[Math.floor(i / STEPS_PER_DAY)];
}

/** Local hour (0..23) for a given 15-minute step index. */
export function hourOfStep(i: number): number {
  return Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR);
}

export type Orientation = "south" | "east" | "west" | "east_west" | "north";

export type ChargeMode = "morning" | "cheapest" | "gridNegative";

/**
 * Normalise a charge-mode value that came from a URL. `midday` was the old
 * name for a fixed 10:00–15:00 window; it is mapped onto `cheapest` so that
 * links shared before the price-ranked charge plan existed keep working — and
 * keep getting a sensible plan rather than the old fixed window.
 */
export function parseChargeMode(value: string | null | undefined, fallback: ChargeMode): ChargeMode {
  if (value === "midday") return "cheapest";
  if (value === "morning" || value === "cheapest" || value === "gridNegative") return value;
  return fallback;
}

/**
 * How the daily discharge window is picked:
 *  - "windows": the most expensive whole-hour block inside the configured
 *    morning / evening clock ranges (the classic behaviour).
 *  - "peak": the single most expensive `capacityKWh / maxPowerKW` hours of the
 *    day, wherever they happen to fall — no clock window at all.
 */
export type DischargeMode = "windows" | "peak";

/**
 * Normalise a discharge-mode value that came from a URL. Anything unknown
 * (including a missing key) falls back to the fixed clock windows, so every
 * link shared before the peak strategy existed keeps its meaning.
 */
export function parseDischargeMode(
  value: string | null | undefined,
  fallback: DischargeMode,
): DischargeMode {
  if (value === "windows" || value === "peak") return value;
  return fallback;
}

export interface PVConfig {
  /** Peak power rating in kWp. */
  peakKWp: number;
  /** Module tilt above horizontal, in degrees (0 = flat roof). */
  tiltDeg: number;
  /** Surface orientation. */
  orientation: Orientation;
  /** Selected location key (see LOCATIONS). */
  location: string;
}

export interface BatteryConfig {
  /** Usable capacity in kWh. */
  capacityKWh: number;
  /** Maximum charge / discharge power in kW. */
  maxPowerKW: number;
  /** Minimum state of charge as a fraction (0..1). */
  minSOC: number;
  /** Maximum state of charge as a fraction (0..1). */
  maxSOC: number;
  /** Round-trip-ish efficiency applied per charge/discharge half-cycle. */
  efficiency: number;
  /** Start of day SOC as a fraction. */
  startSOC: number;
  /** Where / when the battery gets its energy.
   *  - "morning": store every kWh of own surplus the moment it appears.
   *  - "cheapest": store own surplus during the *cheapest* hours of each day.
   *    Storing surplus costs the spot price of the charging hour (that energy
   *    could have been exported instead), so filling the battery as early as
   *    possible leaves money on the table. This mode instead ranks the day's
   *    surplus hours by price and only fills the battery in the cheapest ones,
   *    so the later, more expensive discharge window earns the full spread.
   *  - "gridNegative": charge from PV surplus AND from the grid whenever the
   *    spot price is non-positive (free / negative electricity). */
  chargeMode: "morning" | "cheapest" | "gridNegative";
  /** How the discharge window is chosen. Optional so that existing callers
   *  (and older test fixtures) keep working — `undefined` behaves exactly like
   *  "windows", the pre-existing morning/evening clock behaviour.
   *  In "peak" mode the morning/evening hours below are ignored: the window is
   *  the `capacityKWh / maxPowerKW` most expensive hours of each day instead. */
  dischargeMode?: DischargeMode;
  /** Discharge into the expensive evening window. */
  dischargeEvening: boolean;
  /** Discharge into the expensive morning window. */
  dischargeMorning: boolean;
  /** Hour (local) the evening discharge window opens. */
  eveningStart: number;
  /** Hour (local) the evening discharge window closes. */
  eveningEnd: number;
  /** Hour (local) the morning discharge window opens. */
  morningStart: number;
  /** Hour (local) the morning discharge window closes. */
  morningEnd: number;
}

export interface TariffConfig {
  /** Constant feed-in tariff in EUR per kWh (Einspeisevergütung) used for comparison. */
  feedInEUR: number;
  /** Commissioning year, which sets the EEG reference value (anzulegender Wert). */
  commissioningYear: number;
}

export interface SimConfig {
  pv: PVConfig;
  battery: BatteryConfig;
  tariff: TariffConfig;
  /** Optional external 15-min price series (EUR/MWh), length TOTAL_STEPS. */
  prices?: Float64Array;
  /** Total household + device load per step (kWh), length TOTAL_STEPS. */
  load?: Float64Array;
  /** Optional wind turbine production per step (kWh), length TOTAL_STEPS. */
  wind?: Float64Array;
}

export interface SimResult {
  /** PV production per step (kWh). */
  pv: Float64Array;
  /** Wind turbine production per step (kWh). */
  wind: Float64Array;
  /** Combined PV + Wind generation per step (kWh) — used for battery dispatch. */
  generation: Float64Array;
  /** Price per step (EUR/MWh). */
  price: Float64Array;
  /** Total load per step (kWh). */
  load: Float64Array;
  /** State of charge per step (kWh). */
  soc: Float64Array;
  /** PV used directly to cover load per step (kWh). */
  directUse: Float64Array;
  /** Wind used directly to cover load per step (kWh). */
  directUseWind: Float64Array;
  /** PV stored in the battery per step (kWh). */
  chargeSolar: Float64Array;
  /** Wind stored in the battery per step (kWh). */
  chargeWind: Float64Array;
  /** Grid energy used to charge the battery per step (kWh). */
  chargeGrid: Float64Array;
  /** Battery energy discharged to cover load per step (kWh). */
  dischargeToLoad: Float64Array;
  /** Portion of dischargeToLoad that originated from PV (kWh). */
  dischargeToLoadPV: Float64Array;
  /** Portion of dischargeToLoad that originated from wind (kWh). */
  dischargeToLoadWind: Float64Array;
  /**
   * Portion of `dischargeToLoad` that came out of the grid — either bought in
   * this run (`chargeGrid`) or inherited from the battery's state of charge at
   * 00:00. It served a load, so it counts towards "energy drawn from the grid
   * to serve load", but it is *not* self-consumption: no generation of ours
   * produced it. This is why the report never needs a self-consumption cap.
   */
  dischargeToLoadGrid: Float64Array;
  /** Energy exported directly from PV per step (kWh). */
  exportSolar: Float64Array;
  /** Energy exported directly from wind per step (kWh). */
  exportWind: Float64Array;
  /** Energy exported from the battery per step (kWh). */
  exportBattery: Float64Array;
  /** Energy drawn from the grid per step (kWh). */
  gridImport: Float64Array;
  /** Total exported energy (solar + wind + battery) per step (kWh). */
  exportTotal: Float64Array;
}

export interface MonthlyRow {
  month: number; // 1..12
  pvKWh: number;
  windKWh: number;
  exportSolarKWh: number;
  exportWindKWh: number;
  exportBatteryKWh: number;
  chargeSolarKWh: number;
  chargeWindKWh: number;
  chargeGridKWh: number;
  exportKWh: number;
  marketValueEUR: number;
  gridChargeCostEUR: number;
  fixedValueEUR: number;
  premiumEUR: number;
}

export interface RevenueSummary {
  totalPVKWh: number;
  totalWindKWh: number;
  totalExportKWh: number;
  totalChargeGridKWh: number;
  marketValueEUR: number;
  gridChargeCostEUR: number;
  premiumEUR: number;
  /** EEG reference value (anzulegender Wert) in ct/kWh, blended by system size. */
  referenceValueCt: number;
  /** Computed market premium (Marktprämie) in ct/kWh. */
  marktPraemieCt: number;
  netMarketEUR: number;
  fixedValueEUR: number;
  /** netMarketEUR - fixedValueEUR */
  deltaEUR: number;
  vwapMarketEURperMWh: number;
  monthly: MonthlyRow[];
}
