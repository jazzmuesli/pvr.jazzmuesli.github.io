// The flat configuration contract of the simulator, and its defaults.
//
// `SimParams` is the single input shape shared by the UI, the `/api` endpoint
// and the engine adapter. It lives in its own leaf module so that every
// consumer (the report orchestrator, the CO₂ analysis, the market comparison,
// the config adapter) can depend on it without creating a cycle back into the
// orchestrator.

import { Orientation, DischargeMode } from "./types";
import { ConsumerConfig } from "./consumers";
import { CarParams, DEFAULT_CAR_PARAMS } from "./car";

export interface SimParams {
  // PV
  peakKWp: number;
  tiltDeg: number;
  orientation: Orientation;
  location: string;
  // Battery
  capacityKWh: number;
  maxPowerKW: number;
  minSOC: number;
  maxSOC: number;
  efficiency: number;
  startSOC: number;
  chargeMode: "morning" | "cheapest" | "gridNegative";
  /** How the daily discharge window is chosen: fixed clock windows or the
   *  `capacityKWh / maxPowerKW` most expensive hours of the day. */
  dischargeMode: DischargeMode;
  dischargeEvening: boolean;
  dischargeMorning: boolean;
  eveningStart: number;
  eveningEnd: number;
  morningStart: number;
  morningEnd: number;
  // Tariff
  feedInCt: number;
  commissioningYear: number;
  priceYear: string;
  // Consumers
  consumers: ConsumerConfig;
  // Export / import scheme
  exportScheme: "fixed" | "market";
  importScheme: "fixed" | "dynamic" | "dynamic14a";
  importFixedCt: number;
  // Cost — a single total, independent of kWp / kWh size.
  investmentEUR: number;
  // Economic parameters
  horizonYears: number;           // Analysis period (default 20)
  discountRatePct: number;        // Discount rate for NPV (default 3%)
  priceEscalationPct: number;     // Electricity price escalation (default 2%)
  omPercentPerYear: number;       // O&M as % of investment/year (default 1.5%)
  inverterLifetimeYears: number;  // Inverter lifespan (default 13)
  inverterReplacementCostEUR: number; // Inverter replacement cost (default 1500)
  batteryLifetimeYears: number;   // Battery lifespan (default 13)
  batteryReplacementCostEUR: number; // Battery replacement cost (default 300 * capacityKWh)
  batteryDegradationPct: number;  // Annual battery degradation (default 0.01 = 1%)
  pvDegradationPct: number;       // Annual PV degradation (default 0.005 = 0.5%)
  standbyWattage: number;         // Battery standby consumption (default 5W)
  // Heating: JAZ of the heat pump and its electricity price (for the
  // fossil-fuelled alternative cost comparison in `heating`).
  heatpumpJaz: number;
  heatpumpElectricCt: number;
  // Opportunity-cost comparison inputs (heating + EV vs. diesel). The defaults
  // are realistic for a German household; the heat-pump electricity comes from
  // the heat-pump consumer above.
  car: CarParams;
  // Direktvermarkter-Marge in ct/kWh (only applied when exportScheme === "market").
  marketMarginCt: number;
  // Kleinwindkraftanlage (Expert-Modus)
  windEnabled: boolean;
  windCount: number;
  windHubHeightM: number;
  windTurbineId: string;
  windSpeedMeanMs: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  peakKWp: 10,
  tiltDeg: 35,
  orientation: "south",
  location: "hamburg",
  capacityKWh: 10,
  maxPowerKW: 5,
  minSOC: 0.1,
  maxSOC: 0.9,
  efficiency: 0.95,
  startSOC: 0.5,
  chargeMode: "morning",
  dischargeMode: "windows",
  dischargeEvening: true,
  dischargeMorning: false,
  eveningStart: 17,
  eveningEnd: 21,
  morningStart: 6,
  morningEnd: 9,
  feedInCt: 7.2,
  commissioningYear: 2025,
  priceYear: "2025",
  // Economic parameters
  horizonYears: 20,
  discountRatePct: 3,
  priceEscalationPct: 2,
  omPercentPerYear: 1.5,
  inverterLifetimeYears: 13,
  inverterReplacementCostEUR: 1500,
  batteryLifetimeYears: 13,
  batteryReplacementCostEUR: 3000,
  batteryDegradationPct: 0.01,
  pvDegradationPct: 0.005,
  standbyWattage: 5,
  // Consumers
  consumers: {
    household: { enabled: true, annualKWh: 2400 },
    heatpump: { enabled: true, annualKWh: 5000 },
    bwwp: { enabled: true, annualKWh: 480 },
    ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
  },
  exportScheme: "fixed",
  importScheme: "fixed",
  importFixedCt: 24,
  investmentEUR: 32000,
  // Heating: JAZ of the heat pump and its electricity price (for the
  // fossil-fuelled alternative cost comparison in `heating`).
  heatpumpJaz: 3,
  heatpumpElectricCt: 24,
  // Opportunity-cost comparison inputs (heating + EV vs. diesel). The defaults
  // are realistic for a German household; the heat-pump electricity comes from
  // the heat-pump consumer above.
  car: { ...DEFAULT_CAR_PARAMS },
  marketMarginCt: 1,
  windEnabled: false,
  windCount: 1,
  windHubHeightM: 10,
  windTurbineId: "skywind_ng",
  windSpeedMeanMs: 4.8,
};
