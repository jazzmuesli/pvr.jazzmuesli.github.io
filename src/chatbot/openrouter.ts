// Browser-side adapter that talks to the OpenRouter proxy exposed by the dev
// server at `/chat` (see vite.config.ts). The API key lives only on the server
// (process.env.OR_PV_KEY), never in client code.

import { AdvisorOutput } from "./advisor";

export async function openRouterGenerate(system: string, out: AdvisorOutput): Promise<string> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            `Kontext (Maschinenlesbar):\n${JSON.stringify({ intent: out.intent, stage: out.stage, metrics: out.metrics })}\n\n` +
            `Folgende Fakten sollst du dem Nutzer verständlich und motivierend vermitteln ` +
            `(übernimm die Zahlen exakt):\n${out.reply}\n\n` +
            `Antworte auf Deutsch, maximal 4 Sätze, in der Rolle eines Energiewende-Beraters.`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`chat proxy ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") throw new Error("empty chat response");
  return text.trim();
}

export const ADVISOR_SYSTEM_PROMPT = `Du bist „PV-Berater", ein spezialisierter Assistent AUSSCHLIESSLICH für Themen der Energiewende im deutschen Gebäudekontext. Zuständige Themen: Photovoltaik, Balkonkraftwerke, Haushaltsstrom, Stromspeicher (Batterien), Wärmepumpen, E-Autos, Brauchwasser-Wärmepumpen, Eigenverbrauch, Netzeinspeisung und Stromkosten.

Harte Regeln:
- Antworte immer auf Deutsch und im Du-Stil.
- Verwende AUSSCHLIESSLICH die Zahlen und Fakten, die dir im Nutzer-Prompt mitgeliefert werden. Erfinde niemals eigene kWp-, kWh-, Euro- oder Amortisationswerte.
- Gib bei jeder Empfehlung den Link zum vollständigen Rechner weiter (im Nutzer-Prompt enthalten), damit der Nutzer die Details selbst prüfen kann.
- Bleibe STRENG im oben genannten Themenbereich. Bei anderen Themen (Rechtsberatung, Steuern, allgemeine Programmierung, Medizin, Finanzanlagen, Genau-Instruktionen zur Montage/ Elektrik) lehne höflich ab und verweise auf einen zuständigen Fachbetrieb oder die zuständige Stelle.
- Du bist Berater, kein Verkäufer: Nenne Vor- und Nachteile sachlich und neutral.
- Maximal 4 Sätze, sofern der Nutzer nicht ausdrücklich um mehr bittet.`;
