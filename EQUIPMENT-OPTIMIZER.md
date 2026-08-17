# Equipment Optimisation — what one enhancement level is worth

Design notes for `api/lib/equipmentScan/` + `POST /api/optimize-equipment` + the
**Gear** mode in `ui/`. Sibling to `TRIGGER-OPTIMIZER.md`, and it reuses that
feature's worker pool, seeded RNG, scoring and consumable-cost economics wholesale.

The question is not "what is the best build" but **"where should my next
enhancement levels go"**. That difference decides nearly every design choice below.

---

## 1. A scan, not a search

The trigger optimiser narrows a candidate pool through a four-stage funnel because
it wants one winner. This wants the opposite: a **complete table**. A slot that
would screen out is still an answer — "your gloves are not worth enhancing" is
exactly as useful as "your necklace is" — so every candidate gets the same
fidelity and every candidate is reported.

Consequently there is no beam, no coarse/fine grid, no checkpoint, no resume. One
stage, run to completion. The funnel machinery would have had nothing to narrow.

---

## 2. The +6 probe, and what dividing by six assumes

A single +1 on one piece moves encounters/hour by far less than the Monte-Carlo
noise on any zone worth optimising for. Measuring it directly measures nothing. So
each slot is probed at **+6** and the measured gain divided by the step.

That assumes the response is locally linear in the enhancement multiplier. It is
not exactly, and the direction of the error is knowable. The multiplier table
(`enhancementLevelTotalBonusMultiplierTable`) is **convex**:

```
level:  0   1    2    3    4   5    6    7     8     9    10  …  20
mult:   0   1   2.1  3.3  4.6  6   7.5  9.1  10.8  12.6  14.5 …  50
```

Six levels from +0 buy 7.5 of multiplier where six single first levels would buy
6.0 — so the per-level figure is **optimistic by about 25%** there, and by ~19%
from +5. Rather than silently correcting for it, each row carries
`multiplierRatio`, the exact overstatement at its own level, and the results table
prints the leading row's. A reader who wants the pessimistic number can divide.

The step is clamped **per item**, not per run. An item at +17 is probed three
levels, and the row records the step actually used, because dividing that by the
requested six would halve its true worth. `MAX_ENHANCEMENT_LEVEL` is derived from
the multiplier table's length rather than hard-coded — and clamping is not a
nicety: the engine does not guard the lookup, so an over-cap level yields an
`undefined` multiplier, hence `NaN` stats, hence a simulation that neither throws
nor means anything.

---

## 3. Which slots are skipped, and why the predicate mirrors the engine

Three reasons, in increasing subtlety:

1. **Already at the cap.** There is no +21 to measure.
2. **No enhancement bonuses at all.** All eleven skilling-tool types and ~60 of
   the 102 charms are in this class. Simulating them would spend real time
   proving zero.
3. **Bonuses, but none on a stat the item actually carries.** This one falls out
   of `Equipment.getCombatStat`, which gates on the truthiness of the **base**
   stat before consulting the bonus:

   ```js
   if (this.gameItem.equipmentDetail.combatStats[combatStat]) {
       let enhancementBonus = ...combatEnhancementBonuses[combatStat] || 0;
   ```

   A bonus on a stat whose base is `0` or absent is dead weight *in the engine*.
   No bundled item is affected today, so this is latent rather than live — but
   `liveEnhancementStats` mirrors the engine's rule exactly rather than
   approximating it, so the two cannot drift apart.

Every skipped slot is reported with its reason, following the trigger panel's
`searchable`/`reason` convention. Silently hiding a slot invites the reader to
assume it was measured and found wanting.

### The one caveat the data cannot express

`taskDamage` is applied to **every** damage roll in the engine —
`combatUtilities.js` multiplies by `1 + source.combatDetails.combatStats.taskDamage`
with no test that the target is on the player's task list. In the game it applies
only to task monsters. So a task badge reads to the simulator as a flat global
damage multiplier, and on the first real run an Expert Task Badge duly came out
**ranked first**, ahead of the weapon.

