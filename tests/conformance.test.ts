import { describe, it, expect } from "vitest";

import {
  runSimulation,
  SimParams,
  DEFAULT_SIM_PARAMS,
  defaultSimParams,
  simParamsFromQuery,
  toSimConfig,
  CO2_GAS_DIRECT,
} from "../src/calc/report";
import { simulate } from "../src/calc/simulation";
import { annualSum, DAYS_IN_MONTH, loadByConsumer } from "../src/calc/consumers";
import { TOTAL_STEPS } from "../src/calc/types";
import { computeGasSavings, DEFAULT_GAS_SAVINGS_PARAMS, DEFAULT_GAS_BOILER_EFFICIENCY } from "../src/calc/heatpumpGasSavings";
import { serializeState, deserializeState } from "../src/ui/url";
import { DEFAULT_STATE, toSimParams } from "../src/ui/state";
import { defaultCoreParams } from "../src/domain/params";
import { SCENARIOS, scenarioParams } from "./fixtures";

/**
 * Conformance tests.
 *
 * Every one of these asserts that two places which *must* agree, do agree.
 * They exist because this codebase grew by copy-paste: the same quantity was
 * computed again somewhere else, and the two copies quietly diverged. Each
 * test corresponds to a divergence that actually happened — either a number
 * that was wrong, or a number that changed silently and nobody could tell.
 *
 * The subject is not a module but the *relationships between* modules. That is
 * what a duplicated codebase loses first: not the ability to compute X, but the
 * ability to be sure X is computed the same way everywhere.
 */

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const close = (a: number, b: number, tol = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(a), Math.abs(b)));

describe("conformance: the monthly table must add up to the annual summary", () => {
  for (const s of SCENARIOS) {
    it(`"${s.name}": monthly rows sum to the annual totals`, () => {
      const r = runSimulation(s.params);
      close(sum(r.monthly.map((m) => m.pvKWh)), r.summary.totalPVKWh);
      close(sum(r.monthly.map((m) => m.windKWh)), r.summary.totalWindKWh);
      close(sum(r.monthly.map((m) => m.totalLoadKWh)), r.summary.totalLoadKWh);
      close(sum(r.monthly.map((m) => m.exportKWh)), r.summary.totalExportKWh);
      close(
        sum(r.monthly.map((m) => m.load.household + m.load.heatpump + m.load.bwwp + m.load.ev)),
        r.summary.totalLoadKWh,
      );
    });

    it(`"${s.name}": generation is never lost outside a negative-price step`, () => {
      // Every kWh the plant generates must land in exactly one place: consumed
      // directly, stored, exported, or curtailed. `curtailed` is the residual;
      // it is non-zero only when the spot price is negative, where the model
      // declines to export into a negative price. That is a deliberate choice,
      // but it means real generation is thrown away, so the invariant worth
      // pinning is that *nothing else* goes missing.
      const result = simulate(toSimConfig(s.params));
      let curtailmentKWh = 0;
      for (let i = 0; i < result.load.length; i++) {
        const curtailed = result.pv[i] + result.wind[i] -
          result.directUse[i] - result.directUseWind[i] -
          result.chargeSolar[i] - result.chargeWind[i] -
          result.exportSolar[i] - result.exportWind[i];
        if (curtailed < -1e-12) {
          expect(curtailed, `step ${i}: generation unaccounted for`).toBeGreaterThanOrEqual(-1e-12);
        }
        curtailmentKWh += Math.max(0, curtailed);
        // ...and if it was curtailed, the price really was negative.
        if (curtailed > 1e-12) {
          expect(result.price[i], `step ${i} curtailed at a non-negative price`).toBeLessThan(0);
        }
      }
      // A bound, not an endorsement. Curtailment currently runs at 9-11 % of
      // annual generation, which is large enough to matter and is reported
      // nowhere. The model declines to export into a negative price, on the
      // assumption that injecting is not compensated — but negative day-ahead
      // prices are precisely the case where it is. See "Curtailment at negative
      // prices" in refactoring.md. This bound exists so that if curtailment
      // starts growing, or is fixed, the change is visible here.
      const generation = annualSum(result.pv) + annualSum(result.wind);
      expect(curtailmentKWh).toBeLessThanOrEqual(generation * 0.15);
    });

    it(`"${s.name}": self-consumption is own generation that reached the load`, () => {
      const r = runSimulation(s.params);
      const result = simulate(toSimConfig(s.params));
      const own =
        annualSum(result.directUse) + annualSum(result.directUseWind) +
        annualSum(result.dischargeToLoadPV) + annualSum(result.dischargeToLoadWind);
      close(r.summary.selfConsumptionKWh, own, 1e-9);
      expect(r.summary.selfConsumptionKWh).toBeLessThanOrEqual(
        r.summary.totalPVKWh + r.summary.totalWindKWh + 1e-9,
      );
      r.monthly.forEach((m, mi) => {
        close(
          sum(r.daily[mi].map((d) => d.selfUseKWh)) * DAYS_IN_MONTH[mi],
          m.selfConsumptionKWh,
          1e-9,
        );
      });
    });

    it(`"${s.name}": the 288 typical-day cells re-integrate to the annual totals`, () => {
      const r = runSimulation(s.params);
      // Each month's 24 cells hold that month's *mean day*, so re-integrating
      // means: mean day × days-in-month.
      for (let m = 0; m < 12; m++) {
        const days = DAYS_IN_MONTH[m];
        close(sum(r.daily[m].map((d) => d.pvKWh)) * days, r.monthly[m].pvKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.windKWh)) * days, r.monthly[m].windKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.totalLoadKWh)) * days, r.monthly[m].totalLoadKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.exportKWh)) * days, r.monthly[m].exportKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.importKWh)) * days, r.monthly[m].importKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.meteredImportKWh)) * days, r.monthly[m].meteredImportKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.gridChargedKWh)) * days, r.monthly[m].gridChargedKWh, 1e-9);
        close(sum(r.daily[m].map((d) => d.selfUseKWh)) * days, r.monthly[m].selfConsumptionKWh, 1e-9);
        close(
          sum(r.daily[m].map((d) => d.load.household + d.load.heatpump + d.load.bwwp + d.load.ev)) * days,
          r.monthly[m].totalLoadKWh,
          1e-9,
        );
      }
    });
  }
});

