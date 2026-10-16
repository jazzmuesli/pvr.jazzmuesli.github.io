# Refactoring for Optionality

### Features, futures, burnt options, and what to do about a codebase that grew one feature at a time

---

## 1. The lens: features are not the only thing you ship

Kent Beck's framing is the one I'll use throughout:

> "Features" are the things users ask for. **"Futures"** (or **options**) are the
> things you *could* still build cheaply. Every feature you ship consumes some
> options and creates others. Development slows down not when you run out of
> features, but when you run out of futures.

The mental model is a **features/options graph**:

```
                 now
                  │
   ┌──────────────┼──────────────┐
   │              │              │
 feature A     feature B      tidy up
   │              │              │
   ├── opt        ├── opt        └── restores
   ├── opt        └── opt            structure,
   └── opt                           so new
   (burnt)                           branches open
```

Two consequences matter for this project:

1. **"Behavior change = revenue. Structure change = option."** A new consumer
   type is a behavior change (revenue). Making it possible to add a consumer
   *without touching eleven files* is a structure change (an option).
2. **You tidy in the gaps between features.** Beck's point is not "never take on
   debt"; it is that the *right time* to pay it back is the quiet moment after a
   feature lands, when you can still see all the options the feature opened.

The uncomfortable part of the graph is the count: a codebase with 40 features
and no tidying is not "40 features ahead" — it is a codebase whose *next* feature
costs more than the last, and whose options are being burnt faster than they are
created.

Beck, *Why Does Development Slow? It's the options*; *Behavior Change = Revenue
Versus Structure Change = Option*; *Options*; *Features & Options Revisited*;
*Bundles of Options* (cohesion up, coupling down). See §7.

---

## 2. What the git history actually shows

`git log` tells a very specific story.

| Fact | Value |
|---|---|
| Commits | **66** |
| Window | **2026-08-26 → 2026-10-15** (~7 weeks) |
| Style | every commit message reads like a feature: "add consumers", "add vwaps", "add amortisation", "chatbot", "add car and heating alternatives", "export calculations as excel spreadsheet", "add co2 calculation and gas savings", "add wind simulation", "charge during cheapest hours", "discharge during most expensive hours", "add more cities" |
| First commits | literally `vibe coded pv calculator` ×4 |
| Most-changed files | `src/main.ts` (26×), `src/calc/report.ts` (24×), `index.html` (22×), `src/ui/state.ts` (19×), `src/ui/controls.ts` (19×), `src/i18n/index.ts` (18×), `src/ui/url.ts` (11×) |

This is a **dark-factory product**: built fast, end-to-end, largely by
generation, with the feature list growing monotonically. Read through the
option lens, the history is not "a project shipping features" — it is a project
**spending a balance it never tracks**.

### 2.1 The features (the revenue side)

Clustering the commits into shipped features:

| # | Feature cluster | Commits | Shape of the change |
|---|---|---|---|
| 1 | Household + PV + battery simulation | 1–15 | the seed feature |
| 2 | Consumers (household, heat pump, BWWP, EV) | ~4 | **hardcoded to 4 device types** |
| 3 | VWAP / effective-price accounting | 2 | parallel to the revenue module |
| 4 | Amortisation + lifecycle economics | 2 | |
| 5 | Chatbot advisor | 4 | new UI surface |
| 6 | Car + heating alternatives (opportunity cost) | 1 | new comparison axis |
| 7 | URL sharing / sync | 3 | **second config codec** |
| 8 | Excel export | 2 | **parallel renderer of the whole report** |
| 9 | i18n (DE/UK) | 3 | |
| 10 | CO₂ analysis + gas savings | 4 | **+300 lines into `report.ts`** |
| 11 | Wind producer | 4 | **PV/wind special-cased in the engine** |
| 12 | Fuzz / plausibility testing | 2 | (the one thing that bought options *back*) |
| 13 | Charge/discharge strategies (cheapest / peak) | 2 | dispatch got smarter |
| 14 | More cities | 1 | |

So: roughly **14 feature clusters, ~40 user-visible behaviors**, in seven weeks.
Ordinary pace. The interesting column is the one I put in bold.

### 2.2 The burnt options (the futures side)

Each bold row above is a feature that closed more doors than it opened.

**Option burnt #1 — the config surface fragmented into three codecs.**

The "sync urls" feature added `src/ui/url.ts` with its own hand-written
`serializeState`/`deserializeState`; the "chatbot" feature added
`src/scenario.ts` with *a third* query format; the API kept `simParamsFromQuery`
in `report.ts`. By HEAD, the SPA link format had **silently drifted** from the
simulation contract. Verified directly against the committed tree:

```
$ git grep -l '"jaz"' HEAD -- src        ->  report.ts, heating.ts, workbook.ts     (url.ts: absent)
$ git grep -l '"wpc"' HEAD -- src        ->  report.ts                              (url.ts: absent)
$ git grep -l '"mm"'  HEAD -- src        ->  report.ts                              (url.ts: absent)
$ git grep -l '"km"'  HEAD -- src        ->  report.ts, workbook.ts                 (url.ts: absent)
$ git grep -l '"dl"'  HEAD -- src        ->  report.ts                              (url.ts: absent)
$ git grep -l '"ec"'  HEAD -- src        ->  report.ts                              (url.ts: absent)
$ git grep -l '"kwp"' HEAD -- src        ->  report.ts, url.ts, scenario.ts, workbook.ts
```

Six parameters the engine understands were **not in the share link at all**.
A user could set the car costs, the WP tariff, the heat-pump JAZ and the
Direktvermarkter margin in the UI, share the link — and their friend got the
defaults. This is a **burnt option made of pure drift**: the *right* fix
(one schema) was never taken, so every new parameter re-opened the bug.
The same drift had a second symptom: `simParamsFromQuery` shallow-copied
`DEFAULT_SIM_PARAMS` and then mutated the shared nested `consumers`/`car`
objects, so an API call contaminated the global default for every later call.

**Option burnt #2 — the god module.** `src/calc/report.ts` reached **1,375 LOC**
with **fan-out 15**: config parsing, the investment estimator, dispatch
adaptation, monthly/daily chart aggregation, the scenario matrix, historical
tariff combinations, grid-mix, CO₂ analysis, cashflow and **the report assembly
itself** — all in one file. Fan-out is the metric that matters here: touching
CO₂ logic and touching tariff logic both meant editing the same file, so the
file's blast radius was the union of every concern it held.

**Option burnt #3 — two parallel worlds (consumers, producers).**

- **Consumers** were hardcoded to exactly four (`household | heatpump | bwwp | ev`)
  across ~12 files. Adding a fifth device (say, a pool pump) meant editing the
  config type, the load builder, the breakdown interface, four literal
  `{household:0,…}` objects, the charts, the workbook and i18n.
- **Producers** were hardcoded to exactly two. The engine (`simulation.ts`)
  carries `pv`, `wind`, `directUseWind`, `chargeSolar/Wind`,
  `dischargeToLoadPV/Wind`, `exportSolar/Wind` as first-class fields and two
  separate SOC origin buckets. "Add a third producer" was not a data change; it
  was a rewrite of the dispatch loop.

**Option burnt #4 — a second renderer.** The "Excel export" feature wrote
`src/export/workbook.ts` (**1,087 LOC**) as a *parallel* re-rendering of the
report rather than a serialization of a shared model. Every report change now
has two places to land.

**The one thing that bought options back:** "add fuzz testing and fix a few bugs"
and the plausibility suite. That is why the refactor below is even *possible* —
there is a behavioral net.

### 2.3 Quantifying the burn

Two crude but honest instruments (scripts in `tools/architecture-metrics/`):

- **Shotgun surgery** — for each domain parameter, how many non-test files must
  mention it? At HEAD the average was **7.5 files**, rising to **17–18** for core
  fields like `peakKWp`, `location`, `orientation`.
- **Config-surface duplication** — for each wire key, in how many *source* files
  does the literal key appear? At HEAD shared keys lived in **2** files
  (`report.ts` + `url.ts`); the canonical codec was not single-source.

Neither number is a crime on its own. Together they are the bill for the missing
"tidy up" commit between features.

---

## 3. A framework for criticising the architecture

Before touching code, I picked metrics that (a) are cheap to compute and
(b) correlate with *options*, not with prettiness.

| Metric | What it measures | Why it predicts option loss | Tool |
|---|---|---|---|
| **Efferent coupling (fan-out)** | outbound module dependencies | blast radius of a change | `coupling.mjs` |
| **Instability `I = Ce/(Ca+Ce)`** | volatility vs. stability | stable modules should have low `I`; high‑`I` modules should be leaves | `coupling.mjs` |
| **God-module LOC + fan-out** | concentrated responsibility | one edit at a time | `coupling.mjs` |
| **Shotgun-surgery radius** | files per parameter | cost of the *next* parameter | `shotgun.mjs` |
| **Codec duplication** | files per wire key | drift risk / round-trip safety | `codec.mjs` |
| **Round-trip invariance** | does `decode(encode(x)) == x`? | catches silent option loss | acceptance tests |
| **Layered coverage** | % covered by *calc* vs *ui* | is the safety net where the risk is? | `vitest --coverage` |
| **Parallelism** | N renderers of the same model | N× the edit cost | manual |

