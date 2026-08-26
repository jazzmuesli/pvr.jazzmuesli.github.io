// The Energiewende advisor: a small, deterministic state machine that walks the
// user through a recommended PV path (Balkonkraftwerk → 10 kWp → 10 kWp + battery)
// and offers additional consumers (heat pump, EV, hot-water heat pump). It is
// deliberately free of any network/LLM calls so it can be unit-tested, and it
// produces a structured `AdvisorOutput` that the chatbot layer can either return
// as-is or polish with a language model.

import {
  Scenario,
  OfferKind,
  applyOffer,
  computeMetrics,
  appUrl,
  pvLabel,
  consumerSummary,
} from "../scenario";

export type Stage =
  | "welcome"
  | "offer_balkon"
  | "offer_10kw"
  | "offer_10kw_battery"
  | "ask_consumers"
  | "ready";

export interface AdvisorContext {
  scenario: Scenario;
  stage: Stage;
}

export interface AdvisorOutput {
  /** Natural-language reply (template; the LLM layer may replace it). */
  reply: string;
  /** Machine-readable intent, useful for tests and analytics. */
  intent: string;
  /** Possibly-updated scenario (apply to the shared store). */
  scenario: Scenario;
  /** New stage for the conversation. */
  stage: Stage;
  /** Metrics backing the reply (numbers, no formatting). */
  metrics?: ReturnType<typeof computeMetrics>;
  /** Optional deeplink into the full calculator. */
  link?: string;
}

const OFFER_LABEL: Record<OfferKind, string> = {
  balkon: "Balkonkraftwerk (800 Wp, Süd)",
  "10kw": "10 kWp (Süd)",
  "10kwBattery": "10 kWp mit 10 kWh Speicher",
};

const STAGE_OFFER: Partial<Record<Stage, OfferKind>> = {
  offer_balkon: "balkon",
  offer_10kw: "10kw",
  offer_10kw_battery: "10kwBattery",
};

function fmtEUR(v: number): string {
  return `${Math.round(v).toLocaleString("de-DE")} €`;
}

function fmtAmort(years: number, investment: number): string {
  if (investment <= 0 || !Number.isFinite(years)) return "—";
  return `${years.toFixed(1)} Jahre`;
}

