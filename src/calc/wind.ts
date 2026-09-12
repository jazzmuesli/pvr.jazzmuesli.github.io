// Kleinwindkraftanlagen-Simulationsmodul
//
// 5 realistische Kleinwindkraftanlagen mit Leistungskurven.
// Winddaten: DWD Messstationen + Global Wind Atlas (10m Höhe).

import { TOTAL_STEPS, monthOfStep } from "./types";

// ---- Wind turbine specifications --------------------------------------------

export interface WindTurbine {
  id: string;
  name: string;
  manufacturer: string;
  /** Nennleistung in kW */
  ratedPowerKW: number;
  /** Rotordurchmesser in m */
  rotorDiameterM: number;
  /** Netto-Rotorfläche in m² */
  rotorAreaM2: number;
  /** Einschwindgeschwindigkeit in m/s */
  cutInMs: number;
  /** Nennwindgeschwindigkeit in m/s */
  ratedWindMs: number;
  /** Abschaltwindgeschwindigkeit in m/s */
  cutOutMs: number;
  /** Gewicht in kg */
  weightKg: number;
  /** Preis in € (UVP, ca.) */
  priceEUR: number;
  /** Zertifizierung */
  certification: string;
  /** Leistungskurve: [Windgeschwindigkeit m/s, Leistung kW] */
  powerCurve: [number, number][];
  /** Referenz-Jahresertrag bei 6 m/s */
  referenceAEP6ms: number;
}

// ---- 5 realistische Kleinwindkraftanlagen -----------------------------------
// Alle Kurven basieren auf Herstellerdatenblättern und unabhängigen Tests.

const SKYWIND_NG: WindTurbine = {
  id: "skywind_ng",
  name: "SkyWind NG",
  manufacturer: "SkyWind (DE)",
  ratedPowerKW: 0.310,
  rotorDiameterM: 1.50,
  rotorAreaM2: 1.77,
  cutInMs: 5.5,
  ratedWindMs: 14.0,
  cutOutMs: 20.0,
  weightKg: 19,
  priceEUR: 2949,
  certification: "ICC-SWCC SWCC-23-07",
  referenceAEP6ms: 615,
  powerCurve: [
    [0, 0], [3, 0], [4, 0], [5, 0],
    [5.5, 0.010], [6, 0.030], [7, 0.080], [8, 0.140],
    [9, 0.210], [10, 0.270], [11, 0.310], [12, 0.380],
    [13, 0.460], [14, 0.540], [15, 0.580], [16, 0.609],
    [17, 0.590], [18, 0.560], [19, 0.520], [20, 0],
  ],
};

const BERGEY_XLS_1: WindTurbine = {
  id: "bergey_xls1",
  name: "Bergey Excel 1",
  manufacturer: "Bergey Windpower (US)",
  ratedPowerKW: 1.0,
  rotorDiameterM: 2.50,
  rotorAreaM2: 4.91,
  cutInMs: 2.5,
  ratedWindMs: 11.5,
  cutOutMs: 25.0,
  weightKg: 52,
  priceEUR: 5500,
  certification: "IEC 61400-2 (Small Wind)",
  referenceAEP6ms: 1800,
  powerCurve: [
    [0, 0], [1, 0], [2, 0],
    [2.5, 0.010], [3, 0.025], [4, 0.070], [5, 0.140],
    [6, 0.250], [7, 0.380], [8, 0.520], [9, 0.670],
    [10, 0.820], [11, 0.960], [11.5, 1.000], [12, 1.000],
    [13, 1.000], [14, 1.000], [15, 1.000],
    [16, 1.000], [17, 1.000], [18, 1.000],
    [20, 1.000], [25, 0],
  ],
};

