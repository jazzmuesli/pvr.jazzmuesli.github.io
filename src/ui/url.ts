// Shareable-URL support: serialize the full AppState into the URL so a
// configuration can be shared via a link, and parse it back on load. Missing
// fields fall back to DEFAULT_STATE (we always merge, never replace).
//
// The state lives in the URL *fragment* (`#…`), not in the query string
// (`?…`). Reasons:
//   - Fragments are never sent in an HTTP request, so the hosting server logs
//     do not contain the scenario either.
//   - The usage-measurement script (VeritaMetrics) reads `location.pathname +
//     location.search` and would otherwise transmit the user's location,
//     consumption and investment figures to a third party (Art. 5(1)(c) GDPR).
//   - Legacy links with `?…` are still accepted when reading.

import { AppState, DEFAULT_STATE } from "./state";
import { serializeParams, parseParams, ALL_PARAM_FIELDS } from "../calc/params";

export function serializeState(s: AppState): string {
  return serializeParams(s, ALL_PARAM_FIELDS).toString();
}

export function deserializeState(qs: string): AppState {
  return parseParams(DEFAULT_STATE, new URLSearchParams(qs), ALL_PARAM_FIELDS);
}

/**
 * The serialised scenario from the current URL. Prefers the fragment, falls back
 * to the legacy query string so older shared links keep working.
 */
export function readStateQuery(loc: { search: string; hash: string } = location): string {
  const fromHash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  return fromHash || loc.search.replace(/^\?/, "");
}

export function writeUrl(s: AppState): void {
  const qs = serializeState(s);
  history.replaceState(null, "", `${location.pathname}#${qs}`);
}
