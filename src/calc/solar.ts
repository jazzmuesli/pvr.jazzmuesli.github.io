// Solar irradiation model.
//
// A clear-sky analytical model (Haurwitz GHI + air-mass DNI) projected onto a
// tilted plane gives the *shape* of production across the day and year. A single
// location-specific scaling factor calibrates the absolute annual yield to
// empirical kWh/kWp figures so that, e.g., 10 kWp @ 45° south in Hamburg yields
// roughly 10,000 kWh/year.

import { STEPS_PER_DAY, STEP_HOURS, TOTAL_STEPS, Orientation } from "./types";

export const DEG = Math.PI / 180;
const ALBEDO = 0.2;
// NOTE: the empirical annualYieldPerKWp figures already include inverter and
// other losses, so no extra performance-ratio factor is applied here.

export interface Location {
  name: string;
  latDeg: number;
  /** Empirical annual yield (kWh per kWp) for an optimally tilted south array. */
  annualYieldPerKWp: number;
}

export const LOCATIONS: Record<string, Location> = {
  hamburg: { name: "Hamburg", latDeg: 53.55, annualYieldPerKWp: 1000 },
  berlin: { name: "Berlin", latDeg: 52.52, annualYieldPerKWp: 1050 },
  munich: { name: "München", latDeg: 48.14, annualYieldPerKWp: 1100 },
  cologne: { name: "Köln", latDeg: 50.94, annualYieldPerKWp: 1050 },
  boizenburg: { name: "Boizenburg", latDeg: 53.33, annualYieldPerKWp: 1000 },
};

export const DEFAULT_LOCATION = "hamburg";

function orientationAzimuth(orientation: Orientation): number {
  switch (orientation) {
    case "south":
      return 180;
    case "east":
      return 90;
    case "west":
      return 270;
    case "north":
      return 0;
    case "east_west":
      return 180; // unused; handled separately
  }
}

export function declination(dayFloat: number): number {
  // dayFloat: 0 = Jan 1 .. 364.x. Equinox ~ day 81 (Mar 22).
  return 23.45 * DEG * Math.sin((2 * Math.PI * (dayFloat - 81)) / 365);
}

export interface SolarVector {
  elevationRad: number;
  azimuthRad: number; // 0 = north, clockwise (east=90, south=180, west=270)
}

export function solarVector(latDeg: number, dayFloat: number, localHour: number): SolarVector {
  const lat = latDeg * DEG;
  const dec = declination(dayFloat);
  const H = (localHour - 12) * 15 * DEG; // hour angle
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const elevationRad = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  if (sinEl <= 0) {
    return { elevationRad, azimuthRad: 0 };
  }
  const cosEl = Math.cos(elevationRad);
  const sinAz = (-Math.cos(dec) * Math.sin(H)) / cosEl;
  const cosAz = (Math.sin(dec) - sinEl * Math.sin(lat)) / (cosEl * Math.cos(lat));
  return { elevationRad, azimuthRad: Math.atan2(sinAz, cosAz) };
}

/** Cosine of the incidence angle between sun and a tilted surface. */
export function incidenceCos(sun: SolarVector, tiltDeg: number, surfaceAzimuthDeg: number): number {
  if (sun.elevationRad <= 0) return 0;
  const beta = tiltDeg * DEG;
  const surfAz = surfaceAzimuthDeg * DEG;
  const sinEl = Math.sin(sun.elevationRad);
  const cosEl = Math.cos(sun.elevationRad);
  const cosTilt = Math.cos(beta);
  const sinTilt = Math.sin(beta);
  const dAz = sun.azimuthRad - surfAz;
  return Math.max(0, sinEl * cosTilt + cosEl * sinTilt * Math.cos(dAz));
}

/** Plane-of-array irradiance (W/m²) on a surface for peak=1 kWp. */
export function poaIrradiance(
  latDeg: number,
  dayFloat: number,
  localHour: number,
  tiltDeg: number,
  surfaceAzimuthDeg: number,
): number {
  const sun = solarVector(latDeg, dayFloat, localHour);
  const sinEl = Math.sin(sun.elevationRad);
  if (sinEl <= 0) return 0;
  const I0 = 1361 * (1 + 0.033 * Math.cos((2 * Math.PI * dayFloat) / 365));
  const am = Math.min(20, 1 / Math.max(sinEl, 1e-3));
  const dni = I0 * Math.pow(0.7, Math.pow(am, 0.678));
  const ghi = 1098 * sinEl * Math.exp(-0.057 / sinEl);
  const dhi = Math.max(0, ghi - dni * sinEl);
  const cosTheta = incidenceCos(sun, tiltDeg, surfaceAzimuthDeg);
  const beta = tiltDeg * DEG;
  const beam = dni * cosTheta;
  const diffuse = dhi * ((1 + Math.cos(beta)) / 2);
  const ground = ghi * ALBEDO * ((1 - Math.cos(beta)) / 2);
  return beam + diffuse + ground;
}

/** Energy (kWh) produced by 1 kWp in one 15-min step at the given orientation. */
function rawStepEnergy(
  latDeg: number,
  dayFloat: number,
  localHour: number,
  tiltDeg: number,
  surfaceAzimuthDeg: number,
): number {
  const poa = poaIrradiance(latDeg, dayFloat, localHour, tiltDeg, surfaceAzimuthDeg);
  // peak=1 kWp, PR=1 here; energy = power(kW) * hours
  return (poa / 1000) * STEP_HOURS;
}

