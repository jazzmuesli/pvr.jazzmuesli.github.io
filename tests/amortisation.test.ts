import { describe, it, expect } from "vitest";
import { computeAmortisation, DEFAULT_PV_COST_PER_KWP, DEFAULT_BATTERY_COST_PER_KWH } from "../src/calc/amortisation";
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
describe("amortisation (simple payback)", () => {
  it("annualBenefit = baselineCost + systemNetEUR", () => {
    const a = computeAmortisation({ peakKWp: 10, capacityKWh: 5, baselineCostEUR: 1500, systemNetEUR: 300 });
    expect(a.annualBenefitEUR).toBeCloseTo(1800, 6);
  });

  it("investment = PV (per kWp) + battery (per kWh)", () => {
    const a = computeAmortisation({ peakKWp: 10, capacityKWh: 5, baselineCostEUR: 1500, systemNetEUR: 300 });
    expect(a.pvInvestmentEUR).toBeCloseTo(10 * DEFAULT_PV_COST_PER_KWP, 6);
    expect(a.batteryInvestmentEUR).toBeCloseTo(5 * DEFAULT_BATTERY_COST_PER_KWH, 6);
    expect(a.totalInvestmentEUR).toBeCloseTo(10 * DEFAULT_PV_COST_PER_KWP + 5 * DEFAULT_BATTERY_COST_PER_KWH, 6);
    expect(a.paybackYears).toBeCloseTo(a.totalInvestmentEUR / 1800, 6);
  });

  it("a larger, costlier system has a longer payback", () => {
    const small = computeAmortisation({ peakKWp: 5, capacityKWh: 0, baselineCostEUR: 1000, systemNetEUR: 500 });
    const big = computeAmortisation({ peakKWp: 10, capacityKWh: 0, baselineCostEUR: 1000, systemNetEUR: 500 });
    expect(big.totalInvestmentEUR).toBeGreaterThan(small.totalInvestmentEUR);
    expect(big.paybackYears).toBeGreaterThan(small.paybackYears);
  });

  it("an unprofitable system has infinite payback", () => {
    const a = computeAmortisation({ peakKWp: 10, capacityKWh: 0, baselineCostEUR: 1000, systemNetEUR: -1000 });
    expect(a.annualBenefitEUR).toBeLessThanOrEqual(0);
    expect(a.paybackYears).toBe(Infinity);
  });

  it("default investment for 22 kWp + 19.353 kWh ≈ 32 kEUR", () => {
    const a = computeAmortisation({ peakKWp: 22, capacityKWh: 19.353, baselineCostEUR: 1500, systemNetEUR: 300 });
    expect(a.totalInvestmentEUR).toBeGreaterThan(30000);
    expect(a.totalInvestmentEUR).toBeLessThan(33000);
    expect(a.pvInvestmentEUR).toBeCloseTo(22 * DEFAULT_PV_COST_PER_KWP, 6);
    expect(a.batteryInvestmentEUR).toBeCloseTo(19.353 * DEFAULT_BATTERY_COST_PER_KWH, 6);
  });

  it("payback decreases as the import tariff rises (more savings from self-consumption)", () => {
    const prices = generatePrices(12345);
    const load = totalLoad(consumers);
    const result = simulate(baseConfig(load, 19.353));
    const paybackFor = (ict: number) => {
      const econ = computeEconomics(result, {
        commissioningYear: 2025, peakKWp: 22, exportScheme: "fixed", feedInCt: 7.2,
        importScheme: "fixed", importCity: city, importFixedCt: ict,
      });
      // Mirror main.ts: baseline = cost of importing the WHOLE load at the chosen tariff.
      const imp = importPriceArray("fixed", city, prices, ict);
      let baseline = 0;
      for (let i = 0; i < result.load.length; i++) baseline += (result.load[i] * imp[i]) / 100;
      return computeAmortisation({ peakKWp: 22, capacityKWh: 19.353, baselineCostEUR: baseline, systemNetEUR: econ.netSelectedEUR }).paybackYears;
    };
    const cheap = paybackFor(24);
    const pricey = paybackFor(44.5);
    expect(cheap).toBeGreaterThan(pricey);
  });

  it("a real default config yields a finite, positive payback", () => {    const prices = generatePrices(12345);
    const load = totalLoad(consumers);
    const result = simulate(baseConfig(load, 19.353));
    const econ = computeEconomics(result, {
      commissioningYear: 2025, peakKWp: 22, exportScheme: "fixed", feedInCt: 7.2,
      importScheme: "fixed", importCity: cityForLocation("boizenburg"), importFixedCt: 24,
    });
    const imp = importPriceArray("fixed", city, prices);
    let baseline = 0;
    for (let i = 0; i < result.load.length; i++) baseline += (result.load[i] * imp[i]) / 100;
    const a = computeAmortisation({ peakKWp: 22, capacityKWh: 19.353, baselineCostEUR: baseline, systemNetEUR: econ.netSelectedEUR });
    expect(a.annualBenefitEUR).toBeGreaterThan(0);
    expect(a.paybackYears).toBeGreaterThan(0);
    expect(a.paybackYears).toBeLessThan(40);
  });
});
