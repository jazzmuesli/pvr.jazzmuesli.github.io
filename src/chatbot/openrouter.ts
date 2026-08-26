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

export const ADVISOR_SYSTEM_PROMPT =
  "Du bist ein freundlicher, sachlicher Berater für die Energiewende im deutschen Eigenheim. " +
  "Du erklärst PV-Anlagen, Balkonkraftwerke, Speicher und Verbraucher (Wärmepumpe, E-Auto, " +
  "Brauchwasser-Wärmepumpe) verständlich. Du nennst konkrete Zahlen und amortisationszeiten, " +
  "übertreibst aber nicht. Du antwortest immer auf Deutsch und im Du-Stil.";