describe("conformance: the reported import is the dispatch's own import", () => {
  // `summary.totalImportKWh` was computed as a *residual* (load − self-consumption)
  // while revenue.ts summed `result.gridImport` directly. Two numbers, two
  // definitions, one report object. They diverge whenever the battery charges
  // from the grid: that energy is self-consumption to the residual and import
  // to the sum.
  for (const s of SCENARIOS) {
    it(`"${s.name}": summary.totalImportKWh equals Σ result.gridImport`, () => {
      const r = runSimulation(s.params);
      close(r.summary.totalImportKWh, annualSum(simulate(toSimConfig(s.params)).gridImport), 1e-9);
      close(r.summary.gridChargedKWh, annualSum(simulate(toSimConfig(s.params)).chargeGrid), 1e-9);
    });
  }

  it("the tariff-combination table reports import for its own price year", () => {
    // The combination table re-dispatches once per historical price year, so
    // its import figures describe *those* dispatches. A battery that charges
    // on cheap hours imports a different amount in 2023 than in 2025 — which is
    // the entire point of the table, and used to be invisible because the
    // report published a single global "totalImportKWh" next to it.
    const r = runSimulation(scenarioParams("charge-cheapest"));
    const years = r.tariffCombinations.combinations[0].years;
    expect(new Set(years.map((y) => Math.round(y.importKWh * 100))).size).toBeGreaterThan(1);
    expect(r.tariffCombinations.years).toEqual(years.map((y) => y.year));
  });
});

describe("conformance: energy balance holds in every dispatch branch", () => {
  // simulation.ts has three near-identical step-loop branches (no battery /
  // negative price / normal). The per-step identity
  //   load == directUse + dischargeToLoad + gridImport
  // is what proves the dispatch conserves energy, and only the normal branch
  // was ever asserted.
  const chargeModes: SimParams["chargeMode"][] = ["morning", "cheapest", "gridNegative"];

  for (const chargeMode of chargeModes) {
    it(`holds for chargeMode="${chargeMode}"`, () => {
      const params = { ...scenarioParams("baseline"), chargeMode };
      const r = runSimulation(params);
      const result = simulate(toSimConfig(params));
      let worst = 0;
      for (let i = 0; i < result.load.length; i++) {
        const covered = result.dischargeToLoad[i] || 0;
        worst = Math.max(
          worst,
          Math.abs(result.load[i] - result.directUse[i] - result.directUseWind[i] - covered - result.gridImport[i] + result.chargeGrid[i]),
        );
      }
      expect(worst, `worst per-step residual ${worst.toFixed(6)} kWh`).toBeLessThan(1e-9);
      close(r.summary.totalImportKWh, annualSum(result.gridImport), 1e-6);
    });
  }
});

