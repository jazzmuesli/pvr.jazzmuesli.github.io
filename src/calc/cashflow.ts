// Multi-year cashflow model for PV + battery systems.
//
// Implements a discounted lifecycle cashflow analysis with PV degradation,
// electricity-price escalation, O&M costs, replacement investments (inverter +
// battery), and EEG feed-in tariff expiry — the core of a fair investment
// appraisal (NPV, IRR, LCOE, discounted payback).
//
// The model is driven by the *annual benefit* (what the system saves versus
// buying all electricity from the grid), scaled over the horizon by price
// escalation and PV degradation, and reduced by O&M, standby and replacement
// costs. This keeps it self-contained and purely unit-testable (no dispatch).

/**
 * Input parameters for the cashflow model.
 */
export interface CashflowInput {
  /** Year-0 annual system benefit (€): baselineCost − importCost + exportRevenue. */
  annualBenefitEUR: number;
  /** Year-0 annual PV production (kWh), used for LCOE. */
  annualPVKWh: number;
  /** Total system investment (€). */
  investmentEUR: number;
  /** PV peak power (kWp) — used only to derive a sensible default replacement cost. */
  peakKWp: number;
  /** Battery usable capacity (kWh) — used only to derive a sensible default replacement cost. */
  capacityKWh: number;
  /** EEG feed-in tariff (ct/kWh) — the fixed tariff paid for the first 20 years. */
  feedInCt: number;
  /** Retail import price (ct/kWh) — what grid electricity costs, used to value
   *  the battery standby draw (standby is consumed from the grid, not exported).
   *  Defaults to a typical retail rate when omitted. */
  importPriceCt?: number;
  /** Analysis horizon in years (default 20). */
  horizonYears: number;
  /** Discount / calculation interest rate in % p.a. (default 3). */
  discountRatePct: number;
  /** Electricity price escalation in % p.a. (default 2). */
  priceEscalationPct: number;
  /** O&M as % of investment per year (default 1.5). */
  omPercentPerYear: number;
  /** Inverter lifetime in years (default 13). */
  inverterLifetimeYears: number;
  /** Inverter replacement cost (€) (default 1500). */
  inverterReplacementCostEUR: number;
  /** Battery lifetime in years (default 13). */
  batteryLifetimeYears: number;
  /** Battery replacement cost (€) (default 600 × capacityKWh). */
  batteryReplacementCostEUR: number;
  /** Annual battery capacity degradation as a fraction (default 0.01 = 1 %/yr). */
  batteryDegradationPct: number;
  /** Annual PV yield degradation as a fraction (default 0.005 = 0.5 %/yr). */
  pvDegradationPct: number;
  /** Battery standby power draw in watts (default 5 W). */
  standbyWattage: number;
  /** Inflation for O&M / replacement costs in % p.a. (default 2). */
  omInflationPct: number;
}

/**
 * One year of the cashflow projection.
 */
export interface YearlyCashflow {
  /** Year number (0 = investment year). */
  year: number;
  /** PV yield factor (1.0 in year 0, degrades over time). */
  pvYieldFactor: number;
  /** Price escalation factor (1.0 in year 0). */
  priceFactor: number;
  /** Battery capacity factor (1.0 in year 0, degrades). */
  batteryCapacityFactor: number;
  /** Annual benefit (€) before O&M / replacements. */
  grossBenefitEUR: number;
  /** Operating & maintenance cost (€). */
  omCostEUR: number;
  /** Replacement investment cost (€). */
  replacementCostEUR: number;
  /** Standby electricity cost (€). */
  standbyCostEUR: number;
  /** Net cashflow for the year (€). */
  netCashflowEUR: number;
  /** Discounted net cashflow (€). */
  discountedCashflowEUR: number;
  /** Cumulative undiscounted cashflow (€). */
  cumulativeCashflowEUR: number;
  /** Cumulative discounted cashflow (€). */
  discountedCumulativeCashflowEUR: number;
}

/**
 * Output of the lifecycle cashflow analysis.
 */