`src/combatsimulator/` is upstream-tracked, so correcting it here would be a
divergence to re-resolve on every sync, for a question this feature is not the
right place to answer. The row is therefore measured and reported like any other
and carries a caveat saying what the number assumes — it is exactly right for a
player who is always on task. The caveat fires only when **every** stat an item
gains is a caveated one; a mixed item is measured fairly enough that a warning
would be noise.

---

## 4. The statistics, which are the point

Everything above is bookkeeping. The difficulty is that the quantity being
measured is small and the measurement is noisy, and a confidence interval that is
quietly wrong is worse than none at all — a reader cannot audit one by eye.

### Paired, not unpaired

Every candidate runs on the **same set of seeds** as the baseline, and the
statistic is the mean of the per-seed differences rather than the difference of
the means. The appeal of common random numbers is that they can only help: if the
two runs correlate, `var(d) < var(a) + var(b)` and the test gains power; if the
shared seed buys nothing, `var(d)` equals `var(a) + var(b)` and the test is exactly
the unpaired one. Validity never depends on the correlation, only power.

**Whether it correlates is an empirical question, and the answer here is no.** The
two builds share a seed and therefore the spawn sequence — until the stronger build
kills something a fraction faster, consumes a different number of draws, and the
streams slide out of step. Measured `pairingEfficiency` on a real run was **−0.8%**:
the pairing removed no variance whatever. So it is computed and reported rather
than assumed, and it stays in because it costs nothing and might pay on a quieter
build.

### Student-t, not normal

With six replicates the sample standard deviation is itself a poor estimate, and
1.96 standard errors is not a 95% interval — it is nearer 88%. `t(0.05, 5)` is
2.571. Using the normal quantile at these sample sizes would systematically
overstate confidence, which is precisely the failure this module exists to
prevent.

The quantile is **computed**, not looked up: the regularised incomplete beta by
continued fraction (Lentz), the CDF on top of it, the quantile by bisection. A
hard-coded 95% table would have been shorter and would have foreclosed the next
decision. It is pinned in the tests against published quantiles at df = 1, 2, 5,
10, 20, 30 and at three confidence levels.

### A family-wise flag beside the per-slot one

Fourteen slots tested at 95% confidence give, under a true null, about a **51%**
chance that at least one looks significant. Ranking then puts that accident at the
top — the one place a reader looks. So each row carries **both**:

| flag | claim |
|---|---|
| `significant` | this slot's gain differs from zero |
| `significantFamilywise` | it survives a Šidák correction for having asked all fourteen at once |

The headline — "spend your next levels here" — is a family-wise claim and is
flagged as such. The results table renders three verdicts rather than two:
*Clear gain* (family-wise), *Likely gain* (per-slot), *Within noise*.

### The detection floor

The table also reports the **median 95% margin per level** across slots: the
smallest gain this run could have resolved for a typical slot. Without it, "0.006%,
within noise" reads as a measurement when it is an absence of one.

---

## 5. Shape of a run

Replicates are the outer loop and candidates the inner, so every candidate meets
seed *N* before any candidate meets seed *N+1*. Statistically that is what makes
the comparison paired; practically, a batch is `candidates + 1` simulations, which
comfortably exceeds a worker pool, so the pool stays saturated and finishing a
batch is a natural monotone progress tick.

The baseline is re-run at **every** seed rather than once. It is both the reference
for the paired differences and, through its own spread, the noise measurement —
so unlike the trigger optimiser there is no separate calibration stage to pay for.

Defaults: **24 simulated hours × 6 replicates**. Fifteen candidates is then 90
simulations and 2,160 simulated hours, which on a 13-worker pool takes about
**15 seconds** of wall clock. Measured throughput is 0.010 worker-seconds per
simulated hour on `fly` and 0.046 on `chimerical_den`, so fidelity is not the
binding constraint here and the defaults are generous on purpose.

Failed simulations are dropped **pairwise**. Keeping the partner would compare a
candidate seed against a baseline from a different seed, discarding the only thing
the paired design is for.

---

## 6. What it reuses

Unchanged, by import: `triggerSearch/pool.js` (worker pool and job translation),
`poolWorker.js` (seeded RNG, scoring in the worker), `score.js`
(`scoreSimResult`, `computeDeltas`, `coefficientOfVariation`, `REPORTED_METRICS`,
`defaultObjective`), `shared/consumableCost.js`, and `buildExtraBuffs` from
`api/lib/simulator.js`. None of that machinery ever knew what a trigger was; the
job shape is `{ id, playersData, zoneConfig, extraBuffs, consumableCosts,
simulationTimeLimit, seed }` and enhancement levels ride inside the DTO.

