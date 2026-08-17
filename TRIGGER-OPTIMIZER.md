# Trigger Optimisation — reverse-engineered from the `combat.43.167.210.211.sslip.io` fork

Working notes. Source: the peer bundles already snapshotted in
`.upstream/peer/` — `index-MWE1khT9.js` and `skill-optimizer-CLbXCucw.js` (Vue 3 +
Element Plus, zh-CN, route `/combat/skill-optimizer`, labelled 最优技能组 / "Ability
Optimizer"). Minified identifiers are given alongside the meaning; no source maps are
served, so local variable names are lost but function boundaries are intact.

The peer's own footer confirms the shared ancestry — *"战斗核心基于 MWICombatSimulator（MIT）"*
— so it is the same MIT-licensed upstream as ours, and the algorithm is ours to borrow.
Note also that the peer runs **all** simulation client-side in web workers; its server
does accounts and persistence only (see `.upstream/peer-report.md`). We have a real
Express backend with `worker_threads`, so the natural home for this differs.

Their optimiser searches **two things at once**: which abilities to slot, and what
*trigger thresholds* those abilities should use. The trigger half is the part worth
importing; it is cleanly separable.

---

## 1. Data model

A **trigger preset** (触发条件候选 N — "trigger candidate N") is a named, checkable
bundle of AND-ed conditions attached to one ability:

```js
{
  id: 'custom-<ts>-<n>',
  label: '触发条件候选 2',
  checked: true,            // include this preset in the search
  conditions: [ /* 0..4 */ ]
}
```

An empty `conditions` array is a first-class option, surfaced in the UI as
**空 Trigger** — "cast as soon as cooldown is ready".

Each condition extends our existing `Trigger` shape with two search fields:

```js
{
  dependencyHrid: '/combat_trigger_dependencies/self',
  conditionHrid:  '/combat_trigger_conditions/current_hp',
  comparatorHrid: '/combat_trigger_comparators/less_than_equal',
  value: 0,
  valueMode: 'fixed' | 'search',        // 'search' ⇒ sweep this number
  searchKind: 'percentage' | 'absolute' // how to sweep it
}
```

`searchKind` is defaulted on condition change (`A()`): `percentage` when the
conditionHrid ends `lowest_hp_percentage`, otherwise `absolute`. Cap of 4
conditions per preset (`al`), matching the game.

`Ua`/`k5` flattens a preset back to engine form — `conditions.slice(0, 4)` mapped to
`{dependencyHrid, conditionHrid, comparatorHrid, value}` — i.e. the search metadata
never reaches the engine.

### Preset de-duplication

`OI` builds a per-condition signature:

```js
JSON.stringify([dependencyHrid, conditionHrid, comparatorHrid, valueMode,
  valueMode === 'search' ? searchKind
    : isThresholdComparator ? String(value) : 'no-value'])
```

`b0` returns the sorted-JSON of a preset's condition signatures **only if** some
condition is in `search` mode, else `''`. `B5`/`Il` then refuses to mark a condition
as `search` when doing so would make this preset signature-identical to another —
"相同条件组已有搜索方案" ("this condition group already has a search preset"). Neat: it
stops you burning sim-hours on two presets that would collapse to the same sweep.

Duplicating a preset that contains a search condition resets those to `fixed`
("已复制为新测试组；搜索条件已改为固定").

---

## 2. Search bounds from the zone (`w5`, `f0`, `tm`)

Grid ceilings are derived from the actual zone, not guessed:

- `f0(spawnInfo, tier)` recursively enumerates every spawn combination permitted by
  `maxSpawnCount` and `maxTotalStrength`, instantiating each monster
  (`tm` → `new Monster(hrid, tier).updateCombatDetails()`) to read `maxHitpoints`.
  Returns `{ total, single }` — the largest achievable total wave HP, and the
  largest single-monster HP.
- `w5(zoneHrid, tier)` folds random spawns and each boss wave into
  `{ enemyTotalHp, targetHp }`, defaulting to `10000` when the zone is unknown.

`ti` then picks a ceiling per searched condition:

| dependency ends with | ceiling |
|---|---|
| `/targeted_enemy` | `bounds.targetHp` |
| `/all_allies` | `100` if percentage, else `bounds.partyMissingHp` |
| anything else | `bounds.enemyTotalHp` |

---

## 3. Grid generators

Four, all pure:

```js
// coarse percentage  I5(step = 10)  →  [0, 10, 20, … 100]
Array.from({length: Math.floor(100 / step) + 1}, (_, i) => i * step)

// fine percentage  S5(current, window = 10, step = 5)
//   → current ± 10, in 5s, clamped to [0, 100]
for (let v = max(0, floor(current - 10)); v <= min(100, ceil(current + 10)); v += 5)

// coarse absolute  D5(max, step = 1000)  →  [1, 1000, 2000, … ceil(max/1000)*1000, +1000]

// fine absolute  T5(current, max, window = 1000, step = 200)
//   → current ± 1000 snapped to a 200 grid, clamped to ceil(max/200)*200 + 200,
//     plus `floor(current)` itself, deduped, ascending
```

The changelog confirms the intent: *"百分比阈值改为按 10% 粗搜、5% 精搜"* — percentage
thresholds coarse-searched at 10%, fine-searched at 5%.

---

## 4. Coordinate descent (`Gl`)

Per candidate, sweep one searched parameter at a time, greedily, carrying the winner
forward:

```
params = collectSearchParams(candidate, bounds)        // ti
passes = fine ? 1 : 2
if params is empty: evaluate the candidate once and stop

for pass in 0 .. passes-1:
    changed = false
    for each param:
        current = candidate value at param
        grid    = percentage ? (fine ? S5(current) : I5())
                             : (fine ? T5(current, param.maxValue) : D5(param.maxValue))
        results = simulate(grid.map(v => withValue(candidate, param, v)), hours, seed)
        best    = rank(results, objective)[0]
        candidate = best.candidate
        candidate[param].insensitiveValues = Zt(results, best, param)
        if candidate[param].value !== current: changed = true
    if !changed: break                                 // converged
```

`Zt` records the **insensitivity band**: every swept value whose `xpPerHour` lands
within 0.5% of the winner's, deduped and sorted. That is what lets the UI say
"anything from 40% to 60% is equivalent" rather than pretending 47% is meaningful —
a genuinely good idea given Monte-Carlo noise.

Note the greediness: parameters are optimised sequentially against the *already
updated* candidate, so interactions between two thresholds are only partly captured —
hence the second coarse pass, which repeats until nothing moves.

---

## 5. Three-stage funnel with escalating fidelity (`ri`)

| # | Stage | Sim hours | Seed | Grids | Survivors |
|---|---|---|---|---|---|
| 1 | 初筛 initial screening | 6 | `s` | none — evaluate as configured | top **20** |
| 2 | 粗搜 coarse | 12 | `s+1` | coarse, ≤2 descent passes | top **8** |
| 3 | 精搜 fine | 24 | `s+2` | fine, 1 descent pass | top **5** |
| 4 | 同种子复核 verification | **72** (120 in 稳定模式 stable mode) | `s+3` | none — re-run finalists + baseline on one seed | ranked output |

Cheap sims kill most candidates; only the survivors earn expensive ones. A fresh
baseline is simulated at every stage (`il`) so deltas are always like-for-like.

A checkpoint is emitted after each stage (`onCheckpoint`) carrying
`{completedPhase, candidates, screening, stageBaselines}`, and a run can resume from
`initial`/`coarse`/`fine` — the phase gate is just `d >= 1|2|3`.

---

## 6. Ranking (`Fe`, `Yt`, `Fl`)

Objective → metric: `experience → xpPerHour`, otherwise `profitPerHour`.

Sort descending on that metric; when two results are within **0.1% relative**, fall
through the tie-breakers in order:

1. fewer `deathsPerHour`
2. more `encountersPerHour`
3. **fewer total trigger conditions** (`Fl` sums `conditions.length` across abilities)
4. `id` lexicographic — deterministic output

Tie-breaker 3 is the tasteful one: given equal performance, prefer the simpler trigger
set-up. Worth copying verbatim.

Final rows carry `deltas` (`ni` → `{value, pct}` vs baseline) for `xpPerHour`,
`encountersPerHour`, `revenuePerHour`, `profitPerHour`, `deathsPerHour`.

---

## 7. Worker pool calibration (`ai`, `jl`, `Qt`, `Xt`, `Ft`)

Browser-side, so likely not directly reusable, but the shape is sound: benchmark
`[1, 2, 4, 8, 12, 16]` workers capped at `hardwareConcurrency - 1`, walk upward and
keep the largest count that still buys **≥8%** throughput (`Xt`), cache
`{workers, throughput}` in `localStorage` for 72h keyed by
`hardwareConcurrency|userAgent`, and re-validate the cache with a probe run against an
0.8 tolerance (`Ft`) before trusting it. Falls back to manual worker count.

Our `api/` has real `worker_threads`, so this becomes a server-side pool size.

---

## 8. What is worth taking, and what is not

**Take:**
- `valueMode` / `searchKind` on conditions, and the empty-preset-as-candidate idea
- zone-derived bounds rather than magic ceilings
- the four grid generators (they are tuned and cheap to port)
- coordinate descent with a convergence check
- the insensitivity band — arguably the single most useful output
- escalating sim-hours funnel, fresh baseline per stage
- the ranking tie-breakers, especially "prefer fewer conditions"
- preset signature de-duplication

**Leave:**
- the coupled ability-set search (out of scope here; our `abilityHrids` handling differs)
- `localStorage` worker calibration (we have `worker_threads` server-side)
- cloud history / auth / task persistence

**Watch:**
- greedy descent ignores threshold interactions; consider a final pairwise pass
- 0.1% ranking epsilon and 0.5% insensitivity epsilon are asserted, not derived — at
  6 sim-hours Monte-Carlo noise may well exceed both, which would make stage-1
  screening partly luck. Their escalating-hours funnel mitigates but does not fix this.

---

## 9. What we built, and where it departs from theirs

Shipped as `api/lib/triggerSearch/` + `POST /api/optimize-triggers` + the `Triggers`
mode in `ui/`. Scope is **thresholds only**: the user marks which numeric trigger
values to sweep; condition structure is left alone.

### The measurement that changed the design

Run-to-run standard deviation of encounters/hour, twelve seeds per cell, one build:

| zone | 6h | 12h | 24h |
|---|---|---|---|
| `fly` (single spawn) | 0.115% | 0.101% | 0.077% |
| `chimerical_den` (dungeon) | 1.139% | 0.483% | 0.356% |
| `enchanted_fortress` | **5.730%** | 3.665% | 2.942% |

The peer ranks candidates inside a fixed **0.1%**. On a hard zone at their own
stage-one fidelity the noise is **57×** that, so their screening there is largely
luck; their 0.5% insensitivity band is likewise beneath the floor.

The variance scales as 1/√t almost exactly (5.730% × √(6/24) predicts 2.865%; 2.942%
measured), so we **calibrate once** — a handful of baseline repeats at the cheapest
fidelity — and derive every stage's epsilon from it. Rank epsilon is 1.5σ, the
insensitivity band 3σ, floored at the peer's numbers so we are never *less*
discriminating on a quiet zone, and capped at 25%.

Consequence worth stating: on a loud zone almost everything ties, and the tool
reports `inconclusive` — "nothing beat your current thresholds by more than the
measurement noise". That is the honest answer, and far more useful than a confident
ranking of noise.

### Departures

1. **Seeded RNG without touching the engine.** Our engine calls `Math.random()`
   directly and has no seed. Rather than adapt upstream-tracked code, each pool
   worker replaces `Math.random` in its own global scope before every run
   (`rng.js`) — the idiom `api/tests/guildTrial.test.mjs` already uses. One seed per
   stage, rotated between stages, so a threshold that only wins against one spawn
   sequence is caught by the next.
2. **Beam search instead of greedy descent.** Their funnel narrows a *candidate
   pool*; with thresholds only there is one starting configuration, so it would
   screen it against itself. Ours escalates fidelity over threshold *combinations*:
   6h per-parameter screen keeping the best K values each → 12h beam search carrying
   the best W combinations → 24h fine descent → 72h pinned-seed verification. The
   beam captures interactions that greedy descent cannot see.
3. **Only seven conditions are searchable.** Of 54, only seven carry
   `allowValue: true`. They grid everything except `lowest_hp_percentage` as
   "absolute, 1000-point steps" — meaningless for `number_of_active_units`, an
   integer count of one to a few. We grid each by its real unit, and derive absolute
   steps from the ceiling rather than fixing them.
4. **Correct bounds for `self`.** They default anything that is not
   `targeted_enemy`/`all_allies` to the *enemy's* total HP. For `self` + `current_hp`
   the ceiling is the *player's* maximum, which `api/lib/labStats.js` already knew
   how to compute.
5. **Validity filtering.** `Trigger.isActive` dispatches on the dependency's
   `isSingleTarget`; pairing `self` with a multi-target condition throws. Neither
   their editor nor ours enforces this, so candidate generation must.
6. **Consumables included.** Food and drinks carry triggers too, and
   "eat when missing HP ≥ N" is the archetypal tunable threshold.
7. **`unreachable` detection.** A `>=` threshold above anything the zone can produce
   never fires — "when 2+ enemies are active" in a single-spawn zone. Flagged rather
   than silently optimised.

### Two bugs found in their approach by writing ours

- **The ranking comparator is not a valid ordering.** An epsilon tie-band tested
  pairwise is non-transitive: A ties B, B ties C, A and C differ.
  `Array.prototype.sort` with an inconsistent comparator is undefined, and in
  practice returns an unsorted list — we reproduced exactly that (`29.75, 31.37,
  32.12, 30.12`). Their comparator has the same shape, so its rankings are
  unreliable whenever three or more candidates sit within one epsilon — which, given
  how far their epsilon sits below the noise, is most of the time. Fixed by greedy
  clustering from the top: transitive by construction. Quantising onto epsilon-width
  buckets also fixes transitivity but puts the boundary somewhere arbitrary, and we
  measured a 0.03% difference outranking the baseline under a 0.12% bar.
- **Nothing prefers the incumbent.** At low fidelity most values tie, so ranking
  falls through to `id` and picks arbitrarily among equals — then advises changing a
  threshold it has measured as indistinguishable. Added as a tie-break below "fewer
  conditions": given equal performance, prefer the simpler set-up, then the one you
  already have. Their deaths tie-break also has no epsilon, so 0.01 deaths/hour of
  noise can decide a ranking; ours shares the objective's epsilon.

---

## 10. Consumable thresholds and the cost function

Food and drink triggers are optimised alongside ability triggers — "eat when missing
HP ≥ N" is the archetypal tunable threshold. But **encounters per hour is the wrong
objective for a consumable threshold**, and dangerously so: eating more often costs
that metric nothing while costing the player real resources. The optimum under raw
throughput is degenerate — eat constantly.

Measured, sweeping a Marsberry Donut `missing_hp >= N` at 12 simulated hours:

| zone | best on raw enc/h | gain | donuts/hour |
|---|---|---|---|
| `jungle_planet` | N=1 vs N=400 | +0.37% | 0.0 → **44.3** |
| `planet_of_the_eyes` | N=1 vs N=400 | +0.34% | 0.6 → **55.2** |

A third of one percent, bought with forty-four donuts an hour from a standing start.

### The fix: denominate cost in production TIME, not coins

For an ironcow there is no market — a consumable costs the time to make it. That
makes both sides of the trade the same unit, and no separate cost function is needed,
only the right one:

```
consumableSecondsPerHour = Σ (usagePerHour[item] × secondsEach[item])
effectiveEncountersPerHour = encountersPerHour / (1 + consumableSecondsPerHour / 3600)
```

Encounters per hour of **total** time — combat plus the production owed for
everything burned. Derivation: over H hours with E encounters and T seconds owed,
E / ((3600H + T)/3600), which reduces to the divisor above.

Per-item seconds come from the UI's existing `iron` price source —
`usePrices` → `buildIronPrices` → the cow webapp `/api/value/market`, which already
reports values in seconds (`unit: 'seconds'`). `buildConsumableCosts` in
`ui/src/utils/consumableCosts.js` extracts just the items the party has slotted.
Vendor and market sources report **coins**, which are not commensurable with combat
time, so those are treated as "no cost data" and the UI says so.

The objective is chosen server-side: `effectiveEncountersPerHour` when costs are
present, `encountersPerHour` otherwise. With no cost table the divisor is 1 and the
two are identical, so the metric is always safe to rank on — it simply stops
discriminating.

### Per-item overrides

A fetched production time answers "what would it cost me to make this?", which is
not always the question being asked. An item that arrives free — a daily, a guild
handout, a stockpile already paid for — costs nothing **at the margin**, and its
production time overstates the trade. So the panel's iron-source block lists every
slotted consumable with its fetched time and a box to type a different one, in
seconds per unit. Blank means "use what was fetched"; a typed value wins.

Overrides live in `usePrices` and are persisted in `csim_prices` beside the price
cache, so they survive a refetch, a source switch, a character switch and a reload.

> **Superseded.** This began as `consumableCostOverrides`, editable only from this
> panel and read only by the consumable cost function — drop valuation was
> deliberately left alone. It is now `itemCostOverrides`, covers **any** item, has
> its own **Costs** tab, and is applied inside `usePrices` so that one edited number
> reaches consumable costs, enhancement costs and drop valuation alike. The
> generalisation was forced by the enhancement costing, which needs times for
> drop-only materials no production walker can resolve; see
> EQUIPMENT-OPTIMIZER.md §10. The old key is migrated on load.

**Zero is data, not a missing value**, and every layer had to be taught the
difference. `buildConsumableCosts`, `sanitiseConsumableCosts` and `scoreSimResult`
all screened out non-positive costs, which was right for the -1 that
`buildIronPrices` stores for "unknown" but would silently discard a deliberate 0.
It matters because an empty cost table flips the objective back to raw throughput
and the UI back to warning that the food bill is not counted — so a build whose
every consumable had been declared free would have been told its costs were
unknown, and then optimised toward eating constantly.

The rule now lives in ONE predicate, `isKnownCost` in `shared/consumableCost.js`,
which every layer calls. Writing it once immediately paid for itself: the obvious
form, `Number.isFinite(Number(v)) && Number(v) >= 0`, admits `null`, `''`, `[]`
and `false` as costs of nothing, because `Number()` maps all four to 0. A posted
`null` therefore read as *free* rather than *unknown* — the one wrong answer that
understates the bill and so can only flatter a configuration. The predicate now
checks the type before the number.

The chain is `resolveConsumableCost` (one item → fetched / override / effective) →
`describeConsumableCosts` (the party's slotted items, and the row list the editor
renders) → `buildConsumableCosts` (the table posted to the API). Deriving all
three from one function is what keeps the editor from ever showing something other
than what was sent.

### The same figure on the zone tab

`Effective Enc/Hour` sits beside `Encounters/Hour` in the normal zone results,
computed from the same divisor via `summariseConsumableCost`, with the cook-time
share beneath it and the priced/overridden/unpriced breakdown in its tooltip. It
prices what was ACTUALLY CONSUMED rather than what was slotted — the engine has
already tallied every item, so there is no need to reason about which slots were
reachable — and it is omitted entirely when nothing consumed can be priced, since
a number equal to the raw rate would read as "your food is free" when it means
"we have no idea".

The arithmetic and the conventions are shared rather than reimplemented:
`shared/consumableCost.js` holds `isKnownCost`, `sumConsumablesUsed`,
`consumableSecondsUsed`, `effectiveRatePerHour` and `consumableTimeShare`, and is
imported by both `api/lib/triggerSearch/score.js` and
`ui/src/utils/consumableCosts.js`. It is deliberately NOT in
`src/combatsimulator/`: that directory is upstream-tracked and vendored wholesale
into the MWIX Tampermonkey bundle, and what eating is *worth* is a question about
the player's situation, not one the engine should hold an opinion on.

### What it found

End-to-end on `jungle_planet`, same build, same seeds:

| | winner raw enc/h | consumables/h | **effective enc/h** | cook-time share |
|---|---|---|---|---|
| uncosted | 271.33 | 158.3 | 271.33 | — |
| **costed** | 229.00 | **106.3** | **127.85** | 44.2% |
| baseline, costed | 254.67 | 161.0 | 113.35 | 55.5% |

The costed run deliberately **sacrificed 10% of raw throughput** — raising Dragon
Fruit Gummy from 350 to 1000 so it drinks less often — to cut consumption by a third,
for a net **+12.8% on the real rate**. The uncosted objective moved the opposite way.

(The specific percentages above use stand-in production times of 20–30s per item; the
real figures come from the user's own cow webapp values. The *mechanism* is what these
numbers validate, not the exact shares.)

### Why the tie-break alone is not enough

There is also a consumption tie-break — among candidates indistinguishable on the
objective, prefer the one that eats less — which costs nothing and needs no prices.
But it is **not** a substitute, and a test pins down why: the measured gain for eating
constantly (0.367%) sits a hair *outside* the measured noise floor (0.362%) on that
zone, so the objective cluster splits and the tie-break never fires. It is a safety
net for the within-noise case, not the fix. Counting the cooking time is the fix.

### Incidental finding, not fixed

`ui/src/components/ImportExport.jsx` has a load/save race: its autosave effect is
declared before its load effect, so on mount it writes the default state to
`csim_player_data` before the load reads it. Seeded builds did not survive a reload
during testing. Out of scope here, but worth a look.

---

## 11. The labyrinth as a second target

Both optimisers now take **either** a zone or a labyrinth room. The search itself did
not change — the funnel, the beam, the seeded RNG, the paired ranking and the noise
calibration never knew what they were simulating — but four things around it did, and
one of them changes what the answer *means*.

### The objective is a proportion, not a rate

A labyrinth room is one monster, scaled by `roomLevel / 100`, with a hard **120-second
timer**. An attempt ends in a clear, a death or a timeout, and each one costs a torch
whether or not it succeeds. Torches, not hours, are the scarce resource — so the
objective is **completion chance**, reported as `clearRatePercent`.

The denominator is **resolved rooms** (`labRoomOutcomes`), not `labyAttemptCount`. The
latter counts the room still in progress when the simulation window closed, which is
unfinished rather than failed; including it would bias the clear rate downward by
roughly one room in several hundred. Small, and it would largely cancel under the
paired design — but the figure is meant to be readable as the game's own completion
chance, and a number that is quietly 0.3% pessimistic is not.

Expressed as a **percentage, 0–100, deliberately not a fraction**. Everything
downstream works in relative terms: `rankResults` clusters within a relative epsilon
whose scale is floored at 1, and the scan divides by the baseline mean. A fraction in
[0,1] would silently convert that relative epsilon into an absolute one.

### It saturates at both ends, and the band between is narrow

This is the finding that matters most in practice. Measured on a real level-146 magic
build against the cyclops, three replicates of three simulated hours apiece, with
expert crates:

| room level | 60 | 100 | 140 | 200 | 260 | 300 |
|---|---|---|---|---|---|---|
| clear rate | 100% | 100% | 100% | 97.3% | 4.5% | 0.0% |
| clears/hour | 420.8 | 187.2 | 104.8 | 47.3 | 2.0 | 0.0 |

Below ~140 every attempt clears and **every row in the table is a tie by
construction**; at 300 nothing clears and the table ties again. Only the band between
measures anything, and on this build it is roughly 180 to 280.

Those figures assume the three **expert supply crates**, which is now the UI default.
It was not originally — the crate selectors defaulted to empty — and the difference is
not marginal. Same build, same room level 200:

| | clear rate | clears/hour | deaths/hour |
|---|---|---|---|
| no crates | 32.2% | 14.3 | 30.2 |
| expert crates | **97.3%** | 47.3 | 1.3 |

One crate of each type is consumed on entry whatever its tier, so a basic crate is
simply a worse run at the same price and nobody carries one. Defaulting them to empty
modelled a player who had brought no supplies at all — a situation no one is in — and
moved the measurable band by sixty points of clear rate, which is more than the entire
range any enhancement scan is trying to resolve within it.

A pinned run is **not inconclusive**. The measurement worked perfectly; the answer is
"clearing this room is not what limits you". Conflating the two would report a
successful measurement as a failed one, and the advice differs — raise the room level
at the ceiling, lower it at the floor. So `objectiveSaturation` returns
`'ceiling' | 'floor' | null` rather than a boolean, and both results views lead with it
ahead of `inconclusive`.

At room level 200 the same build's table reads:

| # | slot | item | at | per +1 | ±95% | |
|---|---|---|---|---|---|---|
| 1 | Feet | Pathseeker Boots ★ | +8 | +0.402 pp | 0.457 | within noise |
| 2 | Ring | Philosopher's Ring | +3 | +0.398 pp | 0.221 | **likely gain** |
| 4 | Trinket ⚠ | Expert Task Badge | +2 | +0.353 pp | 0.020 | **clear gain** |

— and at 260, where the build is failing, the weapon dominates everything else at
+1.93 pp per level. Which is the sensible reading: near the cliff, damage is the
constraint.

### Nothing is eaten in there

The game confiscates food, drinks and teas at the door; supply crates are the only
nutrition inside. The **server** strips them (`api/lib/target.js`), not the caller —
an unstripped API run would let the build eat its way through rooms the game would
not, and every row would be measured against a baseline the player cannot field. This
is the same correction the UI already applies to ordinary lab sims, and which the old
webpack UI does not, which is why its predicted clear rates are too high.

Consequently:

- Food and drink thresholds are **listed but not searchable**, with the reason beside
  them. Hiding them would invite the reader to assume they had been searched and found
  wanting; a user who set those values is owed the explanation.
- The whole consumable-cost apparatus is inert — `consumableCosts` is discarded for a
  labyrinth target, and the panel's price-source control hides itself, because
  `consumableParamCount` is necessarily zero.
- A **Guzzling Pouch will measure exactly zero**, since its enhancement raises drink
  concentration and there are no drinks. That is the right answer, arrived at by
  measurement rather than by a special case.

### Costing a level: not a pay-back, but a price per point

Break-even is `T = (C/3600) · E_old / (E_new − E_old)`, derived from `E` being a rate
**per hour**: spend `C` seconds, grind `T` hours, and `E_new·T / (T + C/3600)` overtakes
`E_old`. A clear rate is a proportion, so that arithmetic would produce a number
meaning nothing, and the Gear tab does **not** report a pay-back for a labyrinth run.

What it reports instead is the **enhancing time that buys one percentage point of clear
rate** — `(cost / 3600) ÷ gain per level`. That is the question a fixed enhancing budget
actually poses: not "when does this repay itself", but "which slot buys the most per
hour spent". Same decision, no false claim of repayment.

The two turn out to be the same function. Substituting `gain/base` into break-even
gives `(cost/3600) / relativeGain`, so a pay-back time *is* enhancing-hours-per-unit
with the **relative** gain as its denominator — which is why it comes out in hours of
combat. A bounded objective passes the **absolute** gain instead and gets hours per
percentage point. `shared/enhancementRoi.js` carries both, with the identity pinned in
a test so the two cannot drift into different conventions, since a caller swaps one for
the other on nothing but the target kind.

One earlier objection dissolved on inspection and is worth recording, because it nearly
cost the feature its cost column. The worry was that a labyrinth costing would rest on
an untested difference: the scan computes a confidence interval for the **objective
only**, so anything built on the `clearsPerHour` delta would be a precise-looking figure
resting on a quantity nobody tested. True — but the price per point divides by
`perLevel` on the clear rate, which *is* the objective and *is* the measured quantity.
The objection applies to the rate, not to the proportion.

Everything else in that panel is common to both targets: the cow webapp's Markov cost
solve, the marginal-cost subtraction, the mirror-versus-own-protection choice, and the
orange banner naming materials the production-time walker could not price — which
matters as much here as anywhere, since an unpriced material contributes zero and makes
every figure a lower bound.

### Smaller consequences

- **Enemy bounds** come from one room-scaled monster, not a spawn enumeration. The
  monster cache is keyed on `(hrid, tier, roomLevel)` — the same hrid at two room levels
  is two different creatures, and a cache that ignored the level would silently hand
  every room the level-100 ceilings.
- **`maxSpawnCount` is 1**, so every "2+ units active" threshold is unreachable in a
  labyrinth and is flagged as such by the existing `unreachable` machinery.
- **Noise is higher.** A clear rate is a proportion over a few dozen attempts per hour,
  not a count over hundreds of encounters. Measured CV was 13.5% at the 2-hour
  verification fidelity near the cliff, against 0.08–2.9% for zone encounters/hour at
  comparable durations. Budget more simulated hours here than a zone needs, and read the
  reported noise floor before believing a margin.
- **Lab-shop upgrades** ride inside the `labyrinth` object rather than on
  `extra.mwixLabUpgrades` + `extra.mwixMaze`, because on this path there is no maze
  toggle to gate them: asking for a labyrinth *is* the gate. The buff table itself moved
  to `api/lib/target.js`, and `labStats.js` now imports it — two copies of a mirror of
  `src/worker.js` was one too many to keep honest.
