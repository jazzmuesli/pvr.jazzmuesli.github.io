import { describe, it, expect } from "vitest";
import { advisorTurn, scenariosEqual } from "../src/chatbot/advisor";
import { ChatBot as ChatBotClass } from "../src/chatbot/chatbot";
import { createStore } from "../src/store";
import { defaultScenario, Scenario } from "../src/scenario";

function turn(msg: string, stage: Parameters<typeof advisorTurn>[1]["stage"], scenario?: Scenario) {
  return advisorTurn(msg, { scenario: scenario ?? defaultScenario(), stage });
}

describe("advisor — guided PV funnel", () => {
  it("welcomes and offers the Balkonkraftwerk (300 €)", () => {
    const o = turn("", "welcome");
    expect(o.intent).toBe("offer_balkon");
    expect(o.stage).toBe("offer_balkon");
    expect(o.reply).toContain("Balkonkraftwerk");
    expect(o.reply).toContain("300");
    expect(o.metrics?.investmentEUR).toBe(300);
  });

  it("accepts the Balkonkraftwerk -> moves to 10 kWp offer", () => {
    const o = turn("ja", "offer_balkon");
    expect(o.scenario.pv).toBe("balcony");
    expect(o.stage).toBe("offer_10kw");
    expect(o.reply).toContain("10 kWp");
  });

  it("accepts 10 kWp -> moves to 10 kWp + battery", () => {
    const o = turn("ja", "offer_10kw");
    expect(o.scenario.pv).toBe("10");
    expect(o.stage).toBe("offer_10kw_battery");
  });

  it("accepts the battery -> asks about consumers", () => {
    const o = turn("ja", "offer_10kw_battery");
    expect(o.scenario.battery).toBe("on");
    expect(o.stage).toBe("ask_consumers");
  });

  it("offers heat pump, EV and hot-water heat pump as options", () => {
    const o = turn("was gibt es noch?", "ask_consumers");
    expect(o.reply.toLowerCase()).toContain("wärmepumpe");
    expect(o.reply.toLowerCase()).toContain("e-auto");
    expect(o.reply.toLowerCase()).toContain("brauchwasser");
  });

  it("adds a heat pump with the requested kWh", () => {
    const o = turn("Wärmepumpe 3000", "ask_consumers");
    expect(o.scenario.heatpump).toBe(true);
    expect(o.scenario.heatpumpKWh).toBe(3000);
    expect(o.stage).toBe("ask_consumers");
  });

  it("adds an EV", () => {
    const o = turn("E-Auto", "ask_consumers");
    expect(o.scenario.ev).toBe(true);
  });

  it("adds a hot-water heat pump", () => {
    const o = turn("Brauchwasser", "ask_consumers");
    expect(o.scenario.bwwp).toBe(true);
  });

  it("finishes with a summary and an /index.html link", () => {
    const o = turn("weiter", "ask_consumers");
    expect(o.intent).toBe("summary");
    expect(o.stage).toBe("ready");
    expect(o.link).toMatch(/^\/index\.html\?/);
    expect(o.reply).toContain("index.html");
  });

  it("lets the user adjust the electricity price", () => {
    const o = turn("Strompreis 35", "ready");
    expect(o.scenario.priceCt).toBe(35);
  });

  it("responds to an explicit summary request with a link", () => {
    const o = turn("Bitte zusammenfassen", "ready");
    expect(o.intent).toBe("summary");
    expect(o.link).toBeDefined();
  });
});

describe("ChatBot integration (with injected generator)", () => {
  it("drives the funnel and applies scenario changes to the store", async () => {
    const fakeGen = async (_system: string, out: { intent: string }) => `LLM:${out.intent}`;
    const store = createStore(defaultScenario());
    const bot = new ChatBotClass({ store, generate: fakeGen });

    const greet = await bot.send("");
    expect(greet.reply).toBe("LLM:offer_balkon");

    const afterBalkon = await bot.send("ja");
    expect(afterBalkon.reply).toBe("LLM:accept_balkon");
    expect(store.getState().pv).toBe("balcony");

    await bot.send("ja"); // 10 kWp
    await bot.send("ja"); // + battery
    expect(store.getState().battery).toBe("on");

    const summary = await bot.send("zusammenfassen");
    expect(summary.link).toMatch(/^\/index\.html\?/);
  });

  it("falls back to the template reply if the generator throws", async () => {
    const failingGen = async () => {
      throw new Error("no network");
    };
    const store = createStore(defaultScenario());
    const bot = new ChatBotClass({ store, generate: failingGen });
    const o = await bot.send("");
    expect(o.reply).toContain("Balkonkraftwerk");
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
