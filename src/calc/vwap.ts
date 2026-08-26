// Effective ("net") electricity price of consumed energy.
//
// Simply volume-weighting the *import* price ignores the PV you self-consume
// for free and the revenue you earn from exports. The economically meaningful
// "effective price of the electricity you actually used" is the net annual
// electricity bill divided by total consumption:
//
//     effPreis = (Importkosten − Exporterlös) / Gesamtverbrauch
//
// This values self-consumed PV at its opportunity cost (the export price you
// forgo by consuming it), so it is well below a flat tariff. For a single
// consumer we attribute the import cost by that consumer's share of the load
// at each quarter-hour and split the export revenue proportionally to annual
// consumption.

import { ConsumerLoads } from "./consumers";

export interface EffectivePrice {
  /** Net effective price of all consumed energy (ct/kWh). */
  overallCt: number;
  /** Per-consumer net effective price (ct/kWh), keyed like ConsumerLoads. */
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
        importCost += (arr[i] / totalLoad[i]) * gridImport[i] * (importCt[i] / 100);
      }
    }
    const exportShare = totalLoadKWh > 0 ? consKWh / totalLoadKWh : 0;
    byConsumer[key] = consKWh > 0 ? ((importCost - exportShare * exportRevenueEUR) / consKWh) * 100 : 0;
  }

  let totalImportCost = 0;
  for (let i = 0; i < n; i++) totalImportCost += gridImport[i] * (importCt[i] / 100);
  const overallCt = totalLoadKWh > 0 ? ((totalImportCost - exportRevenueEUR) / totalLoadKWh) * 100 : 0;

  return { overallCt, byConsumer };
}
