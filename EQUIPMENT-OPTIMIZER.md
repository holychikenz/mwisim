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
is the difference `cost(N+1) − cost(N)`, each minimised over `protect_at`. The
item's base price appears once on each side and cancels cleanly. Measured on a
Gobo Slasher: +5 costs 301.0s, +6 costs 505.8s, so that sixth level costs
**204.8 seconds**.

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