The single edit to existing code is a `cancelMessage` option on
`makePoolEvaluator`, so a cancelled scan does not report itself as a cancelled
trigger optimisation.

The objective is the same one, for the same reason: **effective encounters per
hour** — encounters per hour of *total* time, combat plus the production owed for
every consumable burned — whenever production times are loaded, and raw throughput
otherwise. It matters more here than it looks. See §7.

---

## 7. What it found

`fly`, T0, a real ranged build, 6 × 24h, ranked on effective encounters/hour.
Baseline 610.44; run-to-run noise 0.039%; detection floor ±0.005%.

| # | slot | item | at | per +1 | ±95% | verdict |
|---|---|---|---|---|---|---|
| 1 | Neck | Philosopher's Necklace | +3 | **+0.183%** | 0.004% | clear gain |
| 2 | Head | Acrobatic Hood | +7 | +0.084% | 0.006% | clear gain |
| 3 | Feet | Pathfinder Boots ★ | +0 | +0.043% | 0.004% | clear gain |
| 4 | Trinket ⚠ | Expert Task Badge | +2 | +0.014% | 0.004% | clear gain |
| … | | | | | | |
| 13 | Charm | Advanced Ranged Charm | +0 | 0.000% | 0.000% | within noise |
| 14 | **Pouch** | **Guzzling Pouch** | +5 | **−0.020%** | 0.004% | **clear loss** |

Three of these are worth pausing on.

**The pouch is a clear loss.** Enhancing a Guzzling Pouch raises drink
concentration, so the build drinks more, so it owes more production time — and
`effectiveEncountersPerHour` charges it for that while raw throughput would not.
This is the same trap the trigger optimiser found with consumable thresholds,
arriving from the other direction, and it is precisely why the objective is
denominated in seconds on both sides. Under raw enc/h this row would have read as
a small gain.

**The charm is exactly zero, with a zero margin.** Its only enhancement bonus is
`rangedExperience`, which is an XP multiplier and does not touch throughput — so
every replicate returned bit-identical numbers. It is right to *scan* it rather
than skip it: the same row would move under an `experiencePerHour` objective. Note
its XP/h column is the highest in the table.

**Earrings and Ring report identical figures** (+0.008%, ±0.008%). Philosopher's
Earrings and Philosopher's Ring have byte-identical combat stats and enhancement
bonuses, so this is not a bug but a free check that the seeding is deterministic
and the pairing index-aligned.

These are `fly` numbers, where the build massively overpowers the content and the
whole table is under a fifth of a percent. On a zone that actually threatens the
build the spread is an order of magnitude wider — a 12h/4-replicate run on
`planet_of_the_eyes` put the leader at 1.33% per level against a 0.87% noise
coefficient.

---

## 8. Not done here: what the level COSTS

This feature answers what a level is *worth*, full stop. What it *costs* is a
question about the player's situation — their enhancing level, tool, teas,
observatory — and is answered separately. See §9.

---

## 9. Return on investment

The cow webapp already carries a complete enhancement simulator with an explicit
**iron-cow mode**, in which every cost it reports is denominated in **seconds** —
the same unit as the consumable economics and therefore commensurable with the
gains measured above.

- `GET  /api/enhance/character` — an `EnhancementConfig` auto-filled from the live
  character
- `POST /api/enhance/calculate` `{iron_cow: true, config, item_hrid, target}` — a
  Markov solution per protection level; `total_cost` is seconds, and `optimal_prot`
  is already picked

The Markov chain always starts at state 0, so the marginal cost of level *N→N+1*
is the difference `cost(N+1) − cost(N)`, each minimised over `protect_at` — or each
held at a **forced** `protect_at`, which is §10's *protect from +N*. The item's base
price appears once on each side and cancels cleanly. Measured on a Gobo Slasher: +5
costs 301.0s, +6 costs 505.8s, so that sixth level costs **204.8 seconds**.

