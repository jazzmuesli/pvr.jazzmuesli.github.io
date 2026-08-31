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

/** 1-based month (1..12) for a given 15-minute step index. */
export function monthOfStep(i: number): number {
  const day = Math.floor(i / STEPS_PER_DAY);
  const base = new Date(Date.UTC(SIM_YEAR, 0, 1));
  const dt = new Date(base.getTime() + day * 86400000);
  return dt.getUTCMonth() + 1;
}

/** Local hour (0..23) for a given 15-minute step index. */
export function hourOfStep(i: number): number {
  return Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR);
}

export type Orientation = "south" | "east" | "west" | "east_west" | "north";

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
   *  - "morning": charge from PV surplus as soon as it is available (morning).
   *  - "midday": charge from PV surplus only around solar noon.
   *  - "gridNegative": charge from PV surplus AND from the grid whenever the
   *    spot price is non-positive (free / negative electricity). */
  chargeMode: "morning" | "midday" | "gridNegative";
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
}

export interface SimResult {
  /** PV production per step (kWh). */
  pv: Float64Array;
  /** Price per step (EUR/MWh). */
  price: Float64Array;
  /** Total load per step (kWh). */
  load: Float64Array;
  /** State of charge per step (kWh). */
  soc: Float64Array;
  /** PV used directly to cover load per step (kWh). */
  directUse: Float64Array;
  /** PV stored in the battery per step (kWh). */
  chargeSolar: Float64Array;
  /** Grid energy used to charge the battery per step (kWh). */
  chargeGrid: Float64Array;
  /** Battery energy discharged to cover load per step (kWh). */
  dischargeToLoad: Float64Array;
  /** Portion of dischargeToLoad that originated from PV (kWh). */
  dischargeToLoadPV: Float64Array;
  /** Energy exported directly from PV per step (kWh). */
  exportSolar: Float64Array;
  /** Energy exported from the battery per step (kWh). */
  exportBattery: Float64Array;
  /** Energy drawn from the grid per step (kWh). */
  gridImport: Float64Array;
  /** Total exported energy (solar + battery) per step (kWh). */
  exportTotal: Float64Array;
}

export interface MonthlyRow {
  month: number; // 1..12
  pvKWh: number;
  exportSolarKWh: number;
  exportBatteryKWh: number;
  chargeSolarKWh: number;
  chargeGridKWh: number;
  exportKWh: number;
  marketValueEUR: number;
  gridChargeCostEUR: number;
  fixedValueEUR: number;
  premiumEUR: number;
}

export interface RevenueSummary {
  totalPVKWh: number;
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