// Empirical annual yield of an orientation at its *optimal tilt*, relative to
// an optimally tilted south array (fractions of south's kWh/kWp). These match
// real PV-planner figures (single east/west ≈ 86 % of south, a split east-west
// array ≈ 90 %, north ≈ 42 %). The clear-sky geometry alone underestimates the
// diffuse-light contribution to off-south / off-optimum planes, so these
// empirical anchors correct the absolute magnitude at the optimum; the tilt
// dependence *around* the optimum then follows the geometry (see
// `pvProductionPerStep`).
//
// Note: a true east-west split (modules facing both ways) out-yields a single
// east array per kWp installed, because each half is closer to its own optimum
// azimuth and the two peaks fill the morning and afternoon — hence 0.90, not
// the 0.86 of a single east/west field.
const ORIENT_RATIO: Record<Orientation, number> = {
  south: 1.0,
  east: 0.86,
  west: 0.86,
  east_west: 0.88,
  north: 0.42,
};

export interface PVInput {
  peakKWp: number;
  tiltDeg: number;
  orientation: Orientation;
  location: string;
}

/**
 * Approximate optimal tilt (degrees) for a fixed south array as a function of
 * latitude. For German latitudes (48–54°) this lands around 34–39°, matching
 * PV-planner recommendations.
 */
function optimalTiltDeg(latDeg: number): number {
  // A well-established empirical rule: optimal tilt ≈ 0.76·lat − 3.1 (deg).
  const t = 0.76 * latDeg - 3.1;
  return Math.max(0, Math.min(90, t));
}

/** Sum of the clear-sky per-kWp geometry over the whole year for a plane. */
function annualGeometry(latDeg: number, tiltDeg: number, azimuthDeg: number, eastWest: boolean): number {
  let g = 0;
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const day = Math.floor(i / STEPS_PER_DAY);
    const hour = ((i % STEPS_PER_DAY) / STEPS_PER_DAY) * 24;
    const dayFloat = day + hour / 24;
    if (eastWest) {
      g +=
        0.5 * rawStepEnergy(latDeg, dayFloat, hour, tiltDeg, 90) +
        0.5 * rawStepEnergy(latDeg, dayFloat, hour, tiltDeg, 270);
    } else {
      g += rawStepEnergy(latDeg, dayFloat, hour, tiltDeg, azimuthDeg);
    }
  }
  return g;
}

/** Hourly-equivalent production per 15-min step for the full simulated year. */
export function pvProductionPerStep(input: PVInput): Float64Array {
  const loc = LOCATIONS[input.location] ?? LOCATIONS[DEFAULT_LOCATION];
  const eastWest = input.orientation === "east_west";
  const az = orientationAzimuth(input.orientation);

  // Per-step geometric shape at the requested tilt/orientation.
  const geo = new Float64Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const day = Math.floor(i / STEPS_PER_DAY);
    const hour = ((i % STEPS_PER_DAY) / STEPS_PER_DAY) * 24;
    const dayFloat = day + hour / 24;
    if (eastWest) {
      geo[i] =
        0.5 * rawStepEnergy(loc.latDeg, dayFloat, hour, input.tiltDeg, 90) +
        0.5 * rawStepEnergy(loc.latDeg, dayFloat, hour, input.tiltDeg, 270);
    } else {
      geo[i] = rawStepEnergy(loc.latDeg, dayFloat, hour, input.tiltDeg, az);
    }
  }
  let g = 0;
  for (let i = 0; i < TOTAL_STEPS; i++) g += geo[i];

  // Calibration anchor (computed from the same geometry):
  //  - `geoOrientOpt` : *this* orientation at its optimal tilt → the point the
  //                     empirical ORIENT_RATIO is defined for.
  // The absolute yield is anchored to the empirical value at the optimum, and
  // the tilt deviation from the optimum scales physically via the geometry:
  //
  //   yield = annualYieldPerKWp · ORIENT_RATIO · (geo(tilt) / geo(optTilt))
  //
  // so a flat or vertical array correctly produces less than at the optimum,
  // while an optimally tilted array reproduces the calibrated PV-planner value.
  const optTilt = optimalTiltDeg(loc.latDeg);
  const geoOrientOpt = annualGeometry(loc.latDeg, optTilt, az, eastWest);

  // Physical tilt-deviation factor for this orientation (1.0 at optimal tilt).
  const tiltFactor = geoOrientOpt > 0 ? g / geoOrientOpt : 0;

  // Absolute annual target for this orientation at its optimal tilt.
  const orientRatio = ORIENT_RATIO[input.orientation] ?? 1;
  const targetAtOpt = loc.annualYieldPerKWp * orientRatio;

  // Convert the geometric shape into kWh so that:
  //   annual = targetAtOpt · tiltFactor.
  // We distribute `targetAtOpt · tiltFactor` across the year using the shape
  // `geo` (which already carries the requested tilt/orientation intraday form).
  const annualTarget = targetAtOpt * tiltFactor;
  const shapeScale = g > 0 ? annualTarget / g : 0;

  const out = new Float64Array(TOTAL_STEPS);
  for (let i = 0; i < TOTAL_STEPS; i++) out[i] = geo[i] * shapeScale * input.peakKWp;
  return out;
}

/** Aggregate production per calendar month (1..12). */
export function monthlyTotals(perStep: Float64Array): number[] {
  const months = new Array(12).fill(0);
  for (let i = 0; i < perStep.length; i++) {
    const month = Math.floor(i / (STEPS_PER_DAY * 30.4375)) % 12;
    months[month] += perStep[i];
  }
  return months;
}
