# pv-calc — PV + Batterie Wirtschaftlichkeitsrechner

Ein deterministischer, reproduzierbarer Simulator für die Haus-Wirtschaftlichkeit
einer PV- + Batterie-Anlage (Deutschland, EEG 2023–2026). Er berechnet
Energieflüsse, das effektive Beschaffungspreis-Modell, die Amortisation und
vergleicht die vier relevanten Vergütungs-/Bezugsszenarien.

Die gesamte Logik steckt in **einer reinen Funktion**
`runSimulation(params)` (`src/calc/report.ts`), die ein JSON-Serialisierbares
`SimReport` zurückgibt. Dieses Report wird sowohl von der Oberfläche
(`src/main.ts` + `src/ui/charts.ts`) als auch von der HTTP-API (`/api`, siehe
unten) verwendet.

## Schnellstart

```bash
npm install
npm run dev       # Vite Dev-Server auf http://localhost:5173
npm run build     # tsc + vite build nach dist/
npm run preview   # dist/ lokal ausliefern (inkl. /api)
npm test          # Vitest (alle Plausibilitäts- & Modelltests)
npx tsc --noEmit  # reine Typprüfung
```

Die Oberfläche ist eine einzelne Seite (`index.html`). Jede Einstellung ist
über die Steuerleiste (links) einstellbar und wird über die URL
(`?kwp=…&cap=…`) teibar gemacht – ein Konfigurationslink funktioniert also
sowohl in der App als auch als `/api?…`-Aufruf.

## Modell

Alle Profile sind **deterministisch** (kein Zufall), damit die Simulation
vollständig reproduzierbar und per Unit-Test prüfbar ist.

### PV-Erzeugung
`src/calc/solar.ts` — Plane-of-Array Einstrahlung aus Neigung, Ausrichtung und
Standort (`LOCATIONS`, inkl. Boizenburg). MONTHLY-Azimut-Modell + Tagbogen.

### Verbraucher (`src/calc/consumers.ts`)
Vier Lastprofile, summiert zur Gesamtlast:

| Key      | Profil | Form |
|----------|--------|------|
| `household` | H0-Standardlastprofil | Morgen-/Abendspitzen |
| `heatpump`  | Wärmepumpe | winter- & nachtschwer |
| `bwwp`      | Brauchwasser-WP | 2-h-Block mittags (~40 kWh/Monat) |
| `ev`        | E-Auto | `pvShare` mittags (PV), Rest abends |

Jeder Verbraucher kann einzeln aktiviert/deaktiviert und in seinem Jahresverbrauch
kalibriert werden. Für jeden Verbraucher wird die Last **getrennt** geführt, damit
die Diagramme und der effektive Preis pro Verbraucher ausgewiesen werden können.

### Batterie-Dispatch (`src/calc/simulation.ts`)
Pro 15-Minuten-Schritt:

1. PV deckt zuerst die lokale Last (direkte Eigenverbrauch).
2. Überschuss-PV lädt den Speicher (bzw. bei negativen Preisen aus dem Netz).
3. Rest-PV wird eingespeist (bei negativen Preisen gekappt).
4. Nicht durch PV gedeckte Last wird aus dem Speicher, dann aus dem Netz bedient.
5. In den teuersten Nicht-Negativpreis-Fenstern entlädt der Speicher zusätzlich
   ins Netz (Direktvermarktung / strategischer Export).

Ist `capacityKWh = 0`, ist der Speicher deaktiv (alle Last wird aus dem Netz
bezogen, Überschuss voll eingespeist).

### Strompreise & Tarife (`src/calc/tariff.ts`, `priceData.ts`, `priceModel.ts`)
- **Bezug:**
  - `fixed` – konstanter Arbeitspreis (z. B. 24 ct/kWh).
  - `dynamic` – Spot (EPEX) + Stadt-Netzentgelt + Steuern/Marge.
  - `dynamic14a` – wie dynamic, aber Netzentgelt nach § 14a EnWG Modul 3
    (günstig nachts, teuer in Winter-Abendspitzen).
- **Einspeisung:**
  - `fixed` – feste Vergütung (z. B. 7,2 ct/kWh, EEG-gestaffelt nach
    Inbetriebnahme-Jahr).
  - `market` – Direktvermarktung: Marktwert (Spot) + EEG-Marktprämie, verglichen
    mit dem anzulegenden Wert (Referenzwert).

### Effektiver Bezugspreis (`src/calc/vwap.ts`)
Der „effektive Strompreis" ist definiert als

```
effPreis = (Importkosten − Exporterlös) / Gesamtverbrauch   [ct/kWh]
```

und wird pro Verbraucher separat ausgewiesen (nur Bezug, ohne Export).

### Amortisation (`src/calc/amortisation.ts`)
Einfache Amortisation:

```
Jahresersparnis = BaselineKosten − ImportKosten + ExportErlös
                = BaselineKosten + SystemNettoEUR
Amortisation    = Investition / Jahresersparnis
```