With both sides in seconds the honest return is a **break-even time**. Spending
*C* seconds enhancing and then grinding *T* hours gives an overall rate of
`E_new · T / (T + C/3600)`, which beats `E_old` once

```
T  =  (C / 3600) · E_old / (E_new − E_old)
```

— the number of combat hours before the enhancement has repaid the time it cost.

The arithmetic lives in `shared/enhancementRoi.js`, beside `consumableCost.js` and
for the same two reasons: it is not the engine's business, and `ui/` has no test
runner, so a figure that tells someone to grind for nine hours should not be the
one part of the feature nothing covers. The fetching is client-side
(`ui/src/utils/enhancementCosts.js`), exactly where the consumable production
times already come from — the cow webapp is a personal local server holding one
player's character, and the csim API is a stateless simulator that should not
acquire a dependency on it.

One convention differs deliberately from its neighbour. `isKnownCost` in
`consumableCost.js` **admits zero**, because a user can truthfully say a food
reaches them free. `isUsableEnhancementCost` **rejects** it: here the number comes
from a recursive production-time walker that returns `0.0` for anything it cannot
resolve, so a zero is nearly always "unknown" wearing the costume of "free", and
honouring it would report an instant, infinite return on exactly the items we
understand least.

### Two changes it needed in the cow webapp

Both small, both in `cow/webapp/app.py`, and the UI degrades gracefully without
either — an uncostable row reports *why* rather than vanishing.

1. **CORS on `/api/enhance/*`.** `_cors` was applied to only the three endpoints
   csim already used. `/api/enhance/calculate` is a POST carrying
   `application/json`, which is not a CORS "simple request", so the browser sends
   a preflight `OPTIONS` that Flask answers automatically *without entering the
   view* — meaning a per-response wrapper can never run. An `after_request` hook
   scoped to the path prefix, advertising the method and header the preflight
   asks about, is the smallest thing that works.

2. **`target=1`.** The protection loop was `for prot in range(2, target + 1)`,
   empty at `target=1`, so the endpoint returned no rows for precisely the case a
   marginal cost needs: the first level on an item still at +0. `range(min(2,
   target), target + 1)` fixes it; the Markov solver already handles
   `protect_at=1` correctly, since `dest = i - 1 if i >= protect_at else 0`
   resolves to state 0 from state 0 either way.

### What it found

Same `fly` scan as §7, costed. **The ordering inverts.**

| by pay-back | slot | next | costs | buys | pays back after |
|---|---|---|---|---|---|
| 1 | Neck | +4 | 2 min | +0.183% | **17.8 h** |
| 2 | Feet | +1 | 62 s | +0.043% | **40.2 h** |
| 3 | Trinket ⚠ | +3 | 50 s | +0.014% | 4.2 days |
| 7 | Head | +8 | 59 min | +0.084% | 48.8 days |
| 10 | Main hand | +8 | 2.5 h | +0.014% | 762.9 days |
| 13 | Charm | +1 | 11 s | 0.000% | never |
| 14 | Pouch | +6 | 5.7 h | −0.020% | never |

The Acrobatic Hood is **second** by raw gain and **seventh** by pay-back: it buys
twice what the boots do and costs fifty-seven times as much, because +7→+8 sits far
enough up the enhancement curve to be ruinous while +0→+1 is nearly free. Ranking
by gain would have sent the player to the worst available investment. The Sundering
Crossbow is worse still — a 762-day pay-back — and the two "never" rows are the
zero-gain charm and the negative-gain pouch from §7.

### Caveat

A material the production-time walker cannot resolve prices at `0.0`, and that
zero is *inside* the Python sim, below the reach of `isUsableEnhancementCost`. So
a cost can be understated — never overstated — when an item's materials include
something with no acquisition route. A pay-back that looks too good is the shape
that failure takes.

---

## 10. The Costs tab, and why the pay-backs were fiction without it

§9 shipped a return-on-investment column built on the enhancement simulator's own
prices. Those prices have a hole in them, and the hole is invisible.

`/api/value/market` **omits** any item whose production time the walker cannot
resolve — a drop-only material, an item with no recipe. `full_item_price` then
returns `0.0` for it. Nothing anywhere says so. On a real build, thirty of the
thirty-three items the costs depend on came back with no time at all:

| material | needed by | iron value |
|---|---|---|
| `sinister_essence` (10 per attempt) | Acrobatic Hood | absent |
| `star_fragment` (500 per attempt) | Philosopher's Necklace | absent |
| `chaotic_chain` | Chaotic Flail (protection) | absent |
| `acrobats_ribbon` | Acrobatic Hood (protection) | absent |

The 17.8-hour necklace pay-back in §9 was five hundred star fragments priced at
nothing. **The figure was not approximate; it was arbitrary.**

### The fix: one override map, applied at the source

`consumableCostOverrides` becomes `itemCostOverrides` — same shape, same rules,
any item — and is applied **inside `usePrices`**, laying the user's times over the
fetched map before anyone reads it. That is what makes one edited number reach
consumable costs, enhancement costs and drop valuation at once, without every
reader having to know the override map exists. `fetchedPrices` stays beside it,
untouched, because the editor has to show what was fetched *and* what you said
instead; resolving `fetched` from the merged map would report your own number back
as though the server had said it. The old key is migrated on load.

The guard on the merge is load-bearing: overrides are **seconds**, and the market
source is **coins**. Laying one over the other would produce a number that is
neither, so the merge is skipped unless `unit === 'seconds'`.

### Posting them to the enhancement API

The endpoint already accepted everything needed; nothing on the Python side had to
change. `describeEnhancementInputs` resolves each input through the same
override-aware path the consumables use, and `fetchTargetCost` posts:

- `material_unit_costs` — **positional**, zipped by the server against the non-coin
  entries of `enhancementCosts`, so the filter here must match its filter exactly
- `protect_price` / `protect_hrid` — see **Protects: how they are priced** below.
  Posted even when unpriced, as 0, the same treatment the materials get; omitting
  it would hand the choice back to the server's own search.
- `base_price: 0`, always — `total_cost` is base + materials + attempts, and the
  acquisition price is sunk for a piece already worn. Zeroing it makes the marginal
  cost of the *first* level simply `cost(1)`, with no subtraction to get wrong, and
  leaves every other level's difference exactly as it was.

### Flagging what is still missing

An unpriced material contributes zero, so every pay-back is a **floor, never a
ceiling**. Each costed row carries the list of inputs it could not price; the panel
deduplicates them across rows and names them in an orange banner, because one
absent essence typically poisons half the table.

### What it found

Same `fly` scan as §7 and §9. Setting **one** value — Sinister Essence to 900s —

| | Acrobatic Hood, +7 → +8 |
|---|---|
| before | **59 min** → 48.8 days to pay back |
| after | **331.2 h** → 16,394.9 days to pay back |

A factor of **337**, from a single number. The ordering changed too: the Pathfinder
Boots' first level (13 s, 8.4 h) overtook the necklace, because +0 → +1 is nearly
free and the necklace's five hundred star fragments are *still* priced at nothing.

The Costs tab therefore opens on the items this build depends on, **unpriced
first**, with the gear that needs each one named beneath it — and a search box
below for anything else. A search box alone would have been useless: the whole
difficulty is that the items costing nothing are exactly the ones nothing ever
names.

### Protects: how they are priced

A three-way control on the Gear tab, beside **Cost these levels**, defaulting to
**Mirror**. It decides which protection item an enhancement is costed against,
and the default is a judgement about *data* rather than about play.

An item's own protection — a Chaotic Chain, an Acrobat's Ribbon — is drop-only.
It is therefore absent from the production-time map and unpriceable until the
player types a number for **every one of them**, piece by piece. A Philosopher's
Mirror is craftable, works on any piece, and needs pricing exactly **once**. So
**Mirror** collapses a dozen unanswerable questions into one answerable one, and
defaulting to **Cheapest** would mean the pay-back column read zero for most
protections until a dozen drop-only items had been hand-costed — a poor first
impression of a number that is supposed to be trustworthy.

The choice lives in one place, `chooseProtection` in `shared/enhancementRoi.js`,
where the api tests can reach it. Three rules, all load-bearing:

1. **`mirror` is honoured even when the mirror itself has no price.** The
   alternative — quietly falling back to the cheapest of the others — would mean a
   mode labelled *always a mirror* sometimes did something else, in precisely the
   case a user is most likely to hit on a fresh install. A cost of zero the caller
   is told about is better than a silent substitution.
