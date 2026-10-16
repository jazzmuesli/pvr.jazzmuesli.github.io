# Features and Futures — a critique and a plan

*Analysis of `pv-calc` (Energiewendeamortisationsrechner), 66 commits, one author,
~29 000 lines of churn. Written after a refactoring pass that fixed eight
realised defects and introduced the characterisation and conformance nets that
were missing.*

---

## 0. The question this document answers

Kent Beck's framing is the right one for this repository:

> **Features** — what the code does now.
> **Futures** — what we can get the code to do once we learn the lessons of
> this set of features.
>
> *When you develop, you start with any number of futures — you could implement
> lots of different things. When you add a feature, you burn some of those
> futures. At the very least, you'd have to rip that feature out if you wanted
> to replace it with a different feature, or you have to maintain backwards
> compatibility if you add another feature. So every time you add a feature to
> a system, you reduce the futures to some degree.*

And the reason this codebase is in the shape it is:

> *The genie is no good at managing futures. If you're playing The Finish Line
> Game, you're betting that features will cross the finish line before futures
> run out. Playing The Compounding Game requires as much investment in futures
> as in features. The two alternate.*

Read the git log in order and you can watch the bet being made. `vibe coded pv
calculator` → `add consumers` → `add vwaps` → `add amortisation` → `add car and
heating alternatives` → `add co2 calculation` → `add wind simulation` →
`localise to UK/DE` → `charge during cheapest hours` → `add more cities`. Thirty
five features, and — this is the striking part — **not one commit is titled
"tidy", "extract", "separate", "unify" or "deduplicate"**.

So: how many futures were burnt, and how do we buy them back?

---

## 1. How many futures were burnt?

### 1.1 The number that matters is not churn per commit

The obvious metric — lines touched per commit — is *flat*. Measured over
`src/` + `tests/` across all 66 commits:

| | first 28 commits | last 29 commits |
|---|---|---|
| mean churn / commit | 518 lines | 504 lines |
| mean files / commit | 7.6 | 6.7 |

Linear regression of churn against commit index: slope −5.8 lines/commit
(**negative**). Velocity per feature has not decayed at all.

This is exactly Beck's warning about measuring the wrong axis:

> *It's so much easier to count features than it is to count futures that
> everybody's biased in that direction… The strategy that leaves so much value
> on the floor is working on low value features just because they're easy to
> count and skipping super high value futures just because it's underwater.*

Feature throughput looks perfect. What collapsed is **the cost of the next
feature** — and that is what this document measures instead.

### 1.2 The Futures Burnt Rate: cost of the *next* unit on each axis

Measured with `rg -c` over the whole repository, excluding generated data.
This is the number to track, and it is the number this refactoring attacks.

**One new scalar simulation parameter** (e.g. add `inverterEfficiencyPct`):

| Parameter | edit sites (whole repo) | files touched |
|---|---|---|
| `capacityKWh` | **132** | **36** |
| `peakKWp` | **142** | **37** |
| `investmentEUR` | **102** | **23** |
| `location` | **141** | **42** |
| `importFixedCt` | 42 | 15 |
| `horizonYears` | 20 | 9 |

Spread over the codebase, a single new parameter had to be threaded through
**~40 hand-maintained tables**: `DEFAULT_SIM_PARAMS`, `DEFAULT_STATE`,
`toSimParams`, `serializeState`, `deserializeState`, `simParamsFromQuery`,
`scenarioToQuery`, `scenarioFromQuery`, the chatbot's LLM tool schema, the
Excel export's input block, and 19 test fixtures.

**One new consumer** (say a pool heat pump, a notariellike night storage, or
district heating):

| Axis | src edit sites | src files |
|---|---|---|
| `heatpump` | **316** | **20** |
| `bwwp` | ~300 | ~20 |
| `ev` | ~320 | ~20 |

And the reason is structural, not accidental: `ConsumerBreakdown` is a
four-field interface

```ts
// calc/report.ts, before
export interface ConsumerBreakdown {
  household: number;
  heatpump: number;
  bwwp: number;
  ev: number;
}
```

so the compiler *cannot* tell you that a fifth consumer is missing. The
`CONSUMER_ORDER` array, the colours, the chart legends (written three times
over), the workbook columns, the CO₂ scenarios and the chatbot's JSON schema are
all separate hard-coded enumerations of the same four names.