Baseline (HEAD):

| Metric | HEAD | Comment |
|---|---|---|
| src files / LOC | 37 / 12,254 | |
| largest module | `report.ts` 1,375 LOC, fan-out 15 | the god module |
| largest module (non-calc) | `workbook.ts` 1,087 LOC | second renderer |
| avg shotgun radius | **7.5 files / parameter** (max 18) | |
| codec duplication | 2–4 files per wire key | |
| test suite | **589 tests / 33 files**, all green | the safety net |
| coverage | calc ≈ **99.6%**, ui ≈ **20%** | net is exactly backwards |

That last row is the strategic wound. The *calculation* layer — which is pure,
deterministic and cheap to test — is fully covered. The *integration seams* that
actually broke (URL codecs, API entry point, report assembly) sat at **~0%**.
Per the brief, the right move is the opposite of instinctive: **ignore the
unit tests for a moment and buy higher-level acceptance tests first.**

---

## 4. The refactor: buy the safety net, then spend it

The brief was explicit: *cover enough with higher-level tests first, then
refactor; you may lean on integration/acceptance tests rather than unit tests.*
So the work ran in that order.

### Step 0 — The characterization net (new)

`tests/acceptance.test.ts` (+ `tests/support/digest.ts`) pins the behavior the
whole app funnels through:

1. **Golden characterization of `runSimulation`** across a 17-scenario matrix
   (default, no-battery, no-PV, peak-discharge, grid-negative, cheapest-charge,
   market-export-margin, dynamic/dynamic14a import, wind, BWWP-off,
   all-consumers-off, price-2023/2026, big-battery-small-PV, EV-grid-only, and a
   mixed "marketing-expert" scenario). Each report is rounded to 4 dp, hashed,
   and compared to a stored digest. A refactor that moves a number fails **here**,
   loudly, at the highest level — exactly the coarse net the brief asked for.
2. **`/api` contract** — `handleApiRequest(query)` must equal
   `runSimulation(simParamsFromQuery(query))` behaviourally, covering the
   previously-untested `src/api.ts`.
3. **Config round-trip invariants** — `simParamsFromQuery` must reproduce a full
   `SimParams`, must not mutate the shared defaults, and
   `deserializeState(serializeState(s))` must preserve every editable field.

Tests 3b and 3c were **red on purpose** before the refactor (they demonstrated
the mutation bug and the share-link drift). They are green now.

### Step 1 — One parameter schema (`src/calc/params.ts`)

A single declarative table describes each field: its dotted path, its wire key,
its kind (`num`/`bool`/`str`) and any enum normalization. `parseParams` and
`serializeParams` are generic and **deep-clone** the caller's defaults.

- `report.ts#simParamsFromQuery` and `ui/url.ts` both become 1–3 lines.
- The six drifted keys (`jaz`, `wpc`, `mm`, `km`, `dl`, `ec`) now round-trip, and
  the car's remaining cost fields were added for free.
- The shared-default mutation bug is structurally impossible.

**This is the option that was burnt on purpose in Step 1 of the history, now
repaid.** Adding a parameter is one row.

### Step 2 — One state model (`src/ui/state.ts`)

`AppState` was a 45-field hand-copy of `SimParams`. It is now
`interface AppState extends Omit<SimParams, "orientation"> { expertMode; orientation }`,
and `DEFAULT_STATE` is derived from `DEFAULT_SIM_PARAMS` plus the UI's overrides.
`toSimParams` collapsed from a 50-assignment copy to a spread plus the
expert-mode overrides. The UI model can no longer drift from the engine model.

### Step 3 — Break the god module, keep the public surface

`report.ts` (1,375 → **401 LOC**) now orchestrates; the concerns moved to
focused modules. The calc dependency graph is **acyclic** — no extracted module
imports back into the orchestrator (the shared `SimParams` contract was promoted
to its own leaf module so even the type-level graph stays clean):

