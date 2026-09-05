// The Energiewende advisor: a small, deterministic state machine that turns the
// user's free-form requests into concrete scenario changes. It is deliberately
// free of any network/LLM calls so it can be unit-tested, and it produces a
// structured `AdvisorOutput` that the chatbot layer can either return as-is or
// polish with a language model.
//
// Design principle: the user's words are applied *directly* to the shared
// scenario (no "Soll ich das übernehmen?" confirmation step). Every recognised
// change is reflected on the sliders at once and the advisor reports back the
// resulting economics.

import {
  Scenario,
  computeMetrics,
  appUrl,
  pvLabel,
  pvPreset,
} from "../scenario";
import { t } from "../i18n";

export type Stage = "welcome" | "ready";

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

const LOCATIONS = ["boizenburg", "hamburg", "berlin", "koeln", "muenchen"];

function fmtEUR(v: number): string {
  return `${Math.round(v).toLocaleString("de-DE")} €`;
}

function fmtAmort(years: number, investment: number): string {
  if (investment <= 0 || !Number.isFinite(years)) return "—";
  return `${years.toFixed(1)} Jahre`;
}

function norm(s: string): string {
  return s
    .replace(/ü/g, "ue")
    .replace(/ö/g, "oe")
    .replace(/ä/g, "ae")
    .replace(/ß/g, "ss");
}

