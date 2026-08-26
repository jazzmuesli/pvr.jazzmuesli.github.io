import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { runSimulation, simParamsFromQuery } from "./src/calc/report";

// Serve a JSON simulation report at `/api?...` (same query params as the SPA).
// Works on both the dev server (`vite`) and the preview server (`vite preview`).
function apiPlugin(): Plugin {
  const handler = (req: import("http").IncomingMessage, res: import("http").ServerResponse, next: () => void) => {
    if (!req.url || !req.url.startsWith("/api")) return next();
    const qIndex = req.url.indexOf("?");
    const qs = qIndex >= 0 ? req.url.slice(qIndex + 1) : "";
    const params = simParamsFromQuery(new URLSearchParams(qs));
    const report = runSimulation(params);
    const body = JSON.stringify(report);
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
