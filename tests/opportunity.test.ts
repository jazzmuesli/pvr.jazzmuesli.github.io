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
    // function directly with the same inputs that `runSimulation` derives
    // (PV-aware effective prices + EV distance from the E-Auto consumption).
    const evKWh = r.inputs.consumers.ev.enabled ? r.inputs.consumers.ev.annualKWh : 0;
    const annualKm = evKWh > 0
      ? Math.round((evKWh * 100) / r.inputs.car.evKwhPer100km)
      : r.inputs.car.annualKm;
    const evCt = r.inputs.consumers.ev.enabled ? r.effectivePrice.byConsumer.ev : r.inputs.importFixedCt;
    const hpCt = r.inputs.consumers.heatpump.enabled ? r.effectivePrice.byConsumer.heatpump : r.inputs.heatpumpElectricCt;
    const direct = computeOpportunityCosts({
      heating: {
        ...DEFAULT_HEATING_PARAMS,
        heatpumpElectricKWh: r.inputs.consumers.heatpump.enabled ? r.inputs.consumers.heatpump.annualKWh : 0,
        jaz: r.inputs.heatpumpJaz,
        heatpumpElectricCt: hpCt,
      },
      car: { ...r.inputs.car, evElectricCtPerKwh: evCt, annualKm },
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

  it("derives the EV distance from the default E-Auto Verbrauch (2000 kWh)", () => {
    const r = runSimulation(DEFAULT_SIM_PARAMS);
    // 2000 kWh / (18 kWh/100km) = 11111 km.
    expect(r.opportunityCosts.car.annualKm).toBe(Math.round((2000 * 100) / 18));
  });

  it("Strompreis drives the heat-pump and EV electricity cost (via the app mapping)", () => {
    // In the app the heat-pump tariff is tied to the Strompreis (see
    // `toSimParams`), so we set both to the same value here.
    const base = runSimulation({ ...DEFAULT_SIM_PARAMS, importFixedCt: 24, heatpumpElectricCt: 24 });
    const pricier = runSimulation({ ...DEFAULT_SIM_PARAMS, importFixedCt: 40, heatpumpElectricCt: 40 });
    expect(pricier.opportunityCosts.heating.heatpump.energyCostEUR)
      .toBeGreaterThan(base.opportunityCosts.heating.heatpump.energyCostEUR);
    expect(pricier.opportunityCosts.car.ev.energyCostEUR)
      .toBeGreaterThan(base.opportunityCosts.car.ev.energyCostEUR);
  });

  it("E-Auto Verbrauch (kWh) drives the annual distance and EV cost", () => {
    const low = runSimulation({
      ...DEFAULT_SIM_PARAMS,
      consumers: { ...DEFAULT_SIM_PARAMS.consumers, ev: { enabled: true, annualKWh: 1500, pvShare: 0.8 } },
    });
    const high = runSimulation({
      ...DEFAULT_SIM_PARAMS,
      consumers: { ...DEFAULT_SIM_PARAMS.consumers, ev: { enabled: true, annualKWh: 3000, pvShare: 0.8 } },
    });
    expect(high.opportunityCosts.car.annualKm).toBeGreaterThan(low.opportunityCosts.car.annualKm);
    expect(high.opportunityCosts.car.ev.energyCostEUR)
      .toBeGreaterThan(low.opportunityCosts.car.ev.energyCostEUR);
    // Diesel (same distance) also scales with the EV consumption.
    expect(high.opportunityCosts.car.diesel.energyCostEUR)
      .toBeGreaterThan(low.opportunityCosts.car.diesel.energyCostEUR);
  });

  it("disabling the EV keeps the default annual distance", () => {
    const r = runSimulation({
      ...DEFAULT_SIM_PARAMS,
      consumers: { ...DEFAULT_SIM_PARAMS.consumers, ev: { enabled: false, annualKWh: 0, pvShare: 0.8 } },
    });
    expect(r.opportunityCosts.car.annualKm).toBe(15000);
  });

  it("a bigger battery lowers the heat-pump effective price and raises the saving", () => {
    const noBat = runSimulation({ ...DEFAULT_SIM_PARAMS, capacityKWh: 0, maxPowerKW: 0 });
    const bigBat = runSimulation({ ...DEFAULT_SIM_PARAMS, capacityKWh: 19, maxPowerKW: 6 });
    expect(bigBat.opportunityCosts.heating.heatpump.energyCostEUR)
      .toBeLessThan(noBat.opportunityCosts.heating.heatpump.energyCostEUR);
    expect(bigBat.opportunityInvestment.heatingSavingEUR)
      .toBeGreaterThan(noBat.opportunityInvestment.heatingSavingEUR);
  });

  it("a bigger battery also lowers the EV effective price", () => {
    const noBat = runSimulation({ ...DEFAULT_SIM_PARAMS, capacityKWh: 0, maxPowerKW: 0 });
    const bigBat = runSimulation({ ...DEFAULT_SIM_PARAMS, capacityKWh: 19, maxPowerKW: 6 });
    expect(bigBat.opportunityCosts.car.ev.energyCostEUR)
      .toBeLessThanOrEqual(noBat.opportunityCosts.car.ev.energyCostEUR);
  });

  it("ties the financeable investment to the PV payback horizon", () => {
    // PV payback ~10 years, gas heating 2500 € vs heat pump 1400 € → ~1100 €/yr
    // saving → financeable heat pump ≈ 11.000 €.
    const r = runSimulation({
      ...DEFAULT_SIM_PARAMS,
      consumers: {
        household: { enabled: true, annualKWh: 4000 },
        heatpump: { enabled: true, annualKWh: 5000 },
        bwwp: { enabled: true },
        ev: { enabled: true, annualKWh: 2300, pvShare: 1 },
      },
    });
    const inv = r.opportunityInvestment;
    expect(inv.pvPaybackYears).toBeGreaterThan(0);
    expect(Number.isFinite(inv.pvPaybackYears)).toBe(true);
    expect(inv.heatingSavingEUR).toBeGreaterThan(0);
    expect(inv.financeableHeatpumpEUR).not.toBeNull();
    // financeable = present value of the annual saving over the discounted
    // analysis horizon (TODO 6.1), not the old saving × simple payback.
    const d = r.inputs.discountRatePct / 100;
    let expected = 0;
    for (let t = 1; t <= r.inputs.horizonYears; t++) {
      expected += inv.heatingSavingEUR / Math.pow(1 + d, t);
    }
    expect(inv.financeableHeatpumpEUR!).toBeCloseTo(expected, 0);
    expect(inv.financeableEvEUR).not.toBeNull();
  });

  it("reports no financeable investment when there is no PV benefit", () => {
    // No PV, no battery → no system benefit → payback is infinite.
    const r = runSimulation({
      ...DEFAULT_SIM_PARAMS,
      peakKWp: 0,
      capacityKWh: 0,
      maxPowerKW: 0,
      investmentEUR: 0,
    });
    expect(Number.isFinite(r.opportunityInvestment.pvPaybackYears)).toBe(false);
    expect(r.opportunityInvestment.financeableHeatpumpEUR).toBeNull();
  });
});
