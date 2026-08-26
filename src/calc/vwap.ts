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
  for (const key of Object.keys(loads)) {
    const arr = loads[key as keyof ConsumerLoads];
    let importCost = 0;
    let consKWh = 0;
    for (let i = 0; i < n; i++) {
      consKWh += arr[i];
      if (totalLoad[i] > 0) {
        // This consumer's share of the grid energy serving the load this step.
        importCost += (arr[i] / totalLoad[i]) * gridImport[i] * (importCt[i] / 100);
      }
    }
    // Per-consumer effective price = pure cost of the grid electricity it drew.
    byConsumer[key] = consKWh > 0 ? (importCost / consKWh) * 100 : 0;
  }

  let totalImportCost = 0;
  for (let i = 0; i < n; i++) totalImportCost += gridImport[i] * (importCt[i] / 100);
  const overallCt = totalLoadKWh > 0 ? ((totalImportCost - exportRevenueEUR) / totalLoadKWh) * 100 : 0;

  return { overallCt, byConsumer };
}
