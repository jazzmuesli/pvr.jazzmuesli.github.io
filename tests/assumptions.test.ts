import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { totalLoad, loadByConsumer } from "../src/calc/consumers";
import { DEFAULT_STATE, toSimConfig } from "../src/ui/state";
import { generatePrices } from "../src/calc/priceModel";
import { TOTAL_STEPS } from "../src/calc/types";

// Plausibility bounds derived from the real household data in ~/MyDocuments/ha
// (Home Assistant long-term statistics, Dec 2025 – Aug 2026):
//   PV production : 16,225 kWh/yr (S9 sensor) … 18,508 kWh/yr (solar.csv)
//   Heat pump     : ~6,600 kWh/yr (temp-driven model) … ~7,400 kWh/yr (linear)
//   Base load     : ~2,400 kWh/yr (author's monthly model: 200 kWh/month)
//   Battery       : ~19 kWh (author's "19kWh bat" scenarios)
//   EPEX avg      : ~10.2 ct/kWh (EUR/MWh avg 102)
// EV has no usable real series (wb.csv is a 2-day stub) and remains an assumption.

describe("assumptions match real household data", () => {
  const cfg = toSimConfig(DEFAULT_STATE);
  const load = totalLoad(DEFAULT_STATE.consumers);
  const r = simulate({ ...cfg, prices: generatePrices(12345) });

  it("synthetic PV yield for the default array is realistic", () => {
    let pvTotal = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) pvTotal += r.pv[i];
    // Real data: 16,225 – 18,508 kWh/yr. Allow margin for orientation/seed.
    expect(pvTotal).toBeGreaterThan(14000);
    expect(pvTotal).toBeLessThan(20000);
  });

  it("default consumer profile matches real-world magnitudes", () => {
    const c = DEFAULT_STATE.consumers;
    expect(c.household.annualKWh).toBeGreaterThanOrEqual(1000);
    expect(c.household.annualKWh).toBeLessThanOrEqual(4000);
    // Heat pump dominates the real load (~6.6 MWh/yr).
    expect(c.heatpump.annualKWh).toBeGreaterThanOrEqual(5000);
    expect(c.heatpump.annualKWh).toBeLessThanOrEqual(9000);
    // EV is an assumption (no real series); keep in a sane band.
    expect(c.ev.annualKWh).toBeGreaterThan(0);
    expect(c.ev.annualKWh).toBeLessThanOrEqual(5000);
  });

  it("default total annual load is in the real range", () => {
    let total = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) total += load[i];
    // Real total consumption ≈ 8,400 – 10,700 kWh/yr (PV-self-consumed + import).
    expect(total).toBeGreaterThan(8000);
    expect(total).toBeLessThan(13000);
  });

  it("heat pump is the largest single consumer (winter-heavy reality)", () => {
    const by = loadByConsumer(DEFAULT_STATE.consumers);
    let hp = 0, hh = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) { hp += by.heatpump[i]; hh += by.household[i]; }
    expect(hp).toBeGreaterThan(hh);
  });
});