describe("conformance: grid-charged energy is never reported as PV self-consumption", () => {
  // The dispatch added grid-charged energy to the battery's state of charge
  // without tagging its origin, and attributed the whole inherited state of
  // charge to PV. On discharge the PV/wind split normalised to 1, so energy
  // that came from the grid came back out as "PV self-consumption" — which
  // then forced the report into a self-consumption cap and a residual import,
  // and broke the per-step energy balance in this branch outright.
  for (const name of ["charge-gridnegative", "grid-arbitrage"]) {
    it(`"${name}": self-consumption is exactly the generation that reached the load`, () => {
      const params = scenarioParams(name);
      const result = simulate(toSimConfig(params));
      const generation = annualSum(result.pv) + annualSum(result.wind);
      const r = runSimulation(params);

      // The grid-originated bucket must be in use, or this says nothing about
      // origin tracking.
      expect(annualSum(result.dischargeToLoadGrid)).toBeGreaterThan(0);

      const ownServedLoad =
        annualSum(result.directUse) + annualSum(result.directUseWind) +
        annualSum(result.dischargeToLoadPV) + annualSum(result.dischargeToLoadWind);
      close(ownServedLoad, r.summary.selfConsumptionKWh, 1e-9);
      expect(r.summary.selfConsumptionKWh).toBeLessThanOrEqual(generation + 1e-9);
    });
  }

  it('"grid-arbitrage": energy really is bought from the grid and stored', () => {
    const params = scenarioParams("grid-arbitrage");
    const result = simulate(toSimConfig(params));
    expect(annualSum(result.chargeGrid)).toBeGreaterThan(0);
    close(
      annualSum(result.gridImport),
      runSimulation(params).summary.totalImportKWh,
      1e-9,
    );
  });

  it("every battery discharge is attributed to exactly one origin", () => {
    const params = scenarioParams("grid-arbitrage");
    const result = simulate(toSimConfig(params));
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const attributed =
        result.dischargeToLoadPV[i] + result.dischargeToLoadWind[i] + result.dischargeToLoadGrid[i];
      expect(Math.abs(result.dischargeToLoad[i] - attributed)).toBeLessThan(1e-9);
    }
  });
});

describe("conformance: the scenario comparison actually compares", () => {
  // `scenarioVariants` computed importEUR from the *base* import scheme for all
  // four variants, so the "dynamic import" and "§ 14a" bars in the scenario
  // chart displayed the fixed-tariff number under a different label.
  it("the four variants have different import costs", () => {
    const r = runSimulation(scenarioParams("baseline"));
    const distinct = new Set(r.scenario.map((v) => Math.round(v.importEUR * 100)));
    expect(distinct.size, `import costs were ${JSON.stringify(r.scenario.map((v) => v.importEUR))}`).toBeGreaterThan(1);
  });

  it("each variant row matches the tariff combination for the same scheme", () => {
    const p = { ...scenarioParams("baseline"), importScheme: "dynamic" as const, exportScheme: "market" as const };
    const r = runSimulation(p);
    const combos = r.tariffCombinations.combinations;
    const dynamic = combos.find((c) => c.importScheme === "dynamic");
    const fixed = combos.find((c) => c.importScheme === "fixed");
    expect(dynamic).toBeDefined();
    expect(fixed).toBeDefined();
    expect(dynamic!.years[0].importEUR).not.toBeCloseTo(fixed!.years[0].importEUR, 2);
  });
});

describe("conformance: one CO2 factor per quantity", () => {
  // The gas emission factor existed twice: 0.24 kg/kWh (well-to-burner) in
  // report.ts and 0.201 (tank-to-burner) inline in heatpumpGasSavings.ts. The
  // report printed both, computed from the same gas quantity, 19 % apart, with
  // no way for a user to tell which was which.
  it("gas savings use the same factor the CO2 scenarios use", () => {
    const r = runSimulation(scenarioParams("baseline"));
    const gs = r.gasSavings!;
    // `co2SavedKg` is *net* gas saved (direct boiler gas avoided, minus gas
    // burned for the electricity the heat pump drew). Both terms are gas, so
    // the net must be the net gas quantity times the single gas factor.
    expect(Math.abs(gs.co2SavedKg - gs.gasSavedKWh * CO2_GAS_DIRECT)).toBeLessThanOrEqual(0.01);
  });

  it("gasDirectKWh is derived from the heat pump's actual dispatched load", () => {
    // report.ts computed the CO2 heating term from
    // `p.consumers.heatpump.annualKWh` — the space-heating demand only — while
    // the savings module derived it from `loads.heatpump`, which also carries
    // the hot-water load when the BWWP is off. 9.6 % apart in that case.
    const params = scenarioParams("bwwp-off");
    const r = runSimulation(params);
    const loads = loadByConsumer(params.consumers);
    close(
      r.gasSavings!.gasDirectKWh,
      (annualSum(loads.heatpump) * params.heatpumpJaz) / DEFAULT_GAS_BOILER_EFFICIENCY,
      1e-6,
    );
  });

  it("computeGasSavings uses the canonical factor", () => {
    const load = new Float64Array(TOTAL_STEPS).fill(0);
    for (let i = 0; i < TOTAL_STEPS; i++) load[i] = 5000 / TOTAL_STEPS;
    const out = computeGasSavings(
      load,
      {
        heatpumpElectricKWh: 5000,
        jaz: 3,
        gasPowerplantEfficiency: DEFAULT_GAS_SAVINGS_PARAMS.gasPowerplantEfficiency,
        gasBoilerEfficiency: DEFAULT_GAS_SAVINGS_PARAMS.gasBoilerEfficiency,
        gasPriceCtPerKWh: DEFAULT_GAS_SAVINGS_PARAMS.gasPriceCtPerKWh,
      },
      new Float64Array(TOTAL_STEPS), // all grid
      load,
    );
    // co2SavedKg is rounded for display; the gas figures are not.
    expect(Math.abs(out.co2SavedKg - out.gasSavedKWh * CO2_GAS_DIRECT)).toBeLessThanOrEqual(0.01);
  });
});

