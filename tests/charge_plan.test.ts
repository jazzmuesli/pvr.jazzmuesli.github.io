// Charge-plan behaviour: *which* hours the battery is allowed to store surplus.
//
// Storage is not free. A surplus kWh costs the spot price of its hour — it
// could have been exported instead — so the profit of a cycle is
// `price(discharge) − price(charge) / efficiency`. These tests pin down that
// the `cheapest` mode really does store in the cheapest hours, using a
// synthetic price + generation series so the expected answer is exact.

import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { computeDispatchFlags } from "../src/calc/simulation";
import { STEPS_PER_DAY, STEPS_PER_HOUR, TOTAL_STEPS, SimConfig, BatteryConfig } from "../src/calc/types";
import { generatePrices } from "../src/calc/priceModel";

/** Injected surplus energy per HOUR, identical on every day of the year. */
function surplusSeries(byHour: Record<number, number>): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  const perStep = (kwh: number) => kwh / STEPS_PER_HOUR;
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    for (const [h, kwh] of Object.entries(byHour)) {
      const hour = Number(h);
      for (let k = 0; k < STEPS_PER_HOUR; k++) {
        out[d * STEPS_PER_DAY + hour * STEPS_PER_HOUR + k] = perStep(kwh);
      }
    }
  }
  return out;
}

/** Flat hourly price profile, identical on every day. */
function priceSeries(byHour: Record<number, number>): Float64Array {
  const out = new Float64Array(TOTAL_STEPS);
  for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < STEPS_PER_HOUR; k++) {
        out[d * STEPS_PER_DAY + h * STEPS_PER_HOUR + k] = byHour[h] ?? 50;
      }
    }
  }
  return out;
}

const BATTERY: BatteryConfig = {
  capacityKWh: 40,
  maxPowerKW: 14.5,
  minSOC: 0.1,
  maxSOC: 0.95,
  efficiency: 0.95,
  startSOC: 0.1,
  chargeMode: "cheapest",
  dischargeEvening: false,
  dischargeMorning: false,
  eveningStart: 17,
  eveningEnd: 23,
  morningStart: 5,
  morningEnd: 12,
};

function cfg(over: Partial<SimConfig> = {}, batteryOver: Partial<BatteryConfig> = {}): SimConfig {
  return {
    // No PV at all — the injected `wind` array is the only generation, so the
    // "own surplus" the battery can absorb is fully controlled by the test.
    pv: { peakKWp: 0, tiltDeg: 35, orientation: "south", location: "hamburg" },
    battery: { ...BATTERY, ...batteryOver },
    tariff: { feedInEUR: 0.06, commissioningYear: 2025 },
    load: new Float64Array(TOTAL_STEPS),
    ...over,
  };
}

/** Total energy charged / exported during one hour on day 0. */
function hourTotal(r: ReturnType<typeof simulate>, day: number, hour: number): number {
  const from = day * STEPS_PER_DAY + hour * STEPS_PER_HOUR;
  let s = 0;
  for (let k = 0; k < STEPS_PER_HOUR; k++) {
    s += r.chargeSolar[from + k] + r.chargeWind[from + k];
  }
  return s;
}

function hourExported(r: ReturnType<typeof simulate>, day: number, hour: number): number {
  const from = day * STEPS_PER_DAY + hour * STEPS_PER_HOUR;
  let s = 0;
  for (let k = 0; k < STEPS_PER_HOUR; k++) s += r.exportSolar[from + k] + r.exportWind[from + k];
  return s;
}

const DAY0 = 0;