const EOCYCLE_EO25: WindTurbine = {
  id: "eocycle_eo25",
  name: "Eocycle EO25",
  manufacturer: "Eocycle Technologies (CA/DE)",
  ratedPowerKW: 2.5,
  rotorDiameterM: 3.50,
  rotorAreaM2: 9.62,
  cutInMs: 3.0,
  ratedWindMs: 12.0,
  cutOutMs: 25.0,
  weightKg: 175,
  priceEUR: 12500,
  certification: "IEC 61400-2, CE",
  referenceAEP6ms: 4500,
  powerCurve: [
    [0, 0], [1, 0], [2, 0],
    [3, 0.030], [4, 0.100], [5, 0.250],
    [6, 0.480], [7, 0.780], [8, 1.150], [9, 1.550],
    [10, 1.950], [11, 2.280], [12, 2.500], [13, 2.500],
    [14, 2.500], [15, 2.500], [16, 2.500],
    [18, 2.500], [20, 2.500], [25, 0],
  ],
};

const SUPERWIND_350: WindTurbine = {
  id: "superwind_350",
  name: "Superwind 350",
  manufacturer: "Superwind GmbH (DE)",
  ratedPowerKW: 0.350,
  rotorDiameterM: 1.20,
  rotorAreaM2: 1.13,
  cutInMs: 3.0,
  ratedWindMs: 12.0,
  cutOutMs: 25.0,
  weightKg: 15,
  priceEUR: 2800,
  certification: "CE, TÜV",
  referenceAEP6ms: 680,
  powerCurve: [
    [0, 0], [1, 0], [2, 0],
    [3, 0.010], [4, 0.040], [5, 0.100],
    [6, 0.180], [7, 0.260], [8, 0.330], [9, 0.350],
    [10, 0.350], [11, 0.350], [12, 0.350], [13, 0.350],
    [14, 0.350], [15, 0.350], [16, 0.350],
    [18, 0.350], [20, 0.350], [25, 0],
  ],
};

const ENDURANCE_E3120: WindTurbine = {
  id: "endurance_e3120",
  name: "Endurance E-3120",
  manufacturer: "Endurance Wind Power (CA)",
  ratedPowerKW: 3.0,
  rotorDiameterM: 4.40,
  rotorAreaM2: 15.21,
  cutInMs: 3.5,
  ratedWindMs: 11.0,
  cutOutMs: 25.0,
  weightKg: 181,
  priceEUR: 14000,
  certification: "IEC 61400-2, CSA",
  referenceAEP6ms: 5200,
  powerCurve: [
    [0, 0], [1, 0], [2, 0], [3, 0],
    [3.5, 0.040], [4, 0.080], [5, 0.220],
    [6, 0.450], [7, 0.780], [8, 1.200], [9, 1.700],
    [10, 2.300], [11, 3.000], [12, 3.000], [13, 3.000],
    [14, 3.000], [15, 3.000], [16, 3.000],
    [18, 3.000], [20, 3.000], [25, 0],
  ],
};

/** Katalog der 5 bekanntesten Kleinwindkraftanlagen. */
export const WIND_TURBINES: WindTurbine[] = [
  SKYWIND_NG,
  BERGEY_XLS_1,
  EOCYCLE_EO25,
  SUPERWIND_350,
  ENDURANCE_E3120,
];

export const WIND_TURBINE_MAP: Record<string, WindTurbine> = Object.fromEntries(
  WIND_TURBINES.map((t) => [t.id, t]),
);

export const DEFAULT_WIND_TURBINE = SKYWIND_NG;

// ---- City wind data --------------------------------------------------------

export interface WindLocation {
  name: string;
  /** Mittlere jährliche Windgeschwindigkeit bei 10m Höhe in m/s */
  annualMeanWindMs: number;
  /** Geographische Breite */
  latDeg: number;
  /** Monatliche Korrekturfaktoren (Jan..Dez) — relativ zum Jahresmittel.
   *  Basierend auf DWD Messdaten und typischen Windklimatologien. */
  monthlyFactors: number[];
}

/** Mittlere Windgeschwindigkeiten bei 10m Höhe (exponierter Wohnstandort).
 *  Quellen: Global Wind Atlas, DWD Messnetz, literaturbasierte Werte.
 *  Für Wohnstandorte mit guter Exposition (Dach, freie Lage, nicht tief im
 *  Siedlungsgebiet). Monatsfaktoren: Klimatologische Variation (DWD Monatsmittel). */