export interface CashflowAnalysis {
  /** Simple (undiscounted) payback in years; Infinity if never positive. */
  simplePaybackYears: number;
  /** Discounted payback in years; Infinity if never positive. */
  discountedPaybackYears: number;
  /** Net Present Value (€) at the discount rate. */
  npvEUR: number;
  /** Internal Rate of Return in % p.a. (NaN if no valid root). */
  irrPercent: number;
  /** Levelized Cost of Energy (ct/kWh). */
  lcoeCtPerKWh: number;
  /** Year-by-year cashflow data. */
  yearly: YearlyCashflow[];
}

const DEFAULTS = {
  horizonYears: 20,
  discountRatePct: 3,
  priceEscalationPct: 2,
  omPercentPerYear: 1.5,
  inverterLifetimeYears: 13,
  inverterReplacementCostEUR: 1500,
  batteryLifetimeYears: 13,
  batteryDegradationPct: 0.01,
  pvDegradationPct: 0.005,
  standbyWattage: 5,
  omInflationPct: 2,
};

/**
 * Compute the lifecycle cashflow analysis.
 */
export function computeCashflow(input: CashflowInput): CashflowAnalysis {
  const horizonYears = input.horizonYears ?? DEFAULTS.horizonYears;
  const discountRatePct = input.discountRatePct ?? DEFAULTS.discountRatePct;
  const priceEscalationPct = input.priceEscalationPct ?? DEFAULTS.priceEscalationPct;
  const omPercentPerYear = input.omPercentPerYear ?? DEFAULTS.omPercentPerYear;
  const inverterLifetimeYears = input.inverterLifetimeYears ?? DEFAULTS.inverterLifetimeYears;
  const inverterReplacementCostEUR = input.inverterReplacementCostEUR ?? DEFAULTS.inverterReplacementCostEUR;
  const batteryLifetimeYears = input.batteryLifetimeYears ?? DEFAULTS.batteryLifetimeYears;
  const batteryReplacementCostEUR =
    input.batteryReplacementCostEUR ?? Math.round(input.capacityKWh * 600);
  const batteryDegradationPct = input.batteryDegradationPct ?? DEFAULTS.batteryDegradationPct;
  const pvDegradationPct = input.pvDegradationPct ?? DEFAULTS.pvDegradationPct;
  const standbyWattage = input.standbyWattage ?? DEFAULTS.standbyWattage;
  const omInflationPct = input.omInflationPct ?? DEFAULTS.omInflationPct;

  const discountRate = discountRatePct / 100;
  const priceEscalation = priceEscalationPct / 100;
  const omRate = omPercentPerYear / 100;
  const omInflation = omInflationPct / 100;

  const yearly: YearlyCashflow[] = [];

  // Year 0: only the initial investment.
  const year0: YearlyCashflow = {
    year: 0,
    pvYieldFactor: 1,
    priceFactor: 1,
    batteryCapacityFactor: 1,
    grossBenefitEUR: 0,
    omCostEUR: 0,
    replacementCostEUR: input.investmentEUR,
    standbyCostEUR: 0,
    netCashflowEUR: -input.investmentEUR,
    discountedCashflowEUR: -input.investmentEUR,
    cumulativeCashflowEUR: -input.investmentEUR,
    discountedCumulativeCashflowEUR: -input.investmentEUR,
  };
  yearly.push(year0);

  let cumulative = -input.investmentEUR;
  let discountedCumulative = -input.investmentEUR;

  for (let year = 1; year <= horizonYears; year++) {
    const pvYieldFactor = Math.pow(1 - pvDegradationPct, year);
    const batteryCapacityFactor = Math.pow(1 - batteryDegradationPct, year);
    const priceFactor = Math.pow(1 + priceEscalation, year);
    const omInflationFactor = Math.pow(1 + omInflation, year);

    // Gross benefit: year-0 saving, degraded by PV yield and escalated by price.
    const grossBenefitEUR = input.annualBenefitEUR * pvYieldFactor * priceFactor;

    const omCostEUR = input.investmentEUR * omRate * omInflationFactor;

    const standbyKWhPerYear = (standbyWattage / 1000) * 24 * 365;
    // Standby power is drawn FROM the grid, so it is valued at the retail import
    // price (not the much lower feed-in tariff). Fall back to a typical retail
    // rate if no import price was supplied.
    const standbyPriceCt = input.importPriceCt ?? 24;
    const standbyCostEUR = standbyKWhPerYear * (standbyPriceCt / 100) * priceFactor;

    let replacementCostEUR = 0;
    if (year % inverterLifetimeYears === 0) replacementCostEUR += inverterReplacementCostEUR;
    if (year % batteryLifetimeYears === 0) replacementCostEUR += batteryReplacementCostEUR;
    replacementCostEUR *= omInflationFactor;

    const netCashflowEUR = grossBenefitEUR - omCostEUR - replacementCostEUR - standbyCostEUR;
    const discountedCashflowEUR = netCashflowEUR / Math.pow(1 + discountRate, year);

    cumulative += netCashflowEUR;
    discountedCumulative += discountedCashflowEUR;

    yearly.push({
      year,
      pvYieldFactor,
      priceFactor,
      batteryCapacityFactor,
      grossBenefitEUR,
      omCostEUR,
      replacementCostEUR,
      standbyCostEUR,
      netCashflowEUR,
      discountedCashflowEUR,
      cumulativeCashflowEUR: cumulative,
      discountedCumulativeCashflowEUR: discountedCumulative,
    });
  }

  const npvEUR = discountedCumulative;
  const simplePaybackYears = paybackYears(yearly, (y) => y.cumulativeCashflowEUR);
  const discountedPaybackYears = paybackYears(yearly, (y) => y.discountedCumulativeCashflowEUR);
  const irrPercent = irr(yearly) * 100;
  const lcoeCtPerKWh = lcoe(yearly, input, discountRate, pvDegradationPct);

  return {
    simplePaybackYears,
    discountedPaybackYears,
    npvEUR,
    irrPercent,
    lcoeCtPerKWh,
    yearly,
  };
}