**One new producer** (a CHP unit, a second PV array at a different tilt, a
biogas plant): `wind` cost **239 sites across 35 files**, because PV is
first-class (`result.pv`, `pvKWh`, `exportSolar`) and wind is bolted on
(`pv[i] + wind[i]` in nine places).

**One new market** (a fourth import scheme — say a heat-pump tariff or an
hourly PPA): the schemes are not data. They are ten separate ternary chains:

```ts
opts.importScheme === "fixed" ? a : opts.importScheme === "dynamic" ? b : c
```

…plus three parallel fields on `EconomicsSummary`
(`importCostFixedEUR` / `importCostDynamicEUR` / `importCost14aEUR`) that every
consumer must know by name. **This is precisely how the worst bug in the
codebase happened** — see §2.1.

**One new country/market region**: `NET_ENTGELT_CT` is a nine-entry record,
`EEG_ANZULEGENDER` a 4 × 3 table, PVGIS yields a nine-entry record, wind
climatology a nine-entry record — four tables, four places, no shared
`Location` type. `location` appears in 20 source files.

### 1.3 Summary of the burn

| Axis | Cost of the next unit (before) |
|---|---|
| scalar parameter | 132–142 sites / 36–42 files |
| consumer | ~316 src sites / 20 files |
| producer | 239 sites / 35 files |
| market scheme | 10 ternary chains + 3 parallel fields, no compiler help |
| country | 4 independent location tables |

**Futures burnt: roughly 12.** That is, twelve distinct "what if we wanted to…"
decisions have been foreclosed or made expensive, each of which is a plausible
next feature given where this product is going (§5).

---

## 2. Why the burn was not free: eight defects that already materialised

A duplicated codebase's first casualty is not that it becomes slow to change.
It is that **the same quantity is computed twice and the two copies disagree,
and nothing notices.** Every one of the following is a live bug in the
pre-refactoring code, found by writing the conformance tests in §6 before
touching anything.

### 2.1 The scenario-comparison chart showed the wrong number under three labels

`scenarioVariants()` built its own import-cost loop and always priced every row
with the **base** import scheme:

```ts
const imp = importPriceArray(base.importScheme, city, prices, base.importFixedCt);
// …then, for every variant:
importEUR += (result.gridImport[i] * imp[i]) / 100;   // ← base scheme, always
```

Measured (default configuration):

```
scenario-chart import costs, before:  1039.12, 1039.12, 1039.12, 1039.12   ← all identical
scenario-chart import costs, after:    769.97,  769.97,  751.82,  680.26
```

The chart has four bars labelled "feste Einspeisung", "Direktvermarktung",
"dynamischer Bezug" and "§ 14a/3". Three of them were lying. A user comparing
dynamic import against a fixed tariff — *the single most common question this
tool exists to answer* — was shown a difference of zero. The existing test
passed because it only checked `netEUR === exportEUR − importEUR`, which is
self-consistent no matter what `importEUR` is.

### 2.2 The monthly table did not add up to the annual total

`computeEconomics` applied the self-consumption cap **inside** the per-step
loop:

```ts
row.selfConsumptionKWh += sc;
const monthGen = row.pvKWh + row.windKWh;   // ← generation so far this month
if (row.selfConsumptionKWh > monthGen) row.selfConsumptionKWh = monthGen;
```

`row.pvKWh` is the *partial* month total, so the clamp truncated the accumulator
for the rest of the month.

| scenario | Σ monthly self-consumption − annual | Σ monthly import − annual |
|---|---|---|
| baseline | **−21.35 kWh** | +21.35 kWh |
| spa-default (22 kWp) | **−47.33 kWh** | +47.33 kWh |
| wind | −21.68 kWh | +21.68 kWh |

The Excel export sums those columns into a "Jahr" row, so the workbook shipped a
year total that did not match its own monthly rows. `excel_export.test.ts`
*deliberately skipped* the grid-import year total, and the plausible-ranges check
used a 0.5 % tolerance — which is 20 kWh here.

### 2.3 …and the same fix revealed phantom grid import

With the cap removed, months that had **no grid import at all** were showing up
to 4 kWh of it, purely as the residual's way of balancing:

```
m4 import  7.16 → 0.00 kWh
m5 import  2.93 → 0.00 kWh
m6 import  1.24 → 0.00 kWh
m7 import  1.12 → 0.00 kWh
m8 import  1.84 → 0.00 kWh
m9 import  3.91 → 0.00 kWh
```

