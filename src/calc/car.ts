import type { ConsumerCoverageInfo } from "./heating";
// Driving-cost comparison for an electric vehicle (EV) vs. a diesel car.
//
// To make a fair comparison we ask: for the *same* annual distance (km), what
// does it cost to drive with an EV and with a diesel, including not just the
// energy (electricity vs. diesel) but also the "fairen Nebenkosten":
//
//   - Kfz-Steuer (vehicle tax): BEVs are exempt in Germany until 2030, diesel
//     pays a hubraum- and CO2-based tax.
//   - Wartung / Verschleiß (maintenance): EVs have far fewer moving parts and
//     cheaper consumables, so their per-km maintenance rate is lower.
//   - Versicherung + TÜV (insurance + inspection): roughly comparable, kept as a
//     flat annual Nebenkosten block for each mode.
//
// Everything here is a pure function of `CarParams` and carries no DOM /
// simulation state, so it is independently unit-testable.

// ---------------------------------------------------------------------------
// Default assumptions (documented in README). All defaults are realistic for
// a German household in ~2025 and can be overridden per call.
// ---------------------------------------------------------------------------

/** EV electricity consumption, kWh per 100 km — realistic for an ID.3 in a
 *  German mixed profile (city + Landstraße + Autobahn). WLTP is ~15-16, but
 *  real-world (especially Autobahn at 130 km/h) is ~18-20. 15 would be too
 *  optimistic; 18 is a fair middle ground. */
export const DEFAULT_EV_KWH_PER_100KM = 18;
/** EV charging price, ct per kWh (home charging / WP tariff). */
export const DEFAULT_EV_ELECTRIC_CT_PER_KWH = 30;
/** EV maintenance (Wartung/Verschleiß), ct per km — lower than diesel. */
export const DEFAULT_EV_MAINTENANCE_CT_PER_KM = 6;
/** EV Kfz-Steuer per year — BEVs are exempt until 2030. */
export const DEFAULT_EV_VEHICLE_TAX_EUR = 0;
/** EV Versicherung + TÜV per year, €. */
export const DEFAULT_EV_OTHER_NEBENKOSTEN_EUR = 900;

/** Diesel consumption, litres per 100 km — realistic for a Golf-class TDI in a
 *  German mixed profile (city + Landstraße + Autobahn). WLTP is ~4.3-4.6, but
 *  real-world is ~5.5-6.0 L/100km. NOT 7 (far too thirsty) and not as low as 5
 *  (slightly optimistic). 5.5 L is a fair middle ground. */
export const DEFAULT_DIESEL_L_PER_100KM = 5.5;
/** Diesel price, € per litre (user-adjustable via the UI). */
export const DEFAULT_DIESEL_EUR_PER_L = 2.15;
/** Diesel maintenance (Wartung/Verschleiß), ct per km — higher than EV. */
export const DEFAULT_DIESEL_MAINTENANCE_CT_PER_KM = 10;
/** Diesel Kfz-Steuer per year — hubraum- and CO2-based (e.g. ~2.0 TDI). */
export const DEFAULT_DIESEL_VEHICLE_TAX_EUR = 200;
/** Diesel Versicherung + TÜV per year, €. */
export const DEFAULT_DIESEL_OTHER_NEBENKOSTEN_EUR = 1000;

export interface CarParams {
  /** Annual distance driven, km. */
  annualKm: number;

  // --- Electric vehicle (EV) -------------------------------------------
  evKwhPer100km: number;
  evElectricCtPerKwh: number;
  evMaintenanceCtPerKm: number;
  evVehicleTaxEUR: number;
  evOtherNebenkostenEUR: number;

  // --- Diesel -----------------------------------------------------------
  dieselLPer100km: number;
  dieselEurPerL: number;
  dieselMaintenanceCtPerKm: number;
  dieselVehicleTaxEUR: number;
  dieselOtherNebenkostenEUR: number;
}

export const DEFAULT_CAR_PARAMS: CarParams = {
  annualKm: 15000,
  evKwhPer100km: DEFAULT_EV_KWH_PER_100KM,
  evElectricCtPerKwh: DEFAULT_EV_ELECTRIC_CT_PER_KWH,
  evMaintenanceCtPerKm: DEFAULT_EV_MAINTENANCE_CT_PER_KM,
  evVehicleTaxEUR: DEFAULT_EV_VEHICLE_TAX_EUR,
  evOtherNebenkostenEUR: DEFAULT_EV_OTHER_NEBENKOSTEN_EUR,
  dieselLPer100km: DEFAULT_DIESEL_L_PER_100KM,
  dieselEurPerL: DEFAULT_DIESEL_EUR_PER_L,
  dieselMaintenanceCtPerKm: DEFAULT_DIESEL_MAINTENANCE_CT_PER_KM,
  dieselVehicleTaxEUR: DEFAULT_DIESEL_VEHICLE_TAX_EUR,
  dieselOtherNebenkostenEUR: DEFAULT_DIESEL_OTHER_NEBENKOSTEN_EUR,
};

