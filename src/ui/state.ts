import { SimConfig } from "../calc/types";
import { LOCATIONS, DEFAULT_LOCATION } from "../calc/solar";
import { ConsumerConfig, totalLoad } from "../calc/consumers";
import { TariffScheme } from "../calc/tariff";

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
    household: { enabled: true, annualKWh: 4000 },
    heatpump: { enabled: true, annualKWh: 5000 },
    bwwp: { enabled: true },
    ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
  },
  exportScheme: "fixed",
  importScheme: "fixed",
  importFixedCt: 24,
};

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
