import { describe, it, expect } from "vitest";
import { simulate, computeDispatchFlags } from "../src/calc/simulation";
import { totalLoad, ConsumerConfig } from "../src/calc/consumers";
import { generatePrices } from "../src/calc/priceModel";
import { SimConfig, TOTAL_STEPS } from "../src/calc/types";

function cfg(consumers: ConsumerConfig, chargeMode: "morning" | "midday" | "gridNegative" = "morning"): SimConfig {
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "south", location: "hamburg" },
    battery: {
      capacityKWh: 19.353, maxPowerKW: 6, minSOC: 0.1, maxSOC: 0.95, efficiency: 0.95,
      startSOC: 0.5, chargeMode, dischargeEvening: true, dischargeMorning: true,
      eveningStart: 17, eveningEnd: 23, morningStart: 5, morningEnd: 12,
    },
    tariff: { feedInEUR: 0.072, commissioningYear: 2025 },
    prices: generatePrices(12345),
    load: totalLoad(consumers),
  };
}

const consumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 4000 },
  heatpump: { enabled: true, annualKWh: 5000 },
  bwwp: { enabled: true },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

describe("battery dispatch economics", () => {
  const c = cfg(consumers);
  const r = simulate(c);
  const prices = c.prices!;

  it("strategic battery export happens only at positive prices (else curtailed)", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.exportBattery[i] > 0) {
        // Surplus battery energy is exported whenever the spot is positive;
        // the alternative would be to curtail it (a daily battery can't store
        // it long-term). It must never be sold at a non-positive price.
        expect(prices[i]).toBeGreaterThanOrEqual(0);
      }
    }
    // and at least some strategic export should occur over the year
    let any = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) any += r.exportBattery[i];
    expect(any).toBeGreaterThan(0);
  });

  it("the battery covers the load before importing during discharge windows", () => {
    const flags = computeDispatchFlags(c.battery, prices);
    let covered = 0;
    let total = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i] && r.gridImport[i] === 0 && r.load[i] > 0) covered++;
      if (flags.discharge[i] && r.load[i] > 0) total++;
    }
    // most discharge-flagged, load-bearing steps use the battery, not the grid
    expect(covered).toBeGreaterThan(total * 0.7);
  });

  it("never charges and discharges the battery in the same quarter hour", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const charging = r.chargeSolar[i] + r.chargeGrid[i];
      const discharging = r.dischargeToLoad[i] + r.exportBattery[i];
      expect(charging === 0 || discharging === 0).toBe(true);
    }
  });

  it("grid charging from the grid happens only at non-positive prices", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.chargeGrid[i] > 0) expect(prices[i]).toBeLessThanOrEqual(0);
    }
  });

  it("PV and load are each balanced every step (battery is internal)", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      // Load is met by direct use, battery discharge, or grid import.
      const loadMet = r.directUse[i] + r.dischargeToLoad[i] + r.gridImport[i];
      expect(r.load[i]).toBeCloseTo(loadMet, 6);
      const pvOut = r.directUse[i] + r.chargeSolar[i] + r.exportSolar[i];
      if (prices[i] >= 0) {
        // At non-negative prices all PV is used (direct, stored, or exported).
        expect(r.pv[i]).toBeCloseTo(pvOut, 6);
      } else {
        // At negative prices excess PV is curtailed (you don't pay to export),
        // so PV output is at most the generated amount.
        expect(pvOut).toBeLessThanOrEqual(r.pv[i] + 1e-9);
      }
    }
  });
});