function extractKwh(msg: string): number | null {
  const m = msg.match(/(\d{3,5})/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function summarise(s: Scenario, headline?: string): AdvisorOutput {
  const m = computeMetrics(s);
  const reply =
    (headline ? headline + "\n\n" : "") +
    `${t("advisor.summary")} ${pvLabel(s)}:\n` +
    `${t("advisor.consumer_at")} ${s.priceCt} ct/kWh, ${t("advisor.location")}${s.location[0].toUpperCase() + s.location.slice(1)}.\n` +
    `${t("advisor.pv_yield")} ${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh, ${t("advisor.self_consumption")} ${m.selfPct.toFixed(0)} %, ` +
    `${t("advisor.netto")} ${fmtEUR(m.netEUR)}/Jahr, ${t("advisor.savings")} ${fmtEUR(m.savingsEUR)}/Jahr, ` +
    `${t("advisor.amortisation")} ${fmtAmort(m.amortYears, m.investmentEUR)}, ${t("advisor.eff_price")} ${m.effCt.toFixed(1)} ct/kWh.\n` +
    `${t("advisor.full_details")} ${appUrl(s)}`;
  return {
    reply,
    intent: "summary",
    scenario: s,
    stage: "ready",
    metrics: m,
    link: appUrl(s),
  };
}

function resultReply(s: Scenario, changes: string[]): AdvisorOutput {
  const m = computeMetrics(s);
  const reply =
    `${t("advisor.accepted")}\n• ${changes.join("\n• ")}\n\n` +
    `${t("advisor.result")} (${pvLabel(s)}${s.battery === "on" ? " " + t("advisor.with_battery") : ", " + t("advisor.without_battery")}):\n` +
    `${t("advisor.pv_yield")} ${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh/Jahr, ` +
    `${t("advisor.self_consumption")} ${Math.round(m.selfKWh).toLocaleString("de-DE")} kWh (${m.selfPct.toFixed(0)} %).\n` +
    `${t("advisor.netto_label")} ${fmtEUR(m.netEUR)}/Jahr. ` +
    `${t("advisor.savings_label")} ${fmtEUR(m.savingsEUR)}/Jahr.\n` +
    `${t("advisor.amortisation")}: ${fmtAmort(m.amortYears, m.investmentEUR)}, ${t("advisor.eff_price")} ${m.effCt.toFixed(1)} ct/kWh.`;
  return { reply, intent: "adjust", scenario: s, stage: "ready", metrics: m, link: appUrl(s) };
}

export function advisorTurn(message: string, ctx: AdvisorContext): AdvisorOutput {
  let scenario: Scenario = { ...ctx.scenario };
  const msg = (message || "").toLowerCase();
  const changes: string[] = [];

  // 1) Explicit request for a summary / deeplink.
  if (message.trim() !== "" && /(zusammenfa|zusammen|übersicht|summary|bericht|link|index|details|zeig)/.test(msg)) {
    return summarise(scenario);
  }

  // 2) Electricity price — accepts "24c", "24 ct", "Strompreis 35",
  //    "anderer Stromanbieter 24c", "20 cent", etc. Also derives the price from
  //    a total bill, e.g. "ich zahle 100 € für 3500 kWh" → 100*100/3500 ≈ 2,86 ct/kWh.
  const priceM =
    msg.match(/(?:stom|arbeits|preis|cent|\bct\b|€|anbieter).*?(\d{1,2}(?:[.,]\d+)?)/) ||
    msg.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:ct|cent|€|c)\b/);
  if (priceM) {
    const v = parseFloat(priceM[1].replace(",", "."));
    if (Number.isFinite(v) && v >= 10 && v <= 60 && v !== scenario.priceCt) {
      scenario.priceCt = v;
      changes.push(`${t("advisor.price_change")} ${v} ct/kWh`);
    }
  }
  // Derived working price: "<euro> € for <kwh> kWh" (any word order).
  const euroM = msg.match(/(\d{1,3}(?:[.,]\d+)?)\s*(?:€|eur)/i);
  const kwhM = msg.match(/(\d{3,5})\s*kwh/i);
  if (euroM && kwhM) {
    const euro = parseFloat(euroM[1].replace(",", "."));
    const kwh = Number(kwhM[1]);
    const ct = (euro * 100) / kwh;
    if (Number.isFinite(ct) && ct >= 1 && ct <= 60 && Math.abs(ct - scenario.priceCt) > 0.005) {
      scenario.priceCt = Math.round(ct * 100) / 100;
      changes.push(`${t("advisor.price_change")} ${ct.toFixed(2)} ct/kWh (aus ${euro} € / ${kwh} kWh)`);
    }
  }

  // 3) Location.
  const nmsg = norm(msg);
  for (const c of LOCATIONS) {
    if (nmsg.includes(c) && scenario.location !== c) {
      scenario.location = c;
      changes.push(`${t("advisor.location_change")} ${c[0].toUpperCase() + c.slice(1)}`);
      break;
    }
  }

  // 4) PV size — any number is allowed (enums are only example presets).
  if (/\b(kein\s*pv|ohne\s*pv|basis)\b/.test(msg)) {
    if (scenario.peakKWp !== 0) {
      scenario.pv = "none";
      scenario.peakKWp = 0;
      scenario.orientation = "south";
      scenario.battery = "off";
      scenario.capacityKWh = 0;
      scenario.maxPowerKW = 0;
      scenario.investmentEUR = 0;
      changes.push(t("advisor.pv_none"));
    }
  } else if (/\b(balkon(?:kraftwerk)?|\bbkw\b)\b/.test(msg)) {
    const p = pvPreset("balcony");
    scenario.pv = "balcony";
    scenario.peakKWp = p.kwp;
    scenario.orientation = p.orientation;
    scenario.battery = "off";
    scenario.capacityKWh = 0;
    scenario.maxPowerKW = 0;
    scenario.investmentEUR = p.investmentEUR;
    changes.push(pvLabel(scenario));
  } else {
    const pvM = msg.match(/(\d{1,3}(?:[.,]\d+)?)\s*(?:kw|kwp|kw\s*p)/i);
    if (pvM) {
      const n = Number(pvM[1].replace(",", "."));
      if (n > 2) {
        scenario.pv = n >= 19 ? "20" : "10";
        scenario.peakKWp = n;
        scenario.orientation = n >= 19 ? "east_west" : "south";
        scenario.battery = "off";
        scenario.capacityKWh = 0;
        scenario.maxPowerKW = 0;
        scenario.investmentEUR = Math.round(n * 700);
        changes.push(pvLabel(scenario));
      }
    }
  }

  // 5) Battery / storage — capacity is a free number, not an enum.
  if (/\b(ohne\s*speicher|kein\s*speicher)\b/.test(msg)) {
    if (scenario.battery !== "off") {
      scenario.battery = "off";
      scenario.capacityKWh = 0;
      scenario.maxPowerKW = 0;
      changes.push(t("advisor.battery_off"));
    }
  } else if (/\b(speicher|batter\w*)\b/i.test(msg) && scenario.peakKWp > 0) {
    const capM = /\b(speicher|batter\w*)\b/i.test(msg)
      ? message.match(/(\d{1,3}(?:[.,]\d+)?)\s*kwh/i)
      : null;
    if (scenario.battery !== "on" || capM) {
      scenario.battery = "on";
      if (capM) {
        const cap = Number(capM[1].replace(",", "."));
        scenario.capacityKWh = cap;
        scenario.maxPowerKW = Math.max(1, Math.round(cap * 0.5));
        changes.push(`${t("advisor.battery_on")} ${cap} kWh`);
      } else if (scenario.capacityKWh <= 0) {
        const cap = scenario.peakKWp >= 19 ? 15 : scenario.peakKWp >= 9 ? 10 : 2;
        scenario.capacityKWh = cap;
        scenario.maxPowerKW = scenario.peakKWp >= 19 ? 8 : scenario.peakKWp >= 9 ? 5 : 1;
        changes.push(`${t("advisor.battery_on")} ${cap} kWh`);
      }
    }
  }

  // 5b) Investment / cost — "for 30kEUR", "Investition 30000", "Kosten 25000 Euro".
  const investKM = msg.match(/(\d{1,3})\s*(?:k\s*eur|k\s*€|k€)/i);
  const investBig = msg.match(/(?:invest(?:ition)?|kosten|preis)\D*(\d{4,7})\s*(?:eur|euro|€)?/i);
  const investNum = msg.match(/\b(\d{4,7})\s*(?:eur|euro|€)/i);
  let inv: number | null = null;
  if (investKM) inv = Number(investKM[1]) * 1000;
  else if (investBig) inv = Number(investBig[1]);
  else if (investNum) inv = Number(investNum[1]);
  if (inv !== null && inv >= 500 && inv <= 200000 && inv !== scenario.investmentEUR) {
    scenario.investmentEUR = inv;
    changes.push(`${t("advisor.investment_change")} ${inv.toLocaleString("de-DE")} €`);
  }

  // 6) Consumers.
  if (/\b(wärme(?:pumpe|pumpen)?|heatpump|\bwp\b)\b/.test(msg)) {
    const kwh = extractKwh(msg) ?? scenario.heatpumpKWh;
    const clamped = Math.max(2000, Math.min(5000, kwh));
    if (!scenario.heatpump || scenario.heatpumpKWh !== clamped) {
      scenario.heatpump = true;
      scenario.heatpumpKWh = clamped;
      changes.push(`${t("advisor.heatpump_on")} (${clamped} kWh)`);
    }
  }
  if (/\b(e-?auto|\bev\b)\b/.test(msg)) {
    const kwh = extractKwh(msg) ?? scenario.evKWh;
    const clamped = Math.max(500, Math.min(6000, kwh));
    if (!scenario.ev || scenario.evKWh !== clamped) {
      scenario.ev = true;
      scenario.evKWh = clamped;
      changes.push(`${t("advisor.ev_on")} (${clamped} kWh)`);
    }
  }
  if (/\b(brauchwasser|ww-?wp|\bbwwp\b)\b/.test(msg)) {
    if (!scenario.bwwp) {
      scenario.bwwp = true;
      changes.push(t("advisor.bwwp_on"));
    }
  }

  // 7) Household annual consumption.
  const hkM = msg.match(/verbrauch.*?(\d{3,5})/);
  if (hkM) {
    const v = Number(hkM[1]);
    if (Number.isFinite(v) && v !== scenario.consumptionKWh) {
      scenario.consumptionKWh = v;
      changes.push(`${t("advisor.consumption_change")} ${v} kWh`);
    }
  }

  // 8) Something changed -> apply and show the resulting economics.
  if (changes.length) {
    return resultReply(scenario, changes);
  }

  // 9) No change: greeting or clarification.
  if (message.trim() === "") {
    const m = computeMetrics(scenario);
    const reply =
      `${t("advisor.welcome")}\n\n` +
      `${t("advisor.current")} ${pvLabel(scenario)}, ${scenario.consumptionKWh} kWh, ${scenario.priceCt} ct/kWh, ` +
      `${scenario.location[0].toUpperCase() + scenario.location.slice(1)}.`;
    return { reply, intent: "welcome", scenario, stage: "ready", metrics: m };
  }

  return {
    reply:
      `${t("advisor.clarify")}\n` +
      `• ${t("advisor.clarify_price")}\n• ${t("advisor.clarify_location")}\n• ${t("advisor.clarify_pv")}\n` +
      `• ${t("advisor.clarify_battery")}\n• ${t("advisor.clarify_consumers")}\n\n` +
      `${t("advisor.current")} ${pvLabel(scenario)}, ${scenario.priceCt} ct/kWh, ${scenario.location[0].toUpperCase() + scenario.location.slice(1)}.`,
    intent: "clarify",
    scenario,
    stage: "ready",
    metrics: computeMetrics(scenario),
    link: appUrl(scenario),
  };
}

export function scenariosEqual(a: Scenario, b: Scenario): boolean {
  return (
    a.consumptionKWh === b.consumptionKWh &&
    a.priceCt === b.priceCt &&
    a.location === b.location &&
    a.pv === b.pv &&
    a.peakKWp === b.peakKWp &&
    a.orientation === b.orientation &&
    a.battery === b.battery &&
    a.capacityKWh === b.capacityKWh &&
    a.maxPowerKW === b.maxPowerKW &&
    a.investmentEUR === b.investmentEUR &&
    a.heatpump === b.heatpump &&
    a.heatpumpKWh === b.heatpumpKWh &&
    a.ev === b.ev &&
    a.evKWh === b.evKWh &&
    a.bwwp === b.bwwp
  );
}
