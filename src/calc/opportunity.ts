// Shared "opportunity cost" comparison for the two big fossil-vs-electric
// decisions in a household: heating (heat pump vs. heating oil / natural gas)
// and mobility (EV vs. diesel).
//
// This module is intentionally tiny and pure: it just combines the two
// existing comparisons (`computeHeating` and `computeCar`). Because it lives in
// `src/calc` it is used by *both* sides of the app:
//
//   - server side: the `/api` endpoint (see `src/api.ts`) calls
//     `runSimulation`, which calls `computeOpportunityCosts`, and returns the
//     result as JSON.
//   - client side: the SPA (`main.ts`) and the wizard (`wizard.ts`) call
//     `runSimulation` directly (no network) and render the same result.
//
// So the very same function is exposed twice — once over HTTP, once in the
// browser — and both consume the identical `OpportunityCosts` object.

import {
  computeHeating,
  HeatingParams,
  HeatingReport,
} from "./heating";
import {
  computeCar,
  CarParams,
  CarReport,
} from "./car";

export interface OpportunityCostsParams {
  /** Inputs for the heating comparison. */
  heating: HeatingParams;
  /** Inputs for the EV-vs-diesel comparison. */
  car: CarParams;
}

export interface OpportunityCosts {
  /** Heat-pump vs. heating-oil vs. gas for the same useful heat. */
  heating: HeatingReport;
  /** EV vs. diesel for the same annual distance. */
  car: CarReport;
}

/**
 * Compute both opportunity-cost comparisons at once. This is the single source
 * of truth used by the `/api` endpoint and the client UI.
 */
export function computeOpportunityCosts(p: OpportunityCostsParams): OpportunityCosts {
  return {
    heating: computeHeating(p.heating),
    car: computeCar(p.car),
  };
}
