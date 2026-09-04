import { describe, it, expect } from "vitest";
import { simulate } from "../src/calc/simulation";
import { loadByConsumer, ConsumerConfig } from "../src/calc/consumers";
import { getYearPrices } from "../src/calc/priceData";
import { TOTAL_STEPS, STEPS_PER_DAY } from "../src/calc/types";

// Calibration against the user's real 2026 Home Assistant data (year-to-date,
// Jan 1 – Aug 26 = 238 days). These totals were provided by the user and are
// used to guard against regressions in the energy-balance / battery-dispatch
// logic. Tolerances are deliberately loose (the synthetic load profile only
// approximates the real household's timing) but tight enough to catch the
// "battery only discharges inside fixed windows" bug (which collapsed
// dischargeToLoad from ~1.4 MWh to ~0.7 MWh).
const YTD_DAYS = 238;
const REAL = {
  pv: 14.5e3,
  load: 7.78e3,
  chargeSolar: 1.81e3,
  dischargeToLoad: 1.69e3,
  export: 9.38e3,
  import: 2.73e3,
};

function buildConfig() {
  const c: ConsumerConfig = {
    household: { enabled: true, annualKWh: 4000 },
    heatpump: { enabled: true, annualKWh: 5000 },
    bwwp: { enabled: true },
    ev: { enabled: true, annualKWh: 2000, pvShare: 1 },
  };
  const prices = getYearPrices("2025");
  const load = loadByConsumer(c);
  const loadArr = new Float64Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) loadArr[i] = load.household[i] + load.heatpump[i] + load.bwwp[i] + load.ev[i];
  return {
    pv: { peakKWp: 22, tiltDeg: 35, orientation: "east_west" as const, location: "boizenburg" },
    battery: {
      capacityKWh: 19.353, maxPowerKW: 6, minSOC: 0.5, maxSOC: 0.95, efficiency: 0.95,
      startSOC: 0.5, chargeMode: "morning" as const, dischargeEvening: true, dischargeMorning: true,
      eveningStart: 17, eveningEnd: 23, morningStart: 5, morningEnd: 12,
    },
    tariff: { feedInEUR: 0.072, commissioningYear: 2025 },
    prices,
    load: loadArr,
  };
}

function ytdSum(a: Float64Array): number {
  let t = 0;
  for (let i = 0; i < YTD_DAYS * STEPS_PER_DAY; i++) t += a[i];
  return t;
}

describe("calibration vs real 2026 YTD (Home Assistant data)", () => {
  const r = simulate(buildConfig() as any);
  const approx = (got: number, real: number, tol: number) => {
    expect(got).toBeGreaterThanOrEqual(real * (1 - tol));
    expect(got).toBeLessThanOrEqual(real * (1 + tol));
  };

  it("PV production matches within 8%", () => approx(ytdSum(r.pv), REAL.pv, 0.08));
  it("total load matches within 12%", () => approx(ytdSum(r.load), REAL.load, 0.12));
  it("battery PV charge matches within 10%", () => approx(ytdSum(r.chargeSolar), REAL.chargeSolar, 0.1));
  it("battery discharge to load is substantial (>1.0 MWh, catches window bug)", () =>
    expect(ytdSum(r.dischargeToLoad)).toBeGreaterThan(1.0e3));
  it("grid import is in the right range", () => approx(ytdSum(r.gridImport), REAL.import, 0.35));
  it("export is in the right range", () => approx(ytdSum(r.exportTotal), REAL.export, 0.25));
});
