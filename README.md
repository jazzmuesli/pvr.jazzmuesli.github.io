# pv-calc -- PV + Battery Economics Simulator

A deterministic, reproducible simulator for the economics of residential PV + battery systems in Germany (EEG 2023-2026). It calculates energy flows, effective electricity prices, amortisation, and compares the four relevant tariff/export scenarios.

The entire simulation logic lives in a single pure function `runSimulation(params)` (`src/calc/report.ts`) that returns a JSON-serialisable `SimReport`. This report is used by both the browser UI (`src/main.ts` + `src/ui/charts.ts`) and the HTTP API (`/api`).

## Quick Start

```bash
npm install
npm run dev       # Vite dev server at http://localhost:5173
npm run build     # tsc + vite build to dist/
npm run preview   # Serve dist/ locally (includes /api)
npm test          # Vitest (all plausibility & model tests)
npx tsc --noEmit  # Type-check only
```

The UI is a single page (`index.html`). Every setting is adjustable via the sidebar (left) and shareable through URL parameters (`?kwp=...&cap=...`). Configuration links work both in the app and as `/api?...` calls.

## Features

- **PV production** using a clear-sky analytical solar model calibrated to empirical kWh/kWp values for German cities (Hamburg, Berlin, Munich, Cologne, Boizenburg)
- **Battery dispatch** at 15-minute resolution (self-consumption, strategic grid charging at negative prices, export during expensive windows)
- **Consumer load profiles** for household (H0 standard), heat pump, domestic hot water heat pump (BWWP), and electric vehicle
- **Revenue/cost analysis** under four tariff combinations: fixed feed-in vs. Direktvermarktung (market premium), and fixed import vs. dynamic (spot) vs. dynamic + section 14a/3 grid fees
- **Multi-year discounted cashflow** with NPV, IRR, LCOE, battery degradation, PV degradation, O&M costs, replacement investments (inverter + battery), and price escalation
- **Opportunity-cost comparisons**: heat pump vs. heating oil vs. natural gas, and EV vs. diesel car
- **AI-powered Energiewende advisor** (chatbot) that lets users configure scenarios via natural language (backed by OpenRouter LLM with tool-calling, or a deterministic regex fallback)

## Simulation Model

All profiles are **deterministic** (no randomness), making the simulation fully reproducible and unit-testable.

### PV Generation (`src/calc/solar.ts`)

Plane-of-array irradiation computed from tilt, orientation, and location (`LOCATIONS`). The absolute annual yield is anchored to empirical kWh/kWp figures at each orientation's *optimal* tilt, and the tilt deviation from that optimum then scales the yield physically from the clear-sky geometry — so a flat or vertical array correctly produces less than an optimally tilted one, and an east-west split out-yields a single east/west array. Calibrated to real-world yield data for German cities.

### Consumers (`src/calc/consumers.ts`)

Four load profiles, summed to total load:

| Key | Profile | Shape |
|-----|---------|-------|
| `household` | H0 standard load profile | Morning/evening peaks |
| `heatpump` | Heat pump (space heating only) | Winter-heavy, near-zero in summer; hourly demand peaks in the cold early morning, dips at midday |
| `bwwp` | Domestic hot water heat pump | 4 h block 11:00–15:00 (mostly PV), default 480 kWh/year |
| `ev` | Electric vehicle | `pvShare` at midday (10:00–15:00), the rest overnight (00:00–05:00, cheap tariff) |

Each consumer can be individually enabled/disabled and calibrated by annual consumption. Load is tracked separately per consumer so that charts and effective prices can be reported per consumer.

**Hot-water switch:** the `bwwp` slider is the annual hot-water electricity demand (default 480 kWh). When the BWWP is *enabled*, this energy is served by the dedicated BWWP in the midday PV block (so it is mostly self-consumed). When it is *disabled*, the identical energy is instead added to the space-heating heat pump as a year-round, night-heavy load — so the heat pump "consumes more" and draws far more of it from the grid. The total household demand is the same either way; only *who* serves the hot water (and how PV-friendly its timing is) changes.

### Battery Dispatch (`src/calc/simulation.ts`)

Per 15-minute step:

1. PV covers local load first (direct self-consumption).
2. Surplus PV charges the battery (or from grid at negative prices).
3. Remaining PV is exported (capped at negative prices).
4. Load not covered by PV is served from battery, then from grid.
5. In the most expensive non-negative-price windows, the battery additionally discharges to grid (Direktvermarktung / strategic export).

When `capacityKWh = 0`, the battery is disabled (all load from grid, all surplus exported).

