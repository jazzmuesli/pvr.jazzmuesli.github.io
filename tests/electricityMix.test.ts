import { describe, it, expect } from "vitest";
import {
  electricityMixForHour,
  electricityMixForStep,
  electricityMixYear,
  annualAverageMix,
  ElectricitySourceShares,
} from "../src/calc/electricityMix";
import { TOTAL_STEPS } from "../src/calc/types";

function sumSources(mix: ElectricitySourceShares): number {
  return mix.wind + mix.solar + mix.gas + mix.coal + mix.biomass + mix.hydro + mix.other;
}

describe("electricityMixForHour", () => {
  it("all sources sum to 1.0 for every hour in every month", () => {
    for (let month = 1; month <= 12; month++) {
      for (let hour = 0; hour < 24; hour++) {
        const mix = electricityMixForHour(month, hour);
        expect(sumSources(mix)).toBeCloseTo(1.0, 2);
      }
    }
  });

  it("all fractions are non-negative", () => {
    for (let month = 1; month <= 12; month++) {
      for (let hour = 0; hour < 24; hour++) {
        const mix = electricityMixForHour(month, hour);
        expect(mix.wind).toBeGreaterThanOrEqual(0);
        expect(mix.solar).toBeGreaterThanOrEqual(0);
        expect(mix.gas).toBeGreaterThanOrEqual(0);
        expect(mix.coal).toBeGreaterThanOrEqual(0);
        expect(mix.biomass).toBeGreaterThanOrEqual(0);
        expect(mix.hydro).toBeGreaterThanOrEqual(0);
        expect(mix.other).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("solar is zero in deep night (00:00-03:00) for all months", () => {
    for (let month = 1; month <= 12; month++) {
      for (let hour = 0; hour <= 3; hour++) {
        const mix = electricityMixForHour(month, hour);
        expect(mix.solar).toBe(0);
      }
    }
  });

  it("solar is zero after 21:00 for all months", () => {
    for (let month = 1; month <= 12; month++) {
      for (let hour = 21; hour < 24; hour++) {
        const mix = electricityMixForHour(month, hour);
        expect(mix.solar).toBe(0);
      }
    }
  });

  it("solar peaks around midday (11:00-13:00) in summer", () => {
    for (const month of [6, 7, 8]) {
      const solarMidday = electricityMixForHour(month, 12).solar;
      const solarMorning = electricityMixForHour(month, 8).solar;
      const solarEvening = electricityMixForHour(month, 18).solar;
      expect(solarMidday).toBeGreaterThan(solarMorning);
      expect(solarMidday).toBeGreaterThan(solarEvening);
    }
  });

  it("wind is higher in winter than in summer", () => {
    const winterWind = (electricityMixForHour(1, 12).wind + electricityMixForHour(12, 12).wind) / 2;
    const summerWind = (electricityMixForHour(7, 12).wind + electricityMixForHour(8, 12).wind) / 2;
    expect(winterWind).toBeGreaterThan(summerWind);
  });

  it("wind is higher at night than at midday in winter (thermal effects)", () => {
    const nightWind = electricityMixForHour(1, 3).wind;
    const middayWind = electricityMixForHour(1, 12).wind;
    expect(nightWind).toBeGreaterThan(middayWind);
  });

  it("gas is higher in winter evening (18:00) than summer midday", () => {
    const winterEveningGas = electricityMixForHour(1, 18).gas;
    const summerMiddayGas = electricityMixForHour(7, 12).gas;
    expect(winterEveningGas).toBeGreaterThan(summerMiddayGas);
  });

  it("clamps invalid month/hour inputs gracefully", () => {
    const mix0 = electricityMixForHour(0, 12);
    const mix1 = electricityMixForHour(13, 12);
    const mixNeg = electricityMixForHour(-5, 12);
    expect(sumSources(mix0)).toBeCloseTo(1.0, 2);
    expect(sumSources(mix1)).toBeCloseTo(1.0, 2);
    expect(sumSources(mixNeg)).toBeCloseTo(1.0, 2);
  });
});

describe("electricityMixForStep", () => {
  it("matches electricityMixForHour for the same calendar position", () => {
    // Step 0 = Jan 1, hour 0
    const stepMix = electricityMixForStep(0);
    const hourMix = electricityMixForHour(1, 0);
    expect(stepMix.wind).toBeCloseTo(hourMix.wind, 6);
    expect(stepMix.solar).toBeCloseTo(hourMix.solar, 6);
    expect(stepMix.gas).toBeCloseTo(hourMix.gas, 6);
  });

  it("all sources sum to 1.0 for all steps", () => {
    const yearMix = electricityMixYear();
    for (let i = 0; i < TOTAL_STEPS; i++) {
      expect(sumSources(yearMix[i])).toBeCloseTo(1.0, 2);
    }
  });
});

describe("electricityMixYear", () => {
  it("returns an array of length TOTAL_STEPS", () => {
    const yearMix = electricityMixYear();
    expect(yearMix.length).toBe(TOTAL_STEPS);
  });

  it("every entry has all sources defined", () => {
    const yearMix = electricityMixYear();
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const m = yearMix[i];
      expect(typeof m.wind).toBe("number");
      expect(typeof m.solar).toBe("number");
      expect(typeof m.gas).toBe("number");
      expect(typeof m.coal).toBe("number");
      expect(typeof m.biomass).toBe("number");
      expect(typeof m.hydro).toBe("number");
      expect(typeof m.other).toBe("number");
    }
  });
});

describe("annualAverageMix", () => {
  it("all sources sum to 1.0", () => {
    const avg = annualAverageMix();
    expect(sumSources(avg)).toBeCloseTo(1.0, 2);
  });

  it("wind share is between 15% and 40% (realistic for Germany)", () => {
    const avg = annualAverageMix();
    expect(avg.wind).toBeGreaterThan(0.15);
    expect(avg.wind).toBeLessThan(0.40);
  });

  it("solar share is between 5% and 25% (realistic for Germany)", () => {
    const avg = annualAverageMix();
    expect(avg.solar).toBeGreaterThan(0.05);
    expect(avg.solar).toBeLessThan(0.25);
  });

  it("gas share is between 3% and 20% (realistic for Germany)", () => {
    const avg = annualAverageMix();
    expect(avg.gas).toBeGreaterThan(0.03);
    expect(avg.gas).toBeLessThan(0.20);
  });

  it("coal share is between 10% and 60% (realistic for Germany, varies by year)", () => {
    const avg = annualAverageMix();
    expect(avg.coal).toBeGreaterThan(0.10);
    expect(avg.coal).toBeLessThan(0.60);
  });

  it("baseload sources (biomass+hydro+other) sum to ~11%", () => {
    const avg = annualAverageMix();
    const baseload = avg.biomass + avg.hydro + avg.other;
    expect(baseload).toBeCloseTo(0.11, 2);
  });
});

describe("seasonal plausibility", () => {
  it("April-September daytime has significant solar (>=15% at noon)", () => {
    for (const month of [4, 5, 6, 7, 8, 9]) {
      const mix = electricityMixForHour(month, 12);
      expect(mix.solar).toBeGreaterThanOrEqual(0.15);
    }
  });

  it("November-February evening (18:00) has high gas (>10%)", () => {
    for (const month of [11, 12, 1, 2]) {
      const mix = electricityMixForHour(month, 18);
      expect(mix.gas).toBeGreaterThan(0.10);
    }
  });

  it("deep night (00:00-03:00) has zero solar all year", () => {
    for (let month = 1; month <= 12; month++) {
      for (let hour = 0; hour <= 3; hour++) {
        expect(electricityMixForHour(month, hour).solar).toBe(0);
      }
    }
  });

  it("winter months (Nov-Feb) have zero solar at hours 0-5 (late sunrise)", () => {
    for (const month of [11, 12, 1, 2]) {
      for (let hour = 0; hour <= 5; hour++) {
        expect(electricityMixForHour(month, hour).solar).toBe(0);
      }
    }
  });
});