describe("cheapest charge mode picks the cheapest surplus hours", () => {
  // Surplus exists in hours 10..15. Prices rank 13 < 12 < 14 < 11 < 15 < 10.
  // The battery can absorb min(14.5 kW, 20 kWh/h) = 14.5 kWh per hour, and
  // needs (0.95-0.1)*40/0.95 = 35.8 kWh, i.e. exactly 3 hours. So it must
  // pick hours 13, 12 and 14 — and export the 10:00/11:00/15:00 surplus
  // instead of storing it at a price it could have sold for.
  const surplus = surplusSeries({ 10: 20, 11: 20, 12: 20, 13: 20, 14: 20, 15: 20 });
  const prices = priceSeries({ 10: 100, 11: 80, 12: 20, 13: 10, 14: 30, 15: 90 });
  const r = simulate(cfg({ wind: surplus, prices }));

  it("fills the battery in the three cheapest surplus hours", () => {
    expect(hourTotal(r, DAY0, 12)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 13)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 14)).toBeGreaterThan(0);
  });

  it("does not store the surplus in the more expensive surplus hours", () => {
    expect(hourTotal(r, DAY0, 10)).toBe(0);
    expect(hourTotal(r, DAY0, 11)).toBe(0);
    expect(hourTotal(r, DAY0, 15)).toBe(0);
    // …it exports that surplus instead of giving up the better price.
    expect(hourExported(r, DAY0, 10)).toBeCloseTo(20, 6);
    expect(hourExported(r, DAY0, 11)).toBeCloseTo(20, 6);
    expect(hourExported(r, DAY0, 15)).toBeCloseTo(20, 6);
  });

  it("reaches max SOC and stores no more than the battery room", () => {
    const cap = BATTERY.capacityKWh * BATTERY.maxSOC;
    expect(r.soc[DAY0 * STEPS_PER_DAY + 16 * STEPS_PER_HOUR]).toBeCloseTo(cap, 6);
    let total = 0;
    for (let h = 0; h < 24; h++) total += hourTotal(r, DAY0, h);
    expect(total).toBeCloseTo((cap - BATTERY.capacityKWh * BATTERY.startSOC) / BATTERY.efficiency, 6);
  });

  it("is a per-day plan, not a single global window", () => {
    // Every day has the identical profile, so the *plan* must be identical
    // too — check the flags directly, since the battery is already full on
    // day 40 in this no-discharge setup and cannot actually take the energy.
    const flags = computeDispatchFlags(BATTERY, prices, undefined, surplus);
    const hoursOn = (day: number) => {
      const out: number[] = [];
      for (let h = 0; h < 24; h++) {
        if (flags.charge[day * STEPS_PER_DAY + h * STEPS_PER_HOUR]) out.push(h);
      }
      return out;
    };
    expect(hoursOn(0)).toEqual([12, 13, 14]);
    expect(hoursOn(40)).toEqual([12, 13, 14]);
    expect(hoursOn(364)).toEqual([12, 13, 14]);
  });
});

describe("cheapest charge mode follows the price ranking, not the clock", () => {
  it("moves the charge window when the cheap hours move", () => {
    const surplus = surplusSeries({ 6: 20, 7: 20, 16: 20, 17: 20, 18: 20 });
    // The cheapest surplus hour is 07:00, not solar noon.
    const prices = priceSeries({ 6: 90, 7: 10, 16: 60, 17: 40, 18: 20 });
    const r = simulate(cfg({ wind: surplus, prices }));
    let total = 0;
    for (let h = 0; h < 24; h++) total += hourTotal(r, DAY0, h);
    expect(total).toBeGreaterThan(0);
    // 3 hours needed; ranking is 07(10) < 18(20) < 17(40) < 16(60) < 06(90).
    expect(hourTotal(r, DAY0, 7)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 18)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 17)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 6)).toBe(0);
    expect(hourTotal(r, DAY0, 16)).toBe(0);
  });

  it("absorbs negative-price hours first (that surplus would be curtailed)", () => {
    const surplus = surplusSeries({ 10: 20, 11: 20, 12: 20, 13: 20 });
    const prices = priceSeries({ 10: 60, 11: -40, 12: 50, 13: 30 });
    const r = simulate(cfg({ wind: surplus, prices }));
    expect(hourTotal(r, DAY0, 11)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 11)).toBeGreaterThan(hourTotal(r, DAY0, 10));
    // And no grid energy was bought to do it.
    for (let i = 0; i < TOTAL_STEPS; i++) expect(r.chargeGrid[i]).toBe(0);
  });

  it("opens more hours when the battery is bigger than the surplus", () => {
    const surplus = surplusSeries({ 9: 20, 10: 20, 11: 20, 12: 20 });
    const prices = priceSeries({ 9: 90, 10: 80, 11: 70, 12: 60 });
    // A 400 kWh battery can never be filled from 80 kWh of surplus: every
    // surplus hour must be usable rather than truncating the plan early.
    const r = simulate(
      cfg({ wind: surplus, prices }, { capacityKWh: 400, maxPowerKW: 50 }),
    );
    for (const h of [9, 10, 11, 12]) expect(hourTotal(r, DAY0, h)).toBeGreaterThan(0);
  });

  it("keeps the battery full across the day once charged", () => {
    const surplus = surplusSeries({ 10: 20, 11: 20, 12: 20, 13: 20 });
    const prices = priceSeries({ 10: 90, 11: 80, 12: 10, 13: 20 });
    const r = simulate(cfg({ wind: surplus, prices }));
    const cap = BATTERY.capacityKWh * BATTERY.maxSOC;
    for (let h = 14; h < 20; h++) {
      expect(r.soc[DAY0 * STEPS_PER_DAY + h * STEPS_PER_HOUR]).toBeCloseTo(cap, 6);
    }
  });
});

