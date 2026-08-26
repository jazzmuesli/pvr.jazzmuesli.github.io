// Standard (simple) amortisation of a PV + battery system.
//
// Simple payback period = total investment / annual net benefit, where the
// annual benefit is what the system saves versus buying *all* electricity from
// the grid (a "Volleinspeisung aus dem Netz" baseline):
//
//     annualBenefit = baselineCost − importCost + exportRevenue
//                   = baselineCost + systemNetEUR
//
// with systemNetEUR = exportRevenue − importCost (the system's net cash flow).
// Investment is the sum of PV (per kWp) and battery (per kWh) capital cost.

export interface AmortisationInput {
  peakKWp: number;
  capacityKWh: number;
  /** Cost of importing the entire load at the chosen tariff (no PV, no battery). */
  baselineCostEUR: number;
  /** Net cash flow of the system: exportRevenue − importCost (EUR). */
  systemNetEUR: number;
  /** PV capital cost per kWp (€). */
  pvCostPerKWp?: number;
  /** Battery capital cost per kWh (€). */
  batteryCostPerKWh?: number;
}

export interface Amortisation {
  pvInvestmentEUR: number;
  batteryInvestmentEUR: number;
  totalInvestmentEUR: number;
  annualBenefitEUR: number;
  /** Simple payback in years; Infinity if the system is not beneficial. */
  paybackYears: number;
}

export const DEFAULT_PV_COST_PER_KWP = 1100;
export const DEFAULT_BATTERY_COST_PER_KWH = 400;

export function computeAmortisation(input: AmortisationInput): Amortisation {
  const pv = input.pvCostPerKWp ?? DEFAULT_PV_COST_PER_KWP;
  const bat = input.batteryCostPerKWh ?? DEFAULT_BATTERY_COST_PER_KWH;
  const pvInvestmentEUR = Math.max(0, input.peakKWp) * pv;
  const batteryInvestmentEUR = Math.max(0, input.capacityKWh) * bat;
  const totalInvestmentEUR = pvInvestmentEUR + batteryInvestmentEUR;
  const annualBenefitEUR = input.baselineCostEUR + input.systemNetEUR;
  const paybackYears = annualBenefitEUR > 0 ? totalInvestmentEUR / annualBenefitEUR : Infinity;
  return {
    pvInvestmentEUR,
    batteryInvestmentEUR,
    totalInvestmentEUR,
    annualBenefitEUR,
    paybackYears,
  };
}
