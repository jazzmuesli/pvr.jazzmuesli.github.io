// Acceptance tests: the *highest* level of the suite.
//
// These pin the observable behaviour of the public entry points that every
// feature ultimately feeds into:
//
//   1. `runSimulation`      — the whole economic simulation (what the SPA and
//                             the `/api` endpoint both render).
//   2. `handleApiRequest`   — the HTTP contract, byte-for-byte equal to (1).
//   3. the config codec     — `serializeState`/`deserializeState` and the
//                             `simParamsFromQuery` wire format must not drift.
//
// They are deliberately coarse ("characterization") tests: they do not care how
// the simulation is structured, only that the numbers do not move while we
// refactor. A digest change is a prompt to ask "did I mean to change behaviour?"
// — not automatically a bug.

import { describe, it, expect } from "vitest";
import { runSimulation, simParamsFromQuery, DEFAULT_SIM_PARAMS, SimParams } from "../src/calc/report";
import { handleApiRequest } from "../src/api";
import { digest } from "./support/digest";

// ---------------------------------------------------------------------------
// Stable digest of a whole report.
// ---------------------------------------------------------------------------
const reportDigest = digest;

// The behavioural digest ignores the echoed `inputs`: two callers can express
// the same scenario with a field omitted (defaulted) or spelled out, and that
// must not count as a behavioural difference.
function behaviourDigest(r: unknown): string {
  const { inputs, ...rest } = r as { inputs?: unknown };
  void inputs;
  return digest(rest);
}

function P(o: Partial<SimParams> = {}): SimParams {
  return {
    ...DEFAULT_SIM_PARAMS,
    consumers: structuredClone(DEFAULT_SIM_PARAMS.consumers),
    car: { ...DEFAULT_SIM_PARAMS.car },
    ...o,
  };
}

const baseConsumers = structuredClone(DEFAULT_SIM_PARAMS.consumers);

// A broad matrix that exercises every feature axis the project has grown:
// battery strategies, tariffs, markets, producers (wind), consumers (BWWP/EV),
// price years and sizes. Adding a new axis should add a row here.
const SCENARIOS: [string, SimParams][] = [
  ["default", P()],
  ["no-battery", P({ capacityKWh: 0, maxPowerKW: 0 })],
  ["no-pv", P({ peakKWp: 0 })],
  ["peak-discharge", P({ dischargeMode: "peak" })],
  ["grid-negative", P({ chargeMode: "gridNegative" })],
  ["cheapest-charge", P({ chargeMode: "cheapest" })],
  ["market-export-margin", P({ exportScheme: "market", marketMarginCt: 1.5 })],
  ["dynamic-import", P({ importScheme: "dynamic" })],
  ["dynamic14a-import", P({ importScheme: "dynamic14a" })],
  ["wind", P({ windEnabled: true, windCount: 3, windSpeedMeanMs: 6.5 })],
  ["bwwp-off", P({ consumers: { ...baseConsumers, bwwp: { enabled: false } } })],
  ["all-consumers-off", P({ consumers: {
    household: { enabled: false, annualKWh: 0 },
    heatpump: { enabled: false, annualKWh: 0 },
    bwwp: { enabled: false },
    ev: { enabled: false, annualKWh: 0, pvShare: 0.8 },
  } })],
  ["price-2023", P({ priceYear: "2023" })],
  ["price-2026", P({ priceYear: "2026" })],
  ["big-battery-small-pv", P({ peakKWp: 3, capacityKWh: 20, maxPowerKW: 5 })],
  ["ev-grid-only", P({ consumers: { ...baseConsumers, ev: { enabled: true, annualKWh: 3000, pvShare: 0 } } })],
  ["marketing-expert", P({
    dischargeMode: "peak", chargeMode: "gridNegative",
    exportScheme: "market", importScheme: "dynamic14a",
    marketMarginCt: 0.75, windEnabled: true,
  })],
];

// Golden digests captured from the pre-refactor implementation. They are the
// contract that the (behaviour-preserving) structural refactor must not break.
const GOLDEN: Record<string, string> = {
  "default": "951e7da0c98d5c52",
  "no-battery": "6b2fdda15bcf14f2",
  "no-pv": "1bbc304b7b87d603",
  "peak-discharge": "da50f1718cb2669d",
  "grid-negative": "95ca9bf46fc4e1a6",
  "cheapest-charge": "458dfa7381f88a63",
  "market-export-margin": "0ec63926393ee0fc",
  "dynamic-import": "48c08e0ee1226506",
  "dynamic14a-import": "1409c3c30d4ce2de",
  "wind": "ad2e1351be307b82",
  "bwwp-off": "e97f8836f188feeb",
  "all-consumers-off": "dc5a4e6700656728",
  "price-2023": "d8f12f1252892bb4",
  "price-2026": "1c65f6d2375dd42b",
  "big-battery-small-pv": "0e6878aad2a18862",
  "ev-grid-only": "24592d6902a25c6c",
  "marketing-expert": "f24b203423e48513",
};

describe("acceptance: runSimulation characterisation", () => {
  for (const [name, params] of SCENARIOS) {
    it(`scenario "${name}" is byte-stable`, () => {
      const digest = reportDigest(runSimulation(params));
      expect(digest, `scenario "${name}" changed`).toBe(GOLDEN[name]);
    });
  }
});

describe("acceptance: /api contract", () => {
  it("handleApiRequest matches runSimulation for the same query", () => {
    for (const [name, params] of SCENARIOS) {
      // Round-trip the params through the wire format, then compare the two
      // entry points that consume that format.
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          query.set(k, String(v));
        }
      }
      void query; // param names differ from query keys; compare via explicit keys below
      const direct = runSimulation(params);
      const viaApi = handleApiRequest(buildQuery(params));
      expect(behaviourDigest(viaApi), `via /api differs for ${name}`).toBe(behaviourDigest(direct));
    }
  });

  it("returns JSON-serialisable reports", () => {
    expect(() => JSON.stringify(handleApiRequest("kwp=22"))).not.toThrow();
  });
});

