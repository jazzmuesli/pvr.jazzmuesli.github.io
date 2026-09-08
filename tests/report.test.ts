import { describe, it, expect } from "vitest";
import { runSimulation, simParamsFromQuery, DEFAULT_SIM_PARAMS, SimParams, estimateInvestmentEUR } from "../src/calc/report";
import { ConsumerConfig } from "../src/calc/consumers";

const baseConsumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 5000 },
  bwwp: { enabled: true },
  ev: { enabled: true, annualKWh: 2000, pvShare: 0.8 },
};

function params(overrides: Partial<SimParams> = {}): SimParams {
  return { ...DEFAULT_SIM_PARAMS, consumers: baseConsumers, ...overrides };
}

describe("runSimulation", () => {
  it("returns a complete, JSON-serialisable report", () => {
    const r = runSimulation(params());
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.monthly).toHaveLength(12);
    expect(r.daily).toHaveLength(12);
    expect(r.daily[0]).toHaveLength(24);
    expect(r.scenario).toHaveLength(4);
    expect(typeof r.amortisation.paybackYears).toBe("number");
  });

  it("exposes the lifecycle cashflow analysis with all metrics", () => {
    const r = runSimulation(params());
    const c = r.cashflow;
    expect(Number.isFinite(c.npvEUR)).toBe(true);
    expect(Number.isFinite(c.irrPercent)).toBe(true);
    expect(c.lcoeCtPerKWh).toBeGreaterThan(0);
    expect(c.simplePaybackYears).toBeGreaterThan(0);
    expect(c.yearly).toHaveLength(r.inputs.horizonYears + 1);
    expect(c.yearly[0].netCashflowEUR).toBe(-r.inputs.investmentEUR);
  });

  it("summary reports self-consumption rate and autarky degree", () => {
    const r = runSimulation(params());
    expect(r.summary.selfConsumptionRatePct).toBeGreaterThanOrEqual(0);
    expect(r.summary.selfConsumptionRatePct).toBeLessThanOrEqual(100);
    expect(r.summary.selfSufficiencyPct).toBeGreaterThan(0);
    expect(r.summary.selfSufficiencyPct).toBeLessThanOrEqual(100);
  });

  it("the investment estimator scales with PV and battery size (TODO 2.3)", () => {
    const small = estimateInvestmentEUR(5, 0);
    const bigger = estimateInvestmentEUR(10, 10);
    expect(bigger).toBeGreaterThan(small);
    // No battery → purely PV cost; no battery adds positive battery cost.
    const withBat = estimateInvestmentEUR(10, 10);
    const noBat = estimateInvestmentEUR(10, 0);
    expect(withBat).toBeGreaterThan(noBat);
    // A 22 kWp / 19 kWh system lands in a realistic ballpark.
    const full = estimateInvestmentEUR(22, 19);
    expect(full).toBeGreaterThan(20000);
    expect(full).toBeLessThan(40000);
  });

  it("monthly chart sums reproduce the annual totals", () => {
    const r = runSimulation(params());
    const sumPV = r.monthly.reduce((a, d) => a + d.pvKWh, 0);
    const sumLoad = r.monthly.reduce((a, d) => a + d.totalLoadKWh, 0);
    expect(sumPV).toBeCloseTo(r.summary.totalPVKWh, 0);
    expect(sumLoad).toBeCloseTo(r.summary.totalLoadKWh, 0);
  });

  it("every monthly and daily consumer breakdown sums to its total load", () => {
    const r = runSimulation(params());
    for (const d of r.monthly) {
      const s = d.load.household + d.load.heatpump + d.load.bwwp + d.load.ev;
      expect(s).toBeCloseTo(d.totalLoadKWh, 6);
    }
    for (const month of r.daily) {
      for (const h of month) {
        const s = h.load.household + h.load.heatpump + h.load.bwwp + h.load.ev;
        expect(s).toBeCloseTo(h.totalLoadKWh, 6);
      }
    }
  });

  it("scenario netEUR equals exportEUR minus importEUR", () => {
    const r = runSimulation(params());
    for (const s of r.scenario) {
      expect(s.netEUR).toBeCloseTo(s.exportEUR - s.importEUR, 6);
    }
  });

  it("tariffCombinations covers every year for every combination", () => {
    const r = runSimulation(params());
    const tc = r.tariffCombinations;
    expect(tc.combinations).toHaveLength(4);
    expect(tc.years).toEqual(["2023", "2024", "2025", "2026"]);
    for (const c of tc.combinations) {
      expect(c.years).toHaveLength(4);
      for (const y of c.years) {
        expect(y.netEUR).toBeCloseTo(y.exportEUR - y.importEUR, 1);
        expect(Number.isFinite(y.exportEUR)).toBe(true);
        expect(Number.isFinite(y.importEUR)).toBe(true);
      }
    }
  });

  it("tariff combinations differ between schemes and years", () => {
    const r = runSimulation(params());
    const tc = r.tariffCombinations;
    const byKey = Object.fromEntries(tc.combinations.map((c) => [c.key, c]));
    // Market export earns more than fixed export under the same (fixed) import.
    const fixedFixed = byKey["fixed_fixed"].years.find((y) => y.year === "2025")!;
    const marketFixed = byKey["market_fixed"].years.find((y) => y.year === "2025")!;
    expect(marketFixed.exportEUR).toBeGreaterThan(fixedFixed.exportEUR);
    // Different import schemes yield different import costs.
    const dyn = byKey["market_dynamic"].years.find((y) => y.year === "2025")!;
    const dyn14a = byKey["market_dynamic14a"].years.find((y) => y.year === "2025")!;
    expect(dyn.importEUR).not.toBeCloseTo(dyn14a.importEUR, 1);
  });

  it("amortisation is investment / annual benefit", () => {
    const inv = 32000;
    const r = runSimulation(params({ investmentEUR: inv }));
    expect(r.amortisation.totalInvestmentEUR).toBe(inv);
    expect(r.amortisation.annualBenefitEUR).toBeGreaterThan(0);
    expect(r.amortisation.paybackYears).toBeCloseTo(inv / r.amortisation.annualBenefitEUR, 6);
  });

  it("a higher total investment lengthens the payback (size held constant)", () => {
    const low = runSimulation(params({ investmentEUR: 15000 }));
    const high = runSimulation(params({ investmentEUR: 40000 }));
    expect(high.amortisation.paybackYears).toBeGreaterThan(low.amortisation.paybackYears);
    expect(high.amortisation.totalInvestmentEUR).toBeGreaterThan(low.amortisation.totalInvestmentEUR);
  });

  it("disabling the battery changes only the energy flows, not the investment", () => {
    const withB = runSimulation(params({ capacityKWh: 19.353, investmentEUR: 32000 }));
    const noB = runSimulation(params({ capacityKWh: 0, investmentEUR: 32000 }));
    expect(noB.amortisation.totalInvestmentEUR).toBe(withB.amortisation.totalInvestmentEUR);
    // A battery serves more load from PV, so grid import drops without it.
    expect(noB.summary.totalImportKWh).toBeGreaterThan(withB.summary.totalImportKWh);
  });

  it("effective price with no PV and no battery equals the flat tariff", () => {
    const r = runSimulation(params({ peakKWp: 0, capacityKWh: 0, importScheme: "fixed", importFixedCt: 24 }));
    expect(r.effectivePrice.overallCt).toBeCloseTo(24, 0);
  });
});