### Electricity Prices & Tariffs (`src/calc/tariff.ts`, `priceData.ts`, `priceModel.ts`)

- **Import:**
  - `fixed` -- constant working price (e.g. 24 ct/kWh)
  - `dynamic` -- spot (EPEX) + municipal grid fees + taxes/margin
  - `dynamic14a` -- like dynamic, but grid fees per section 14a EnWG module 3 (cheaper at night, expensive in winter evening peaks)
- **Export:**
  - `fixed` -- fixed feed-in tariff (e.g. 7.2 ct/kWh, EEG-stepped by commissioning year)
  - `market` -- Direktvermarktung: market value (spot) + EEG market premium, compared to the reference value (anzulegender Wert)

### Effective Electricity Price (`src/calc/vwap.ts`)

The "effective electricity price" is defined as:

```
effPrice = (import costs - export revenue) / total consumption   [ct/kWh]
```

Reported separately per consumer (import only, excluding export).

### Amortisation (`src/calc/amortisation.ts`)

Simple amortisation:

```
annualSaving = baselineCost - importCost + exportRevenue
             = baselineCost + systemNetEUR
amortisation = investment / annualSaving
```

`baselineCost` = cost if the entire consumption were imported from the grid.

### Multi-Year Cashflow (`src/calc/cashflow.ts`)

Discounted cashflow analysis over a configurable horizon (default 20 years) including:

- **NPV** (Net Present Value) at a configurable discount rate
- **IRR** (Internal Rate of Return)
- **LCOE** (Levelised Cost of Energy) in ct/kWh
- Battery and PV degradation
- O&M costs with inflation
- Replacement investments (inverter at year ~13, battery at year ~13)
- Price escalation for import electricity

### Heating Cost Comparison (`src/calc/heating.ts`)

Compares the heat pump with fossil alternatives (heating oil, natural gas) for the same useful heat output. Includes chimney sweep costs, gas network fees, and boiler efficiency.

### EV vs. Diesel (`src/calc/car.ts`)

Compares electric vehicle operating costs with a diesel car for the same annual distance, including energy, maintenance, and vehicle tax.

## Investment Slider

The investment is a single total amount (`investmentEUR`, slider at the top of the sidebar), independent of kWp/kWh. The slider range starts at 100 EUR, allowing configurations from small balcony systems to full rooftop installations.

The PV peak power slider starts at 0.4 kWp (400 W), covering balcony power stations through large commercial arrays.

## HTTP API

The dev server (`npm run dev`) and preview server (`npm run preview`) serve the same `SimReport` as JSON at `/api`. Query parameters match the SPA URL parameters:

```bash
curl "http://localhost:5173/api?kwp=22&cap=19.353&inv=32000&ex=market&im=dynamic14a"
```

Key parameters (all optional, defaults in `DEFAULT_SIM_PARAMS` in `src/calc/report.ts`):

| Param | Description | Default |
|-------|-------------|---------|
| `kwp` | Peak power (kWp) | 10 |
| `tilt` | Tilt (degrees) | 35 |
| `o` | Orientation `south/east/west/east_west` | south |
| `loc` | Location `hamburg/berlin/munich/cologne/boizenburg` | hamburg |
| `cap` | Battery capacity (kWh, 0 = no battery) | 10 |
| `pwr` | Battery max power (kW) | 5 |
| `minsoc`/`maxsoc` | SOC limits | 0.1 / 0.9 |
| `eff` | Round-trip efficiency | 0.95 |
| `soc0` | Start SOC | 0.5 |
| `charge` | Charge strategy `morning/midday/gridNegative` | morning |
| `de`/`dm` | Discharge evening/morning (0/1) | 1 / 0 |
| `evs`/`eve` | Evening window (hours) | 17 / 21 |
| `mns`/`mne` | Morning window (hours) | 6 / 9 |
| `fi` | Feed-in tariff (ct/kWh) | 7.2 |
| `yr` | Commissioning year (EEG) | 2025 |
| `py` | Spot price year (`priceData.ts`) | 2025 |
| `hh`/`hk`, `wp`/`wk`, `bw`/`bwk`, `ev`/`ek`, `es` | Consumer on/off, kWh (incl. BWWP hot-water kWh `bwk`, default 480), EV PV-share | see `DEFAULT_SIM_PARAMS` |
| `ex` | Export `fixed`/`market` | fixed |
| `im` | Import `fixed`/`dynamic`/`dynamic14a` | fixed |
| `ict` | Fixed import price (ct/kWh) | 24 |
| `inv` | **Total investment (EUR)** | 32000 |
| `jaz` | Heat pump seasonal COP | 3 |
| `wpc` | Heat pump electricity price (ct/kWh) | 24 |
| `hor` | Analysis horizon (years) | 20 |
| `d` | Discount rate (%) | 3 |
| `esc` | Price escalation (%/year) | 2 |
| `om` | O&M (% of investment/year) | 1.5 |