export const WIND_LOCATIONS: Record<string, WindLocation> = {
  hamburg: {
    name: "Hamburg",
    annualMeanWindMs: 4.8,
    latDeg: 53.55,
    monthlyFactors: [1.18, 1.15, 1.10, 0.98, 0.88, 0.82, 0.80, 0.82, 0.90, 1.00, 1.12, 1.20],
  },
  berlin: {
    name: "Berlin",
    annualMeanWindMs: 4.0,
    latDeg: 52.52,
    monthlyFactors: [1.15, 1.12, 1.08, 0.98, 0.90, 0.84, 0.82, 0.84, 0.92, 1.02, 1.10, 1.18],
  },
  munich: {
    name: "München",
    annualMeanWindMs: 3.6,
    latDeg: 48.14,
    monthlyFactors: [1.10, 1.08, 1.05, 0.98, 0.92, 0.88, 0.86, 0.88, 0.94, 1.00, 1.08, 1.15],
  },
  cologne: {
    name: "Köln",
    annualMeanWindMs: 4.3,
    latDeg: 50.94,
    monthlyFactors: [1.15, 1.12, 1.08, 0.98, 0.88, 0.82, 0.80, 0.82, 0.90, 1.02, 1.12, 1.20],
  },
  boizenburg: {
    name: "Boizenburg",
    annualMeanWindMs: 6.0,
    latDeg: 53.33,
    monthlyFactors: [1.20, 1.16, 1.10, 0.96, 0.86, 0.80, 0.78, 0.80, 0.88, 1.00, 1.14, 1.22],
  },
};

// ---- Power curve interpolation ---------------------------------------------

/** Leistung (kW) bei gegebener Windgeschwindigkeit (m/s).
 *  Interpoliert zwischen den Leistungskurven-Punkten. */
export function powerAtWindSpeed(turbine: WindTurbine, windMs: number): number {
  const curve = turbine.powerCurve;
  if (windMs <= curve[0][0]) return curve[0][1];
  if (windMs >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [v0, p0] = curve[i];
    const [v1, p1] = curve[i + 1];
    if (windMs >= v0 && windMs <= v1) {
      const t = (windMs - v0) / (v1 - v0);
      return p0 + t * (p1 - p0);
    }
  }
  return 0;
}

// ---- Rayleigh wind distribution --------------------------------------------

/** Rayleigh-Verteilung: Wahrscheinlichkeit (Pdf) der Windgeschwindigkeit v
 *  bei mittlerer Windgeschwindigkeit V_mean.
 *  f(v) = (π/2) · (v / V²) · exp(-π/4 · (v/V)²) */
function rayleighPdf(v: number, vMean: number): number {
  if (vMean <= 0 || v <= 0) return 0;
  const ratio = v / vMean;
  return (Math.PI / 2) * (ratio / vMean) * Math.exp(-Math.PI / 4 * ratio * ratio);
}

// ---- Energy production calculation -----------------------------------------

export interface WindEnergyResult {
  /** Monatlicher Ertrag in kWh (Index 0 = Januar) */
  monthlyKWh: number[];
  /** Gesamter Jahresertrag in kWh */
  annualKWh: number;
  /** Volllaststunden */
  fullLoadHours: number;
  /** Spezifischer Ertrag (kWh pro m² Rotorfläche) */
  specificYield: number;
  /** Mittlere Windgeschwindigkeit an der Nabenhöhe in m/s */
  meanWindAtHubMs: number;
}

/** Windprofil-Höhentransformation nach Potenzgesetz:
 *  v(h) = v(h_ref) · (h / h_ref)^α
 *  α ≈ 0.14 für normale Landschaft (Rauigkeitslänge z0 ≈ 0.03-0.1m) */
function windSpeedAtHeight(vRef: number, hRef: number, h: number, alpha = 0.14): number {
  if (hRef <= 0 || h <= 0) return vRef;
  return vRef * Math.pow(h / hRef, alpha);
}

/** Berechne den Jahresertrag einer Kleinwindkraftanlage.
 *  Nutzt Rayleigh-Verteilung für die Windgeschwindigkeitsverteilung
 *  und die Turbinen-Leistungskurve. */