| New module | LOC | Responsibility |
|---|---|---|
| `calc/co2.ts` | 395 | CO₂ constants, `computeGridMix`, `computeCo2Analysis` |
| `calc/params.ts` | 213 | the config codec (wire schema + parse/serialize) |
| `calc/reportModel.ts` | 152 | the report DTO types |
| `calc/simParams.ts` | 137 | the `SimParams` contract + defaults (leaf module) |
| `calc/charts.ts` | 98 | monthly/daily aggregation |
| `calc/markets.ts` | 71 | **the market catalogue** (schemes + comparison matrices) |
| `calc/tariffCombinations.ts` | 66 | historical tariff combinations |
| `calc/simConfig.ts` | 62 | `SimParams → SimConfig` adapter |
| `calc/scenarios.ts` | 40 | scheme-comparison chart |
| `calc/util.ts` | 6 | shared numerics |

`report.ts` re-exports the entire previous surface, so no caller changed.

### Step 4 — Seams for the coming feature explosion

- **Market catalogue** (`calc/markets.ts`): `EXPORT_SCHEMES`, `IMPORT_SCHEMES`
  and the two comparison matrices (`SCENARIO_VARIANTS`, `TARIFF_COMBOS`) now live
  in one place instead of being duplicated between the report and the chart
  layers.
- **Consumer registry**: `ConsumerKey`/`CONSUMER_ORDER` moved next to the
  consumer domain, and the aggregation code (`charts.ts`) now *iterates* the
  registry to build breakdowns and totals, instead of spelling out
  `{household:0, heatpump:0, bwwp:0, ev:0}` in several places.

### Results

| Metric | Before | After |
|---|---|---|
| Tests | 589 / 33 files | **611 / 34 files**, all green |
| Largest calc module | `report.ts` 1,375 LOC | `simulation.ts` 574 LOC |
| `report.ts` | 1,375 LOC, fan-out 15 | **402 LOC**, fan-out 21 |
| Avg module size | 331 LOC | **262 LOC** |
| src files / LOC | 37 / 12,254 | 47 / 12,297 (no bloat) |
| Calc dependency cycles | (type-level back-edges into `report`) | **none** |
| Codec files per wire key | 2–4 | **1** (`params.ts`) |
| Share-link drift | 6 keys lost | **0 lost** (pinned by test) |
| Default-mutation bug | present | **structurally impossible** |
| Build | — | `tsc` + `vite build` clean |

### Two honest caveats

1. **`report.ts` fan-out rose (15 → 21).** That is *expected and fine*: an
   orchestrator at the top of an acyclic graph should depend on its parts. The
   win is cohesion of the parts, not the orchestrator's degree. I would rather
   have one 402-line conductor with 21 dependees than a 1,375-line module with
   15 and ten tangled concerns.
2. **The identifier-based "shotgun radius" went 7.5 → 8.4.** That metric counts
   how many files mention a *field name*, and I added nine cohesive modules that
   legitimately mention `peakKWp`, `capacityKWh`, etc. The metric that reflects
   the thing we fixed — *how many files encode the wire key* — fell to 1.0.
   This is a good reminder that a metric is a lens, not a verdict.

---

## 5. The dark-factory angle

