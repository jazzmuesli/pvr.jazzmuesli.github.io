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
//
// Investment is supplied as a single total (€) so it can be set independently
// of the kWp / kWh sizes — see `investmentEUR` in the UI / API.

export interface AmortisationInput {
  /** Cost of importing the entire load at the chosen tariff (no PV, no battery). */
  baselineCostEUR: number;
  /** Net cash flow of the system: exportRevenue − importCost (EUR). */
  systemNetEUR: number;
  /** Total system investment (€), set independently of the kWp / kWh size. */
  investmentEUR: number;
}

export interface Amortisation {
  totalInvestmentEUR: number;
  annualBenefitEUR: number;
  /** Simple payback in years; Infinity if the system is not beneficial. */
  paybackYears: number;
}

export function computeAmortisation(input: AmortisationInput): Amortisation {
  const totalInvestmentEUR = Math.max(0, input.investmentEUR);
  const annualBenefitEUR = input.baselineCostEUR + input.systemNetEUR;
  const paybackYears = annualBenefitEUR > 0 ? totalInvestmentEUR / annualBenefitEUR : Infinity;
  return {
    totalInvestmentEUR,
    annualBenefitEUR,
    paybackYears,
  };
}
