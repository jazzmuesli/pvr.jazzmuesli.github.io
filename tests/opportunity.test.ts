import { describe, it, expect } from "vitest";
import {
  computeOpportunityCosts,
  OpportunityCosts,
} from "../src/calc/opportunity";
import {
  DEFAULT_HEATING_PARAMS,
} from "../src/calc/heating";
import { DEFAULT_CAR_PARAMS as CAR } from "../src/calc/car";
import { runSimulation, DEFAULT_SIM_PARAMS } from "../src/calc/report";

describe("computeOpportunityCosts (heating + EV)", () => {
  const oc: OpportunityCosts = computeOpportunityCosts({
    heating: { ...DEFAULT_HEATING_PARAMS, heatpumpElectricKWh: 5000, jaz: 3 },
    car: { ...CAR },
  });

  it("heat pump is cheaper than oil and gas for the same heat", () => {
    expect(oc.heating.heatpump.totalEUR).toBeLessThan(oc.heating.oil.totalEUR);
    expect(oc.heating.heatpump.totalEUR).toBeLessThan(oc.heating.gas.totalEUR);
    // Fossil alternatives report a positive delta vs. the heat pump.
    expect(oc.heating.oil.deltaVsHeatpumpEUR).toBeGreaterThan(0);
    expect(oc.heating.gas.deltaVsHeatpumpEUR).toBeGreaterThan(0);
  });

  it("delivers identical useful heat across all three heating modes", () => {
    expect(oc.heating.oil.usefulHeatKWh).toBe(oc.heating.heatpump.usefulHeatKWh);
    expect(oc.heating.gas.usefulHeatKWh).toBe(oc.heating.heatpump.usefulHeatKWh);
  });

  it("EV is cheaper than diesel for the same annual distance", () => {
    expect(oc.car.ev.totalEUR).toBeLessThan(oc.car.diesel.totalEUR);
    expect(oc.car.diesel.deltaVsEvEUR).toBeGreaterThan(0);
    expect(oc.car.ev.annualKm).toBe(oc.car.diesel.annualKm);
  });

  it("plausible absolute magnitudes (defaults, 2025 Germany)", () => {
    // Heat pump ~1200 €/yr; oil and gas clearly above.
    expect(oc.heating.heatpump.totalEUR).toBeCloseTo(1200, 0);
    expect(oc.heating.oil.totalEUR).toBeGreaterThan(2000);
    expect(oc.heating.gas.totalEUR).toBeGreaterThan(2000);
    // EV ~2600 €/yr, diesel ~4500 €/yr at defaults.
    expect(oc.car.ev.totalEUR).toBeGreaterThan(2000);
    expect(oc.car.ev.totalEUR).toBeLessThan(3500);
    expect(oc.car.diesel.totalEUR).toBeGreaterThan(oc.car.ev.totalEUR);
    expect(oc.car.diesel.totalEUR).toBeLessThan(6000);
  });
});

describe("opportunity costs inside runSimulation (the shared /api + client function)", () => {
  it("is present in the report and equals the standalone computation", () => {
    const r = runSimulation(DEFAULT_SIM_PARAMS);
    expect(r.opportunityCosts.heating).toBeDefined();
    expect(r.opportunityCosts.car).toBeDefined();
    // The report's opportunity costs must be identical to calling the shared
    // function directly with the same inputs.
    const direct = computeOpportunityCosts({
      heating: {
        ...DEFAULT_HEATING_PARAMS,
        heatpumpElectricKWh: r.inputs.consumers.heatpump.enabled ? r.inputs.consumers.heatpump.annualKWh : 0,
        jaz: r.inputs.heatpumpJaz,
        heatpumpElectricCt: r.inputs.heatpumpElectricCt,
      },
      car: r.inputs.car,
    });
    expect(r.opportunityCosts.heating.heatpump.totalEUR).toBe(direct.heating.heatpump.totalEUR);
    expect(r.opportunityCosts.car.ev.totalEUR).toBe(direct.car.ev.totalEUR);
    expect(r.opportunityCosts.car.diesel.totalEUR).toBe(direct.car.diesel.totalEUR);
  });

  it("respects the /api query parameters (km, dl)", () => {
    const r = runSimulation({
      ...DEFAULT_SIM_PARAMS,
      consumers: { ...DEFAULT_SIM_PARAMS.consumers, heatpump: { enabled: false, annualKWh: 0 }, ev: { enabled: false, annualKWh: 0, pvShare: 0.8 } },
      car: { ...DEFAULT_SIM_PARAMS.car, annualKm: 30000, dieselEurPerL: 1.8 },
    });
    expect(r.opportunityCosts.car.annualKm).toBe(30000);
    // Cheaper diesel pulls the diesel total down (but EV stays cheaper).
    expect(r.opportunityCosts.car.diesel.energyCostEUR).toBeLessThan(
      computeOpportunityCosts({
        heating: { ...DEFAULT_HEATING_PARAMS, heatpumpElectricKWh: 0, jaz: 3 },
        car: { ...CAR, annualKm: 30000, dieselEurPerL: 2.15 },
      }).car.diesel.energyCostEUR,
    );
  });

  it("defaults to the German 2025 car assumptions (15.000 km/yr)", () => {
    const r = runSimulation(DEFAULT_SIM_PARAMS);
    expect(r.opportunityCosts.car.annualKm).toBe(15000);
  });
});