2. **`cheapest` takes the cheapest *priced* candidate.** An unpriced one must not
   win by default, and that is not hypothetical: the server's own selection reads
   `if pc and pc < cheapest`, where a zero is falsy and so skipped, leaving it to
   fall back to the mirror without saying so.
3. **`free` returns the mirror at zero, marked `assumedFree`.** The arithmetic is
   identical to an unpriced mirror; the marker is the whole difference. An unpriced
   input is a hole in the data and makes every figure a lower bound, so it belongs
   in the orange banner; a free one is a *claim the player made about their own
   stash*, as trustworthy as anything else they typed, and putting it in that
   banner would be calling them unreliable about their own inventory.

The Costs tab lists exactly what the Gear tab will **read**, and no more. Under
`cheapest` that is everything the chooser might pick; under `mirror`, one item;
under `free`, no protection at all. The omission **is** the simplification — on a
real build, moving from `cheapest` to `mirror` took the tab from 33 items and 30
unpriced to **24 and 20**, nine drop-only protections collapsing into one Mirror
row that names every piece using it. Asking for a price nothing consults is worse
than asking for nothing: it buries the two boxes that would change a number.

Measured on the same build, Acrobatic Hood +7 → +8, with the Ribbon hand-priced at
25,000 s:

| | cost | pay-back |
|---|---|---|
| **Cheapest** (priced → the Ribbon) | 331.2 h | 16,394.9 days |
| **Mirror** (still unpriced here) | 174.4 h | 8,632.2 days |

### Protects: where they start, and how many

Pricing a protect is only half of the question. The other half is **where
protecting begins**, and until now the answer was always "wherever the Markov
solver liked best" — `fetchTargetCost` took the cheapest of the response's rows.

While a protect has a *price*, that minimum answers a real question: cost and
count trade against each other and the solver balances them. Once a protect is
**free** the trade collapses. Protecting from the earliest level the chain allows
is then unbeatable, and the answer it gives is a fantasy — measured on the
Acrobatic Hood, free protects and a free hand put the solver at `protect_at = 2`,
where taking one hood from +0 to +8 spends **59.3 mirrors**, and to +13, **1,472**.
Nobody has 1,472 mirrors. *Free but finite* is the real situation, and a forced level is
how a finite stack is expressed. Hence the **protect from +N** input, offered by
the `free` mode alone; `forcedProtectLevel` owns that coupling and explains it.

`pickProtectionRow` then takes the row matching the policy instead of the cheapest,
and **clamps** the level into the range the response offers. The clamp is not a
fudge but an identity. Attempts run from states 0 … *target*−1 and the Markov step
is `dest = i - 1 if i >= protect_at else 0`, so the top row — `protect_at` equal to
the target — has no state that protects and therefore **is** "never protect".
Forcing +7 on a programme that stops at +5 means exactly that: no attempt in it
ever reaches the level where a mirror would be spent. Which is also what keeps the
marginal cost positive: both sides of `cost(N+1) − cost(N)` are held at one policy,
and reaching a higher level under a policy cannot be cheaper than reaching a lower.

Alongside it, a **Protects** column: the expected number of protection items the
level consumes, by the same difference-of-programmes argument as the cost. It is
the number that says whether *free* is a fair assumption or a comfortable fiction,
and nothing else on the panel would ever say so.

Measured on the Acrobatic Hood, protects free throughout:

| next level | solver's choice | protects | forced from +7 | protects |
|---|---|---|---|---|
| +4 | 0.16 h (`prot@2`) | 2.8 | 0.31 h (`prot@4`, clamped) | **0** |
| +7 | 0.64 h (`prot@2`) | 15.2 | 4.79 h (`prot@7`) | **0** |
| +8 | 1.10 h (`prot@2`) | 27.1 | 8.04 h (`prot@7`) | **1.65** |
| +13 | 29.75 h (`prot@2`) | 757.4 | 209.45 h (`prot@7`) | **99.4** |

Seven times the cost for the eighth level, and the reason is legible in the last
column: the cheap figure was never available to anyone whose mirrors are counted.
Note also that a forced level *below* the next one costs **nothing in protects**
and more in time — which is correct, and is the clamp doing its work.

