// Heating cost comparison for the heat-pump vs. fossil alternatives.
//
// The heat pump delivers useful heat (Wärmeenergie) from electricity. Its
// efficiency is the Jahresarbeitszahl (JAZ): useful heat [kWh] per kWh of
// electricity consumed. To make a fair comparison we ask: for the *same*
// amount of useful heat, what would it cost to produce it with heating oil
// (Heizöl) or natural gas (Gas), including the boiler efficiency, the
// Schornsteinfeger and — for gas — the grid fee and other Nebenkosten?
//
// Everything here is a pure function of `HeatingParams` and carries no DOM /
// simulation state, so it is independently unit-testable.

// ---------------------------------------------------------------------------
// Default assumptions (documented in README). All defaults are realistic for
// a German household in ~2025 and can be overridden per call.
// ---------------------------------------------------------------------------

/** Heating-oil price, € per 100 L. */
export const DEFAULT_OIL_EUR_PER_100L = 130;
/** Lower heating value of heating oil, kWh per litre. */
export const DEFAULT_OIL_KWH_PER_L = 10;
/** Typical oil boiler efficiency (utilisation of the fuel's energy). */
export const DEFAULT_OIL_EFFICIENCY = 0.85;

/** Natural-gas price, ct per kWh. */
export const DEFAULT_GAS_CT_PER_KWH = 11;
/** Condensing gas boiler efficiency. */
export const DEFAULT_GAS_EFFICIENCY = 0.92;
/** Gas netzentgelt (distribution fee), ct per kWh. */
export const DEFAULT_GAS_GRID_FEE_CT_PER_KWH = 2.0;
/** Gas Grundgebühr + other Nebenkosten per year, €. */
export const DEFAULT_GAS_NEBENKOSTEN_EUR = 120;

/** Schornsteinfeger (chimney sweep) per year, € — needed for both oil and gas. */
export const DEFAULT_CHIMNEY_SWEEP_EUR = 200;

/** Default heat-pump electricity price, ct per kWh (WP often on a special tariff). */
export const DEFAULT_HEATPUMP_ELECTRIC_CT = 24;

export interface HeatingParams {
  /** Electricity consumed by the heat pump (kWh/year). */
  heatpumpElectricKWh: number;
  /** Jahresarbeitszahl: useful heat per kWh of electricity. Default 3. */
  jaz: number;

  /** Heat-pump electricity price (ct/kWh). Default 24. */
  heatpumpElectricCt: number;

  // --- Heating oil -------------------------------------------------------
  oilEurPer100L: number;
  oilKWhPerL: number;
  oilEfficiency: number;
  oilChimneySweepEUR: number;

  // --- Natural gas -------------------------------------------------------
  gasCtPerKWh: number;
  gasEfficiency: number;
  gasGridFeeCtPerKWh: number;
  gasNebenkostenEUR: number;
  gasChimneySweepEUR: number;
}

export const DEFAULT_HEATING_PARAMS: Omit<HeatingParams, "heatpumpElectricKWh" | "jaz"> = {
  heatpumpElectricCt: DEFAULT_HEATPUMP_ELECTRIC_CT,
  oilEurPer100L: DEFAULT_OIL_EUR_PER_100L,
  oilKWhPerL: DEFAULT_OIL_KWH_PER_L,
  oilEfficiency: DEFAULT_OIL_EFFICIENCY,
  oilChimneySweepEUR: DEFAULT_CHIMNEY_SWEEP_EUR,
  gasCtPerKWh: DEFAULT_GAS_CT_PER_KWH,
  gasEfficiency: DEFAULT_GAS_EFFICIENCY,
  gasGridFeeCtPerKWh: DEFAULT_GAS_GRID_FEE_CT_PER_KWH,
  gasNebenkostenEUR: DEFAULT_GAS_NEBENKOSTEN_EUR,
  gasChimneySweepEUR: DEFAULT_CHIMNEY_SWEEP_EUR,
};

export type HeatingMode = "heatpump" | "oil" | "gas";

export interface HeatingAlternative {
  mode: HeatingMode;
  label: string;
  /** Useful heat delivered (kWh) — identical for all three modes. */
  usefulHeatKWh: number;
  /** Primary energy input (kWh): electricity for WP, oil kWh, gas kWh. */
  primaryEnergyKWh: number;
  /** Fuel / energy cost (€). */
  energyCostEUR: number;
  /** Grid / network fee (€) — gas netzentgelt; 0 for WP and oil. */
  gridFeeEUR: number;
  /** Schornsteinfeger (€). */
  chimneySweepEUR: number;
  /** Other Nebenkosten such as Grundgebühr (€). */
  otherNebenkostenEUR: number;
  /** Sum of all cost components (€). */
  totalEUR: number;
  /** For oil/gas: totalEUR − heatpump.totalEUR (positive = more expensive). */
  deltaVsHeatpumpEUR: number;
}

