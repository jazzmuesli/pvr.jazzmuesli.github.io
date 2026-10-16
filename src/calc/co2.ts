/**
 * The one place CO2 emission factors live.
 *
 * These numbers used to be scattered: seven electricity-mix factors and a gas
 * factor in `report.ts`, a *different* gas factor (0.201 vs 0.24) inline in
 * `heatpumpGasSavings.ts`, a diesel factor plus a hand-inlined `9.8` kWh/L in
 * `report.ts`, and more literals in `workbook.ts`. The report printed results
 * computed with both gas factors, from the same gas quantity, 19 % apart.
 *
 * Basis matters and is stated per factor:
 *  - `mix` factors are lifecycle CO2 per kWh of *generated* electricity, used
 *    to weight the hourly grid mix.
 *  - `gasDirectKgPerKWh` is well-to-burner (upstream + own combustion), which
 *    is the correct basis for "the gas this boiler no longer burns".
 *  - `dieselKgPerLitre` is well-to-tank plus tank-to-wheel.
 */

/** CO2 per kWh generated, by electricity source (kg/kWh, lifecycle). */
export const CO2_EMISSION_FACTORS = {
  wind: 0.011,
  solar: 0.045,
  gas: 0.38,
  coal: 0.62,
  biomass: 0.23,
  hydro: 0.006,
  other: 0.35,
} as const;

export type GridSource = keyof typeof CO2_EMISSION_FACTORS;

/** The keys, in the order every mix table and pie chart uses. */
export const GRID_SOURCES = Object.keys(CO2_EMISSION_FACTORS) as GridSource[];

/** Natural gas burnt directly in a boiler, well-to-burner (kg CO2/kWh gas). */
export const CO2_GAS_DIRECT = 0.24;

/** Diesel, well-to-wheel (kg CO2 per litre). */
export const CO2_DIESEL_PER_LITRE = 3.17;

/** Heating value of diesel (kWh per litre). */
export const DIESEL_KWH_PER_LITRE = 9.8;

/** Convenience: the canonical gas factor, named for its basis. */
export function co2ForGasKWh(): number {
  return CO2_GAS_DIRECT;
}

/** Legacy per-kWh diesel factor, derived rather than re-typed. */
export const CO2_DIESEL = CO2_DIESEL_PER_LITRE / DIESEL_KWH_PER_LITRE;

/** Sum a `Record<GridSource, number>` share table against the factors. */
export function co2Intensity(shares: Record<GridSource, number>): number {
  let total = 0;
  for (const source of GRID_SOURCES) total += shares[source] * CO2_EMISSION_FACTORS[source];
  return total;
}