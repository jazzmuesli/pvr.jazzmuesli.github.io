import { SimConfig } from "../calc/types";
import { LOCATIONS, DEFAULT_LOCATION } from "../calc/solar";
import { ConsumerConfig, totalLoad } from "../calc/consumers";
import { TariffScheme } from "../calc/tariff";
import { SimParams } from "../calc/report";
import { CarParams, DEFAULT_CAR_PARAMS } from "../calc/car";

export type Orientation = "south" | "east" | "west" | "east_west";

export interface AppState {
  expertMode: boolean;
  peakKWp: number;
  tiltDeg: number;
  orientation: Orientation;
  location: string;
  capacityKWh: number;
  maxPowerKW: number;
  minSOC: number;
  maxSOC: number;
  efficiency: number;
  startSOC: number;
  chargeMode: "morning" | "midday" | "gridNegative";
  dischargeEvening: boolean;
  dischargeMorning: boolean;
  eveningStart: number;
  eveningEnd: number;
  morningStart: number;
  morningEnd: number;
  feedInCt: number; // ct/kWh
  commissioningYear: number;
  priceYear: string;
  // Verbraucher
  consumers: ConsumerConfig;
  // Einspeisung (Export)
  exportScheme: "fixed" | "market";
  // Stromtarif (Import)
  importScheme: TariffScheme;
  importFixedCt: number; // ct/kWh
  // Investition: eine einzige Gesamtinvestition (€), unabhängig von kWp/kWh.
  investmentEUR: number;
  // Ökonomische Parameter (Lebensdauer-Cashflow).
  horizonYears: number;
  discountRatePct: number;
  priceEscalationPct: number;
  omPercentPerYear: number;
  inverterLifetimeYears: number;
  inverterReplacementCostEUR: number;
  batteryLifetimeYears: number;
  batteryReplacementCostEUR: number;
  batteryDegradationPct: number;
  pvDegradationPct: number;
  standbyWattage: number;
  // Heizung: JAZ der Wärmepumpe und ihr Strompreis (ct/kWh) für den
  // Kostenvergleich mit Heizöl / Gas.
  heatpumpJaz: number;
  heatpumpElectricCt: number;
  // Opportunitätskosten: E-Auto vs. Diesel (jährliche Fahrleistung u. a.).
  car: CarParams;
}

export const DEFAULT_STATE: AppState = {
  expertMode: false,
  peakKWp: 22,
  tiltDeg: 35,
  orientation: "east_west",
  location: "boizenburg",
  capacityKWh: 19.353,
  maxPowerKW: 6,
  minSOC: 0.1,
  maxSOC: 0.95,
  efficiency: 0.95,
  startSOC: 0.5,
  chargeMode: "morning",
  dischargeEvening: true,
  dischargeMorning: true,
  eveningStart: 17,
  eveningEnd: 23,
  morningStart: 5,
  morningEnd: 12,
  feedInCt: 7.2,
  commissioningYear: 2025,
  priceYear: "2025",
  consumers: {
    // Profile calibrated to the real household data in ~/MyDocuments/ha:
    // heat pump ~6.6 MWh/yr (temp-driven, winter-heavy), base load ~2.4 MWh/yr.
    household: { enabled: true, annualKWh: 2400 },
    heatpump: { enabled: true, annualKWh: 6500 },
    bwwp: { enabled: true },
    ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
  },
  exportScheme: "fixed",
  importScheme: "fixed",
  importFixedCt: 24,
  investmentEUR: 32000,
  horizonYears: 20,
  discountRatePct: 3,
  priceEscalationPct: 2,
  omPercentPerYear: 1.5,
  inverterLifetimeYears: 13,
  inverterReplacementCostEUR: 1500,
  batteryLifetimeYears: 13,
  batteryReplacementCostEUR: 6000,
  batteryDegradationPct: 0.01,
  pvDegradationPct: 0.005,
  standbyWattage: 5,
  heatpumpJaz: 3,
  heatpumpElectricCt: 24,
  car: { ...DEFAULT_CAR_PARAMS },
};

