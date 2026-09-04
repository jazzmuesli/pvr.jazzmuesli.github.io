// Effective ("net") electricity price of consumed energy.
//
// The system-level "effective price of all electricity you used" is the net
// annual electricity bill divided by total consumption:
//
//     effPreis = (Importkosten − Exporterlös) / Gesamtverbrauch        (overallCt)
//
// Self-consumed PV is valued at its opportunity cost (the export price you
// forgo by consuming it), so this is well below a flat tariff.
//
// Per consumer we do NOT credit global export revenue: an individual device
// never "earns" export — that belongs to the PV system. A consumer's effective
// price is simply the cost of the grid electricity *it* draws, divided by its
// own consumption. Self-consumed PV (direct use + battery discharge) is free,
// so the effective price is the blended price of its grid imports and is always
// >= 0 (it can never go negative).

import { ConsumerLoads } from "./consumers";

export interface EffectivePrice {
  /** Net effective price of all consumed energy, net of export revenue (ct/kWh). */
  overallCt: number;
  /** Per-consumer effective price = grid-import cost of that consumer / its consumption (ct/kWh). */
  byConsumer: Record<string, number>;
  /** Per-consumer coverage split: how much of each consumer's load is served
   *  from own PV+battery vs. from the grid, and at what grid price. */
  coverage: Record<string, ConsumerCoverage>;
}

export interface ConsumerCoverage {
  /** Total consumption of this consumer (kWh/year). */
  consumptionKWh: number;
  /** kWh served from own PV + battery (self-consumption). */
  pvCoveredKWh: number;
  /** kWh drawn from the grid. */
  gridKWh: number;
  /** Share of consumption covered by PV+battery (0..1). */
  pvSharePct: number;
  /** Grid-only price for this consumer's imports (ct/kWh) — for a dynamic
   *  tariff this is the volume-weighted average spot price of the hours in
   *  which it actually drew from the grid (e.g. cheap night hours for the EV). */
  gridPriceCt: number;
  /** Blended effective price over the whole consumption (grid cost only, PV
   *  self-consumption valued at 0) = byConsumer[key] (ct/kWh). */
  effectiveCt: number;
}

export function effectiveNetPrice(
  loads: ConsumerLoads,
  totalLoad: Float64Array,
  gridImport: Float64Array,
  importCt: Float64Array,
  exportRevenueEUR: number,
): EffectivePrice {
  const n = totalLoad.length;
  let totalLoadKWh = 0;
  for (let i = 0; i < n; i++) totalLoadKWh += totalLoad[i];

  const byConsumer: Record<string, number> = {};
  const coverage: Record<string, ConsumerCoverage> = {};
  for (const key of Object.keys(loads)) {
    const arr = loads[key as keyof ConsumerLoads];
    let importCost = 0;
    let consKWh = 0;
    let gridKWh = 0;
    for (let i = 0; i < n; i++) {
      consKWh += arr[i];
      if (totalLoad[i] > 0) {
        // This consumer's share of the grid energy serving the load this step.
        const share = arr[i] / totalLoad[i];
        const gridPart = share * gridImport[i];
        gridKWh += gridPart;
        importCost += gridPart * (importCt[i] / 100);
      }
    }
    // Per-consumer effective price = pure cost of the grid electricity it drew.
    byConsumer[key] = consKWh > 0 ? (importCost / consKWh) * 100 : 0;
    const pvCoveredKWh = Math.max(0, consKWh - gridKWh);
    coverage[key] = {
      consumptionKWh: consKWh,
      pvCoveredKWh,
      gridKWh,
      pvSharePct: consKWh > 0 ? (pvCoveredKWh / consKWh) * 100 : 0,
      // Grid-only price: cost of grid imports / grid kWh. For a dynamic tariff
      // this is the volume-weighted average price of the hours the consumer
      // actually imported (cheaper for the EV thanks to night charging).
      gridPriceCt: gridKWh > 0 ? (importCost / gridKWh) * 100 : 0,
      effectiveCt: byConsumer[key],
    };
  }

  let totalImportCost = 0;
  for (let i = 0; i < n; i++) totalImportCost += gridImport[i] * (importCt[i] / 100);
  const overallCt = totalLoadKWh > 0 ? Math.max(0, ((totalImportCost - exportRevenueEUR) / totalLoadKWh) * 100) : 0;

  return { overallCt, byConsumer, coverage };
}
