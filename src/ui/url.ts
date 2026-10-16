// Shareable-URL support: serialise the full AppState into the URL so a
// configuration can be shared via a link, and parse it back on load.
//
// The state lives in the URL *fragment* (`#…`), not in the query string
// (`?…`). Reasons:
//   - Fragments are never sent in an HTTP request, so the hosting server logs
//     do not contain the scenario either.
//   - The usage-measurement script (VeritaMetrics) reads `location.pathname +
//     location.search` and would otherwise transmit the user's location,
//     consumption and investment figures to a third party (Art. 5(1)(c) GDPR).
//   - Legacy links with `?…` are still accepted when reading.
//
// The scalar parameter list, its defaults and its URL keys all come from
// `domain/params.ts`. Writing and reading the same registry is the only reason
// a parameter cannot be readable but not writable — the failure mode that lost
// the heat-pump JAZ and the Direktvermarkter margin on every share link.

import { AppState, DEFAULT_STATE, coerceState } from "./state";
import { paramsFromQuery, paramsToQuery } from "../domain/params";
import { consumerParamsToQuery, consumerParamsFromQuery, carParamsToQuery, carParamsFromQuery } from "../domain/consumers";

/** The full state as a query string. Symmetric with `deserializeState`. */
export function serializeState(s: AppState): string {
  return paramsToQuery(s as unknown as Record<string, unknown>, {
    expert: s.expertMode ? "1" : "0",
    ...consumerParamsToQuery(s.consumers),
    ...carParamsToQuery(s.car),
  });
}

export function deserializeState(qs: string): AppState {
  const query = new URLSearchParams(qs);
  // Scalar parameters first: the consumer and car groups override a few of
  // them (the heat pump's electricity price follows the import tariff).
  const scalars = paramsFromQuery(DEFAULT_STATE as unknown as Record<string, unknown>, query);
  const state = coerceState(scalars);
  state.expertMode = query.get("expert") === "1";
  state.consumers = consumerParamsFromQuery(DEFAULT_STATE.consumers, query);
  state.car = carParamsFromQuery(DEFAULT_STATE.car, query);
  return state;
}
/**
 * Which part of the URL carries the scenario.
 *
 * Preference order is fragment → query string, and the result never touches the
 * network: see the privacy note at the top of this file. A legacy link that
 * still puts the scenario in `?…` is read, and rewritten to `#…` on the next
 * state change, so it stops being transmitted by the analytics script.
 */
export function readStateQuery(loc: { search: string; hash: string } = location): string {
  const fromHash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  return fromHash || loc.search.replace(/^\?/, "");
}

export function writeUrl(s: AppState): void {
  const qs = serializeState(s);
  history.replaceState(null, "", `${location.pathname}#${qs}`);
}