function extractKwh(msg: string): number | null {
  const m = msg.match(/(\d{3,5})/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function offerReply(s: Scenario, kind: OfferKind): { reply: string; metrics: ReturnType<typeof computeMetrics> } {
  const sc = applyOffer(s, kind);
  const m = computeMetrics(sc);
  const reply =
    `${OFFER_LABEL[kind]} – Investition ca. ${fmtEUR(m.investmentEUR)}.\n` +
    `Erwarteter PV-Ertrag: ${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh/Jahr, ` +
    `davon Eigenverbrauch ${Math.round(m.selfKWh).toLocaleString("de-DE")} kWh (${m.selfPct.toFixed(0)} %).\n` +
    `Netto-Bilanz (Export − Import): ${fmtEUR(m.netEUR)}/Jahr. ` +
    `Deine Ersparnis ggü. Volleinspeisung aus dem Netz: ${fmtEUR(m.savingsEUR)}/Jahr.\n` +
    `Amortisation: ${fmtAmort(m.amortYears, m.investmentEUR)}.\n` +
    `Soll ich das übernehmen? (ja / nein)`;
  return { reply, metrics: m };
}

function summarise(s: Scenario): AdvisorOutput {
  const m = computeMetrics(s);
  const reply =
    `Zusammenfassung – ${pvLabel(s)}:\n` +
    `Verbraucher: ${consumerSummary(s)} @ ${s.priceCt} ct/kWh.\n` +
    `PV-Ertrag ${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh, Eigenverbrauch ${m.selfPct.toFixed(0)} %, ` +
    `Netto ${fmtEUR(m.netEUR)}/Jahr, Ersparnis ${fmtEUR(m.savingsEUR)}/Jahr, ` +
    `Amortisation ${fmtAmort(m.amortYears, m.investmentEUR)}, eff. Strompreis ${m.effCt.toFixed(1)} ct/kWh.\n` +
    `Volle Details & Charts im Rechner: ${appUrl(s)}`;
  return {
    reply,
    intent: "summary",
    scenario: s,
    stage: "ready",
    metrics: m,
    link: appUrl(s),
  };
}

function askConsumers(s: Scenario): AdvisorOutput {
  return {
    reply:
      `Möchtest du weitere Verbraucher einbinden, um den Eigenverbrauch zu erhöhen?\n` +
      `• Wärmepumpe (typisch 2.000–5.000 kWh/Jahr)\n` +
      `• E-Auto (z. B. 2.000 kWh/Jahr)\n` +
      `• Brauchwasser-Wärmepumpe (~400 kWh/Jahr)\n` +
      `Sag z. B. „Wärmepumpe 3000" oder „weiter", wenn es passt.`,
    intent: "ask_consumers",
    scenario: s,
    stage: "ask_consumers",
  };
}

function nextOfferStage(stage: Stage): Stage {
  if (stage === "offer_balkon") return "offer_10kw";
  if (stage === "offer_10kw") return "offer_10kw_battery";
  if (stage === "offer_10kw_battery") return "ask_consumers";
  return "ask_consumers";
}

export function advisorTurn(message: string, ctx: AdvisorContext): AdvisorOutput {
  let scenario: Scenario = { ...ctx.scenario };
  let stage: Stage = ctx.stage;
  const msg = (message || "").toLowerCase();

  // 1) Explicit request for a summary / deeplink.
  if (/\b(zusammen|zusammenfass|übersicht|summary|bericht|link|index|details)\b/.test(msg)) {
    return summarise(scenario);
  }

  // 2) Explicit adjustments (price, consumers, PV size, battery).
  let pvKeyword: OfferKind | "20" | null = null;
  const priceM =
    msg.match(/(?:stompreis|arbeitspreis|preis|cent|\bct\b|€).*?(\d{1,2}(?:[.,]\d+)?)/) ||
    msg.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:ct|cent|€)/);
  if (priceM) {
    const v = parseFloat(priceM[1].replace(",", "."));
    if (v >= 10 && v <= 60) {
      scenario = { ...scenario, priceCt: v };
    }
  }
  if (/\b(wärme(?:pumpe|pumpen)?|heatpump|\bwp\b)\b/.test(msg)) {
    const kwh = extractKwh(msg) ?? 3500;
    scenario = { ...scenario, heatpump: true, heatpumpKWh: Math.max(2000, Math.min(5000, kwh)) };
  }
  if (/\b(e-?auto|\bev\b)\b/.test(msg)) {
    const kwh = extractKwh(msg) ?? 2000;
    scenario = { ...scenario, ev: true, evKWh: Math.max(500, Math.min(6000, kwh)) };
  }
  if (/\b(brauchwasser|ww-?wp|\bbwwp\b)\b/.test(msg)) {
    scenario = { ...scenario, bwwp: true };
  }
  if (/\bbalkon(?:kraftwerk)?\b/.test(msg)) pvKeyword = "balkon";
  if (/\b20\s*kwp|20kw\b/.test(msg)) pvKeyword = "20";
  if (/\b10\s*kwp|10kw\b/.test(msg)) pvKeyword = "10kw";
  if (/\b(speicher|batterie)\b/.test(msg) && scenario.pv !== "none") {
    scenario = { ...scenario, battery: "on" };
  }

  // 3) Welcome: greet and present the first relevant offer.
  if (stage === "welcome") {
    if (pvKeyword === "balkon") {
      const o = offerReply(scenario, "balkon");
      return { reply: `Hallo! Gerne berate ich dich zur Energiewende. ${o.reply}`, intent: "offer_balkon", scenario, stage: "offer_balkon", metrics: o.metrics };
    }
    if (pvKeyword === "10kw" || pvKeyword === "20") {
      const o = offerReply(scenario, "10kw");
      return { reply: `Hallo! Gerne berate ich dich zur Energiewende. ${o.reply}`, intent: "offer_10kw", scenario, stage: "offer_10kw", metrics: o.metrics };
    }
    const o = offerReply(scenario, "balkon");
    return {
      reply:
        `Hallo! Ich helfe dir bei der Energiewende: vom Balkonkraftwerk bis zur PV-Anlage ` +
        `mit Speicher. Wir starten mit einem Standard-Haushalt (2.500 kWh/Jahr). ${o.reply}`,
      intent: "offer_balkon",
      scenario,
      stage: "offer_balkon",
      metrics: o.metrics,
    };
  }

  // 4) Offer stages: accept / decline, with optional PV-keyword jump.
  const currentOffer = STAGE_OFFER[stage];
  if (currentOffer) {
    if (pvKeyword === "balkon" || pvKeyword === "10kw" || pvKeyword === "20") {
      const kind: OfferKind = pvKeyword === "balkon" ? "balkon" : "10kw";
      const targetStage: Stage = kind === "balkon" ? "offer_balkon" : "offer_10kw";
      const o = offerReply(scenario, kind);
      return { reply: o.reply, intent: `offer_${kind}`, scenario, stage: targetStage, metrics: o.metrics };
    }
    const accepted = /^(ja|ok|gerne|weiter|passt|zeig|ja bitte|mache|klingt gut|gut|übernimm|übernehmen)\b/.test(msg.trim()) || msg.trim() === "";
    const declined = /\b(nein|überspring|skip|kein|lieber nicht|keine|überspringen|nicht)\b/.test(msg);
    if (accepted) {
      const applied = applyOffer(scenario, currentOffer);
      const next = nextOfferStage(stage);
      if (next === "ask_consumers") return askConsumers(applied);
      const o = offerReply(applied, STAGE_OFFER[next]!);
      return { reply: o.reply, intent: `accept_${currentOffer}`, scenario: applied, stage: next, metrics: o.metrics };
    }
    if (declined) {
      const next = nextOfferStage(stage);
      if (next === "ask_consumers") return askConsumers(scenario);
      const o = offerReply(scenario, STAGE_OFFER[next]!);
      return { reply: o.reply, intent: `decline_${currentOffer}`, scenario, stage: next, metrics: o.metrics };
    }
    const o = offerReply(scenario, currentOffer);
    return { reply: o.reply, intent: `offer_${currentOffer}`, scenario, stage, metrics: o.metrics };
  }

  // 5) Ask-consumers stage.
  if (stage === "ask_consumers") {
    if (/\b(weiter|fertig|genug|passt|ok|ja|gut|übernimm|übernehmen)\b/.test(msg)) {
      return summarise(scenario);
    }
    return askConsumers(scenario);
  }

  // 6) Ready: default to a fresh summary (price/consumer changes already applied).
  return summarise(scenario);
}

export function scenariosEqual(a: Scenario, b: Scenario): boolean {
  return (
    a.consumptionKWh === b.consumptionKWh &&
    a.priceCt === b.priceCt &&
    a.location === b.location &&
    a.pv === b.pv &&
    a.battery === b.battery &&
    a.heatpump === b.heatpump &&
    a.heatpumpKWh === b.heatpumpKWh &&
    a.ev === b.ev &&
    a.evKWh === b.evKWh &&
    a.bwwp === b.bwwp
  );
}
