import { describe, it, expect } from "vitest";
import {
  computeCar,
  evAlternative,
  dieselAlternative,
  evEnergyKWh,
  dieselLitres,
  CarParams,
  DEFAULT_CAR_PARAMS,
  DEFAULT_DIESEL_EUR_PER_L,
  DEFAULT_EV_KWH_PER_100KM,
  DEFAULT_DIESEL_L_PER_100KM,
} from "../src/calc/car";

function params(overrides: Partial<CarParams> = {}): CarParams {
  return { ...DEFAULT_CAR_PARAMS, ...overrides };
}

describe("energy input", () => {
  it("EV kWh scales with distance and consumption", () => {
    expect(evEnergyKWh(15000, DEFAULT_EV_KWH_PER_100KM)).toBeCloseTo(2700, 6);
    expect(evEnergyKWh(10000, 20)).toBeCloseTo(2000, 6);
  });

  it("diesel litres scales with distance and consumption", () => {
    expect(dieselLitres(15000, DEFAULT_DIESEL_L_PER_100KM)).toBeCloseTo(825, 6);
    expect(dieselLitres(10000, 7)).toBeCloseTo(700, 6);
  });
});

describe("EV alternative", () => {
  it("costs electricity + maintenance + tax + Nebenkosten", () => {
    const r = computeCar(params());
    // 15000 km, 18 kWh/100km = 2700 kWh * 0.30 € = 810 €
    // maintenance 15000 * 0.06 = 900 €, tax 0, other 900 → total 2610 €
    expect(r.ev.primaryEnergy).toBeCloseTo(2700, 6);
    expect(r.ev.energyCostEUR).toBeCloseTo(810, 6);
    expect(r.ev.maintenanceEUR).toBeCloseTo(900, 6);
    expect(r.ev.vehicleTaxEUR).toBe(0);
    expect(r.ev.otherNebenkostenEUR).toBe(900);
    expect(r.ev.totalEUR).toBeCloseTo(2610, 6);
    expect(r.ev.deltaVsEvEUR).toBe(0);
  });

  it("scales with the EV electricity price", () => {
    const cheap = computeCar(params({ evElectricCtPerKwh: 20 }));
    const exp = computeCar(params({ evElectricCtPerKwh: 40 }));
    expect(cheap.ev.totalEUR).toBeLessThan(exp.ev.totalEUR);
  });

  it("scales with annual distance", () => {
    const near = computeCar(params({ annualKm: 5000 }));
    const far = computeCar(params({ annualKm: 25000 }));
    expect(far.ev.totalEUR).toBeGreaterThan(near.ev.totalEUR);
  });
});

describe("diesel alternative", () => {
  it("includes fuel, maintenance, Kfz-Steuer and Nebenkosten", () => {
    const r = computeCar(params());
    // 15000 km, 5.5 L/100km = 825 L * 2.15 € = 1773.75 €
    // maintenance 15000 * 0.10 = 1500 €, tax 200, other 1000 → total 4473.75 €
    expect(r.diesel.primaryEnergy).toBeCloseTo(825, 6);
    expect(r.diesel.energyCostEUR).toBeCloseTo(1773.75, 6);
    expect(r.diesel.maintenanceEUR).toBeCloseTo(1500, 6);
    expect(r.diesel.vehicleTaxEUR).toBe(200);
    expect(r.diesel.otherNebenkostenEUR).toBe(1000);
    expect(r.diesel.totalEUR).toBeCloseTo(4473.75, 6);
  });

  it("scales with the diesel price (user-adjustable)", () => {
    const cheap = computeCar(params({ dieselEurPerL: 1.80 }));
    const exp = computeCar(params({ dieselEurPerL: DEFAULT_DIESEL_EUR_PER_L }));
    expect(cheap.diesel.totalEUR).toBeLessThan(exp.diesel.totalEUR);
    // Cheaper diesel narrows the gap vs the EV.
    expect(cheap.diesel.deltaVsEvEUR).toBeLessThan(exp.diesel.deltaVsEvEUR);
  });

  it("scales with diesel consumption", () => {
    const efficient = computeCar(params({ dieselLPer100km: 5 }));
    const thirsty = computeCar(params({ dieselLPer100km: 9 }));
    expect(efficient.diesel.totalEUR).toBeLessThan(thirsty.diesel.totalEUR);
  });
});

describe("delta vs EV", () => {
  it("diesel is more expensive than the EV at default assumptions", () => {
    const r = computeCar(params());
    expect(r.diesel.deltaVsEvEUR).toBeCloseTo(r.diesel.totalEUR - r.ev.totalEUR, 6);
    expect(r.diesel.deltaVsEvEUR).toBeGreaterThan(0);
  });

  it("a cheap enough diesel price can flip the comparison", () => {
    const r = computeCar(
      params({
        dieselEurPerL: 0.8,
        dieselMaintenanceCtPerKm: 6, // equal to EV
        dieselVehicleTaxEUR: 0, // equal to EV
        dieselOtherNebenkostenEUR: 900, // equal to EV
      })
    );
    // 1050 L * 0.80 = 840 € + 900 maintenance + 900 other = 2640 € < EV 2700 €
    expect(r.diesel.deltaVsEvEUR).toBeLessThan(0);
  });
});

describe("zero distance", () => {
  it("reports zero energy cost but keeps fixed Nebenkosten", () => {
    const r = computeCar(params({ annualKm: 0 }));
    expect(r.ev.energyCostEUR).toBe(0);
    expect(r.ev.maintenanceEUR).toBe(0);
    expect(r.ev.totalEUR).toBeCloseTo(r.ev.vehicleTaxEUR + r.ev.otherNebenkostenEUR, 6);
    expect(r.diesel.energyCostEUR).toBe(0);
    expect(r.diesel.totalEUR).toBeCloseTo(
      r.diesel.vehicleTaxEUR + r.diesel.otherNebenkostenEUR,
      6
    );
  });
});

describe("individual alternative functions", () => {
  it("evAlternative is deterministic and matches the report", () => {
    const p = params();
    const a = evAlternative(p);
    expect(a.totalEUR).toBeCloseTo(computeCar(p).ev.totalEUR, 6);
  });

  it("dieselAlternative is deterministic and matches the report", () => {
    const p = params();
    const a = dieselAlternative(p);
    expect(a.totalEUR).toBeCloseTo(computeCar(p).diesel.totalEUR, 6);
  });
});
