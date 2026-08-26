import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { runSimulation, simParamsFromQuery } from "./src/calc/report";

// Recursively round every number in the report to at most 3 decimal places.
// More precision is not necessary for the API output.
function roundNumbers(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
  }
  if (Array.isArray(value)) {
    return value.map(roundNumbers);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = roundNumbers(v);
    return out;
  }
  return value;
}

// Serve a JSON simulation report at `/api?...` (same query params as the SPA).
// Works on both the dev server (`vite`) and the preview server (`vite preview`).
function apiPlugin(): Plugin {
  const handler = (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: () => void) => {
    if (!req.url) return next();

    // OpenRouter chat proxy: keeps the API key server-side (OR_PV_KEY).
    if (req.url.startsWith("/chat")) {
      const key = process.env.OR_PV_KEY;
      if (!key) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "OR_PV_KEY is not set on the server" }));
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        (async () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const model = process.env.OR_MODEL || "meta-llama/llama-3.2-3b-instruct:free";
            const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:5173",
                "X-Title": "pv-calc-wizard",
              },
              body: JSON.stringify({ model, messages: parsed.messages, max_tokens: 400, temperature: 0.6 }),
            });
            const text = await upstream.text();
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", "application/json");
            res.end(text);
          } catch (e) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e) }));
          }
        })();
      });
      return;
    }

    if (!req.url.startsWith("/api")) return next();
    const qIndex = req.url.indexOf("?");
    const qs = qIndex >= 0 ? req.url.slice(qIndex + 1) : "";
    const params = simParamsFromQuery(new URLSearchParams(qs));
    const report = runSimulation(params);
    const body = JSON.stringify(roundNumbers(report));
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(body);
  };
  return {
    name: "pv-calc-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    target: "es2020",
  },
  plugins: [apiPlugin()],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