This project is a dark-factory artifact. Dan Shapiro's five levels of AI coding
autonomy top out at **Level 5: "The Dark Factory"** — a lights-out line where
specs go in and products come out, named after FANUC's lights-out robotics plant
("a dark factory has no people not because it's empty, but because it doesn't
*need* people"). The first four commits here are literally titled *"vibe coded
pv calculator"*. That is the dark factory operating on a hobby scale.

The factory metaphor is useful because it predicts where the debt lands:

- **Spec debt replaces tech debt.** The factory optimizes for producing the next
  artifact, so what erodes first is the *shared interface* between steps — here,
  the config surface. Three codecs, six drifted keys, a shared-default mutation:
  all spec/interfaces, not algorithms. The algorithms were fine (99.6% covered);
  the *seams* were unowned (~0%).
- **Volume amplifies entropy.** `darkfactory.dev` reports AI-generated PRs carry
  roughly **1.7×** the issue rate of human ones. Sixty-six commits in seven weeks
  is exactly the volume at which small interface mistakes compound.
- **The tests are the factory's quality gate.** The single most valuable commit
  in that history was not a feature — it was "add fuzz testing". When generation
  is cheap, **behavioral characterization is the asset**; source is almost
  disposable. That is why Step 0 above came first.

Optionality matters *more* under a dark factory, not less. If the next feature
is one generation away, then the binding constraint is no longer "can we build
it?" but "can we build it **without a human re-deriving the whole interface by
hand**?" The refactor above is an attempt to make the interfaces machine-sized.

---

## 6. Roadmap: keeping the futures open (consumers, producers, markets, rules)

The refactor removed the drift and gave each concern a home. It did **not** yet
generalize the two hardest axes. Here is the plan, in descending value.

### 6.1 Producers: generalize the dispatch to N producers  ← biggest option

The engine still special-cases PV + wind. The generalization is mechanical and —
critically — **provably identical for the existing two producers**:

- Today `directUse` is split by `pRemain / gen` and charge by the same ratio.
  Because `gen` is decremented by exactly the per-producer allocations, the
  invariant `gen == Σ remain[p]` holds throughout, so `remain[p]/gen` is just
  "producer `p`'s share of the remaining generation". Replace `pRemain/wRemain`
  with an array `remain[p]` and a loop.
- Today the battery tracks two origin buckets `pvSOC`, `windSOC`. Replace with
  `socOrigin[p]`; the discharge split `socOrigin[p] / Σ socOrigin` generalizes
  directly. Reproduce the current seeding (all initial SOC attributed to PV) to
  keep digests bit-identical.
- Add `SimConfig.producers?: { id, production }[]` and
  `SimResult.byProducer?: Record<id, ProducerFlows>`, keeping the legacy
  `pv/wind/*Wind` fields as projections of `byProducer.pv` / `byProducer.wind`.
  Then `simConfig.ts` builds producers from a registry, and the report stops
  knowing what a "wind" is.

The golden-digest suite (§4.0) makes this safe: any last-bit drift fails 17
scenarios immediately. **Do this next.**

### 6.2 Consumers: a device registry

Promote the four hardcoded consumers to a registry
`ConsumerSpec { key, config, load(cfg), labelKey, defaults }` so a new device is
one entry plus one control. The domain coupling that blocks a pure registry —
"hot water moves from the BWWP to the heat pump when the BWWP is off" — becomes
an explicit `derives`/`fallbackTo` link in the spec instead of an `if` in
`loadByConsumer`. This unlocks the pool-pump / second-EV / wallbox classes.

### 6.3 Markets & rules: scheme objects, not switches

Markets are currently enumerated in `TariffScheme` + a price `if` chain +
`computedEconomics`'s three named cost columns. Move to a scheme object:

```ts
interface ImportScheme { id; label; priceCtPerKWh(city, spotCt, step, fixedCt); }
interface ExportScheme { id; label; revenue(result, ctx); }
```

Then `EconomicsSummary` carries `importCostByScheme: Record<schemeId, eur>` and
the named fields become views. New markets (capacity markets, new §14a modules,
guaranteed feed-in variants) and new **rules** (EEG degression tables, grid-fee
regulations, dynamic-cap regimes) become registrations rather than edits to a
growing `if`/`switch`.

### 6.4 Unify the third codec

`src/scenario.ts` still hand-rolls its own query format for the wizard/chatbot.
It should serialize a `SimParams` through `params.ts` (or a documented subset).
Doing so removes the last place a wire key is duplicated.

### 6.5 Collapse the parallel renderer

`workbook.ts` (1,087 LOC) re-renders the report. It should consume the report
DTOs (`reportModel.ts`) and be a pure serializer, so the report has one shape and
the workbook one writer. Full UI view-model extraction — pulling `main.ts`'s
imperative HTML into small renderers — is the natural follow-on.

---

## 7. References

- Kent Beck, *Why Does Development Slow? It's the options* — the
  features/options graph; each feature burns options; tidy in the gaps.
- Kent Beck, *Behavior Change = Revenue Versus Structure Change = Option*.
- Kent Beck, *Options* and *Features & Options Revisited* — bundles of options,
  cohesion up / coupling down.
- Dan Shapiro, *The Five Levels of AI Coding Autonomy* — Level 5 "Dark Factory";
  origin in FANUC's lights-out plant.
- `darkfactory.dev` — spec/interface debt (`spec debt`) in dark-factory
  workflows; AI-assisted PR issue rates.
- Martin Fowler, *Coupling*, *Instability* (`I = Ce/(Ca+Ce)`) and *Shotgun
  Surgery* — the architecture-criticism metrics used in §3.

---

## Appendix — reproducing the numbers

```bash
# Requires Node 22 (vitest). In this sandbox a temporary Node 22 was prepended to PATH.

# behaviour + contract + codec safety net
npx vitest run tests/acceptance.test.ts

# full suite (611 tests)
npx vitest run

# typecheck + production build
npm run build

# architecture metrics (run from the repo root)
node tools/architecture-metrics/coupling.mjs   # coupling, instability, cycles, god modules
node tools/architecture-metrics/shotgun.mjs    # files touched per parameter
node tools/architecture-metrics/codec.mjs      # source files per wire key
git log --format="%ad|%s" --date=short         # the feature timeline
```
