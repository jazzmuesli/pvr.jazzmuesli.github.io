// Server-side entry point for the `/api` endpoint.
//
// The deployment serves this module for requests like `/api?kwp=10&...`. It
// reuses the exact same simulation + opportunity-cost pipeline as the SPA:
// `simParamsFromQuery` parses the (identical) query string used by the app,
// `runSimulation` calls `computeOpportunityCosts`, and the result is returned
// as JSON. So the opportunity-cost numbers the API returns are produced by the
// *same* function the browser renders — just exposed over HTTP.

import {
  simParamsFromQuery,
  runSimulation,
  SimReport,
} from "./calc/report";

/**
 * Handle an `/api` request. Accepts either a raw query string or a
 * `URLSearchParams` (e.g. from a `Request`/`Event` in a serverless function).
 * Returns the full `SimReport`, which already contains `opportunityCosts`
 * (heating + EV-vs-diesel comparison).
 */
export function handleApiRequest(query: string | URLSearchParams): SimReport {
  const q = typeof query === "string" ? new URLSearchParams(query) : query;
  const params = simParamsFromQuery(q);
  return runSimulation(params);
}
