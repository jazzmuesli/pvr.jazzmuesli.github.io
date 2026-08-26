import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { SimConfig, STEPS_PER_DAY, STEPS_PER_HOUR, TOTAL_STEPS } from "../src/calc/types";

function baseConfig(load: Float64Array, capacityKWh = 19.353, maxKW = 6): SimConfig {
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "south", location: "Hamburg" },
    battery: {
      capacityKWh,
      maxPowerKW: maxKW,
      minSOC: 0.1,
      maxSOC: 0.95,
      efficiency: 0.95,
      startSOC: 0.5,
      chargeMode: "morning",
      dischargeEvening: true,
      dischargeMorning: true,
      eveningStart: 17,
      eveningEnd: 23,
      morningStart: 5,
      morningEnd: 12,
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

describe("simulate with load — energy balance", () => {
  const load = totalLoad(consumers);
  const r = simulate(baseConfig(load));

  it("meets the load every step (pv-direct + battery + grid)", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const met = r.directUse[i] + r.dischargeToLoad[i] + r.gridImport[i];
      expect(Math.abs(met - r.load[i])).toBeLessThan(1e-9);
    }
  });

  it("never charges and discharges in the same step", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const charging = r.chargeSolar[i] > 0 || r.chargeGrid[i] > 0;
      const discharging = r.dischargeToLoad[i] > 0 || r.exportBattery[i] > 0;
      expect(charging && discharging).toBe(false);
    }
  });

  it("keeps the SOC within bounds", () => {
    const cap = 19.353;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      expect(r.soc[i]).toBeGreaterThanOrEqual(0.1 * cap - 1e-6);
      expect(r.soc[i]).toBeLessThanOrEqual(0.95 * cap + 1e-6);
    }
  });

  it("battery energy bookkeeping is consistent with SOC", () => {
    const eff = 0.95;
    let prev = 0.5 * 19.353;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const charge = (r.chargeSolar[i] + r.chargeGrid[i]) * eff;
      const discharge = r.dischargeToLoad[i] + r.exportBattery[i];
      const expected = prev + charge - discharge;
      expect(Math.abs(r.soc[i] - expected)).toBeLessThan(1e-6);
      prev = r.soc[i];
    }
  });

  it("exportTotal equals solar plus battery export", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      expect(r.exportTotal[i]).toBeCloseTo(r.exportSolar[i] + r.exportBattery[i], 9);
    }
  });
});

describe("simulate with load — plausibility", () => {
  it("self-consumes PV (grid import < total load with a battery)", () => {
    const load = totalLoad(consumers);
    const r = simulate(baseConfig(load));
    let gridImport = 0;
    let loadTotal = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      gridImport += r.gridImport[i];
      loadTotal += r.load[i];
    }
    expect(gridImport).toBeLessThan(loadTotal);
    expect(gridImport).toBeGreaterThan(0); // winter import still needed
  });

  it("reduces grid import versus no battery", () => {
    const load = totalLoad(consumers);
    const withBat = simulate(baseConfig(load, 19.353, 6));
    const noBat = simulate(baseConfig(load, 0, 6));
    let giB = 0;
    let giN = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      giB += withBat.gridImport[i];
      giN += noBat.gridImport[i];
    }
    expect(giB).toBeLessThan(giN);
  });

  it("a 40 kWh / 5 kW battery can still discharge substantially into the evening peak", () => {
    const load = totalLoad(consumers);
    const r = simulate(baseConfig(load, 40, 5));
    let maxEveningDischarge = 0;
    for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
      let evening = 0;
      for (let k = 0; k < STEPS_PER_DAY; k++) {
        const i = d * STEPS_PER_DAY + k;
        const h = Math.floor(k / STEPS_PER_HOUR);
        if (h >= 17 && h < 23) evening += r.dischargeToLoad[i] + r.exportBattery[i];
      }
      maxEveningDischarge = Math.max(maxEveningDischarge, evening);
    }
    // Discharge is gated to windows, so over a single evening peak the 40 kWh
    // battery should still deliver a meaningful share of its capacity.
    expect(maxEveningDischarge).toBeGreaterThan(10);
  });
});