describe("heating section", () => {
  it("is included in the report and uses the heat-pump consumption", () => {
    const r = runSimulation(params({ consumers: { ...baseConsumers, heatpump: { enabled: true, annualKWh: 5000 } }, heatpumpJaz: 3 }));
    expect(r.opportunityCosts).toBeDefined();
    expect(r.opportunityCosts.heating.heatpumpElectricKWh).toBe(5000);
    expect(r.opportunityCosts.heating.usefulHeatKWh).toBe(15000);
    // The heat pump now pays the PV-aware *effective* price of its own imports
    // (not a flat 24 ct/kWh), so its cost equals consumption × effective price.
    const expected = Math.round((5000 * r.effectivePrice.byConsumer.heatpump) / 100 * 100) / 100;
    expect(r.opportunityCosts.heating.heatpump.energyCostEUR).toBeCloseTo(expected, 2);
    expect(r.opportunityCosts.heating.heatpump.totalEUR).toBeCloseTo(expected, 2);
    expect(r.opportunityCosts.heating.oil.totalEUR).toBeGreaterThan(r.opportunityCosts.heating.heatpump.totalEUR);
    expect(r.opportunityCosts.heating.gas.totalEUR).toBeGreaterThan(r.opportunityCosts.heating.heatpump.totalEUR);
  });

  it("reflects the JAZ query parameter", () => {
    const r = runSimulation(params({ heatpumpJaz: 4, consumers: { ...baseConsumers, heatpump: { enabled: true, annualKWh: 5000 } } }));
    expect(r.opportunityCosts.heating.usefulHeatKWh).toBe(20000);
  });
});

describe("simParamsFromQuery", () => {
  it("uses sensible defaults when the query is empty", () => {
    const p = simParamsFromQuery(new URLSearchParams(""));
    expect(p).toEqual(DEFAULT_SIM_PARAMS);
  });

  it("parses the same param names as the SPA URL", () => {
    const p = simParamsFromQuery(new URLSearchParams("kwp=22&cap=0&inv=40000&ex=market&im=dynamic14a&es=0.3"));
    expect(p.peakKWp).toBe(22);
    expect(p.capacityKWh).toBe(0);
    expect(p.investmentEUR).toBe(40000);
    expect(p.exportScheme).toBe("market");
    expect(p.importScheme).toBe("dynamic14a");
    expect(p.consumers.ev.pvShare).toBeCloseTo(0.3, 6);
  });

  it("parses marketMarginCt from query string", () => {
    const p = simParamsFromQuery(new URLSearchParams("mm=1.5"));
    expect(p.marketMarginCt).toBe(1.5);
  });

  it("marketMarginCt defaults to 1 when not in query", () => {
    const p = simParamsFromQuery(new URLSearchParams(""));
    expect(p.marketMarginCt).toBe(1);
  });

  it("marketMarginCt reduces export revenue in market scheme", () => {
    const r0 = runSimulation(params({ marketMarginCt: 0, exportScheme: "market" }));
    const r1 = runSimulation(params({ marketMarginCt: 1.5, exportScheme: "market" }));
    expect(r1.summary.exportRevenueEUR).toBeLessThan(r0.summary.exportRevenueEUR);
  });

  it("marketMarginCt has no effect in fixed export scheme", () => {
    const r0 = runSimulation(params({ marketMarginCt: 0, exportScheme: "fixed" }));
    const r1 = runSimulation(params({ marketMarginCt: 1.5, exportScheme: "fixed" }));
    expect(r1.summary.exportRevenueEUR).toBeCloseTo(r0.summary.exportRevenueEUR, 10);
  });
});

