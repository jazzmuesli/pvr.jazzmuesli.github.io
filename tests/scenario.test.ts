import { describe, it, expect } from "vitest";
import {
  defaultScenario,
  scenarioToQuery,
  scenarioFromQuery,
  runScenario,
  computeMetrics,
  applyOffer,
  appUrl,
} from "../src/scenario";

describe("scenario model", () => {
  it("round-trips through the query string", () => {
    const s = defaultScenario();
    const back = scenarioFromQuery(scenarioToQuery(s).toString());
    expect(back.consumptionKWh).toBe(s.consumptionKWh);
    expect(back.priceCt).toBe(s.priceCt);
    expect(back.location).toBe(s.location);
    expect(back.pv).toBe(s.pv);
    expect(back.battery).toBe(s.battery);
    expect(back.heatpumpKWh).toBe(s.heatpumpKWh);
    expect(back.evKWh).toBe(s.evKWh);
  });

  it("produces a query that index.html understands", () => {
    const q = scenarioToQuery(defaultScenario());
    expect(q.get("kwp")).toBe("10");
    expect(q.get("o")).toBe("south");
    expect(q.get("ict")).toBe("30");
    expect(q.get("hh")).toBe("1");
  });

  it("runs the simulation and yields finite numbers", () => {
    for (const kind of ["none", "balcony", "10", "20"] as const) {
      const rep = runScenario({ ...defaultScenario(), pv: kind, battery: kind === "10" ? "on" : "off" });
      expect(Number.isFinite(rep.summary.totalPVKWh)).toBe(true);
      expect(Number.isFinite(rep.summary.totalLoadKWh)).toBe(true);
      expect(rep.monthly).toHaveLength(12);
      expect(rep.daily).toHaveLength(12);
    }
  });

  it("prices the recommended offers as specified", () => {
    expect(computeMetrics(applyOffer(defaultScenario(), "balkon")).investmentEUR).toBe(300);
    expect(computeMetrics(applyOffer(defaultScenario(), "10kw")).investmentEUR).toBe(7000);
    expect(computeMetrics(applyOffer(defaultScenario(), "10kwBattery")).investmentEUR).toBe(10000);
  });

  it("computes savings vs. a no-PV baseline", () => {
    const m = computeMetrics(applyOffer(defaultScenario(), "10kwBattery"));
    expect(m.savingsEUR).toBeGreaterThan(0);
    expect(m.pvKWh).toBeGreaterThan(0);
  });

  it("builds an /index.html deeplink", () => {
    expect(appUrl(defaultScenario())).toMatch(/^\/index\.html\?/);
  });
});
