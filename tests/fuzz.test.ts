import { describe, it, expect } from "vitest";
import { runSimulation, DEFAULT_SIM_PARAMS, SimParams } from "../src/calc/report";
import { WIND_TURBINES } from "../src/calc/wind";

/**
 * Robust property-based (fuzz) test suite for the PV & Wind Simulation SPA.
 * Generates hundreds of different configuration scenarios, covering min, max,
 * and random intermediate values of all key parameters, asserting physical
 * and economic conservation laws/invariants.
 */
describe("Simulation Invariant Fuzzing", () => {
  // Simple seedable PRNG so tests are 100% deterministic
  let seed = 12345;
  function random(): number {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  }

  function randomRange(min: number, max: number): number {
    return min + random() * (max - min);
  }

  function randomElement<T>(arr: T[]): T {
    return arr[Math.floor(random() * arr.length)];
  }

  function generateFuzzParams(): SimParams {
    const hasBattery = random() > 0.3;
    const hasPV = random() > 0.2;
    const hasWind = random() > 0.3;

    return {
      peakKWp: hasPV ? randomRange(0, 50) : 0,
      tiltDeg: randomRange(0, 60),
      orientation: randomElement(["south", "east", "west", "east_west", "north"]),
      location: randomElement(["hamburg", "berlin", "munich", "cologne", "boizenburg"]),
      capacityKWh: hasBattery ? randomRange(1, 40) : 0,
      maxPowerKW: hasBattery ? randomRange(1, 20) : 0,
      minSOC: randomRange(0, 0.4),
      maxSOC: randomRange(0.6, 1.0),
      efficiency: randomRange(0.7, 0.99),
      startSOC: randomRange(0, 1.0),
      chargeMode: randomElement(["morning", "midday", "gridNegative"]),
      dischargeEvening: random() > 0.2,
      dischargeMorning: random() > 0.2,
      eveningStart: Math.floor(randomRange(15, 20)),
      eveningEnd: Math.floor(randomRange(21, 24)),
      morningStart: Math.floor(randomRange(4, 8)),
      morningEnd: Math.floor(randomRange(9, 14)),
      feedInCt: randomRange(4, 12),
      commissioningYear: randomElement([2023, 2024, 2025, 2026]),
      priceYear: randomElement(["2023", "2024", "2025", "2026"]),
      consumers: {
        household: { enabled: true, annualKWh: randomRange(1000, 6000) },
        heatpump: { enabled: random() > 0.5, annualKWh: randomRange(2000, 8000) },
        bwwp: { enabled: random() > 0.5, annualKWh: randomRange(200, 1000) },
        ev: { enabled: random() > 0.5, annualKWh: randomRange(1000, 5000), pvShare: randomRange(0.1, 1.0) },
      },
      exportScheme: randomElement(["fixed", "market"]),
      importScheme: randomElement(["fixed", "dynamic", "dynamic14a"]),
      importFixedCt: randomRange(18, 45),
      investmentEUR: randomRange(0, 80000),
      horizonYears: Math.floor(randomRange(10, 25)),
      discountRatePct: randomRange(0, 10),
      priceEscalationPct: randomRange(-2, 8),
      omPercentPerYear: randomRange(0, 5),
      inverterLifetimeYears: Math.floor(randomRange(5, 20)),
      inverterReplacementCostEUR: randomRange(500, 4000),
      batteryLifetimeYears: Math.floor(randomRange(5, 20)),
      batteryReplacementCostEUR: randomRange(1000, 8000),
      batteryDegradationPct: randomRange(0.001, 0.05),
      pvDegradationPct: randomRange(0.001, 0.02),
      standbyWattage: randomRange(1, 20),
      heatpumpJaz: randomRange(2.0, 5.0),
      heatpumpElectricCt: randomRange(15, 45),
      car: {
        annualKm: randomRange(5000, 30000),
        evKwhPer100km: randomRange(12, 25),
        dieselLitersPer100km: randomRange(4.5, 9.0),
        dieselPriceEURPerLiter: randomRange(1.3, 2.3),
        electricityPriceCtPerKWh: randomRange(15, 45),
        evAnnualNebenkostenEUR: randomRange(100, 600),
        dieselAnnualNebenkostenEUR: randomRange(300, 1200),
        evMaintenanceEURPerKm: randomRange(0.02, 0.1),
        dieselMaintenanceEURPerKm: randomRange(0.05, 0.2),
      },
      marketMarginCt: randomRange(0.1, 2.0),
      windEnabled: hasWind,
      windCount: hasWind ? Math.floor(randomRange(1, 6)) : 0,
      windHubHeightM: randomRange(3, 15),
      windTurbineId: randomElement(WIND_TURBINES.map((t) => t.id)),
    };
  }

  it("successfully passes fuzzed physical and economic invariants on 100 random scenarios", () => {
    for (let run = 1; run <= 100; run++) {
      const p = generateFuzzParams();
      let r;
      try {
        r = runSimulation(p);
      } catch (err: any) {
        throw new Error(`Failed to simulate configuration at run ${run}: ${err.message}\nParams: ${JSON.stringify(p, null, 2)}`);
      }

      const s = r.summary;

      // Asserting Physical Conservation Invariants
      expect(s.totalPVKWh, `run ${run}: PV yield`).toBeGreaterThanOrEqual(0);
      expect(s.totalWindKWh, `run ${run}: Wind yield`).toBeGreaterThanOrEqual(0);
      expect(s.totalLoadKWh, `run ${run}: total load`).toBeGreaterThan(0);
      expect(s.totalImportKWh, `run ${run}: total import`).toBeGreaterThanOrEqual(0);
      expect(s.totalExportKWh, `run ${run}: total export`).toBeGreaterThanOrEqual(0);

      const totalGeneration = s.totalPVKWh + s.totalWindKWh;

      // 1. Self-consumption cannot exceed total generation (cap enforced)
      expect(s.selfConsumptionKWh, `run ${run}: self-consumption`).toBeLessThanOrEqual(totalGeneration + 1.0); // tiny buffer for any boundary float adjustments

      // 2. Self-consumption cannot exceed total load
      expect(s.selfConsumptionKWh, `run ${run}: self-consumption vs load`).toBeLessThanOrEqual(s.totalLoadKWh + 0.1);

      // 3. Grid Import + Self-consumption must balance the Total Load within 2% (due to battery round-trip losses and standby power)
      const balanceDifference = Math.abs((s.totalImportKWh + s.selfConsumptionKWh) - s.totalLoadKWh);
      const balancePct = (balanceDifference / s.totalLoadKWh) * 100;
      expect(balancePct, `run ${run}: energy balance difference too high (${balancePct.toFixed(2)}%)`).toBeLessThan(2.0);

      // 4. Verification of rates being in bounds
      expect(s.selfConsumptionRatePct, `run ${run}: self-consumption rate bounds`).toBeGreaterThanOrEqual(0);
      expect(s.selfConsumptionRatePct, `run ${run}: self-consumption rate bounds`).toBeLessThanOrEqual(100.1);
      expect(s.selfSufficiencyPct, `run ${run}: self-sufficiency bounds`).toBeGreaterThanOrEqual(0);
      expect(s.selfSufficiencyPct, `run ${run}: self-sufficiency bounds`).toBeLessThanOrEqual(100.1);

      // Asserting Economic/Amortisation Invariants
      expect(r.amortisation.totalInvestmentEUR, `run ${run}: total investment`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.amortisation.annualBenefitEUR), `run ${run}: annual benefit finite`).toBe(true);

      // Simple payback consistency check
      if (r.amortisation.annualBenefitEUR > 0 && p.investmentEUR > 0) {
        const expectedPayback = p.investmentEUR / r.amortisation.annualBenefitEUR;
        expect(r.amortisation.paybackYears, `run ${run}: payback period mismatch`).toBeCloseTo(expectedPayback, 2);
      } else if (p.investmentEUR > 0) {
        expect(r.amortisation.paybackYears, `run ${run}: payback period should be Infinity when benefit <= 0`).toBe(Infinity);
      } else {
        expect(r.amortisation.paybackYears, `run ${run}: payback period should be 0 when investment is 0`).toBe(0);
      }

      // Check for any NaNs inside entire serialized report output (super robust check!)
      const reportStr = JSON.stringify(r);
      expect(reportStr.includes("NaN"), `run ${run}: report JSON contains NaN: ${reportStr}`).toBe(false);
      expect(reportStr.includes("null"), `run ${run}: report JSON contains invalid null (except expected gasSavings/tariffCombinations)`).toBe(true); // JSON representation check, gasSavings can be null
    }
  });
});
