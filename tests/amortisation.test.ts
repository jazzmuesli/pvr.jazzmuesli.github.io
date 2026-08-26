import { describe, it, expect } from "vitest";
import { computeAmortisation } from "../src/calc/amortisation";
import { simulate } from "../src/calc/simulation";
import { totalLoad, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { importPriceArray, cityForLocation } from "../src/calc/tariff";
import { computeEconomics } from "../src/calc/revenue";

function baseConfig(load: Float64Array, capacityKWh = 19.353): Parameters<typeof simulate>[0] {
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "east_west", location: "boizenburg" },
    battery: {
      capacityKWh, maxPowerKW: 6, minSOC: 0.1, maxSOC: 0.95, efficiency: 0.95, startSOC: 0.5,
      chargeMode: "morning", dischargeEvening: true, dischargeMorning: true,
      eveningStart: 17, eveningEnd: 23, morningStart: 5, morningEnd: 12,
    },
    tariff: { feedInEUR: 0.072, commissioningYear: 2025 },
    prices: generatePrices(12345),
    load,
  };
}

const consumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 6500 },
  bwwp: { enabled: true },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

const city = cityForLocation("boizenburg");

// Mirror runSimulation: baseline = cost of importing the whole load at the tariff.
function baselineFor(result: ReturnType<typeof simulate>, ict: number): number {
  const imp = importPriceArray("fixed", city, generatePrices(12345), ict);
  let baseline = 0;
  for (let i = 0; i < result.load.length; i++) baseline += (result.load[i] * imp[i]) / 100;
  return baseline;
}

describe("amortisation (simple payback)", () => {
  it("annualBenefit = baselineCost + systemNetEUR", () => {
    const a = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 300, investmentEUR: 20000 });
    expect(a.annualBenefitEUR).toBeCloseTo(1800, 6);
  });

  it("investment is the single supplied total, independent of kWp/kWh", () => {
    const a = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 300, investmentEUR: 20000 });
    expect(a.totalInvestmentEUR).toBe(20000);
    expect(a.paybackYears).toBeCloseTo(20000 / 1800, 6);

    // Different sizes at the same total investment yield the same payback inputs.
    const small = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 300, investmentEUR: 20000 });
    const big = computeAmortisation({ baselineCostEUR: 1500, systemNetEUR: 300, investmentEUR: 20000 });
    expect(big.totalInvestmentEUR).toBe(small.totalInvestmentEUR);
  });

  it("a larger investment lengthens the payback (benefit held constant)", () => {
    const cheap = computeAmortisation({ baselineCostEUR: 1000, systemNetEUR: 500, investmentEUR: 15000 });
    const pricey = computeAmortisation({ baselineCostEUR: 1000, systemNetEUR: 500, investmentEUR: 30000 });
    expect(pricey.totalInvestmentEUR).toBeGreaterThan(cheap.totalInvestmentEUR);
    expect(pricey.paybackYears).toBeGreaterThan(cheap.paybackYears);
  });

  it("an unprofitable system has infinite payback", () => {
    const a = computeAmortisation({ baselineCostEUR: 1000, systemNetEUR: -1000, investmentEUR: 10000 });
    expect(a.annualBenefitEUR).toBeLessThanOrEqual(0);
    expect(a.paybackYears).toBe(Infinity);
  });

  it("payback decreases as the import tariff rises (more savings from self-consumption)", () => {
    const load = totalLoad(consumers);
    const result = simulate(baseConfig(load, 19.353));
    const paybackFor = (ict: number, investmentEUR: number) => {
      const econ = computeEconomics(result, {
        commissioningYear: 2025, peakKWp: 22, exportScheme: "fixed", feedInCt: 7.2,
        importScheme: "fixed", importCity: city, importFixedCt: ict,
      });
      return computeAmortisation({ baselineCostEUR: baselineFor(result, ict), systemNetEUR: econ.netSelectedEUR, investmentEUR }).paybackYears;
    };
    const cheap = paybackFor(24, 32000);
    const pricey = paybackFor(44.5, 32000);
    expect(cheap).toBeGreaterThan(pricey);
  });

  it("a real default config yields a finite, positive payback", () => {
    const load = totalLoad(consumers);
    const result = simulate(baseConfig(load, 19.353));
    const econ = computeEconomics(result, {
      commissioningYear: 2025, peakKWp: 22, exportScheme: "fixed", feedInCt: 7.2,
      importScheme: "fixed", importCity: cityForLocation("boizenburg"), importFixedCt: 24,
    });
    const a = computeAmortisation({ baselineCostEUR: baselineFor(result, 24), systemNetEUR: econ.netSelectedEUR, investmentEUR: 32000 });
    expect(a.annualBenefitEUR).toBeGreaterThan(0);
    expect(a.paybackYears).toBeGreaterThan(0);
    expect(a.paybackYears).toBeLessThan(40);
  });
});
