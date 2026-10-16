/**
 * Canonical scenario fixtures shared by the higher-level tests.
 *
 * These are deliberately *feature-shaped*, not random: each one pins a
 * different capability of the simulator so that a characterisation snapshot
 * covers the whole feature surface rather than a single lucky configuration.
 * Adding a new feature means adding one entry here, which is what keeps the
 * golden snapshots an honest regression net.
 */

import { DEFAULT_SIM_PARAMS, SimParams } from "../src/calc/report";
import { ConsumerConfig } from "../src/calc/consumers";
import { DEFAULT_STATE } from "../src/ui/state";

const consumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 5000 },
  bwwp: { enabled: true, annualKWh: 480 },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

/** Spread consumer sub-configs so the aggregate tables are exercised too. */
const noConsumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 3200 },
  heatpump: { enabled: false, annualKWh: 0 },
  bwwp: { enabled: false, annualKWh: 480 },
  ev: { enabled: false, annualKWh: 0, pvShare: 0 },
};

/** The parameter set the API/CLI defaults to (no consumer overrides). */
export function baselineParams(): SimParams {
  return { ...DEFAULT_SIM_PARAMS, consumers };
}

/** `{}` — the true out-of-the-box defaults, exactly what `/api?` returns. */
export function defaultParams(): SimParams {
  return JSON.parse(JSON.stringify(DEFAULT_SIM_PARAMS)) as SimParams;
}

/** What the SPA shows on a cold load with an empty URL. */
export function spaDefaultParams(): SimParams {
  return JSON.parse(JSON.stringify(DEFAULT_STATE)) as SimParams;
}

export interface Scenario {
  name: string;
  /** Short human description of which capability this pins down. */
  about: string;
  params: SimParams;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "baseline",
    about: "PV + battery, all four consumers, fixed feed-in, fixed import",
    params: baselineParams(),
  },
  {
    name: "defaults",
    about: "DEFAULT_SIM_PARAMS verbatim: the /api and library contract",
    params: defaultParams(),
  },
  {
    name: "spa-default",
    about: "The SPA's own DEFAULT_STATE mapped through the UI mapper",
    params: spaDefaultParams(),
  },
  {
    name: "no-battery",
    about: "PV only, no storage: export-only economics",
    params: { ...baselineParams(), capacityKWh: 0, maxPowerKW: 0 },
  },
  {
    name: "no-pv-no-battery",
    about: "Pure consumption: grid mix, CO2 and opportunity costs without generation",
    params: { ...baselineParams(), peakKWp: 0, capacityKWh: 0, maxPowerKW: 0, consumers: noConsumers },
  },
  {
    name: "direct-marketing",
    about: "Direktvermarktung (Marktprämie) export with dynamic import",
    params: { ...baselineParams(), exportScheme: "market", importScheme: "dynamic" },
  },
  {
    name: "d14a",
    about: "§ 14a Modul 3 dynamic import windows",
    params: { ...baselineParams(), importScheme: "dynamic14a", exportScheme: "market" },
  },
  {
    name: "charge-cheapest",
    about: "Price-aware charging: the battery chases the cheapest hours",
    params: { ...baselineParams(), chargeMode: "cheapest", dischargeMode: "peak" },
  },
  {
    name: "charge-gridnegative",
    about: "Grid charging when spot prices go negative (arbitrage branch)",
    params: { ...baselineParams(), chargeMode: "gridNegative", dischargeMode: "windows" },
  },
  {
    // A large battery behind a *small* array, in the year with the most
    // negative price hours. This is the only shape in which the grid-charging
    // branch fires at all on real data: the battery is empty when the negative
    // hours arrive, so the dispatch genuinely buys from the grid. It is also
    // the configuration in which stored-energy origin tracking matters, and in
    // which the old code reported grid-bought kWh as PV self-consumption.
    //
    // Found by sweeping 4 price years x 6 capacities x 5 array sizes: with the
    // default 22 kWp array the battery is always full during a negative hour
    // and `chargeGrid` is exactly zero. See refactoring.md.
    name: "grid-arbitrage",
    about: "Large battery, small array, 2024 prices: genuine grid-to-battery arbitrage",
    params: {
      ...baselineParams(),
      priceYear: "2024",
      peakKWp: 4,
      capacityKWh: 19.353,
      maxPowerKW: 3,
      maxSOC: 0.9,
      chargeMode: "gridNegative",
      dischargeMode: "windows",
    },
  },
  {
    name: "wind",
    about: "Kleinwindkraft: wind production, mixed export and CO2 factors",
    params: { ...baselineParams(), windEnabled: true, windCount: 2, windTurbineId: "enercon_e101" },
  },
  {
    name: "bwwp-off",
    about: "BWWP disabled: hot-water load must route into the heat pump",
    params: { ...baselineParams(), consumers: { ...consumers, bwwp: { enabled: false, annualKWh: 480 } } },
  },
  {
    name: "long-horizon",
    about: "30-year horizon with escalation, degradation and battery replacement",
    params: {
      ...baselineParams(),
      horizonYears: 30,
      discountRatePct: 4,
      priceEscalationPct: 3,
      batteryLifetimeYears: 10,
      inverterLifetimeYears: 12,
    },
  },
];

export function scenarioParams(name: string): SimParams {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario: ${name}`);
  return JSON.parse(JSON.stringify(s.params)) as SimParams;
}