export function computeWindEnergy(
  turbine: WindTurbine,
  location: WindLocation,
  hubHeightM: number = 10,
): WindEnergyResult {
  // Windgeschwindigkeit an der Nabenhöhe
  const meanWindAtHub = windSpeedAtHeight(location.annualMeanWindMs, 10, hubHeightM);

  const monthlyKWh: number[] = [];
  const hoursPerMonth = [744, 672, 744, 720, 744, 720, 744, 744, 720, 744, 720, 744];

  for (let m = 0; m < 12; m++) {
    const monthlyWind = meanWindAtHub * location.monthlyFactors[m];
    let energyWh = 0;

    if (monthlyWind <= 0) {
      monthlyKWh.push(0);
      continue;
    }

    // Rayleigh-Integration über Windgeschwindigkeits-Bins
    const binSize = 0.5; // m/s
    const maxWind = 25; // m/s
    for (let v = 0; v < maxWind; v += binSize) {
      const vCenter = v + binSize / 2;
      const prob = rayleighPdf(vCenter, monthlyWind) * binSize;
      const powerKW = powerAtWindSpeed(turbine, vCenter);
      energyWh += powerKW * 1000 * prob * hoursPerMonth[m];
    }

    monthlyKWh.push(energyWh / 1000);
  }

  const annualKWh = monthlyKWh.reduce((a, b) => a + b, 0);
  const fullLoadHours = turbine.ratedPowerKW > 0 ? annualKWh / turbine.ratedPowerKW : 0;
  const specificYield = turbine.rotorAreaM2 > 0 ? annualKWh / turbine.rotorAreaM2 : 0;

  return {
    monthlyKWh,
    annualKWh,
    fullLoadHours,
    specificYield,
    meanWindAtHubMs: meanWindAtHub,
  };
}

/** Erzeuge 15-Minuten-Leistungsprofil für ein ganzes Jahr (35,040 Schritte).
 *  Das Windprofil berücksichtigt die monatliche Variation.
 *  Für jede 15-Min-Periode wird ein zufälliger Wind auf Basis der
 *  Rayleigh-Verteilung des jeweiligen Monats erzeugt. */
export function windProductionPerStep(
  turbine: WindTurbine,
  location: WindLocation,
  hubHeightM: number = 10,
): Float64Array {
  const meanWindAtHub = windSpeedAtHeight(location.annualMeanWindMs, 10, hubHeightM);
  const out = new Float64Array(TOTAL_STEPS);

  // Deterministischer Pseudo-Zufallsgenerator (Mulberry32)
  let seed = 42;
  function random(): number {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Weibull-inverse-CDF für Rayleigh (k=2): v = V_mean · sqrt(-ln(1-u) · 4/π)
  function rayleighSample(vMean: number): number {
    const u = random();
    return vMean * Math.sqrt(-Math.log(1 - u) * 4 / Math.PI);
  }

  for (let i = 0; i < TOTAL_STEPS; i++) {
    const month = monthOfStep(i) - 1; // 0-basiert
    const monthlyWind = meanWindAtHub * location.monthlyFactors[month];
    const windSpeed = rayleighSample(monthlyWind);
    const powerKW = powerAtWindSpeed(turbine, windSpeed);
    out[i] = powerKW * 0.25; // 15 min = 0.25 h → Energie in kWh
  }

  return out;
}

// ---- Reference validation --------------------------------------------------

/** Validiere den berechneten Ertrag gegen den zertifizierten Referenzwert.
 *  SkyWind NG: 615 kWh/Jahr bei 6 m/s mittlerer Windgeschwindigkeit (10m Nabenhöhe). */
export function validateAgainstCertification(): { calculated: number; certified: number; deviation: number } {
  const testLocation: WindLocation = {
    name: "Test (6 m/s)",
    annualMeanWindMs: 6.0,
    latDeg: 0,
    monthlyFactors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  };
  const result = computeWindEnergy(DEFAULT_WIND_TURBINE, testLocation, 10);
  return {
    calculated: Math.round(result.annualKWh),
    certified: DEFAULT_WIND_TURBINE.referenceAEP6ms,
    deviation: Math.round(result.annualKWh - DEFAULT_WIND_TURBINE.referenceAEP6ms),
  };
}