describe("conformance: the share link is lossless", () => {
  // The share-URL writer and the /api query reader were two hand-maintained
  // lists. Six parameters the app can change — including the heat-pump JAZ the
  // user is actively dragging in expert mode — had no key in the writer, so
  // they reset on every refresh and every share link.
  it("every shareable parameter survives serialize → deserialize → toSimParams", () => {
    const state = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), heatpumpJaz: 2.7, tiltDeg: 11 };
    const params = toSimParams(deserializeState(serializeState(state as never)));
    expect(params.heatpumpJaz).toBeCloseTo(2.7, 9);
    expect(params.tiltDeg).toBeCloseTo(11, 9);
  });

  it("the share link and the /api query read the same registry", () => {
    const qs = serializeState(JSON.parse(JSON.stringify(DEFAULT_STATE)) as never);
    const viaApi = simParamsFromQuery(new URLSearchParams(qs));
    // Expert mode so that no simple-mode derivation is applied on one side only.
    const viaApp = toSimParams({ ...deserializeState(qs), expertMode: true });
    for (const key of Object.keys(DEFAULT_SIM_PARAMS) as (keyof SimParams)[]) {
      // Two fields are deliberately derived rather than carried:
      //   heatpumpElectricCt — a heat pump is a grid consumer, so it pays the
      //     import tariff;
      //   car.annualKm — the EV/diesel comparison must cover the same distance,
      //     so when the EV is on the km come from its energy use.
      if (key === "heatpumpElectricCt" || key === "car") continue;
      expect(viaApp[key], `share link vs /api mismatch on "${key}"`).toEqual(viaApi[key]);
    }
  });

  it("the expert-only parameters are all in the share link", () => {
    // These five had a reader but no writer: the heat-pump JAZ the user is
    // actively dragging, the Direktvermarkter margin, and the three car
    // inputs all reset on every refresh and every share link.
    const qs = new URLSearchParams(serializeState({ ...DEFAULT_STATE, heatpumpJaz: 2.5 } as never));
    for (const key of ["mm", "jaz", "km", "dl", "ec"]) {
      expect(qs.has(key), `share link is missing "${key}"`).toBe(true);
    }
  });

  it("the heat pump's electricity price follows the import tariff", () => {
    // `wpc` is not a share key because it is not an independent input in the UI:
    // a heat pump is a grid consumer, so its price *is* the import tariff.
    // Changing the tariff must move it.
    const state = { ...DEFAULT_STATE, importFixedCt: 33 };
    const params = toSimParams(deserializeState(serializeState(state as never)));
    expect(params.heatpumpElectricCt).toBe(33);
    // The API still honours an explicit override.
    expect(simParamsFromQuery(new URLSearchParams("wpc=11")).heatpumpElectricCt).toBe(11);
  });
});

describe("conformance: the UI default and the API default are the same system", () => {
  // DEFAULT_STATE (what a cold SPA load shows) and DEFAULT_SIM_PARAMS (what
  // `/api?` with no query returns) disagreed on peak size, location, battery
  // capacity, SOC limits and the whole financial block — same product, two
  // different answers to "what does this cost". Both now come from the registry.
  it("the /api default is the registry default", () => {
    expect(simParamsFromQuery(new URLSearchParams(""))).toEqual(defaultSimParams());
    expect(defaultSimParams()).toEqual(DEFAULT_SIM_PARAMS);
  });

  it("the SPA default maps onto the API default", () => {
    const viaApi = defaultSimParams();
    // The SPA's default configuration must be the registry's, so that a cold
    // load and `/api?` describe the same system.
    expect(toSimParams(JSON.parse(JSON.stringify(DEFAULT_STATE))).importFixedCt)
      .toBe(viaApi.importFixedCt);
    // Every scalar default is the registry default — no second list.
    expect(defaultCoreParams()).toEqual(
      Object.fromEntries(
        Object.entries(DEFAULT_STATE).filter(([k]) => k !== "expertMode" && k !== "consumers" && k !== "car"),
      ),
    );
    expect(viaApi.consumers).toEqual(toSimParams(DEFAULT_STATE).consumers);
  });
});