`BaselineKosten` = Kosten, die anfielen, wenn der **gesamte** Verbrauch aus dem
Netz bezogen würde („Volleinspeisung aus dem Netz").

#### Investition als ein einziger Parameter
Die Investition ist **eine einzige Gesamtinvestition** (`investmentEUR`, Slider
oben in der Steuerleiste, Default 32.000 €), unabhängig von kWp/kWh. Dadurch ist
das Verhalten intuitiv:

- Eine Anlage, die die Jahresersparnis erhöht (z. B. ein sinnvoller Speicher),
  **verkürzt** die Amortisation – bei gleichbleibender Investition.
- Eine höhere Investition (bei gleicher Anlage) **verlängert** die Amortisation.

> Hinweis: In einer früheren Version war die Investition an kWp/kWh gekoppelt
> (`PV-Investition €/kWp` + `Speicher-Investition €/kWh`). Dort verkürzte das
> *Entfernen* des Speichers die Amortisation – ein Artefakt der gekoppelten
> Kosten, nicht der Physik. Der aktuelle Ein-Investitions-Slider behebt das.

## HTTP-API

Der Dev-Server (`npm run dev`) und der Preview-Server (`npm run preview`)
liefern unter `/api` dasselbe `SimReport` als JSON aus. Die Query-Parameter
sind identisch mit den SPA-URL-Parametern:

```bash
curl "http://localhost:5173/api?kwp=22&cap=19.353&inv=32000&ex=market&im=dynamic14a"
```

Wichtige Parameter (alle optional, Defaults siehe `DEFAULT_SIM_PARAMS` in
`src/calc/report.ts`):

| Param | Bedeutung | Default |
|-------|-----------|---------|
| `kwp` | Peak-Leistung (kWp) | 10 |
| `tilt` | Neigung (°) | 35 |
| `o` | Ausrichtung `south/east/west/east_west` | south |
| `loc` | Standort `hamburg/berlin/munich/cologne/boizenburg` | hamburg |
| `cap` | Batterie-Kapazität (kWh, 0 = kein Speicher) | 10 |
| `pwr` | Batterie-Maximalleistung (kW) | 5 |
| `minsoc`/`maxsoc` | SOC-Grenzen | 0.1 / 0.9 |
| `eff` | Rundtauswirkungsgrad | 0.95 |
| `soc0` | Start-SOC | 0.5 |
| `charge` | Ladestrategie `morning/midday/gridNegative` | morning |
| `de`/`dm` | Entladung abends/morgens (0/1) | 1 / 0 |
| `evs`/`eve` | Abend-Fenster (Stunden) | 17 / 21 |
| `mns`/`mne` | Morgen-Fenster (Stunden) | 6 / 9 |
| `fi` | Einspeisevergütung (ct/kWh) | 7.2 |
| `yr` | Inbetriebnahme-Jahr (EEG) | 2025 |
| `py` | Spot-Preisjahr (`priceData.ts`) | 2025 |
| `hh`/`hk`, `wp`/`wk`, `bw`, `ev`/`ek`, `es` | Verbraucher an/aus, kWh, EV-PV-Anteil | s. `DEFAULT_SIM_PARAMS` |
| `ex` | Einspeisung `fixed`/`market` | fixed |
| `im` | Bezug `fixed`/`dynamic`/`dynamic14a` | fixed |
| `ict` | Fester Bezugspreis (ct/kWh) | 24 |
| `inv` | **Gesamtinvestition (€)** | 32000 |

Das zurückgegebene `SimReport` enthält: `summary`, `amortisation`,
`effectivePrice`, `monthly[]` (12 Einträge), `daily[][]` (12 Monate × 24 Stunden)
und `scenario[]` (4 Varianten).

## Architektur

```
src/calc/                 # reine, DOM-freie Simulation
  solar.ts                 # PV-Erzeugung
  consumers.ts             # Lastprofile + Summen
  simulation.ts            # Dispatch PV/Batterie/Netz (15-Min-Schritte)
  priceModel.ts, priceData.ts, tariff.ts   # Spot-Preise & Tarife
  revenue.ts               # EEG/DV-Abrechnung, Marktprämie
  vwap.ts                  # effektiver Bezugspreis
  amortisation.ts          # einfache Amortisation
  report.ts                # runSimulation(params) -> SimReport  (Einstiegspunkt)
src/ui/
  state.ts                 # AppState + toSimParams()
  url.ts                   # teilbare URL (serialize/deserialize)
  controls.ts              # Steuerleiste
  charts.ts                # handgemachte SVG-Diagramme (kein Charting-Dep)
src/main.ts                # verdrahtet State -> runSimulation -> Charts
vite.config.ts             # + /api Middleware-Plugin
tests/                     # Vitest: Modell-, Plausibilitäts- & Report-Tests
```

## Tests

`npm test` führt ~140 Tests aus, u. a.:

- **`report.test.ts`** — Struktur des `SimReport`, Monats-/Tages-Summen stimmen
  mit den Jahrestotalen überein, Szenario-`netEUR = exportEUR − importEUR`,
  Amortisation = Investition / Jahresersparnis, größere Investition → längere
  Amortisation, Parameter-Parsing (`simParamsFromQuery`).
- **`plausibility.test.ts` / `assumptions.test.ts`** — PV-Ertrag, Lasten und
  Verbraucheranteile in realistischen Bändern (kalibriert an echten
  Haushaltsdaten); Schema-Reihenfolge DV ≥ fest, §14a/3 ≥ dynamisch.
- **`economic_model.test.ts`** — Semantik des effektiven Preises (ohne PV/Batterie
  = Tarif), PV-Eigenverbrauchs-Invarianten.
- **`amortisation.test.ts`** — Payback-Identitäten und Sensitivitäten.