describe("runSimulation > gridMix", () => {
  const SOURCES = ["wind", "solar", "gas", "coal", "biomass", "hydro", "other"] as const;

  function sumShares(s: { wind: number; solar: number; gas: number; coal: number; biomass: number; hydro: number; other: number }): number {
    return SOURCES.reduce((a, k) => a + s[k], 0);
  }

  it("gridMix shares sum to 1.0 for all three views", () => {
    const r = runSimulation(params());
    expect(sumShares(r.gridMix.heatpump)).toBeCloseTo(1.0, 6);
    expect(sumShares(r.gridMix.overall)).toBeCloseTo(1.0, 6);
    expect(sumShares(r.gridMix.withoutPv)).toBeCloseTo(1.0, 6);
  });

  it("overall grid import has higher gas share than withoutPv (PV removes sunny hours)", () => {
    const r = runSimulation(params());
    // Self-consumed PV removes sunny daytime hours (high solar, low gas)
    // from the grid import, so the remaining grid import is gas-heavier.
    expect(r.gridMix.overall.gas).toBeGreaterThanOrEqual(r.gridMix.withoutPv.gas);
  });

  it("overall grid import has lower solar share than withoutPv", () => {
    const r = runSimulation(params());
    // Solar PV is self-consumed, so it doesn't appear in grid import.
    expect(r.gridMix.overall.solar).toBeLessThanOrEqual(r.gridMix.withoutPv.solar);
  });

  it("heatpump grid mix is present when HP is enabled", () => {
    const r = runSimulation(params({ consumers: { ...baseConsumers, heatpump: { enabled: true, annualKWh: 5000 } } }));
    expect(sumShares(r.gridMix.heatpump)).toBeGreaterThan(0);
  });

  it("overall mix has non-zero shares for at least two sources", () => {
    const r = runSimulation(params());
    const nonZero = SOURCES.filter((k) => r.gridMix.overall[k] > 0.01).length;
    expect(nonZero).toBeGreaterThanOrEqual(2);
  });

  it("all shares are between 0 and 1", () => {
    const r = runSimulation(params());
    for (const view of [r.gridMix.heatpump, r.gridMix.overall, r.gridMix.withoutPv]) {
      for (const src of SOURCES) {
        expect(view[src], `${src} should be >= 0`).toBeGreaterThanOrEqual(0);
        expect(view[src], `${src} should be <= 1`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("runSimulation > co2Analysis", () => {
  it("current scenario has lower CO2 than without PV", () => {
    const r = runSimulation(params());
    expect(r.co2Analysis.current.co2Kg).toBeLessThan(r.co2Analysis.withoutPv.co2Kg);
  });

  it("current scenario has lower CO2 than baseline (no PV, no HP)", () => {
    const r = runSimulation(params());
    expect(r.co2Analysis.current.co2Kg).toBeLessThan(r.co2Analysis.baseline.co2Kg);
  });

  it("savedVsBaseline is positive when PV reduces CO2", () => {
    const r = runSimulation(params());
    expect(r.co2Analysis.savedVsBaselineKg).toBeGreaterThan(0);
  });

  it("direct gas emits more CO2 than current HP scenario", () => {
    const r = runSimulation(params({ consumers: { ...baseConsumers, heatpump: { enabled: true, annualKWh: 5000 } } }));
    if (r.co2Analysis.directGas.co2Kg > 0) {
      expect(r.co2Analysis.current.co2Kg).toBeLessThan(r.co2Analysis.directGas.co2Kg);
    }
  });

  it("all scenario CO2 values are non-negative", () => {
    const r = runSimulation(params());
    const scenarios = [r.co2Analysis.current, r.co2Analysis.withoutPv, r.co2Analysis.withoutHp, r.co2Analysis.baseline, r.co2Analysis.directGas];
    for (const s of scenarios) {
      expect(s.co2Kg, `${s.label} CO2 should be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it("co2Tonnes is consistent with co2Kg", () => {
    const r = runSimulation(params());
    const s = r.co2Analysis.current;
    expect(s.co2Tonnes).toBeCloseTo(s.co2Kg / 1000, 1);
  });
});