/** Map the UI state onto the pure simulation parameters. */
export function toSimParams(s: AppState): SimParams {
  // In simple mode, derive sensible battery defaults from capacity.
  const cap = s.capacityKWh;
  const maxPowerKW = s.expertMode ? s.maxPowerKW : Math.min(cap * 0.33, 20);
  const minSOC = s.expertMode ? s.minSOC : 0.1;
  const maxSOC = s.expertMode ? s.maxSOC : 0.95;
  const efficiency = s.expertMode ? s.efficiency : 0.95;
  const startSOC = s.expertMode ? s.startSOC : 0.5;
  const chargeMode = s.expertMode ? s.chargeMode : "morning";
  const dischargeEvening = s.expertMode ? s.dischargeEvening : true;
  const dischargeMorning = s.expertMode ? s.dischargeMorning : true;
  const eveningStart = s.expertMode ? s.eveningStart : 17;
  const eveningEnd = s.expertMode ? s.eveningEnd : 23;
  const morningStart = s.expertMode ? s.morningStart : 5;
  const morningEnd = s.expertMode ? s.morningEnd : 12;
  return {
    peakKWp: s.peakKWp,
    tiltDeg: s.tiltDeg,
    orientation: s.orientation,
    location: s.location,
    capacityKWh: cap,
    maxPowerKW,
    minSOC,
    maxSOC,
    efficiency,
    startSOC,
    chargeMode,
    dischargeEvening,
    dischargeMorning,
    eveningStart,
    eveningEnd,
    morningStart,
    morningEnd,
    feedInCt: s.feedInCt,
    commissioningYear: s.commissioningYear,
    priceYear: s.priceYear,
    consumers: s.consumers,
    exportScheme: s.exportScheme,
    importScheme: s.importScheme,
    importFixedCt: s.importFixedCt,
    investmentEUR: s.investmentEUR,
    horizonYears: s.horizonYears,
    discountRatePct: s.discountRatePct,
    priceEscalationPct: s.priceEscalationPct,
    omPercentPerYear: s.omPercentPerYear,
    inverterLifetimeYears: s.inverterLifetimeYears,
    inverterReplacementCostEUR: s.inverterReplacementCostEUR,
    batteryLifetimeYears: s.batteryLifetimeYears,
    batteryReplacementCostEUR: s.batteryReplacementCostEUR,
    batteryDegradationPct: s.batteryDegradationPct,
    pvDegradationPct: s.pvDegradationPct,
    standbyWattage: s.standbyWattage,
    heatpumpJaz: s.heatpumpJaz,
    heatpumpElectricCt: s.importFixedCt,
    car: { ...s.car },
  };
}

export function toSimConfig(s: AppState): SimConfig {
  const hasBattery = s.capacityKWh > 0;
  return {
    pv: {
      peakKWp: s.peakKWp,
      tiltDeg: s.tiltDeg,
      orientation: s.orientation,
      location: s.location in LOCATIONS ? s.location : DEFAULT_LOCATION,
    },
    battery: {
      capacityKWh: s.capacityKWh,
      maxPowerKW: s.maxPowerKW,
      minSOC: s.minSOC,
      maxSOC: s.maxSOC,
      efficiency: s.efficiency,
      startSOC: s.startSOC,
      chargeMode: s.chargeMode,
      dischargeEvening: hasBattery && s.dischargeEvening,
      dischargeMorning: hasBattery && s.dischargeMorning,
      eveningStart: s.eveningStart,
      eveningEnd: s.eveningEnd,
      morningStart: s.morningStart,
      morningEnd: s.morningEnd,
    },
    tariff: {
      feedInEUR: s.feedInCt / 100,
      commissioningYear: s.commissioningYear,
    },
    load: totalLoad(s.consumers),
  };
}