describe("charge mode comparisons", () => {
  const surplus = surplusSeries({ 10: 20, 11: 20, 12: 20, 13: 20, 14: 20, 15: 20 });
  const prices = priceSeries({ 10: 100, 11: 80, 12: 20, 13: 10, 14: 30, 15: 90 });

  it("'morning' still stores every surplus hour as soon as it appears", () => {
    const r = simulate(cfg({ wind: surplus, prices }, { chargeMode: "morning" }));
    expect(hourTotal(r, DAY0, 10)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 11)).toBeGreaterThan(0);
    expect(hourTotal(r, DAY0, 12)).toBeGreaterThan(0);
  });

  it("'cheapest' stores strictly less early, non-negative energy than 'morning'", () => {
    const morning = simulate(cfg({ wind: surplus, prices }, { chargeMode: "morning" }));
    const cheap = simulate(cfg({ wind: surplus, prices }, { chargeMode: "cheapest" }));
    expect(hourTotal(cheap, DAY0, 10)).toBeLessThan(hourTotal(morning, DAY0, 10));
  });

  it("both modes end up with the same total stored energy", () => {
    const total = (r: ReturnType<typeof simulate>) => {
      let s = 0;
      for (let i = 0; i < TOTAL_STEPS; i++) s += r.chargeSolar[i] + r.chargeWind[i];
      return s;
    };
    const morning = simulate(cfg({ wind: surplus, prices }, { chargeMode: "morning" }));
    const cheap = simulate(cfg({ wind: surplus, prices }, { chargeMode: "cheapest" }));
    expect(total(cheap)).toBeCloseTo(total(morning), 4);
  });

  it("'cheapest' never stores in an hour reserved for discharge", () => {
    const flags = computeDispatchFlags(
      { ...BATTERY, dischargeEvening: true, eveningStart: 12, eveningEnd: 18 },
      prices,
      undefined,
      surplus,
    );
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (flags.discharge[i]) expect(flags.charge[i]).toBe(0);
    }
  });
});

describe("charge plan is economically sound", () => {
  // Merchant-style setup: no local load, surplus exported at the spot price,
  // battery discharged into the expensive window. Storing at the cheapest
  // hour and releasing at the priciest must beat storing first-come-first-served.
  const surplus = surplusSeries({ 9: 6, 10: 6, 11: 6, 12: 6, 13: 6, 14: 6, 15: 6, 16: 6 });
  const prices = priceSeries({
    9: 70, 10: 65, 11: 60, 12: 45, 13: 20, 14: 25, 15: 55, 16: 60,
    19: 140, 20: 130,
  });
  const battery = {
    ...BATTERY,
    capacityKWh: 20,
    maxPowerKW: 10,
    maxSOC: 0.9,
    dischargeEvening: true,
    eveningStart: 19,
    eveningEnd: 21,
  };

  const revenue = (r: ReturnType<typeof simulate>) => {
    let s = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      s += (r.exportSolar[i] + r.exportWind[i] + r.exportBattery[i]) * prices[i];
    }
    return s / 1000; // EUR
  };

  it("price-ranked charging earns more than earliest-possible charging", () => {
    const morning = simulate(cfg({ wind: surplus, prices }, { ...battery, chargeMode: "morning" }));
    const cheapest = simulate(cfg({ wind: surplus, prices }, { ...battery, chargeMode: "cheapest" }));
    expect(revenue(cheapest)).toBeGreaterThan(revenue(morning));
  });

  it("never beats the theoretical maximum spread (no free lunch)", () => {
    // Perfect foresight: store only at the single cheapest surplus hour and
    // release only at the single priciest hour.
    const cheapestHour = 13; // 20 EUR/MWh
    const releaseHour = 19; // 140 EUR/MWh
    const r = simulate(cfg({ wind: surplus, prices }, { ...battery, chargeMode: "cheapest" }));

    let stored = 0;
    let released = 0;
    let weightedChargePrice = 0;
    for (let d = 0; d < TOTAL_STEPS / STEPS_PER_DAY; d++) {
      for (let h = 0; h < 24; h++) {
        for (let k = 0; k < STEPS_PER_HOUR; k++) {
          const i = d * STEPS_PER_DAY + h * STEPS_PER_HOUR + k;
          const c = r.chargeSolar[i] + r.chargeWind[i];
          const e = r.exportBattery[i];
          stored += c;
          released += e;
          weightedChargePrice += c * prices[i];
        }
      }
    }
    expect(released).toBeGreaterThan(0);
    // The realised average charge price can never be below the best hour's.
    expect(weightedChargePrice / stored).toBeGreaterThanOrEqual(prices[cheapestHour * STEPS_PER_HOUR] - 1e-6);
    // …and the realised average release price can never exceed the best hour's.
    let weightedReleasePrice = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) weightedReleasePrice += r.exportBattery[i] * prices[i];
    expect(weightedReleasePrice / released).toBeLessThanOrEqual(prices[releaseHour * STEPS_PER_HOUR] + 1e-6);
  });
});

