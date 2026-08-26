import { SimConfig } from "../calc/types";
import { LOCATIONS, DEFAULT_LOCATION } from "../calc/solar";
import { ConsumerConfig, totalLoad } from "../calc/consumers";
import { TariffScheme } from "../calc/tariff";
import { SimParams } from "../calc/report";
import { CarParams, DEFAULT_CAR_PARAMS } from "../calc/car";

export type Orientation = "south" | "east" | "west" | "east_west";

export interface AppState {
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
  // Heizung: JAZ der Wärmepumpe und ihr Strompreis (ct/kWh) für den
  // Kostenvergleich mit Heizöl / Gas.
  heatpumpJaz: number;
  heatpumpElectricCt: number;
  // Opportunitätskosten: E-Auto vs. Diesel (jährliche Fahrleistung u. a.).
  car: CarParams;
}

export const DEFAULT_STATE: AppState = {
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
  heatpumpJaz: 3,
  heatpumpElectricCt: 24,
  car: { ...DEFAULT_CAR_PARAMS },
};

/** Map the UI state onto the pure simulation parameters. */
export function toSimParams(s: AppState): SimParams {
  return {
    peakKWp: s.peakKWp,
    tiltDeg: s.tiltDeg,
    orientation: s.orientation,
    location: s.location,
    capacityKWh: s.capacityKWh,
    maxPowerKW: s.maxPowerKW,
    minSOC: s.minSOC,
    maxSOC: s.maxSOC,
    efficiency: s.efficiency,
    startSOC: s.startSOC,
    chargeMode: s.chargeMode,
    dischargeEvening: s.dischargeEvening,
    dischargeMorning: s.dischargeMorning,
    eveningStart: s.eveningStart,
    eveningEnd: s.eveningEnd,
    morningStart: s.morningStart,
    morningEnd: s.morningEnd,
    feedInCt: s.feedInCt,
    commissioningYear: s.commissioningYear,
    priceYear: s.priceYear,
    consumers: s.consumers,
    exportScheme: s.exportScheme,
    importScheme: s.importScheme,
    importFixedCt: s.importFixedCt,
    investmentEUR: s.investmentEUR,
    heatpumpJaz: s.heatpumpJaz,
    heatpumpElectricCt: s.heatpumpElectricCt,
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
