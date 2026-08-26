// Browser-side adapter that talks to the OpenRouter proxy exposed by the dev
// server at `/chat` (see vite.config.ts). The API key lives only on the server
// (process.env.OR_PV_KEY), never in client code.
//
// The advisor uses *tool calling* so the language model interprets the user's
// free-form request and emits structured scenario changes (instead of us
// parsing natural language with brittle regexes). `interpretMessage` returns the
// model's natural-language reply plus an optional scenario patch; the chatbot
// layer applies the patch to the shared store.

import { Scenario } from "../scenario";

export const SCENARIO_TOOL = {
  type: "function",
  function: {
    name: "apply_scenario_changes",
    description:
      "Wende vom Nutzer genannte Änderungen am PV-Szenario an. Setze NUR die Felder, die der Nutzer " +
      "explizit erwähnt oder eindeutig meint. Leite abgeleitete Werte korrekt her, z. B. Arbeitspreis " +
      "in ct/kWh = (Euro pro Jahr × 100) / (kWh pro Jahr).",
    parameters: {
      type: "object",
      properties: {
        consumptionKWh: {
          type: "number",
          description: "Jahresverbrauch Haushalt in kWh (typ. 500–9000).",
        },
        priceCt: {
          type: "number",
          description:
            "Arbeitspreis in ct/kWh. Ableiten falls nur ein Jahresbetrag genannt wurde: ct/kWh = Euro×100/kWh.",
        },
        location: {
          type: "string",
          enum: ["boizenburg", "hamburg", "berlin", "koeln", "muenchen"],
          description: "Standort des Systems.",
        },
        pv: {
          type: "string",
          enum: ["none", "balcony", "10", "20"],
          description: "PV-Anlagengröße: none=kein PV, balcony=800 Wp, 10=10 kWp Süd, 20=20 kWp Ost/West.",
        },
        battery: {
          type: "string",
          enum: ["off", "on"],
          description: "Speicher ein oder aus.",
        },
        heatpump: { type: "boolean", description: "Wärmepumpe aktiv?" },
        heatpumpKWh: {
          type: "number",
          description: "Wärmepumpen-Verbrauch in kWh/Jahr (typ. 2000–5000).",
        },
        ev: { type: "boolean", description: "E-Auto aktiv?" },
        evKWh: {
          type: "number",
          description: "E-Auto-Verbrauch in kWh/Jahr (typ. 500–6000).",
        },
        bwwp: { type: "boolean", description: "Brauchwasser-Wärmepumpe aktiv?" },
      },
      required: [],
    },
  },
};

export interface InterpretResult {
  reply: string;
  patch?: Partial<Scenario>;
}

export async function interpretMessage(opts: {
  system: string;
  userMessage: string;
  scenario: Scenario;
}): Promise<InterpretResult> {
  const scenarioContext =
    `\n\nAktuelles Szenario (Maschinenlesbar, nur zur Information):\n${JSON.stringify(opts.scenario)}\n\n` +
    `Wenn der Nutzer eine Änderung am Szenario meint, rufe die Funktion ` +
    `apply_scenario_changes mit GENAU den betroffenen Feldern auf. Antworte auf Deutsch, im Du-Stil, ` +
    `maximal 4 Sätze und nenne ggf. den Link aus dem Kontext nicht erneut.`;

  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: opts.system + scenarioContext },
        { role: "user", content: opts.userMessage },
      ],
      tools: [SCENARIO_TOOL],
      tool_choice: "auto",
      max_tokens: 700,
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`chat proxy ${res.status}`);
  const data = await res.json();
  const choice = data?.choices?.[0]?.message;
  const toolCall = (choice?.tool_calls || []).find(
    (tc: any) => tc?.function?.name === "apply_scenario_changes",
  );
  let patch: Partial<Scenario> | undefined;
  if (toolCall?.function?.arguments) {
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      if (parsed && typeof parsed === "object") patch = parsed as Partial<Scenario>;
    } catch {
      patch = undefined;
    }
  }
  let reply = (choice?.content || "").trim();
  if (!reply) reply = patch ? "Übernommen." : "Ich habe deine Nachricht erhalten, bin mir aber nicht sicher, was sich ändern soll.";
  return { reply, patch };
}

export const ADVISOR_SYSTEM_PROMPT = `Du bist „PV-Berater", ein spezialisierter Assistent AUSSCHLIESSLICH für Themen der Energiewende im deutschen Gebäudekontext. Zuständige Themen: Photovoltaik, Balkonkraftwerke, Haushaltsstrom, Stromspeicher (Batterien), Wärmepumpen, E-Autos, Brauchwasser-Wärmepumpen, Eigenverbrauch, Netzeinspeisung und Stromkosten.

Harte Regeln:
- Antworte immer auf Deutsch und im Du-Stil.
- Verwende AUSSCHLIESSLICH die Zahlen und Fakten, die dir im Nutzer-Prompt mitgeliefert werden bzw. die du selbst aus genannten Beträgen korrekt herleitest. Erfinde niemals eigene kWp-, kWh-, Euro- oder Amortisationswerte.
- Bleibe STRENG im oben genannten Themenbereich. Bei anderen Themen (Rechtsberatung, Steuern, allgemeine Programmierung, Medizin, Finanzanlagen, Genau-Instruktionen zur Montage/ Elektrik) lehne höflich ab und verweise auf einen zuständigen Fachbetrieb oder die zuständige Stelle.
- Du bist Berater, kein Verkäufer: Nenne Vor- und Nachteile sachlich und neutral.
- Wende Änderungen üBER die Funktion apply_scenario_changes an, nicht im Fließtext. Maximal 4 Sätze, sofern der Nutzer nicht ausdrücklich um mehr bittet.`;