### 2.4 Grid-bought energy was reported as PV self-consumption

`simulation.ts` added grid-charged energy to the battery's state of charge
without tagging its origin, and attributed the entire inherited 00:00 state of
charge to PV (`windSOC` was initialised `startSOC * cap * 0` — vestigial). On
discharge the origin split normalised to 1, so **every** discharged kWh was
labelled `dischargeToLoadPV`. Consequences:

* the per-step energy identity `load = directUse + discharge + import` was
  **violated by up to 0.676 kWh per step** in the `gridNegative` branch —
  and `dispatch.test.ts` asserted that identity only for the `morning` branch;
* the report had to paper over it with a self-consumption cap (§2.2) and a
  residual import definition;
* `summary.totalImportKWh` (a residual) and `econ.totalImportKWh`
  (`Σ gridImport`) were **two different numbers for the same quantity in the
  same report object**, differing by 0.09 kWh in `cheapest` mode and 0.30 kWh
  in `gridNegative` mode.

### 2.5 Two CO₂ factors for the same avoided gas

| Location | Factor | Basis |
|---|---|---|
| `report.ts: CO2_GAS_DIRECT` | 0.24 kg/kWh | well-to-burner |
| `heatpumpGasSavings.ts` (inline literal) | 0.201 kg/kWh | tank-to-burner |

On the default configuration the report printed **both**: `gasSavings.co2SavedKg`
at 3 139 kg and the CO₂ scenarios at 3 748 kg, **19.4 % apart**, for the same
gas. Each was pinned by its own unit test, so the drift was enshrined.

### 2.6 The gas quantity itself disagreed

`report.ts` derived the avoided gas from `p.consumers.heatpump.annualKWh`
(space heating only) while `computeGasSavings` derived it from the dispatched
heat-pump load — which **also carries the hot-water demand when the BWWP is
off**. The two were 9.6 % apart in that configuration, and the UI showed a gas
bill that did not match the CO₂ story beside it.

### 2.7 A second, dead implementation of the export economics

`computeRevenue()` was a complete parallel implementation of the export/import
economics, kept "for the existing domain tests", called by nothing in
production. It had drifted from the live path by **3.5 % in `marktPraemieCt`
and 25.6 % in `premiumEUR`**, because it weighted the Monatsmarktwert by
*export* while `computeEconomics` correctly weights it by *PV production*
(§ 23a EEG is a fleet-wide reference). `RevenueSummary` and `MonthlyRow` existed
only to serve it.

Alongside it, `typicalDay()` was a second implementation of the 12 × 24
profile that `dailyAll()` already builds — computed on all five `computeEconomics`
calls per report and read by exactly one assertion.

### 2.8 The share link silently lost six parameters

The share-URL writer and the `/api` query reader were two hand-maintained key
lists, and they did not match. `mm`, `jaz`, `km`, `dl`, `ec`, `wpc` had a
reader but **no writer**:

* the **heat-pump JAZ** — the slider the user drags in expert mode — reset to 3
  on every refresh and every share link;
* the **Direktvermarkter margin** reset to 1;
* three car inputs reset.

No test would have caught it: `privacy.test.ts`'s round-trip assertion covered
`location` and `peakKWp`.

### 2.9 And the product had two different answers to its own question

`DEFAULT_STATE` (a cold SPA load) and `DEFAULT_SIM_PARAMS` (`/api?` with no
query) disagreed on **eight fields**:

| | SPA | `/api` |
|---|---|---|
| `peakKWp` | 22 | 10 |
| `location` | boizenburg | hamburg |
| `capacityKWh` | 19.353 | 10 |
| `maxSOC` | 0.95 | 0.9 |
| `dischargeMorning` | true | false |
| `eveningEnd` | 23 | 21 |
| `morningStart` / `morningEnd` | 5 / 12 | 6 / 9 |
| `windSpeedMeanMs` | 6.0 | 4.8 |

Same product, two defaults, no test.

---

## 3. What was actually good

The credit where it is due, because it determined how cheap this refactor was:

* **The domain layer was already pure.** Zero occurrences of `document`,
  `window`, `fetch`, `localStorage`, `navigator`, `Math.random` or `Date.now`
  in `src/calc/*`. No cycles: `ui → calc` only. That constraint is the single
  most valuable thing in the repository and it was preserved throughout.