The returned `SimReport` contains: `summary`, `amortisation`, `cashflow`, `effectivePrice`, `monthly[]` (12 entries), `daily[][]` (12 months x 24 hours), `scenario[]` (4 variants), `tariffCombinations`, and `opportunityCosts` (heating + EV comparisons).

## Architecture

```
src/calc/                 # Pure, DOM-free simulation engine
  solar.ts                # PV generation
  consumers.ts            # Load profiles + summation
  simulation.ts           # Dispatch PV/battery/grid (15-min steps)
  priceModel.ts           # Synthetic spot-price generator
  priceData.ts            # Real spot-price loader (energy-charts.info)
  tariff.ts               # Import tariff models (fixed/dynamic/14a)
  revenue.ts              # EEG/DV billing, market premium
  vwap.ts                 # Effective procurement price
  amortisation.ts         # Simple payback period
  cashflow.ts             # Multi-year discounted cashflow (NPV, IRR, LCOE)
  heating.ts              # Heat pump vs. oil vs. gas cost comparison
  car.ts                  # EV vs. diesel cost comparison
  opportunity.ts          # Combined opportunity-cost module
  report.ts               # runSimulation(params) -> SimReport (entry point)
  types.ts                # Core types and constants
src/ui/
  state.ts                # AppState + toSimParams()
  url.ts                  # Shareable URL (serialize/deserialize)
  controls.ts             # Sidebar controls (sliders, selects, checkboxes)
  charts.ts               # Hand-rolled SVG charts (no charting library)
src/wizard/
  wizard.ts               # Interactive step-by-step wizard UI
src/chatbot/
  chatbot.ts              # ChatBot class (wires store + interpreter + advisor)
  chat-ui.ts              # Chat panel DOM rendering
  openrouter.ts           # Browser-side OpenRouter proxy adapter
  advisor.ts              # Deterministic regex-based advisor state machine
  logger.ts               # Client-side conversation logger
src/main.ts               # Wires State -> runSimulation -> Charts
vite.config.ts            # Vite build + /api + /chat middleware plugin
tests/                    # ~140 Vitest tests (model, plausibility, report)
```

## Tech Stack

| Category | Technology |
|----------|------------|
| Language | TypeScript (ES2020, strict mode) |
| Build | Vite 5 |
| Test | Vitest 2 |
| Runtime | Vanilla TypeScript (no framework) |
| Charts | Hand-rolled SVG (zero dependencies) |
| State | Custom minimal observable store |
| AI | OpenRouter API (server-side proxy, key in `OR_PV_KEY` env var) |
| Data | energy-charts.info (Bundesnetzagentur/SMARD spot prices, CC BY 4.0) |

**Zero runtime dependencies.** The entire bundle is self-contained TypeScript.

## Tests

`npm test` runs ~140 tests including:

- **`report.test.ts`** -- SimReport structure, monthly/daily sums match annual totals, scenario `netEUR = exportEUR - importEUR`, amortisation = investment / annual saving, parameter parsing (`simParamsFromQuery`)
- **`plausibility.test.ts` / `assumptions.test.ts`** -- PV yield, loads, and consumer shares in realistic bands (calibrated to real household data); scheme ordering DV >= fixed, 14a/3 >= dynamic
- **`cashflow.test.ts`** -- NPV monotonicity with discount rate, IRR/NPV consistency, price escalation sensitivity, battery replacement impact
- **`economic_model.test.ts`** -- Effective price semantics (no PV/battery = tariff), PV self-consumption invariants
- **`amortisation.test.ts`** -- Payback identities and sensitivities
- **`chatbot.test.ts`** -- Advisor regex interpretation, scenario patching

## Environment Variables

The chatbot feature requires an OpenRouter API key. Set it in a `.env` file (git-ignored):

```bash
OR_PV_KEY=your_openrouter_api_key_here
OR_MODEL=nvidia/nemotron-3-super-120b-a12b:free  # optional
```

**No API keys are hardcoded in source code.** The key is read server-side only and proxied through the dev server's `/chat` endpoint.

## Price Data

Real German day-ahead spot prices (2023-2026) sourced from [energy-charts.info](https://energy-charts.info) (Bundesnetzagentur/SMARD data, CC BY 4.0). Fetch updated data with:

```bash
node scripts/fetch_prices.mjs
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