/**
 * Find the year in which a cumulative series turns non-negative, with linear
 * interpolation between the surrounding years. Returns Infinity if never.
 */
function paybackYears(yearly: YearlyCashflow[], series: (y: YearlyCashflow) => number): number {
  for (let i = 1; i < yearly.length; i++) {
    const prev = series(yearly[i - 1]);
    const curr = series(yearly[i]);
    if (curr >= 0) {
      if (prev >= 0) return yearly[i - 1].year;
      const fraction = Math.abs(prev) / Math.abs(prev - curr);
      return yearly[i - 1].year + fraction;
    }
  }
  return Infinity;
}

/**
 * Internal Rate of Return via Newton-Raphson on the NPV function.
 * Returns NaN when no valid root is found (e.g. a strictly loss-making project).
 */
function irr(yearly: YearlyCashflow[]): number {
  let guess = 0.05;
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0;
    let dnpv = 0;
    for (const y of yearly) {
      if (y.year === 0) {
        npv += y.netCashflowEUR;
        continue;
      }
      const df = Math.pow(1 + guess, y.year);
      npv += y.netCashflowEUR / df;
      dnpv += (-y.year * y.netCashflowEUR) / Math.pow(1 + guess, y.year + 1);
    }
    if (Math.abs(dnpv) < 1e-12) return Number.NaN;
    const next = guess - npv / dnpv;
    if (Math.abs(next - guess) < 1e-9) return next;
    guess = next;
    if (guess < -1) return Number.NaN;
  }
  return Number.NaN;
}

/**
 * Levelized Cost of Energy.
 *
 *   LCOE = Σ (Cost_t / (1+d)^t) / Σ (Energy_t / (1+d)^t)
 *
 * Costs include the initial investment (year 0), O&M and replacement costs.
 * Energy is the degraded annual PV production. Result in ct/kWh.
 */
function lcoe(
  yearly: YearlyCashflow[],
  input: CashflowInput,
  discountRate: number,
  pvDegradationPct: number
): number {
  let discountedCosts = 0;
  let discountedEnergy = 0;

  for (const y of yearly) {
    const discountFactor = Math.pow(1 + discountRate, y.year);
    if (y.year === 0) {
      discountedCosts += input.investmentEUR;
      continue;
    }
    discountedCosts += (y.omCostEUR + y.replacementCostEUR) / discountFactor;
    const energyKWh = input.annualPVKWh * Math.pow(1 - pvDegradationPct, y.year);
    discountedEnergy += energyKWh / discountFactor;
  }

  if (discountedEnergy <= 0) return 0;
  return (discountedCosts / discountedEnergy) * 100;
}