// Build the canonical query string for a SimParams via the public parser's
// inverse (kept in one place so the test itself does not drift).
function buildQuery(p: SimParams): string {
  const q = new URLSearchParams();
  q.set("kwp", String(p.peakKWp));
  q.set("tilt", String(p.tiltDeg));
  q.set("o", p.orientation);
  q.set("loc", p.location);
  q.set("cap", String(p.capacityKWh));
  q.set("pwr", String(p.maxPowerKW));
  q.set("minsoc", String(p.minSOC));
  q.set("maxsoc", String(p.maxSOC));
  q.set("eff", String(p.efficiency));
  q.set("soc0", String(p.startSOC));
  q.set("charge", p.chargeMode);
  q.set("dsp", p.dischargeMode);
  q.set("de", p.dischargeEvening ? "1" : "0");
  q.set("dm", p.dischargeMorning ? "1" : "0");
  q.set("evs", String(p.eveningStart));
  q.set("eve", String(p.eveningEnd));
  q.set("mns", String(p.morningStart));
  q.set("mne", String(p.morningEnd));
  q.set("fi", String(p.feedInCt));
  q.set("yr", String(p.commissioningYear));
  q.set("py", p.priceYear);
  q.set("hh", p.consumers.household.enabled ? "1" : "0");
  q.set("hk", String(p.consumers.household.annualKWh));
  q.set("wp", p.consumers.heatpump.enabled ? "1" : "0");
  q.set("wk", String(p.consumers.heatpump.annualKWh));
  q.set("bw", p.consumers.bwwp.enabled ? "1" : "0");
  q.set("bwk", String(p.consumers.bwwp.annualKWh ?? 480));
  q.set("ev", p.consumers.ev.enabled ? "1" : "0");
  q.set("ek", String(p.consumers.ev.annualKWh));
  q.set("es", String(p.consumers.ev.pvShare));
  q.set("ex", p.exportScheme);
  q.set("im", p.importScheme);
  q.set("ict", String(p.importFixedCt));
  q.set("inv", String(p.investmentEUR));
  q.set("hor", String(p.horizonYears));
  q.set("d", String(p.discountRatePct));
  q.set("esc", String(p.priceEscalationPct));
  q.set("om", String(p.omPercentPerYear));
  q.set("invlife", String(p.inverterLifetimeYears));
  q.set("invrep", String(p.inverterReplacementCostEUR));
  q.set("batlife", String(p.batteryLifetimeYears));
  q.set("batrep", String(p.batteryReplacementCostEUR));
  q.set("batdeg", String(p.batteryDegradationPct));
  q.set("pvdeg", String(p.pvDegradationPct));
  q.set("stdby", String(p.standbyWattage));
  q.set("jaz", String(p.heatpumpJaz));
  q.set("wpc", String(p.heatpumpElectricCt));
  q.set("mm", String(p.marketMarginCt));
  q.set("km", String(p.car.annualKm));
  q.set("dl", String(p.car.dieselEurPerL));
  q.set("ec", String(p.car.evElectricCtPerKwh));
  q.set("wen", p.windEnabled ? "1" : "0");
  q.set("wc", String(p.windCount));
  q.set("wh", String(p.windHubHeightM));
  q.set("wt", p.windTurbineId);
  q.set("wsm", String(p.windSpeedMeanMs));
  return q.toString();
}

// Fields the shared-link format is *expected* to round-trip. This set is the
// contract of the config codec; a field that is not covered must be added here
// when the feature lands (and the codec taught about it).
describe("acceptance: config codec completeness", () => {
  it("simParamsFromQuery reproduces a full SimParams via the wire format", () => {
    const original = P({
      dischargeMode: "peak",
      chargeMode: "cheapest",
      exportScheme: "market",
      importScheme: "dynamic14a",
      marketMarginCt: 0.9,
      heatpumpJaz: 3.4,
      windEnabled: true,
      windCount: 2,
    });
    const parsed = simParamsFromQuery(new URLSearchParams(buildQuery(original)));
    // Everything except explicitly user-overridable consumer/hp derivations.
    expect(parsed).toEqual(original);
  });

  it("does not mutate the shared defaults", () => {
    const before = JSON.stringify(DEFAULT_SIM_PARAMS);
    simParamsFromQuery(new URLSearchParams("hk=9999&km=9999&wp=0&wpc=77&ict=44"));
    expect(JSON.stringify(DEFAULT_SIM_PARAMS)).toBe(before);
  });
});

// The shared-link format must round-trip every field the UI can edit. This
// guards the class of bug where a new parameter is added to the simulation but
// the URL serializer is forgotten, so shared links silently lose it.
describe("acceptance: shared-link codec completeness", () => {
  it("deserializeState(serializeState(s)) preserves every editable field", async () => {
    const { DEFAULT_STATE, toSimParams } = await import("../src/ui/state");
    const { serializeState, deserializeState } = await import("../src/ui/url");
    const rich = {
      ...structuredClone(DEFAULT_STATE),
      expertMode: true,
      marketMarginCt: 0.75,
      heatpumpJaz: 3.7,
      heatpumpElectricCt: 21,
      car: { ...DEFAULT_STATE.car, annualKm: 12345, dieselEurPerL: 1.87, evElectricCtPerKwh: 27 },
    };
    const restored = deserializeState(serializeState(rich));
    expect(toSimParams(restored)).toEqual(toSimParams(rich));
  });
});