One consequence worth knowing: changing either control does **not** refetch. Thirty
requests to a personal Flask server should be asked for rather than triggered by a
click, so the panel instead marks the table *settings changed — refetch* when the
policy on screen no longer matches the one the figures were costed under. Showing
yesterday's numbers under today's settings and saying nothing was the alternative,
and it is the sort of quiet wrongness this document exists to prevent.

---

## 11. Scanning a labyrinth room

The scan now takes **either** a zone or a labyrinth room. The machinery is unchanged —
the +6 probe, the paired design, the Student-t interval, the Šidák family-wise
correction and the detection floor are all indifferent to what is being fought — but
the objective is not a rate, and that changes two things in this document.

The full account of the target abstraction, the saturation behaviour, the stripped
consumables and the measured clear-rate curve lives in **TRIGGER-OPTIMIZER.md §11**,
since both features share it. What follows is what a *gear* scan in particular needs to
know.

### The verdict columns now read in percentage points

A labyrinth scan ranks on **completion chance** (`clearRatePercent`), so `perLevel` is
in percentage points of clear rate rather than in encounters per hour. `perLevelPct`
remains the relative figure — the gain as a fraction of the baseline clear rate — and
is still what the table sorts on, so a slot worth +0.4 pp on a 97% baseline and one
worth +0.4 pp on a 20% baseline are correctly not treated as equals.

### §9 changes its unit, and §8 stands unchanged

§8's division of labour survives intact: this feature says what a level is *worth*, and
what it *costs* is a separate question answered against the cow webapp. §9's machinery
survives too — the Markov solve, the marginal-cost subtraction, the mirror choice, the
unpriced-materials banner. What changes is the final division.

A pay-back time needs a rate per hour on both sides, and a completion chance is a
proportion. So the last column becomes the **enhancing time that buys one percentage
point of clear rate**:

```
hours per point  =  (cost / 3600)  ÷  gain per level
```

Not a repayment horizon, and not presented as one — but the same decision, since what a
player allocating enhancing hours wants to know is which slot returns the most per hour
spent. §9's central finding transfers verbatim: the Acrobatic Hood was second by raw
gain and seventh by pay-back, because +7 → +8 sits far enough up the enhancement curve
to be ruinous while +0 → +1 is nearly free. Ranking by gain alone still sends the player
to the worst available purchase, whichever fight they are in.

Two presentational details follow from the arithmetic. The **Buys** column shows
percentage points for a labyrinth run and a relative percentage for a zone, because
those are the respective denominators — showing the relative gain beside a per-point
cost would invite the reader to divide two numbers that do not correspond. And the
warning about gains being raw encounters while costs are seconds is suppressed: in a
labyrinth the two sides are *meant* to be different units, and their ratio is the point.

### What §7's caveats become

- **The pouch trap inverts into a triviality.** §7's headline oddity was a Guzzling
  Pouch measuring as a *clear loss* because enhancing it made the build drink more and
  owe more production time. In a labyrinth there are no drinks at all, so the same row
  measures exactly zero. The mechanism that produced the interesting answer is simply
  absent — which is worth knowing before reading a zero as a surprise.
- **The `taskDamage` caveat is unchanged and, if anything, louder.** `combatUtilities`
  applies it to every damage roll regardless of task, and on a real room-level-200 scan
  the Expert Task Badge came out **fourth by gain with the tightest interval in the
  table** (+0.353 pp per level, ±0.020). Same engine behaviour, same caveat, same
  reading: exactly right for a player who is always on task.
- **Skip reasons are unchanged.** The three classes in §3 — at the cap, no enhancement
  bonuses, bonuses on stats the item does not carry — are properties of the item, not of
  the fight.

### Fidelity

Budget more than the zone defaults. A clear rate is a proportion over a few dozen room
attempts per hour, where a zone's encounter count is in the hundreds; measured
run-to-run CV near the failure cliff was an order of magnitude worse than a hard zone's.
The scan reports its own noise floor and detection floor as it always has — read them
before believing a margin, and if the verdict column is a wall of *within noise*, check
first whether the run saturated rather than reaching for more replicates.