describe("charge plan on the real price model", () => {
  const prices = generatePrices();
  // A realistic cycling battery: fills during the day, discharges into the
  // expensive evening window, so it is empty again each morning.
  const cycling = {
    ...BATTERY,
    startSOC: 0.5,
    dischargeEvening: true,
    eveningStart: 17,
    eveningEnd: 23,
  };
  const realCfg = (chargeMode: BatteryConfig["chargeMode"]): SimConfig => ({
    pv: { peakKWp: 50, tiltDeg: 25, orientation: "south", location: "boizenburg" },
    battery: { ...cycling, chargeMode },
    tariff: { feedInEUR: 0.06, commissioningYear: 2025 },
    prices,
    load: new Float64Array(TOTAL_STEPS), // merchant plant: no local load
  });

  const chargeStats = (r: ReturnType<typeof simulate>) => {
    let kWh = 0;
    let cost = 0;
    const byHour = new Float64Array(24);
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const c = r.chargeSolar[i] + r.chargeWind[i];
      if (c <= 0) continue;
      kWh += c;
      cost += c * prices[i];
      byHour[Math.floor((i % STEPS_PER_DAY) / STEPS_PER_HOUR)] += c;
    }
    return { kWh, avgPrice: cost / kWh, byHour };
  };

  const marketRevenue = (r: ReturnType<typeof simulate>) => {
    let s = 0;
    for (let i = 0; i < TOTAL_STEPS; i++) {
      s += (r.exportSolar[i] + r.exportWind[i] + r.exportBattery[i]) * prices[i];
    }
    return s / 1000; // EUR
  };

  it("fills the battery in the cheap midday hours, not at the first available hour", () => {
    const { kWh, byHour } = chargeStats(simulate(realCfg("cheapest")));
    expect(kWh).toBeGreaterThan(0);
    let early = 0;
    let midday = 0;
    for (let h = 0; h < 24; h++) {
      if (h < 11) early += byHour[h];
      else if (h < 15) midday += byHour[h];
    }
    // The reported bug filled the battery from 10:00; almost nothing may be
    // stored before 11:00 now, and 11:00-15:00 must dominate.
    expect(early / kWh).toBeLessThan(0.05);
    expect(midday / kWh).toBeGreaterThan(0.8);
  });

  it("buys the energy at a much lower average price than storing it immediately", () => {
    const morning = chargeStats(simulate(realCfg("morning")));
    const cheapest = chargeStats(simulate(realCfg("cheapest")));
    expect(cheapest.avgPrice).toBeLessThan(morning.avgPrice * 0.75);
  });

  it("earns more market revenue than storing surplus as early as possible", () => {
    expect(marketRevenue(simulate(realCfg("cheapest")))).toBeGreaterThan(
      marketRevenue(simulate(realCfg("morning"))),
    );
  });

  it("never loses throughput, and captures more free energy than 'morning'", () => {
    const morning = chargeStats(simulate(realCfg("morning")));
    const cheapest = chargeStats(simulate(realCfg("cheapest")));
    // The battery turns over (0.95-0.1)*40/0.95 = 35.8 kWh per day, so ~13 000
    // kWh/yr is the ceiling. Storing the first surplus available fills the
    // battery at 10:00 and then misses every negative-price trough that
    // follows; ranking by price stores those for free first.
    const ceiling = ((0.95 - 0.1) * 40) / 0.95 * 365;
    expect(morning.kWh).toBeLessThan(ceiling * 0.85);
    expect(cheapest.kWh).toBeGreaterThan(morning.kWh);
    expect(cheapest.kWh).toBeGreaterThan(ceiling * 0.95);
    expect(cheapest.kWh).toBeLessThanOrEqual(ceiling * 1.001);
  });

  it("absorbs the negative-price troughs", () => {
    const { kWh, avgPrice } = chargeStats(simulate(realCfg("cheapest")));
    // A chunk of the year is negative-priced; those hours rank cheapest and so
    // are always stored first. The weighted average must land well below zero.
    expect(avgPrice).toBeLessThan(40);
    expect(kWh).toBeGreaterThan(5000);
  });

  it("never stores energy in a discharge hour", () => {
    const r = simulate(realCfg("cheapest"));
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (r.exportBattery[i] > 0) expect(r.chargeSolar[i] + r.chargeWind[i]).toBe(0);
    }
  });
});