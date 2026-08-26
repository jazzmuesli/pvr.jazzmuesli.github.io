import { describe, it, expect } from "vitest";
import { advisorTurn, scenariosEqual } from "../src/chatbot/advisor";
import { ChatBot as ChatBotClass, coercePatch, InterpretFn } from "../src/chatbot/chatbot";
import { createStore } from "../src/store";
import { defaultScenario, Scenario } from "../src/scenario";

function turn(msg: string, scenario?: Scenario) {
  return advisorTurn(msg, { scenario: scenario ?? defaultScenario(), stage: "ready" });
}

describe("advisor — applies user input directly (no confirmation)", () => {
  it("welcomes without changing the scenario", () => {
    const o = turn("");
    expect(o.intent).toBe("welcome");
    expect(o.scenario).toEqual(defaultScenario());
  });

  it("adjusts the electricity price from '24c'", () => {
    const o = turn("ok, nimm anderen stromanbieter fuer 24c");
    expect(o.scenario.priceCt).toBe(24);
    expect(o.intent).toBe("adjust");
  });

  it("derives the price from a yearly bill ('100 € for 3500 kWh')", () => {
    const o = turn("ich zahle 100 euro für 3500 kWh im jahr");
    expect(o.scenario.priceCt).toBeCloseTo(2.86, 1);
    expect(o.intent).toBe("adjust");
  });

  it("changes the location", () => {
    const o = turn("anderer ort hamburg");
    expect(o.scenario.location).toBe("hamburg");
  });

  it("adds a heat pump with the requested kWh", () => {
    const o = turn("wärmepumpe 3000");
    expect(o.scenario.heatpump).toBe(true);
    expect(o.scenario.heatpumpKWh).toBe(3000);
  });

  it("adds an EV", () => {
    const o = turn("e-auto");
    expect(o.scenario.ev).toBe(true);
  });

  it("selects 10 kWp and a battery", () => {
    const o1 = turn("10 kwp");
    expect(o1.scenario.pv).toBe("10");
    expect(turn("mit speicher").scenario.battery).toBe("on");
  });

  it("returns a summary link on explicit request", () => {
    const o = turn("bitte zusammenfassen");
    expect(o.intent).toBe("summary");
    expect(o.link).toMatch(/^\/index\.html\?/);
  });

  it("clarifies (without changing) on unrelated input", () => {
    const o = turn("wie wird das wetter?");
    expect(o.intent).toBe("clarify");
    expect(o.scenario).toEqual(defaultScenario());
  });
});

describe("ChatBot with LLM interpreter", () => {
  it("applies the interpreter's patch and replies", async () => {
    const interpret: InterpretFn = async () => ({ reply: "Preis auf 24 ct gesetzt.", patch: { priceCt: 24 } });
    const store = createStore(defaultScenario());
    const bot = new ChatBotClass({ store, interpret });
    const o = await bot.send("anderer stromanbieter 24c");
    expect(store.getState().priceCt).toBe(24);
    expect(o.intent).toBe("adjust");
    expect(o.reply).toContain("24");
  });

  it("falls back to the advisor when the interpreter throws", async () => {
    const interpret: InterpretFn = async () => {
      throw new Error("no network");
    };
    const store = createStore(defaultScenario());
    const bot = new ChatBotClass({ store, interpret });
    await bot.send("strompreis 35");
    expect(store.getState().priceCt).toBe(35);
  });
});

describe("ChatBot fallback (generate only)", () => {
  it("uses the deterministic advisor and polishes the text", async () => {
    const fakeGen = async (_s: string, out: { intent: string }) => `LLM:${out.intent}`;
    const store = createStore(defaultScenario());
    const bot = new ChatBotClass({ store, generate: fakeGen });
    const o = await bot.send("strompreis 35");
    expect(store.getState().priceCt).toBe(35);
    expect(o.reply).toBe("LLM:adjust");
  });
});

describe("coercePatch", () => {
  it("drops invalid enum values and clamps numbers", () => {
    const s = coercePatch(defaultScenario(), {
      pv: "99" as Scenario["pv"],
      priceCt: 999,
      consumptionKWh: 10,
    } as Partial<Scenario>);
    expect(s.pv).toBe("10"); // unchanged (invalid enum)
    expect(s.priceCt).toBe(60); // clamped
    expect(s.consumptionKWh).toBe(500); // clamped
  });
});

describe("scenariosEqual", () => {
  it("detects differences", () => {
    const a = defaultScenario();
    const b = { ...a, pv: "20" as const };
    expect(scenariosEqual(a, b)).toBe(false);
    expect(scenariosEqual(a, { ...a })).toBe(true);
  });
});
