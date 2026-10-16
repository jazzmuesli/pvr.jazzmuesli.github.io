// Chart aggregation: turn the raw step-by-step dispatch into the monthly and
// per-month daily profile series the UI renders.
//
// Kept apart from the CO2/tariff analysis because it is a pure data-shaping
// concern — it only ever reads `SimResult` and the per-consumer loads.

import { SimResult, TOTAL_STEPS, STEPS_PER_DAY, monthOfStep, hourOfStep } from "./types";
import { ConsumerLoads, CONSUMER_ORDER } from "./consumers";
import type { ConsumerBreakdown, DayChartDatum } from "./reportModel";

/** A zeroed per-consumer breakdown, driven by the consumer registry. */
function emptyBreakdown(): ConsumerBreakdown {
  const b = {} as ConsumerBreakdown;
  for (const k of CONSUMER_ORDER) b[k] = 0;
  return b;
}

export function monthlyConsumerSums(loads: ConsumerLoads): ConsumerBreakdown[] {
  const out: ConsumerBreakdown[] = Array.from({ length: 12 }, emptyBreakdown);
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const m = monthOfStep(i) - 1;
    for (const k of CONSUMER_ORDER) out[m][k] += loads[k][i];
  }
  return out;
}

interface DayAccumulator {
  hour: number;
  pvKWh: number;
  windKWh: number;
  load: ConsumerBreakdown;
  selfUseKWh: number;
  importKWh: number;
  exportKWh: number;
  avgPrice: number;
  socKWh: number;
  count: number;
}

function emptyDay(hour: number): DayAccumulator {
  return {
    hour,
    pvKWh: 0,
    windKWh: 0,
    load: emptyBreakdown(),
    selfUseKWh: 0,
    importKWh: 0,
    exportKWh: 0,
    avgPrice: 0,
    socKWh: 0,
    count: 0,
  };
}

export function dailyAll(result: SimResult, loads: ConsumerLoads): DayChartDatum[][] {
  const data: DayAccumulator[][] = Array.from({ length: 12 }, () =>
    Array.from({ length: 24 }, (_, h) => emptyDay(h)),
  );
  for (let i = 0; i < result.pv.length; i++) {
    const m = monthOfStep(i) - 1;
    const h = hourOfStep(i);
    const d = data[m][h];
    d.pvKWh += result.pv[i];
    d.windKWh += result.wind[i];
    for (const k of CONSUMER_ORDER) d.load[k] += loads[k][i];
    d.selfUseKWh += result.directUse[i] + result.directUseWind[i] + result.dischargeToLoadPV[i] + result.dischargeToLoadWind[i];
    d.importKWh += result.gridImport[i];
    d.exportKWh += result.exportTotal[i];
    d.avgPrice += result.price[i];
    d.socKWh += result.soc[i];
    d.count += 1;
  }
  const stepsPerHour = STEPS_PER_DAY / 24;
  return data.map((month) =>
    month.map((d) => {
      const n = d.count || 1;
      const load = emptyBreakdown();
      let totalLoadKWh = 0;
      for (const k of CONSUMER_ORDER) {
        const v = (d.load[k] / n) * stepsPerHour;
        load[k] = v;
        totalLoadKWh += v;
      }
      return {
        hour: d.hour,
        pvKWh: (d.pvKWh / n) * stepsPerHour,
        windKWh: (d.windKWh / n) * stepsPerHour,
        load,
        totalLoadKWh,
        selfUseKWh: (d.selfUseKWh / n) * stepsPerHour,
        importKWh: (d.importKWh / n) * stepsPerHour,
        exportKWh: (d.exportKWh / n) * stepsPerHour,
        avgPrice: d.avgPrice / n,
        socKWh: d.socKWh / n,
      };
    }),
  );
}