export type CarMode = "ev" | "diesel";

export interface CarAlternative {
  mode: CarMode;
  label: string;
  /** Distance driven (km) — identical for both modes. */
  annualKm: number;
  /** Primary energy input: electricity kWh (EV) or diesel litres (diesel). */
  primaryEnergy: number;
  /** Energy / fuel cost (€). */
  energyCostEUR: number;
  /** Maintenance (Wartung/Verschleiß), €. */
  maintenanceEUR: number;
  /** Kfz-Steuer (€). */
  vehicleTaxEUR: number;
  /** Other Nebenkosten such as Versicherung + TÜV (€). */
  otherNebenkostenEUR: number;
  /** Sum of all cost components (€). */
  totalEUR: number;
  /** For diesel: totalEUR − ev.totalEUR (positive = more expensive). */
  deltaVsEvEUR: number;
}

export interface CarReport {
  annualKm: number;
  ev: CarAlternative;
  diesel: CarAlternative;
  /** PV+battery coverage of the EV's charging electricity (optional). */
  coverage?: ConsumerCoverageInfo;
}

/** Energy input for the EV: kWh for the given distance. */
export function evEnergyKWh(annualKm: number, kwhPer100km: number): number {
  return (annualKm / 100) * kwhPer100km;
}

/** Energy input for diesel: litres for the given distance. */
export function dieselLitres(annualKm: number, lPer100km: number): number {
  return (annualKm / 100) * lPer100km;
}

/** Cost of driving the distance with the EV (electricity + fair Nebenkosten). */
export function evAlternative(p: CarParams): CarAlternative {
  const primaryEnergy = evEnergyKWh(p.annualKm, p.evKwhPer100km);
  const energyCostEUR = (primaryEnergy * p.evElectricCtPerKwh) / 100;
  const maintenanceEUR = (p.annualKm * p.evMaintenanceCtPerKm) / 100;
  const totalEUR = energyCostEUR + maintenanceEUR + p.evVehicleTaxEUR + p.evOtherNebenkostenEUR;
  return {
    mode: "ev",
    label: "E-Auto",
    annualKm: p.annualKm,
    primaryEnergy: round2(primaryEnergy),
    energyCostEUR: round2(energyCostEUR),
    maintenanceEUR: round2(maintenanceEUR),
    vehicleTaxEUR: p.evVehicleTaxEUR,
    otherNebenkostenEUR: p.evOtherNebenkostenEUR,
    totalEUR: round2(totalEUR),
    deltaVsEvEUR: 0,
  };
}

/** Cost of driving the same distance with diesel, including fair Nebenkosten. */
export function dieselAlternative(p: CarParams): CarAlternative {
  const primaryEnergy = dieselLitres(p.annualKm, p.dieselLPer100km);
  const energyCostEUR = primaryEnergy * p.dieselEurPerL;
  const maintenanceEUR = (p.annualKm * p.dieselMaintenanceCtPerKm) / 100;
  const totalEUR = energyCostEUR + maintenanceEUR + p.dieselVehicleTaxEUR + p.dieselOtherNebenkostenEUR;
  const ev = evAlternative(p);
  return {
    mode: "diesel",
    label: "Diesel",
    annualKm: p.annualKm,
    primaryEnergy: round2(primaryEnergy),
    energyCostEUR: round2(energyCostEUR),
    maintenanceEUR: round2(maintenanceEUR),
    vehicleTaxEUR: p.dieselVehicleTaxEUR,
    otherNebenkostenEUR: p.dieselOtherNebenkostenEUR,
    totalEUR: round2(totalEUR),
    deltaVsEvEUR: round2(totalEUR) - round2(ev.totalEUR),
  };
}

/** Full car comparison for the same annual distance. */
export function computeCar(p: CarParams = DEFAULT_CAR_PARAMS): CarReport {
  const ev = evAlternative(p);
  const diesel = dieselAlternative(p);
  diesel.deltaVsEvEUR = round2(diesel.totalEUR - ev.totalEUR);
  return {
    annualKm: p.annualKm,
    ev,
    diesel,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
