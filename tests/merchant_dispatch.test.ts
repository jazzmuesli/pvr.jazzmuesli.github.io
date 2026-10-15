import { describe, it, expect } from "vitest";
import { simulate, computeDispatchFlags } from "../src/calc/simulation";
import { totalLoad, ConsumerConfig } from "../src/calc/consumers";
import { getYearPrices } from "../src/calc/priceData";
import { SimConfig, TOTAL_STEPS } from "../src/calc/types";

/**
 * Regression guard for the merchant (Direktvermarktung) discharge path.
 *
 * Bug: the strategic grid export was conditioned on concurrent generation
 * (`gen > 0`). A merchant plant with no local load could therefore never sell
 * its stored energy after sunset — i.e. exactly in the most expensive evening
 * and morning windows. The battery stayed pinned at maxSOC from dusk until
 * sunrise, which is what a user reported as "the SOC stands roughly the same".
 *
 * Fix: a discharge window with *no local load at all* may sell its stored
 * energy regardless of generation. Windows that do carry local demand keep the
 * historical behaviour, so the prosumer path stays calibrated against the real
 * Home Assistant measurements in tests/calibration.test.ts.
 */

const battery = {
  capacityKWh: 30, maxPowerKW: 15, minSOC: 0.1, maxSOC: 0.95, efficiency: 0.95,
  startSOC: 0.5, chargeMode: "gridNegative" as const,
  dischargeEvening: true, dischargeMorning: true,
  eveningStart: 16, eveningEnd: 22, morningStart: 5, morningEnd: 10,
};

const pv = { peakKWp: 30, tiltDeg: 25, orientation: "south" as const, location: "boizenburg" };
const tariff = { feedInEUR: 0.0619, commissioningYear: 2026 };
const prices = getYearPrices("2026");
const sum = (a: Float64Array) => { let t = 0; for (const v of a) t += v; return t; };

const noLoad = new Float64Array(TOTAL_STEPS);

const consumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 5000 },
  bwwp: { enabled: true },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

function cfg(c: SimConfig["battery"], load: Float64Array): SimConfig {
  return { pv, battery: c, tariff, prices, load };
}

describe("merchant discharge path (no local load)", () => {
  const r = simulate(cfg(battery, noLoad));

  it("actually sells stored energy to the grid", () => {
    expect(sum(r.exportBattery)).toBeGreaterThan(4000);
  });

  it("sells the bulk of what it stores (a working daily cycle)", () => {
    const stored = sum(r.chargeSolar);
    expect(stored).toBeGreaterThan(0);
    // A healthy arbitrage cycle returns most of the stored energy to the grid.
    expect(sum(r.exportBattery) / stored).toBeGreaterThan(0.8);
  });

  it("sells after sunset, not only while the PV is running", () => {
    // Evening/morning windows that sit after dark must still export.
    let afterDark = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.exportBattery[i] > 0 && r.pv[i] === 0) afterDark++;
    }
    expect(afterDark).toBeGreaterThan(100);
  });

  it("never sells at a negative price", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.exportBattery[i] > 0) expect(prices[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("never charges and discharges in the same quarter hour", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const charging = r.chargeSolar[i] + r.chargeGrid[i];
      const discharging = r.dischargeToLoad[i] + r.exportBattery[i];
      expect(charging === 0 || discharging === 0).toBe(true);
    }
  });

  it("keeps the SOC within its limits all year", () => {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      expect(r.soc[i]).toBeGreaterThanOrEqual(0.1 * 30 - 1e-6);
      expect(r.soc[i]).toBeLessThanOrEqual(0.95 * 30 + 1e-6);
    }
  });

  it("battery energy balance closes (in + startSOC == out + endSOC)", () => {
    const inKWh = sum(r.chargeSolar) * battery.efficiency + sum(r.chargeGrid) * battery.efficiency;
    const outKWh = sum(r.dischargeToLoad) + sum(r.exportBattery);
    const startSOC = battery.startSOC * battery.capacityKWh;
    const endSOC = r.soc[TOTAL_STEPS - 1];
    expect(inKWh + startSOC).toBeCloseTo(outKWh + endSOC, 3);
    // Over a full year a daily cycling battery settles near its floor.
    expect(endSOC).toBeCloseTo(0.1 * battery.capacityKWh, 3);
  });
});

describe("merchant flag is only set for load-free windows", () => {
  it("is zero for a prosumer profile (protects the calibrated behaviour)", () => {
    const load = totalLoad(consumers);
    const flags = computeDispatchFlags(battery, prices, load);
    let any = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) if (flags.merchant[i] === 1) any++;
    expect(any).toBe(0);
  });

  it("is set across the whole window for a load-free profile", () => {
    const flags = computeDispatchFlags(battery, prices, noLoad);
    let flagged = 0, merchant = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i] === 1) flagged++;
      if (flags.merchant[i] === 1) merchant++;
    }
    expect(flagged).toBeGreaterThan(0);
    expect(merchant).toBe(flagged);
  });

  it("a prosumer still keeps its battery for self-supply", () => {
    const r = simulate(cfg(battery, totalLoad(consumers)));
    expect(sum(r.dischargeToLoad)).toBeGreaterThan(0);
  });
});