/** How much of the heat pump's electricity is covered by own PV+battery. */
export interface ConsumerCoverageInfo {
  /** kWh served from own PV+battery (self-consumption). */
  pvCoveredKWh: number;
  /** kWh drawn from the grid. */
  gridKWh: number;
  /** Share of consumption covered by PV+battery (%). */
  pvSharePct: number;
  /** Grid-only price (ct/kWh) — VWAP of the grid-import hours for dynamic tariffs. */
  gridPriceCt: number;
  /** Blended effective price over the whole consumption (ct/kWh). */
  effectiveCt: number;
  /** True when the import tariff is dynamic/§14a (price is a VWAP), else fixed. */
  dynamic: boolean;
}

export interface HeatingReport {
  jaz: number;
  heatpumpElectricKWh: number;
  usefulHeatKWh: number;
  heatpump: HeatingAlternative;
  oil: HeatingAlternative;
  gas: HeatingAlternative;
  /** PV+battery coverage of the heat pump's electricity (optional). */
  coverage?: ConsumerCoverageInfo;
}

/** Useful heat delivered by the heat pump: electricity × JAZ. */
export function usefulHeatKWh(electricKWh: number, jaz: number): number {
  return electricKWh * jaz;
}

/** Cost of producing the heat with the heat pump (electricity only). */
export function heatpumpAlternative(p: HeatingParams, usefulHeat: number): HeatingAlternative {
  const primaryEnergyKWh = p.heatpumpElectricKWh;
  const energyCostEUR = (primaryEnergyKWh * p.heatpumpElectricCt) / 100;
  const totalEUR = energyCostEUR;
  return {
    mode: "heatpump",
    label: "Wärmepumpe",
    usefulHeatKWh: usefulHeat,
    primaryEnergyKWh,
    energyCostEUR: round2(totalEUR),
    gridFeeEUR: 0,
    chimneySweepEUR: 0,
    otherNebenkostenEUR: 0,
    totalEUR: round2(totalEUR),
    deltaVsHeatpumpEUR: 0,
  };
}

/** Cost of producing the same heat with heating oil, including a boiler. */
export function oilAlternative(p: HeatingParams, usefulHeat: number): HeatingAlternative {
  const primaryEnergyKWh = usefulHeat / p.oilEfficiency; // kWh of oil energy needed
  const litres = primaryEnergyKWh / p.oilKWhPerL;
  const energyCostEUR = litres * (p.oilEurPer100L / 100);
  const totalEUR = energyCostEUR + p.oilChimneySweepEUR;
  return {
    mode: "oil",
    label: "Heizöl",
    usefulHeatKWh: usefulHeat,
    primaryEnergyKWh: round2(primaryEnergyKWh),
    energyCostEUR: round2(energyCostEUR),
    gridFeeEUR: 0,
    chimneySweepEUR: p.oilChimneySweepEUR,
    otherNebenkostenEUR: 0,
    totalEUR: round2(totalEUR),
    deltaVsHeatpumpEUR: round2(totalEUR) - round2(heatpumpAlternative(p, usefulHeat).totalEUR),
  };
}

/** Cost of producing the same heat with gas, including netzentgelt & Nebenkosten. */
export function gasAlternative(p: HeatingParams, usefulHeat: number): HeatingAlternative {
  const primaryEnergyKWh = usefulHeat / p.gasEfficiency; // kWh of gas needed
  const energyCostEUR = (primaryEnergyKWh * p.gasCtPerKWh) / 100;
  const gridFeeEUR = (primaryEnergyKWh * p.gasGridFeeCtPerKWh) / 100;
  const totalEUR = energyCostEUR + gridFeeEUR + p.gasNebenkostenEUR + p.gasChimneySweepEUR;
  return {
    mode: "gas",
    label: "Erdgas",
    usefulHeatKWh: usefulHeat,
    primaryEnergyKWh: round2(primaryEnergyKWh),
    energyCostEUR: round2(energyCostEUR),
    gridFeeEUR: round2(gridFeeEUR),
    chimneySweepEUR: p.gasChimneySweepEUR,
    otherNebenkostenEUR: p.gasNebenkostenEUR,
    totalEUR: round2(totalEUR),
    deltaVsHeatpumpEUR: round2(totalEUR) - round2(heatpumpAlternative(p, usefulHeat).totalEUR),
  };
}

/**
 * Full heating comparison. Returns `null` when the heat pump is disabled /
 * has no consumption, so callers can simply omit the section.
 */
export function computeHeating(p: HeatingParams): HeatingReport {
  const usefulHeat = usefulHeatKWh(p.heatpumpElectricKWh, p.jaz);
  const heatpump = heatpumpAlternative(p, usefulHeat);
  const oil = oilAlternative(p, usefulHeat);
  const gas = gasAlternative(p, usefulHeat);
  // Recompute deltas against the exact heatpump total for consistency.
  oil.deltaVsHeatpumpEUR = round2(oil.totalEUR - heatpump.totalEUR);
  gas.deltaVsHeatpumpEUR = round2(gas.totalEUR - heatpump.totalEUR);
  return {
    jaz: p.jaz,
    heatpumpElectricKWh: p.heatpumpElectricKWh,
    usefulHeatKWh: round2(usefulHeat),
    heatpump,
    oil,
    gas,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
