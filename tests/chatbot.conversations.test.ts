import { describe, it, expect } from "vitest";
import { ChatBot } from "../src/chatbot/chatbot";
import { createLogger, Logger } from "../src/chatbot/logger";
import { createStore } from "../src/store";
import { defaultScenario } from "../src/scenario";
import { AdvisorOutput } from "../src/chatbot/advisor";

// Deterministic "generator": returns the structured template text, so we can
// assert on the *rough* response (keywords, numbers, deeplink) without a network.
const passthrough = async (_system: string, out: AdvisorOutput) => out.reply;

describe("simulated conversation A — Mieter, 2500 kWh, Balkonkraftwerk", () => {
  it("offers a BKW, accepts it, and can show results + link", async () => {
    const store = createStore(defaultScenario());
    const bot = new ChatBot({ store, generate: passthrough });

    const r1 = await bot.send("Ich wohne zur Miete und verbrauche 2500 kWh, möchte ein BKW – lohnt es sich?");
    expect(r1.intent).toBe("offer_balkon");
    expect(r1.reply).toContain("Balkonkraftwerk");
    expect(r1.reply).toContain("300"); // ~300 € Anschaffung

    const r2 = await bot.send("Ja, zeige mir die Ergebnisse");
    expect(store.getState().pv).toBe("balcony");
    expect(r2.stage).toBe("offer_10kw");

    const r3 = await bot.send("Bitte zusammenfassen");
    expect(r3.link).toMatch(/^\/index\.html\?/);
    expect(r3.reply).toContain("index.html");
    expect(r3.reply).toMatch(/Balkonkraftwerk|800 Wp/);
  });
});

describe("simulated conversation B — Einfamilienhaus, 10 kWp + Speicher", () => {
  it("offers 10 kWp, discusses storage, adopts the battery", async () => {
    const store = createStore(defaultScenario());
    const bot = new ChatBot({ store, generate: passthrough });

    const r1 = await bot.send(
      "Ich wohne in einem Einfamilienhaus und will 10 kWp, was bringt das und brauche ich einen Speicher?",
    );
    expect(r1.stage).toBe("offer_10kw");
    expect(r1.reply).toContain("10 kWp");

    const r2 = await bot.send("Ja");
    expect(store.getState().pv).toBe("10");
    expect(r2.reply).toContain("Speicher");

    const r3 = await bot.send("Ja, ich nehme den Speicher");
    expect(store.getState().battery).toBe("on");
    expect(r3.stage).toBe("ask_consumers");

    const r4 = await bot.send("zusammenfassen");
    expect(r4.link).toBeDefined();
    expect(r4.reply).toContain("index.html");
  });
});

describe("conversation logger", () => {
  it("records user and bot turns with a session id", async () => {
    const records: any[] = [];
    const fakeLogger: Logger = { sessionId: "test-session", record: (t) => records.push(t) };
    const store = createStore(defaultScenario());
    const bot = new ChatBot({ store, generate: passthrough, logger: fakeLogger });

    await bot.send("Hallo");
    await bot.send("Ja");

    const userTurns = records.filter((r) => r.role === "user");
    const botTurns = records.filter((r) => r.role === "bot");
    expect(userTurns.length).toBe(2);
    expect(botTurns.length).toBe(2);
    expect(fakeLogger.sessionId).toBe("test-session");
    expect(records.some((r) => r.scenario && typeof r.scenario === "object")).toBe(true);
  });

  it("createLogger returns a non-empty session id", () => {
    const logger = createLogger();
    expect(typeof logger.sessionId).toBe("string");
    expect(logger.sessionId.length).toBeGreaterThan(0);
  });
});
