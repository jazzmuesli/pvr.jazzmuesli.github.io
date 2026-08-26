import { describe, it, expect } from "vitest";
import { computeCashflow, CashflowInput } from "../src/calc/cashflow";

// A realistic, profitable scenario: 10 kWp PV, 5 kWh battery, ~9 000 €
// investment, 1 000 kWh/kWp yield, 30 % self-consumption, 30 ct import,
// 8 ct feed-in. This yields a positive annual benefit so the financial
// invariants (NPV ordering, IRR root, discounted payback) are meaningful.
function baseInput(): CashflowInput {
  const annualBenefitEUR = 900; // baseline − import + export (net saving / yr)
  const annualPVKWh = 10000; // 10 kWp × 1000 kWh/kWp
  return {
    annualBenefitEUR,
    annualPVKWh,
    investmentEUR: 9000,
    peakKWp: 10,
    capacityKWh: 5,
    feedInCt: 8,
    horizonYears: 20,
    discountRatePct: 3,
    priceEscalationPct: 2,
    omPercentPerYear: 1.5,
    inverterLifetimeYears: 13,
    inverterReplacementCostEUR: 1500,
    batteryLifetimeYears: 13,
    batteryReplacementCostEUR: 3000, // 5 kWh × 600 €/kWh
    batteryDegradationPct: 0.01,
    pvDegradationPct: 0.005,
    standbyWattage: 5,
    omInflationPct: 2,
  };
}

describe("cashflow analysis — structure", () => {
  it("returns all required metrics and yearly data over horizon + year 0", () => {
    const input = baseInput();
    const result = computeCashflow(input);
    expect(result.yearly.length).toBe(input.horizonYears + 1);
    expect(result.yearly[0].year).toBe(0);
    expect(result.yearly[0].netCashflowEUR).toBe(-input.investmentEUR);
    expect(Number.isFinite(result.npvEUR)).toBe(true);
    expect(result.lcoeCtPerKWh).toBeGreaterThan(0);
    expect(result.irrPercent).toBeGreaterThan(0);
  });

  it("a profitable scenario yields a positive NPV and finite payback", () => {
    const result = computeCashflow(baseInput());
    expect(result.npvEUR).toBeGreaterThan(0);
    expect(result.simplePaybackYears).toBeGreaterThan(0);
    expect(result.simplePaybackYears).toBeLessThan(20);
    expect(result.discountedPaybackYears).toBeLessThan(20);
  });
});

describe("cashflow analysis — discounting invariants (TODO 7.4)", () => {
  it("NPV is monotonically decreasing in the discount rate (profitable case)", () => {
    const rates = [0, 1, 3, 5, 8];
    const npvs = rates.map((d) => computeCashflow({ ...baseInput(), discountRatePct: d }).npvEUR);
    for (let i = 1; i < npvs.length; i++) {
      expect(npvs[i]).toBeLessThan(npvs[i - 1]);
    }
  });

  it("IRR is the discount rate at which NPV is (approximately) zero", () => {
    const input = baseInput();
    const result = computeCashflow(input);
    // Re-evaluate NPV exactly at the computed IRR — it should be ~0.
    const npvAtIrr = computeCashflow({ ...input, discountRatePct: result.irrPercent }).npvEUR;
    expect(Math.abs(npvAtIrr)).toBeLessThan(1);
  });
});

describe("cashflow analysis — price escalation invariant (TODO 1.3)", () => {
  it("a higher price escalation shortens the discounted payback", () => {
    const low = computeCashflow({ ...baseInput(), priceEscalationPct: 0 });
    const high = computeCashflow({ ...baseInput(), priceEscalationPct: 4 });
    expect(high.discountedPaybackYears).toBeLessThan(low.discountedPaybackYears);
  });

  it("a higher price escalation raises the NPV", () => {
    const low = computeCashflow({ ...baseInput(), priceEscalationPct: 0 });
    const high = computeCashflow({ ...baseInput(), priceEscalationPct: 4 });
    expect(high.npvEUR).toBeGreaterThan(low.npvEUR);
  });
});

describe("cashflow analysis — replacements & degradation (TODO 2.2, 3.1)", () => {
  it("a battery replacement creates a visible dip in the cumulative cashflow", () => {
    const input = baseInput();
    input.batteryLifetimeYears = 10;
    const result = computeCashflow(input);
    const y10 = result.yearly.find((y) => y.year === 10)!;
    expect(y10.replacementCostEUR).toBeGreaterThan(0);
    // The cumulative slope in the replacement year must be smaller (more negative
    // increment) than in the year before.
    const y9 = result.yearly.find((y) => y.year === 9)!;
    expect(y10.netCashflowEUR).toBeLessThan(y9.netCashflowEUR);
  });

  it("battery usable capacity degrades: year-20 factor ≈ 0.85 × year 1", () => {
    const result = computeCashflow({ ...baseInput(), batteryDegradationPct: 0.01 });
    const y1 = result.yearly.find((y) => y.year === 1)!.batteryCapacityFactor;
    const y20 = result.yearly.find((y) => y.year === 20)!.batteryCapacityFactor;
    expect(y20).toBeCloseTo(Math.pow(0.99, 20), 6);
    expect(y20).toBeCloseTo(0.85, 1);
    expect(y20).toBeLessThan(y1);
  });

  it("PV yield degrades: annual PV factor falls monotonically over the horizon", () => {
    const result = computeCashflow(baseInput());
    for (let i = 2; i < result.yearly.length; i++) {
      expect(result.yearly[i].pvYieldFactor).toBeLessThan(result.yearly[i - 1].pvYieldFactor);
    }
  });

  it("O&M and standby costs reduce the annual cashflow below the gross benefit", () => {
    const result = computeCashflow(baseInput());
    const y1 = result.yearly[1];
    expect(y1.omCostEUR).toBeGreaterThan(0);
    expect(y1.standbyCostEUR).toBeGreaterThan(0);
    expect(y1.netCashflowEUR).toBeLessThan(y1.grossBenefitEUR);
  });
});

describe("cashflow analysis — LCOE consistency (TODO 1.4, 7.4)", () => {
  it("LCOE is positive and sits in a plausible range for rooftop PV", () => {
    const result = computeCashflow(baseInput());
    expect(result.lcoeCtPerKWh).toBeGreaterThan(5);
    expect(result.lcoeCtPerKWh).toBeLessThan(15);
  });

  it("a higher investment raises the LCOE (energy held constant)", () => {
    const cheap = computeCashflow({ ...baseInput(), investmentEUR: 7000 });
    const pricey = computeCashflow({ ...baseInput(), investmentEUR: 14000 });
    expect(pricey.lcoeCtPerKWh).toBeGreaterThan(cheap.lcoeCtPerKWh);
  });
});

describe("cashflow analysis — edge cases", () => {
  it("a strictly loss-making project has negative NPV and no finite IRR", () => {
    const input = baseInput();
    input.annualBenefitEUR = 100; // far below O&M + replacements
    const result = computeCashflow(input);
    expect(result.npvEUR).toBeLessThan(0);
    expect(result.simplePaybackYears).toBe(Infinity);
    expect(Number.isNaN(result.irrPercent)).toBe(true);
  });
});
