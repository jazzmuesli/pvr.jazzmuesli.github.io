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
} from "../scenario";

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
    `Zusammenfassung – ${pvLabel(s)}:\n` +
    `Verbraucher @ ${s.priceCt} ct/kWh, Ort ${s.location[0].toUpperCase() + s.location.slice(1)}.\n` +
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

function resultReply(s: Scenario, changes: string[]): AdvisorOutput {
  const m = computeMetrics(s);
  const reply =
    `Übernommen:\n• ${changes.join("\n• ")}\n\n` +
    `Ergebnis (${pvLabel(s)}${s.battery === "on" ? " mit Speicher" : ", ohne Speicher"}):\n` +
    `PV-Ertrag ${Math.round(m.pvKWh).toLocaleString("de-DE")} kWh/Jahr, ` +
    `Eigenverbrauch ${Math.round(m.selfKWh).toLocaleString("de-DE")} kWh (${m.selfPct.toFixed(0)} %).\n` +
    `Netto (Export − Import): ${fmtEUR(m.netEUR)}/Jahr. ` +
    `Ersparnis ggü. Basis: ${fmtEUR(m.savingsEUR)}/Jahr.\n` +
    `Amortisation: ${fmtAmort(m.amortYears, m.investmentEUR)}, eff. Strompreis ${m.effCt.toFixed(1)} ct/kWh.`;
  return { reply, intent: "adjust", scenario: s, stage: "ready", metrics: m, link: appUrl(s) };
}

export function advisorTurn(message: string, ctx: AdvisorContext): AdvisorOutput {
  let scenario: Scenario = { ...ctx.scenario };
  const msg = (message || "").toLowerCase();
  const changes: string[] = [];

  // 1) Explicit request for a summary / deeplink.
  if (message.trim() !== "" && /\b(zusammen|zusammenfass|übersicht|summary|bericht|link|index|details|zeig)\b/.test(msg)) {
    return summarise(scenario);
  }

  // 2) Electricity price — accepts "24c", "24 ct", "Strompreis 35",
  //    "anderer Stromanbieter 24c", "20 cent", etc.
  const priceM =
    msg.match(/(?:stom|arbeits|preis|cent|\bct\b|€|anbieter).*?(\d{1,2}(?:[.,]\d+)?)/) ||
    msg.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:ct|cent|€|c)\b/);
  if (priceM) {
    const v = parseFloat(priceM[1].replace(",", "."));
    if (Number.isFinite(v) && v >= 10 && v <= 60 && v !== scenario.priceCt) {
      scenario.priceCt = v;
      changes.push(`Strompreis → ${v} ct/kWh`);
    }
  }

  // 3) Location.
  const nmsg = norm(msg);
  for (const c of LOCATIONS) {
    if (nmsg.includes(c) && scenario.location !== c) {
      scenario.location = c;
      changes.push(`Ort → ${c[0].toUpperCase() + c.slice(1)}`);
      break;
    }
  }

  // 4) PV size.
  if (/\b(kein\s*pv|ohne\s*pv|basis)\b/.test(msg)) {
    if (scenario.pv !== "none") {
      scenario.pv = "none";
      changes.push("PV → Kein PV (Basis)");
    }
  } else if (/\b(balkon(?:kraftwerk)?|\bbkw\b)\b/.test(msg)) {
    if (scenario.pv !== "balcony") {
      scenario.pv = "balcony";
      changes.push("PV → Balkonkraftwerk 800 Wp");
    }
  } else if (/\b20\s*kwp|20kw\b/.test(msg)) {
    if (scenario.pv !== "20") {
      scenario.pv = "20";
      changes.push("PV → 20 kWp (Ost/West)");
    }
  } else if (/\b10\s*kwp|10kw\b/.test(msg)) {
    if (scenario.pv !== "10") {
      scenario.pv = "10";
      changes.push("PV → 10 kWp (Süd)");
    }
  }

  // 5) Battery / storage.
  if (/\b(ohne\s*speicher|kein\s*speicher)\b/.test(msg)) {
    if (scenario.battery !== "off") {
      scenario.battery = "off";
      changes.push("Speicher → aus");
    }
  } else if (/\b(speicher|batterie)\b/.test(msg) && scenario.pv !== "none") {
    if (scenario.battery !== "on") {
      scenario.battery = "on";
      changes.push("Speicher → ein");
    }
  }

  // 6) Consumers.
  if (/\b(wärme(?:pumpe|pumpen)?|heatpump|\bwp\b)\b/.test(msg)) {
    const kwh = extractKwh(msg) ?? scenario.heatpumpKWh;
    const clamped = Math.max(2000, Math.min(5000, kwh));
    if (!scenario.heatpump || scenario.heatpumpKWh !== clamped) {
      scenario.heatpump = true;
      scenario.heatpumpKWh = clamped;
      changes.push(`Wärmepumpe → ein (${clamped} kWh)`);
    }
  }
  if (/\b(e-?auto|\bev\b)\b/.test(msg)) {
    const kwh = extractKwh(msg) ?? scenario.evKWh;
    const clamped = Math.max(500, Math.min(6000, kwh));
    if (!scenario.ev || scenario.evKWh !== clamped) {
      scenario.ev = true;
      scenario.evKWh = clamped;
      changes.push(`E-Auto → ein (${clamped} kWh)`);
    }
  }
  if (/\b(brauchwasser|ww-?wp|\bbwwp\b)\b/.test(msg)) {
    if (!scenario.bwwp) {
      scenario.bwwp = true;
      changes.push("Brauchwasser-WP → ein");
    }
  }

  // 7) Household annual consumption.
  const hkM = msg.match(/verbrauch.*?(\d{3,5})/);
  if (hkM) {
    const v = Number(hkM[1]);
    if (Number.isFinite(v) && v !== scenario.consumptionKWh) {
      scenario.consumptionKWh = v;
      changes.push(`Jahresverbrauch → ${v} kWh`);
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
      `Hallo! Ich passe dein PV-Szenario direkt an, sobald du mir etwas sagst – ganz ohne Rückfrage. ` +
      `Beispiele: „Strompreis 24 ct", „Wärmepumpe 3000", „10 kWp mit Speicher", „anderer Ort Hamburg".\n\n` +
      `Aktuell: ${pvLabel(scenario)}, ${scenario.consumptionKWh} kWh, ${scenario.priceCt} ct/kWh, ` +
      `${scenario.location[0].toUpperCase() + scenario.location.slice(1)}.`;
    return { reply, intent: "welcome", scenario, stage: "ready", metrics: m };
  }

  return summarise(
    scenario,
    `Ich habe keine Änderung erkannt. Sag mir z. B., was ich anpassen soll:\n` +
      `• Strompreis („24 ct")\n• Ort („Hamburg")\n• PV („Balkonkraftwerk", „10 kWp", „20 kWp")\n` +
      `• Speicher („mit/ohne Speicher")\n• Verbraucher („Wärmepumpe 3000", „E-Auto", „Brauchwasser").`,
  );
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
