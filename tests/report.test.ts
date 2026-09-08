import { describe, it, expect } from "vitest";
import { runSimulation, simParamsFromQuery, DEFAULT_SIM_PARAMS, SimParams, estimateInvestmentEUR, CO2_EMISSION_FACTORS, CO2_GAS_DIRECT, CO2_DIESEL } from "../src/calc/report";
import { ConsumerConfig, evLoad } from "../src/calc/consumers";
import { annualAverageMix, electricityMixForStep } from "../src/calc/electricityMix";

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
  it("baseline has higher CO2 than +PV", () => {
    const r = runSimulation(params());
    expect(r.co2Analysis.baseline.co2Kg).toBeGreaterThanOrEqual(r.co2Analysis.plusPv.co2Kg);
  });

  it("+EV (grid-only, no PV) is cleaner than the diesel baseline", () => {
    // Physically honest: even charged 100% from the current German grid (no PV,
    // no smart charging), an EV emits clearly LESS CO2 than a diesel over the
    // same distance. The reason is the drivetrain-efficiency gap: a diesel burns
    // ~55 kWh of chemical energy per 100 km (5.5 l × ~10 kWh/l) vs. the EV's
    // ~17 kWh/100 km, so grid electricity at ~0.39 kg/kWh still beats diesel at
    // ~3.17 kg/l well-to-wheel. The earlier model wrongly charged the diesel
    // with the EV's 17 kWh/100 km, erasing this gap and making the EV look
    // dirtier — a bug this test now guards against.
    const r = runSimulation(params());
    const b = r.co2Analysis.baseline;      // diesel + gas + household grid
    const ev = r.co2Analysis.plusEv;       // EV + gas + (household+EV) grid
    // Compare the mobility term directly: EV grid-charging CO2 vs. diesel CO2.
    const evChargingCo2 = ev.electricityCo2Kg - b.electricityCo2Kg; // extra grid for EV
    expect(evChargingCo2).toBeGreaterThan(0);
    expect(b.carCo2Kg).toBeGreaterThan(0);
    // The EV's grid-charging emissions must be well below the diesel's.
    expect(evChargingCo2).toBeLessThan(b.carCo2Kg);
    // And the whole +EV scenario must beat the diesel baseline overall.
    expect(ev.co2Kg).toBeLessThan(b.co2Kg);
  });

  it("diesel CO2 is litre-based (dieselLPer100km), not the EV's kWh/100km", () => {
    // Regression guard for the fixed bug: diesel CO2 must scale with the diesel
    // car's own litre consumption × ~3.17 kg/l, so ~15000 km at 5.5 l/100km
    // → ~825 l → ~2.6 t, NOT the ~0.8 t the old 17 kWh/100km path produced.
    const km = 15000;
    // Disable the EV so the diesel distance comes from p.car.annualKm directly
    // (when the EV is on, the model derives the shared distance from EV kWh).
    const r = runSimulation(params({
      consumers: { ...baseConsumers, ev: { enabled: false, annualKWh: 0, pvShare: 0.8 } },
      car: { ...DEFAULT_SIM_PARAMS.car, annualKm: km, dieselLPer100km: 5.5 },
    }));
    const carCo2 = r.co2Analysis.baseline.carCo2Kg;
    const expectedLitres = (km / 100) * 5.5;           // 825 l
    const expectedCo2 = expectedLitres * 3.17;         // ~2615 kg
    expect(carCo2).toBeGreaterThan(expectedCo2 * 0.97);
    expect(carCo2).toBeLessThan(expectedCo2 * 1.03);
  });

  it("+EV+PV beats the diesel baseline once PV covers part of the charging", () => {
    // With PV in the mix the EV clearly wins on CO2 vs. the diesel baseline.
    const r = runSimulation(params());
    expect(r.co2Analysis.plusEvPv.co2Kg).toBeLessThan(r.co2Analysis.baseline.co2Kg);
  });

  it("+EV+WP has the lowest CO2 of all scenarios", () => {
    const r = runSimulation(params({ consumers: { ...baseConsumers, heatpump: { enabled: true, annualKWh: 5000 } } }));
    const all = [r.co2Analysis.baseline, r.co2Analysis.plusPv, r.co2Analysis.plusEv, r.co2Analysis.plusEvPv, r.co2Analysis.plusEvWp];
    const min = Math.min(...all.map((s) => s.co2Kg));
    expect(r.co2Analysis.plusEvWp.co2Kg).toBe(min);
  });

  it("baseline has non-zero CO2 (diesel + gas + grid)", () => {
    const r = runSimulation(params({ car: { ...DEFAULT_SIM_PARAMS.car, annualKm: 15000 } }));
    expect(r.co2Analysis.baseline.co2Kg).toBeGreaterThan(0);
    expect(r.co2Analysis.baseline.carCo2Kg).toBeGreaterThan(0);
    expect(r.co2Analysis.baseline.heatingCo2Kg).toBeGreaterThan(0);
  });

  it("all scenario CO2 values are non-negative", () => {
    const r = runSimulation(params());
    const scenarios = [r.co2Analysis.baseline, r.co2Analysis.plusPv, r.co2Analysis.plusEv, r.co2Analysis.plusEvPv, r.co2Analysis.plusEvWp];
    for (const s of scenarios) {
      expect(s.co2Kg, `${s.label} CO2 should be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it("co2Tonnes is consistent with co2Kg", () => {
    const r = runSimulation(params());
    for (const s of [r.co2Analysis.baseline, r.co2Analysis.plusEvWp]) {
      expect(s.co2Tonnes).toBeCloseTo(s.co2Kg / 1000, 1);
    }
  });

  it("heating + electricity + car sums to total CO2", () => {
    const r = runSimulation(params({ car: { ...DEFAULT_SIM_PARAMS.car, annualKm: 15000 } }));
    for (const s of [r.co2Analysis.baseline, r.co2Analysis.plusEvWp]) {
      expect(s.heatingCo2Kg + s.electricityCo2Kg + s.carCo2Kg).toBeCloseTo(s.co2Kg, -1);
    }
  });

  it("savings are zero for baseline", () => {
    const r = runSimulation(params());
    expect(r.co2Analysis.baseline.co2SavedKg).toBe(0);
    expect(r.co2Analysis.baseline.gasSavedKWh).toBe(0);
  });

  // ---- Plausibility guards (regression for the inflated-CO2 bug) ----------

  it("the modelled grid intensity is in the realistic German band (~0.35-0.45 kg/kWh)", () => {
    const m = annualAverageMix();
    const intensity =
      m.wind * CO2_EMISSION_FACTORS.wind +
      m.solar * CO2_EMISSION_FACTORS.solar +
      m.gas * CO2_EMISSION_FACTORS.gas +
      m.coal * CO2_EMISSION_FACTORS.coal +
      m.biomass * CO2_EMISSION_FACTORS.biomass +
      m.hydro * CO2_EMISSION_FACTORS.hydro +
      m.other * CO2_EMISSION_FACTORS.other;
    expect(intensity).toBeGreaterThan(0.33);
    expect(intensity).toBeLessThan(0.45);
  });

  it("baseline electricity CO2 reflects ONLY the household (no phantom heat-pump elec)", () => {
    // 2400 kWh household at ~0.35-0.42 kg/kWh → ~840-1010 kg. Must NOT include
    // the 5000 kWh heat-pump electricity (that heat is gas in the baseline).
    const r = runSimulation(params());
    const elec = r.co2Analysis.baseline.electricityCo2Kg;
    expect(elec).toBeGreaterThan(700);
    expect(elec).toBeLessThan(1100);
    // Sanity: household-only intensity per kWh is realistic.
    expect(elec / 2400).toBeGreaterThan(0.30);
    expect(elec / 2400).toBeLessThan(0.45);
  });

  it("baseline heating uses gas (not electricity) and is the dominant term", () => {
    const r = runSimulation(params());
    const b = r.co2Analysis.baseline;
    // 15000 kWh useful heat / 0.92 × gas factor → ~3.5-4.2 t
    expect(b.heatingCo2Kg).toBeGreaterThan(3000);
    expect(b.heatingCo2Kg).toBeLessThan(4500);
    expect(b.heatingCo2Kg).toBeGreaterThan(b.electricityCo2Kg);
  });

  it("+EV+WP savedEUR aligns with the opportunity-cost module (diesel + gas savings)", () => {
    const r = runSimulation(params());
    const dieselSaving = r.opportunityInvestment.carSavingEUR;   // diesel − EV
    const gasSaving = r.opportunityInvestment.heatingSavingEUR;  // gas − heat pump
    const expected = dieselSaving + gasSaving;
    // Allow small rounding (savedEUR is rounded to whole euros).
    expect(r.co2Analysis.plusEvWp.savedEUR).toBeGreaterThan(expected - 3);
    expect(r.co2Analysis.plusEvWp.savedEUR).toBeLessThan(expected + 3);
    // And it must be substantial (thousands of €), not a few hundred.
    expect(r.co2Analysis.plusEvWp.savedEUR).toBeGreaterThan(1500);
  });

  it("+EV savedEUR equals the diesel→EV running-cost saving", () => {
    const r = runSimulation(params());
    const dieselSaving = r.opportunityInvestment.carSavingEUR;
    expect(r.co2Analysis.plusEv.savedEUR).toBeGreaterThan(dieselSaving - 3);
    expect(r.co2Analysis.plusEv.savedEUR).toBeLessThan(dieselSaving + 3);
  });

  it("diesel & gas emission factors are well-to-wheel (fair vs. grid electricity)", () => {
    // Diesel WTW ≈ 3.17 kg/litre; expressed per kWh that is ~3.17/9.8 ≈ 0.32
    // kg/kWh (tooltip only). Gas ≈ 0.24 kg/kWh well-to-burner.
    expect(CO2_DIESEL).toBeGreaterThan(0.30);
    expect(CO2_DIESEL).toBeLessThan(0.34);
    expect(CO2_GAS_DIRECT).toBeGreaterThan(0.22);
    expect(CO2_GAS_DIRECT).toBeLessThan(0.26);
    // Gas *fuel* factor must be well below the old bogus 1.0 kg/kWh electricity.
    expect(CO2_EMISSION_FACTORS.gas).toBeLessThan(0.5);
  });

  it("the fully-electrified scenario (+EV+WP) is the CO2 winner and saves multi-tonne", () => {
    const r = runSimulation(params());
    const all = [
      r.co2Analysis.baseline,
      r.co2Analysis.plusPv,
      r.co2Analysis.plusEv,
      r.co2Analysis.plusEvPv,
      r.co2Analysis.plusEvWp,
    ];
    const min = Math.min(...all.map((s) => s.co2Kg));
    expect(r.co2Analysis.plusEvWp.co2Kg).toBe(min);
    expect(r.co2Analysis.plusEvWp.co2SavedKg).toBeGreaterThan(2000);
  });

  // ---- New scenarios: electrification without PV --------------------------

  it("evWpNoPv (EV+WP, all grid) sits between the baseline and the PV-backed +EV+WP", () => {
    // Fully electrified (heat pump + EV, no gas, no diesel) but WITHOUT PV.
    // It must beat the fossil baseline (electrification helps even on grid
    // power), yet emit MORE than the same config WITH PV (plusEvWp), so the
    // PV contribution is isolated and positive.
    const r = runSimulation(params());
    const noPv = r.co2Analysis.evWpNoPv;
    expect(noPv.co2Kg).toBeLessThan(r.co2Analysis.baseline.co2Kg);
    expect(noPv.co2Kg).toBeGreaterThan(r.co2Analysis.plusEvWp.co2Kg);
    // No gas and no diesel in this scenario — heat and mobility are electric.
    expect(noPv.heatingCo2Kg).toBe(0);
    expect(noPv.carCo2Kg).toBe(0);
    expect(noPv.co2SavedKg).toBeGreaterThan(0);
  });

  it("wpDieselGrid (WP + diesel, all grid, no PV) still drives diesel and avoids gas", () => {
    const r = runSimulation(params());
    const s = r.co2Analysis.wpDieselGrid;
    // Heat is electric (no gas), mobility is still diesel.
    expect(s.heatingCo2Kg).toBe(0);
    expect(s.carCo2Kg).toBeGreaterThan(0);
    // Same diesel car as the baseline, so identical diesel CO2.
    expect(s.carCo2Kg).toBeCloseTo(r.co2Analysis.baseline.carCo2Kg, -1);
    // Swapping gas heat for a grid heat pump reduces total CO2 vs. baseline.
    expect(s.co2Kg).toBeLessThan(r.co2Analysis.baseline.co2Kg);
    // But keeping diesel makes it dirtier than the fully-electrified no-PV case.
    expect(s.co2Kg).toBeGreaterThan(r.co2Analysis.evWpNoPv.co2Kg);
    // Only the gas→heat-pump money saving (car unchanged).
    expect(s.savedEUR).toBeGreaterThan(0);
  });

  it("the two new scenarios keep the heating+electricity+car identity", () => {
    const r = runSimulation(params());
    for (const s of [r.co2Analysis.evWpNoPv, r.co2Analysis.wpDieselGrid]) {
      expect(s.heatingCo2Kg + s.electricityCo2Kg + s.carCo2Kg).toBeCloseTo(s.co2Kg, -1);
      expect(s.co2Kg).toBeGreaterThanOrEqual(0);
    }
  });

  it("EV charges at cleaner-than-average grid hours (no evening/morning dirty charging)", () => {
    // The seasonal EV profile targets the sunny midday window (summer) and the
    // wind-rich night window (winter), avoiding the dirty morning/evening peaks.
    // So the grid-intensity-weighted average of the EV load must be at or below
    // the flat annual grid average.
    const ev = evLoad(2000, 0.8);
    const intensity = (i: number): number => {
      const x = electricityMixForStep(i);
      return (
        x.wind * CO2_EMISSION_FACTORS.wind +
        x.solar * CO2_EMISSION_FACTORS.solar +
        x.gas * CO2_EMISSION_FACTORS.gas +
        x.coal * CO2_EMISSION_FACTORS.coal +
        x.biomass * CO2_EMISSION_FACTORS.biomass +
        x.hydro * CO2_EMISSION_FACTORS.hydro +
        x.other * CO2_EMISSION_FACTORS.other
      );
    };
    let evWeighted = 0;
    let evTotal = 0;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i] > 0) {
        evWeighted += ev[i] * intensity(i);
        evTotal += ev[i];
      }
    }
    const evAvg = evWeighted / evTotal;

    const flat = annualAverageMix();
    const flatAvg =
      flat.wind * CO2_EMISSION_FACTORS.wind +
      flat.solar * CO2_EMISSION_FACTORS.solar +
      flat.gas * CO2_EMISSION_FACTORS.gas +
      flat.coal * CO2_EMISSION_FACTORS.coal +
      flat.biomass * CO2_EMISSION_FACTORS.biomass +
      flat.hydro * CO2_EMISSION_FACTORS.hydro +
      flat.other * CO2_EMISSION_FACTORS.other;

    // EV timing must be no dirtier than an all-hours-flat charge.
    expect(evAvg).toBeLessThanOrEqual(flatAvg + 0.005);

    // And crucially: even a PURE GRID charger (no own PV) still benefits from
    // clean grid hours (sunny summer middays / windy winter nights), so its
    // timing is strictly cleaner than charging flat across all hours.
    const gridOnly = evLoad(2000, 0);
    let gw = 0;
    let gt = 0;
    for (let i = 0; i < gridOnly.length; i++) {
      if (gridOnly[i] > 0) {
        gw += gridOnly[i] * intensity(i);
        gt += gridOnly[i];
      }
    }
    expect(gw / gt).toBeLessThan(flatAvg);
  });
});