* **The time grid is uniform.** Everything physical is 15-minute steps.
* **The test suite was real.** 589 tests, 99 % passing, with a seeded PRNG, a
  fuzz suite over 100 random scenarios, a closed battery energy-balance check,
  a *no free lunch* assertion on the charge plan, and real Home Assistant
  calibration data.
* **`excel_export.test.ts` re-evaluates every workbook formula with
  HyperFormula** and compares against the `SimReport`. That is the strongest
  numeric cross-check in the repo — and it is what finally caught §2.2's
  residual once the report changed underneath it.

The domain being pure is why the "boring refactor" below was possible at all.

---

## 4. The metrics to use from now on

Future decay is measurable; it just is not the metric anyone reaches for. Four
cheap ones, in increasing order of usefulness.

### 4.1 Declaration fan-out — *the primary metric*

> **For every parameter in the registry, how many files declare it?**

```bash
rg -c -w '<paramName>' src/ | wc -l
```

Target: **1** (the registry row). Before: 3–5 files for every scalar, and for
consumers/producers 20 files with hard-coded names.

This is the metric that predicts the cost of the next feature. It is
observable in seconds and it is not gameable by writing more code.

### 4.2 Registry completeness — enforced by the compiler *and* a test

* Compile time: `CoreParams` is **derived** from `PARAM_REGISTRY` via a mapped
  type, so a new field cannot be added to `SimParams` without a registry row.
* Run time: `tests/conformance.test.ts` asserts every registry row survives
  `serialize → deserialize → toSimParams`, and that the share link and `/api`
  agree on every key.
* A new registry row with a missing URL key, a missing default, or a type that
  disagrees with the domain fails one of these immediately.

### 4.3 Conformance drift — the count of copies of each quantity

> **How many places compute this quantity? (Target: 1.)**

A grep-able inventory. Before the refactor:

| Quantity | Copies | Agreed? |
|---|---|---|
| self-consumption | 5 | ✗ capped mid-loop, diverged from annual by 21–47 kWh |
| grid import | 4 (3 definitions) | ✗ residual vs `Σ gridImport`, 0.09–0.30 kWh |
| gas CO₂ factor | 2 | ✗ 0.24 vs 0.201 |
| monthly calendar | 3 | ✓ |
| `round2` | 5 | ✓ |
| `totalPVKWh` | 3 | ✓ |
| EUR formatting | 3 | ✗ `de-DE` hardcoded in `main.ts` |
| month labels | 3 | ✗ German baked into the domain |
| grid-import money accumulation | 5 | ✓ (until it wasn't — §2.1) |

`grep -c` for the quantity's name is enough. Keep it at one line per quantity
in the test file so the trend is visible in review.

### 4.4 Blast radius — cost of the next unit

> **How many edit sites does adding the *next* thing on each axis require?**

Re-measure with the §1.2 script. Add it to CI as a budget: *"no new parameter may
add a declaration outside the registry"* is checkable; *"the next consumer must
cost ≤ N sites"* is a ratchet you can tighten.

### 4.5 A note on what not to measure

Do **not** use churn-per-commit or lines-of-code. Both are flat or improving in
this repository while §2.1 shipped four identical bars in a user-facing chart.
Productivity proxies measure output; futures are the asset.

---

## 5. Where this is going, and what that implies

The growth axes visible in the log, extrapolated:

| Axis | where it is | where it plausibly goes | the future at risk |
|---|---|---|---|
| **Consumers** | household, heat pump, BWWP, EV | pool heat pump, night storage, district heating, two EVs + depot, heat pump + EV with load shifting, commercial demand | `ConsumerBreakdown` is a 4-field struct; the 5th consumer is ~316 sites |
| **Producers** | PV, wind | PV + wind + CHP/biogas, second PV array at a different tilt, behind-the-meter solar for a tenant, export from a rental flat | `pv + wind` hard-coded in 9 places; `exportSolar`/`exportWind` as distinct arrays |
| **Markets** | fixed / market × fixed / dynamic / § 14a | hourly PPA, heat-pump tariff, § 14a Modul 1, dynamic with a floor, plus more export remuneration | 10 ternary chains, 3 parallel fields — **already produced §2.1** |
| **Rules** | EEG, Marktprämie, § 14a, Stromsteuer, Konzessionsabgabe, 20-year feed-in expiry | new EEG year, Mieterstromzuschlag, § 53 EnWG flexibility payments, capacity charges, VAT changes, guarantees of origin | constants inline in `revenue.ts`/`tariff.ts`; a rule change is a code edit |
| **Geography** | 9 German/European cities, hard-coded Netzentgelt | EU markets, Länder tariffs (§ 36a EnWG differences), non-EU currencies and taxes | four parallel location tables |
| **Time** | 15-min, 4 price years, 20–30 year cashflow, hourly tariffs, 15-min flexibility markets | quarter-hour market data, intraday auctions, rolling forecasts | the step size is a constant in 5 places |
| **Presentation** | SPA panels, Excel, JSON API, chatbot, wizard | whatever the next surface is | two UI apps, already diverged in 12 feature areas |

The single most important observation: **four of these seven axes are
enumerations the compiler cannot check.** `ConsumerBreakdown`'s four fields,
`NET_ENTGELT_CT`'s nine entries, the three `importCost*EUR` fields, the
`orientation` union. TypeScript will happily compile a system that forgot
France.

---

## 6. The safety net that was missing

Everything below was written *before* any product code was touched. That order
is the point: Beck's *"If anything's red, something's not fine. Yes, that part's
absolutely true. But if everything's green, that just means I have to pay
attention to what happens."* — the previous 589 tests would not have caught a
single one of the eight defects.

### 6.1 `tests/characterisation.test.ts` — golden snapshots of the whole report

Twelve feature-shaped scenarios pin the **entire** `SimReport` at 6 decimals:
every monthly row, all 288 typical-day cells, all 4 price years × 4 tariff
combinations, every CO₂ scenario. 1.7 MB of JSON in `tests/__golden__/`.

```bash
npm test -- characterisation              # compare
UPDATE_GOLDEN=1 npm test -- characterisation   # deliberately accept a change
```

Before this existed, **not one absolute € or kWh value** produced by
`runSimulation` was pinned anywhere. Every assertion in the suite was a
hand-written inequality (`> 0`, `< 4500`) or an internal identity. A silent 0.4 %
shift in the annual Marktprämie was invisible.

The suite is only trustworthy because it *fails usefully*: on mismatch it
reports the first differing **line number with context**, not two 10 000-line
blobs. And there is a guard on the fixture list itself, so a new feature axis
cannot be added without a scenario covering it.

### 6.2 `tests/conformance.test.ts` — relationships between modules

Not "does this function work" but "must these two agree, and do they?". 84
assertions across the twelve scenarios:

* the monthly table re-integrates to the annual total (12 × 5);
* every one of the 288 typical-day cells re-integrates per month;
* `selfConsumption + loadImport = totalLoad`, exactly, monthly and annually;
* `meteredImport − gridCharged + gridOriginDischarge = loadImport`;
* the per-step energy identity, in **all three** dispatch branches;
* every battery discharge attributed to exactly one origin;
* generation is never lost outside a negative-price step;
* the share link is lossless; the share link and `/api` read the same registry;
* the SPA default and the API default are the same system.

### 6.3 The order of work, which is the transferable lesson

```
0.  Golden snapshots of current behaviour.       (nothing may change silently)
1.  Conformance tests. Run them. Let them FAIL.  (each failure is a real bug)
2.  Fix the bugs. Re-run. Watch the goldens.
3.  Only now: structural change.
```

Step 1 is what turned "this code smells" into a list of eight specific,
quantified defects with reproductions.

---

## 7. What was changed, and what it bought

### 7.1 Defects fixed

| # | Defect | Evidence |
|---|---|---|
| 1 | Scenario chart: 3 of 4 bars showed the fixed-tariff cost | 1039.12 ×4 → 769.97 / 769.97 / 751.82 / 680.26 |
| 2 | Monthly self-consumption cap applied mid-loop | Σmonthly − annual: −21.35 → 1e−6 kWh |
| 3 | Phantom grid import in zero-import months | 7.16/2.93/1.24/1.12/1.84/3.91 → 0.00 kWh |
| 4 | Grid-bought energy counted as PV self-consumption | per-step residual 0.676 → < 1e−9 kWh |
| 5 | Two grid-import definitions in one report object | 0.09 / 0.30 kWh → identical |
| 6 | Two CO₂ gas factors | 3 139 vs 3 748 kg → one number |
| 7 | Gas quantity: space heating vs space + hot water | 9.6 % → identical |
| 8 | Share link lost 6 parameters | `mm jaz km dl ec wpc` all now round-trip |

Plus: the Excel export's `MAX(0, load − self-consumption)` live formulas were
replaced with the real identity `load − self-use + grid-charged`, with the
correction term as a visible column. The sheet now *shows* the reader why the
number is what it is.

### 7.2 The single change that buys the most futures: a parameter registry

`src/domain/params.ts` — one row per scalar:

```ts
{
  key: "heatpumpJaz", url: "jaz", kind: "number", default: 3,
  min: 1.5, max: 6, step: 0.1, group: "consumer",
}
```

From that one table we **generate**:

* `CoreParams` — the type, via a mapped type. A field cannot be added to
  `SimParams` without a row, and the compiler enforces it.
* `defaultCoreParams()` — the one default configuration. `/api?` and a cold SPA
  load now return *the same system* (§2.9).
* `paramsFromQuery()` / `paramsToQuery()` — the URL codec. Writer and reader
  come from the same table, so §2.8 is now structurally impossible.
* `applyExpertDefaults()` — the simple-mode derivations, previously 13 lines of
  hand-written ternaries in `toSimParams`.

`src/domain/consumers.ts` does the same for the nested groups, and carries the
chart colour and the i18n key so the legend cannot disagree with the panel.

Measured effect on declaration fan-out (`src/` only):

| parameter | before | after |
|---|---|---|
| `horizonYears` | 14 sites / 4 files | **7 sites / 3 files** |
| `discountRatePct` | 17 sites / 4 files | **10 sites / 3 files** |
| `heatpumpJaz` | 10 sites / 3 files | **5 sites / 3 files** |
| `windSpeedMeanMs` | 11 sites / 4 files | **4 sites / 3 files** |

What remains is *consumption* — the code that actually uses the value, which is
irreducible. **What is gone is declaration.** Adding a scalar parameter is now
**one row**, and the four things that used to be independently forgettable
(default, URL key, simple-mode value, type) are in it by construction.

Honest limitation: `capacityKWh` and `location` barely moved (67 → 58, 73 → 69
sites), because their cost is dominated by *reading* them in the engine and the
UI, which is real work. The registry fixes the declaration half of that cost.
The consumption half is §8.1.

### 7.3 `src/calc/markets.ts` — schemes as data

Replaces 10 ternary chains and 3 parallel `importCost*EUR` fields with

```ts
export const IMPORT_SCHEMES = ["fixed", "dynamic", "dynamic14a"] as const;
export function importCostByScheme(gridImport, price, city, fixedCt)
  : Record<ImportScheme, number>
```

and derives both comparison tables (`SCENARIO_VARIANTS`,
`TARIFF_COMBINATIONS`) from the scheme lists. **This is the change that makes
§2.1 unrepeatable**: there is no longer a chain to copy incorrectly, only a
table to add a row to. And, consistent with the registry, `values: [...]` makes
adding a scheme widen the `CoreParams` union automatically.

### 7.4 Stored energy tagged by origin

`pvSOC` / `windSOC` / `gridSOC` instead of two buckets, and a new
`dischargeToLoadGrid` output. This removed the need for a self-consumption cap
*and* for a residual import definition — one modelling fix eliminated four
downstream hacks, including the Excel formulas and a unit test.

### 7.5 Dead code deleted

`computeRevenue` + `RevenueSummary` + `MonthlyRow` (§2.7), `typicalDay` (a
second 12 × 24 implementation read by one assertion), a dead `dayMonth` table
built at import time, the dead `GAS_HEAT_KWH_PER_KWH_USEFUL` export, and
`src/api.ts` (nothing imported it; the real handler is the Vite plugin).

### 7.6 Memoisation — 2.4× faster reports, 4× faster suite

`runSimulation` evaluates the same array up to **five times** per report: once
for the headline, once per historical price year. Only the *prices* differ
between those runs — the sun does not.

PV geometry and the four consumer load profiles are now memoised on their actual
inputs. Every cache **stores the series and returns a copy**: a `Float64Array`
is mutable, and `getYearPrices()` was already handing out a shared array that
any caller could corrupt for the rest of the process. Copying 35 040 doubles
costs 0.03 ms; the class of bug is not worth it.

| | before | after |
|---|---|---|
| `runSimulation` (default config) | 278.8 ms | **105–115 ms** |
| one dispatch (`simulate(toSimConfig(p))`) | 41.6 ms | **6.8–7.1 ms** |
| full test suite | 99 s | **24 s** |
| tests | 589 | **689** |

This is the part of tidying that pays for itself immediately: the UI coalesces
recomputation with `requestAnimationFrame`, so a keystroke was triggering five
full annual dispatches per frame.

### 7.7 A German string left the domain layer

`MONTH_LABELS` in `report.ts` meant an English user saw "Mär / Mai / Okt / Dez"
on the monthly chart and in the Excel export, while the hourly chart beside it
was correctly translated. The report now publishes `monthKey` and
`src/ui/monthLabels.ts` resolves it against the catalogue.

---

## 8. The plan: buying back the twelve futures

Ordered by leverage per unit of risk. Phases 0–2 are **done in this commit**.

### Phase 0 — safety net ✅
Characterisation goldens, conformance invariants, the failure-first order.
*Without this, everything below is guesswork.*

### Phase 1 — realised defects ✅
Eight bugs, all with reproductions in the conformance suite. Each is now
impossible to reintroduce: either the cause is gone (origin tagging removed the
need for a cap) or an invariant pins it.

### Phase 2 — one source of truth ✅
Parameter registry, markets table, `co2.ts`, centralised calendar, origin
tagging, memoisation, dead-code removal, i18n leak closed.

### Phase 3 — consumers become data · *the biggest remaining win*

**Today:** `ConsumerBreakdown` is a 4-field interface; 20 files name the four
consumers; colours, legends, URL keys and chatbot schema are separate
enumerations.

**Target:** every consumer is a row.

```ts
// src/domain/consumers.ts — the table already exists, minus the plumbing
export interface ConsumerSpec {
  key: string;                 // "heatpump"
  urlPrefix: string;           // "w"
  labelKey: string;            // "consumer.heatpump"
  color: string;
  kind: ParamKind;
  default: number | boolean | string;
  /** How this consumer's demand is shaped over the year. */
  profile: (annualKWh: number) => Float64Array;
  /** Optional: the fossil alternative it replaces, and its module. */
  alternative?: { module: "heating" | "car"; labelKey: string };
}
```

Then:

1. `ConsumerBreakdown` → `Record<ConsumerKey, number>`; `monthlyConsumerSums`
   already iterates `CONSUMER_ORDER`, so it is a type change.
2. `CONSUMER_COLORS` / `CONSUMER_LABELS` in `charts.ts` → read the table.
   This also kills the German duplicate of `t("consumer.*")`.
3. The three copies of the consumer legend in `charts.ts` → one function.
4. The chatbot tool schema in `openrouter.ts` → generated from the table.
5. The Excel columns → generated from the table.
6. `ui/state.ts`'s `toSimConfig` → deleted; it was a second hand-wired copy of
   `report.ts`'s.
7. A conformance test: *"every `CONSUMER_SPECS` key appears in the report, the
   chart colour map, the workbook and the chatbot schema"* — so a half-added
   consumer fails.

**Definition of done:** a new consumer costs **one row + one load profile**, and
the compiler flags every place that has not been taught about it.

### Phase 4 — producers become an array · *removes the `pv + wind` pattern*

`SimResult` grows `producers: { key: "pv" | "wind" | string; series: Float64Array }[]`
instead of `pv` / `wind` / `exportSolar` / `exportWind` as four special fields.
`report.pvKWh` becomes `productionByKey: Record<string, number>`. CO₂ factors
become per-producer rather than a property of the *mix*. This is the axis where
"a second PV array at a different tilt" — the most likely next feature — lands.

### Phase 5 — geography as one `Location` type · *new markets*

`LOCATIONS` (solar), `WIND_LOCATIONS`, `NET_ENTGELT_CT`, `cityForLocation` and
`GERMAN_CITIES` become:

```ts
interface Market {
  key: string; labelKey: string;
  lat: number; lon: number;
  pvYieldKWhPerKWp: number;        // PVGIS-derived
  netzentgeltCt: number;           // grid charge
  wind: { annualMeanMs: number; monthlyFactors: number[] };
  taxes: { stromsteuerCt: number; konzessionsabgabeCt: number; vatPct: number };
  currency: string;
}
```

Adding a country becomes one row plus a data file. `Netzentgelt` per city stops
being a hard-coded 9-entry record in `tariff.ts`.

### Phase 6 — rules as versioned policy

`EEG_ANZULEGENDER`, the feed-in expiry at year 20, the § 14a windows and the
Marktprämie formula become a `Policy` object keyed by year, with the effective
date a parameter. Today they are inline tables in `revenue.ts` and `tariff.ts`
with magic numbers, and a new EEG year is a code edit.

### Phase 7 — presentation

1. **Delete the second UI.** `src/wizard/wizard.ts` re-implements `main.ts`'s
   render path and has already diverged in 12 feature areas (no CO₂, no grid
   mix, no BWWP panel, no expert mode, different EV-cost breakdown). It should
   be a *view* over the same `SimReport`, not a parallel application.
2. **Fix the i18n seams.** `main.ts` is hard-wired to `de-DE` in ~10 places
   (`toLocaleString("de-DE")`, `"kg CO₂"`, `"/Jahr"`, `"Netto"` in `charts.ts`)
   while `fmtEUR`/`fmtKWh` are locale-aware. Roughly half the English UI is
   German.
3. **Fix `relocalize()`** (`main.ts`): it writes the scenario hint into the
   tariff panel by DOM index and leaves the scenario panel German.
4. **Generate the control panel from the registry.** 15 `numberControl` calls
   in `controls.ts`, each re-declaring min/max/step that the registry already
   knows. This also fixes the full-panel `innerHTML = ""` teardown on 9
   interaction paths, which destroys focus mid-edit via randomly generated
   element ids.
5. **Remove the dead UI**: SVG/PNG export buttons in `index.html` with no
   listener; the `.legend` CSS class that nothing emits.
6. **A DOM test environment.** `environment: "node"` means `controls.ts`
   (393 lines), `charts.ts` (883), `numberField.ts`, `main.ts` and `wizard.ts`
   have **zero** tests. Adding `jsdom` and a handful of tests on the control
   builder and the number field would cover more real risk than another dozen
   unit tests on the engine.

### Phase 8 — make the future cheap to see · *process, not code*

* The registry completeness test and the declaration fan-out count go into CI.
* A `tests/fixtures.ts` scenario per feature axis, required by
  `characterisation.test.ts`'s guard test, so a new feature must extend the net.
* Whenever a conformance test fires, treat it as a finding about the
  *structure*, not the assertion: the reason the invariant was violated is
  always that something is computed twice.

---

## 9. What I would not do

* **Do not raise the level of ceremony.** This is a single-author, 12 000-line
  TypeScript project with a fast test suite. A clean architecture framework
  would cost more than the twelve futures it tries to save.
* **Do not fix the curtailment finding by reflex.** §6.2 established that
  **9–11 % of annual generation is discarded at negative-price hours** and is
  reported nowhere. The model declines to export into a negative price,
  assuming injection is not compensated — but negative day-ahead prices are
  precisely the case where it *is*. This is a domain decision with a revenue
  consequence and a calibration history, not a refactoring. It needs an
  explicit choice, and the test pins the current magnitude so the change, when
  made, is visible.
* **Do not touch the dispatch algorithm.** It is well tested
  (`charge_plan`, `peak_discharge`, `merchant_dispatch`, `dispatch`, `fuzz`) and
  its three branches are 95 % duplicated — but duplicating a hot loop is a much
  cheaper failure mode than a subtly wrong refactor of it. Unify the three
  branches only behind the conformance identities already in place.
* **Do not trust a green suite without a golden.** The 589 tests that existed
  before this pass were all green while four bars of a user-facing chart showed
  identical, wrong numbers.

---

## 10. The one-line summary

Feature throughput was never the problem — it has been flat at ~500 lines per
commit for the whole history. The problem is that the *cost of the next
feature* had grown to 130–320 edit sites, and the duplication that caused it had
already produced eight shipped defects, including a chart that showed three
different tariffs as the same number.

The fix is not more features and not more tests. It is: make each quantity
computable in exactly one place, make each axis an enumeration the compiler can
check, and put a characterisation net under all of it so the next hundred
features are cheaper than the last thirty-five.

*Files added:* `src/domain/params.ts`, `src/domain/consumers.ts`,
`src/calc/markets.ts`, `src/calc/co2.ts`, `src/ui/monthLabels.ts`,
`tests/characterisation.test.ts`, `tests/conformance.test.ts`,
`tests/fixtures.ts`, `tests/__golden__/`.

*Tests:* 589 → 689. *Runtime:* 99 s → 24 s. *Report:* 279 ms → 110 ms.