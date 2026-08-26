import { describe, it, expect } from "vitest";
import { runSimulation, simParamsFromQuery, DEFAULT_SIM_PARAMS, SimParams } from "../src/calc/report";
import { ConsumerConfig } from "../src/calc/consumers";

const baseConsumers: ConsumerConfig = {
  household: { enabled: true, annualKWh: 2400 },
  heatpump: { enabled: true, annualKWh: 6500 },
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
    expect(r.opportunityCosts.heating.heatpump.totalEUR).toBeCloseTo(1200, 2);
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
});
