# Closing the performance gap

**Revision 7, 2026-09-21.** Revision 6 recorded the round that acted hardest on
per-UNIT cost. This revision records three more stages, each one aimed at the
largest item a fresh profile left on the board, and the first round in which
every one of the three beat its own forecast.

**Three stages shipped, compounding to -17.9% on the candle's geometric mean**
over four counterbalanced rounds against `1492a74` — buff mirror -6.1%, heap
removal -8.7%, condition ordinal -4.2%. **Every dungeon fell by about a third**:
`dungeon-den-600` 73.4 -> 50.9 ms/sim-h (-30.6%), `dungeon-den-200` and
`dungeon-circus` -31.9%, `dungeon-fort-t2` -31.3%, `dungeon-pirate` -29.8%.
21 of 22 cases improved and won every round in the cumulative run; the 22nd,
`floor-solo`, came back -4.9% at 5/6 on a focused six-round re-measurement, so
all 22 improved.

Nothing was dropped this round, which has not happened before and is worth
naming rather than celebrating: three for three is a small sample, and the
selection was unusually well informed — every stage was pointed at a number a
profile had already measured rather than at a structure that looked wasteful.

*Note on absolute figures.* The ms/sim-h numbers in this revision were taken on
a faster machine than revision 6's and are NOT comparable with them. Only the
percentages are. Revision 6's `dungeon-den-600` at 94.5 ms/sim-h and this
revision's 73.4 for the same commit are the same engine, measured twice.

Revision 1's proposals (`Float64Array` stat blocks, event-object pooling) remain
rejected with evidence in §6 — but the `Float64Array` entry now has a NUMBER
against it rather than an argument, and the number says the rejection was right
for a reason nobody had stated. Do not re-propose them.

## 0. The measurement that had never been taken

On node 26.8.2, a keyed property store costs **about 21.5 ns** as soon as the
loop touches more than one name. V8's keyed inline cache goes megamorphic at the
SECOND distinct key and the cost is flat per access thereafter — measured at 1,
2, 4, 8, 16, 32 and 63 keys, the per-key cost sits between 20.7 and 23.9 ns
throughout. The same store written as a named field costs **0.35 ns**.

```
  obj[nameString] = v      21.5 ns      obj.stabAccuracy = v      0.35 ns
```

The engine was performing **844 458 such accesses per simulated dungeon hour**
in two loops — player.js's 70-name equipment copy and monster.js's 63-name
zero-fill — or 18.2 ms of a 132 ms hour. Compiling them into straight-line field
code is the same work, the same values, the same order, for 0.3 ms.

Three consequences worth carrying forward:

- **The gain is at DYNAMIC-key sites only.** Interning an hrid into an ordinal —
  the thing `generated/buffTypes.js` already did — is worth 11.7 ns to 7.1 ns,
  a factor of 1.6. Compiling a keyed STAT access is worth a factor of 61. The
  phrase "indexed lookup" points at the smaller of the two.
- **A megamorphic SOURCE defeats a compiled loop.** Compiling monster.js's
  zero-fill alone recovered only a third of its cost, because the game-data
  blocks it reads come in ~95 distinct shapes. Normalising the block once, per
  block, took it from 3844 ns to 43.6 ns. Ask where the megamorphic reads went,
  not just where the megamorphic writes went.
- **Ask what a stage moves cost TO.** Hoisting a string concatenation out of
  trigger evaluation paid -4.0% and cost `floor-party` +1.2%, because that case
  spawns many monsters into cheap fights and the concatenation had simply moved
  from evaluation to construction. A build-time table fixed it. Neither the
  profile nor the candle would have found this without the per-case table.

---

## 1. The reframing: our problem is per-unit cost, not per-encounter cost

Measured today, 22 cases, both engines interleaved. The reference figures live
outside this repository with the harness that produces them (see
`api/bench/README.md` for why).

> **STALE AS OF REVISION 6 — DO NOT QUOTE THESE RATIOS.** Every figure in this
> section predates the compiled-stat round, which took the csim column down
> -23.3% on the geometric mean without the reference column being re-measured at
> all. The ratios below are therefore all too high by roughly a factor of 1.3,
> and the per-unit arithmetic that follows is correspondingly overstated. The
> ANALYSIS stands — per-unit cost is still the term that matters, and the
> compiled-stat round was aimed at it and moved every dungeon — but the numbers
> need a fresh interleaved run against the reference harness before anyone
> repeats them. Left in place, rather than deleted, because the reasoning in
> this section is what directed the round.

| | round 1 | before today | now |
|---|---|---|---|
| cheapest case | 1.6× | 1.4× | **1.4×** |
| solo, geared | 3.3–5.3× | 3.2–5.1× | **2.7–4.6×** |
| 3-player party | 4.1× | 3.8× | **3.3×** |
| 5-player dungeon | 5.5–7.1× | 5.2–6.7× | **4.9–6.3×** |
| geometric mean | 3.85× | 3.70× | **3.30×** |

That table has been the scoreboard since round 1 and it has been quietly
misleading us. Convert it to cost per ENCOUNTER and hold the zone fixed while
varying only party size — the candle has exactly one such pair:

| | csim µs/enc | reference | ratio |
|---|---|---|---|
| `melee-swarm` (aqua_planet, **1** player) | 32.8 | 12.3 | 2.67× |
| `party3-swarm` (aqua_planet, **3** players) | 73.2 | 17.5 | 4.17× |

Fit a line through the two points:

```
                fixed cost/enc    marginal cost per extra unit
  csim              12.7 µs                 20.2 µs
  reference          9.7 µs                  2.6 µs
                    ──────                  ──────
  ratio              1.31×                   7.70×
```

**The framing was then tested, and it held.** Two stages aimed squarely at
per-unit cost moved that second column for the first time in the project:

```
                fixed cost/enc    marginal cost per extra unit
  csim              14.5 µs                 17.8 µs
  reference          9.7 µs                  3.0 µs
                    ──────                  ──────
  ratio              1.50×                   5.86×     (was 7.70×)
```

Note the fixed column went the WRONG way (1.31× → 1.50×) while the total gap
improved. That is the trade being made, and it is the right one: the fixed
term is multiplied once per encounter and the marginal term five times over in
a dungeon.

### The encounter-rate control, and a correction to the arithmetic above

The `enc/h` column shows this engine simulating **2.6–7.4% FEWER encounters per
simulated hour** than the reference in the party and dungeon cases. Earlier
revisions filed that under "our combat-mechanics delta, out of scope", which
implied it was ours to close. **It is not. This engine matches the live game.
Where the reference's encounter rate differs, the reference is wrong.**

That has a consequence for the per-ENCOUNTER arithmetic above, and it cuts
against the number we quoted. Dividing by encounters credits the reference with
encounters that are cheap partly because they are wrongly SHORT — a fight that
ends early has fewer events in it. Correcting `party3-swarm`'s reference figure
by its own 7.4% excess moves the marginal-cost-per-unit ratio from **5.86× to
roughly 4.8×**. Still several times ours, so nothing about the strategy
changes; but 5.86× is an overestimate and should not be quoted as it stands.

It also retires a claim revisions 3 and 4 made in the other direction — that
"the per-encounter gap is worse than the per-hour gap, so the ratio flatters
us". That reading was wrong. **Milliseconds per SIMULATED HOUR is the robust
metric and stays the headline:** a simulated hour is the same quantity of
simulated combat in either engine, however it happens to be divided into
encounters. Use per-encounter figures only to compare a case against ITSELF
across party sizes, and say out loud that the reference column is contaminated
when you do.

**Our fixed per-encounter cost is within 30% of the reference. Our cost per
additional unit is roughly eight times theirs.** The dungeons are not a
different problem; they are that multiplier applied five times over.

*Caveat, stated so nobody over-reads it:* `aqua_planet` is the only pair in the
candle that varies party size with everything else held constant. This is one
controlled observation, not a curve. The monotone ordering across all 22 cases
(solos 1.4–5.0×, two- and three-player 3.5–4.2×, five-player dungeons 5.5–6.8×)
is consistent with it but confounded, since the dungeons also have waves.

### The rule this gives us, and it is the useful part

**Before measuring a candidate, ask whether its cost scales with unit count.**
A change that removes fixed per-encounter or per-pass work cannot move a
dungeon, however large it looks in a profile.

This is retrospectively why §5a paid `starter-solo` −5.3% and `dungeon-den-600`
nothing: it removed two array allocations per trigger PASS, a cost independent
of roster size. The profile did not mislead us. We optimised the wrong term.

## 2. What shipped

| stage | result |
|---|---|
| unconditional recompute in `removeExpiredBuffs` | −20% to −32% everywhere |
| `Monster.updateCombatDetails` flat stat copy | up to −15.8% |
| buff-type ordinal table (generated) | enabling work for the next row |
| buff boost index keyed by ordinal | dungeons −7.6% to −10.8% overall |
| integer `typeId` + closure-free queue scans | small, consistent on deep queues |
| synchronous `processEvent` | `floor-solo` −6.5%, `mid-solo` −4.9%; a wash on heavy cases |
| allocation-free trigger fixpoint and ability scan | `starter-solo` −5.3%, `floor-party` −4.2%; **nothing on the dungeons** |
| per-unit pending-action count (retires a heap scan) | **every dungeon −3.7% to −8.9%**, `mid-solo` −20.1%, 11 of 22 won every round |
| batched multi-buff ability effects | `selfbuff-solo` −17.4%, `tank-solo` −9.8%, dungeons −4.3% to −7.7% |
| `abilityHaste`/`tenacity` declared — one hidden class per unit | too small to measure alone; folded into the row below |
| **compiled stat-block copies** (generated) | **all 22 cases, all winning every round; geometric mean −16.8%** |
| trigger constants hoisted + generated condition index | 20 of 22, geometric mean −6.0%; `dungeon-den-200` −10.6% |
| normalised monster stat blocks (generated) | 20 of 22, none lost every round, geometric mean −1.9% |
| insertion-ordered buff mirror | 19 of 22, geometric mean −6.1%; dungeons −9.4% to −14.7% |
| linear-scan heap removal | 21 of 22, geometric mean −8.7%; dungeons −13.5% to −16.0% |
| condition-kind ordinal (generated) | 21 of 22, geometric mean −4.2%; dungeons −4.9% to −9.7% |

Cumulative for those two, four counterbalanced rounds at `--reps=5`: **18 of 22
medians improved, 14 won every round, none lost every round.** Every dungeon
moved, 6.4–9.4%.

## 3. What was dropped, and why that matters

Four ideas were measured and thrown away; the `upstream-update.sh` ledger has
them in full.

- **Trigger derived-key precompute.** Correct, `sim:check` 3/3, and four
  interleaved rounds could not separate it from noise.
- **Single-compaction heapify.** Failed the parity gate: 2 of 3 fixtures
  drifted, ability casts landing in a different order. The array one compaction
  produces is not the array N successive removals produce. This is why
  `clearMatching`'s collect-then-remove shape is load-bearing.
- **Integer dispatch in `processEvent`.** Correct, medians straddle zero. V8
  already lowers a string switch to pointer compares.
- **Cached `_nextBuffExpiry` early-out.** Dropped in an earlier round as noise.

A stage that cannot be separated from noise costs review effort and
upstream-merge friction forever in exchange for nothing. Dropping it is the
result, not a failure to find one.

**Revision 7 dropped nothing, and one of its three stages was expected to be a
drop.** The condition-kind ordinal was sized at "about 3%" in §6a and flagged as
close enough to the noise floor that reverting it would be the legitimate
outcome. It measured -4.2% on the geometric mean, 21 of 22 cases improved, none
lost every round — well clear. Recorded because the §6a estimate was the honest
one at the time and was simply low, and because "expected to be noise" is not a
reason to skip the measurement.

That result also does NOT overturn the `processEvent` integer-dispatch drop
above, and the difference is worth keeping. That switch had 19 arms over strings
V8 interns and lowers to pointer compares, which are already integer compares.
`getDependencyValue` had 55 labels in source order, so a condition late in the
list was tested against dozens of pointers per evaluation, where nine dense
small integers are a table V8 can build. **Chain length, not the compare.**

## 4. How to measure, or you will ship an artefact

**Interleaving rounds is not enough. The order WITHIN a round must alternate.**

The synchronous-`processEvent` change first measured as a consistent REGRESSION
— `melee-solo` +6.1%, `dungeon-den-600` +1.6%, losing in all three rounds. It
was an artefact. Every round ran the baseline first and the change second, and
this machine warms within a round. Counterbalancing (ABBA over four rounds)
inverted both to small wins. Every A/B on this branch predating that correction
carries the same bias; treat their magnitudes as soft.

**Run one benchmark at a time.** A later investigation had two processes
benchmarking this worktree concurrently, and one of them had instrumentation
live in `eventQueue.js` for part of the window. Every absolute millisecond
figure from that window is contaminated. Counter deltas and `sim:check` results
survive it; timings do not.

**Comments cost performance.** V8's inlining budget is measured in SOURCE
CHARACTERS, comments included. A note added inside three warm methods, plus
four comment lines inside `addNextAttackEvent`, cost `starter-solo` +3.7% over
six counterbalanced rounds — on a case that executed none of the changed code.
Hoisting the identical text out of the function bodies took it to −1.3%. Put
long explanations ABOVE the method, not inside it. This is also a warning
about attributing a measured delta to the change you *meant* to make.

The rest is unchanged and still binding:

- Every stage passes `npm run sim:check` **3/3 bit-identical**. Re-recording
  fixtures to make a stage pass is forbidden.
- A stage that regresses any candle case is reverted, not tuned — **after** the
  regression survives a counterbalanced re-measurement.
- Run the WHOLE candle before believing a stage. The eager-allocation
  regression in the buff-ordinal work (`starter-solo` +24%) reproduced only in
  a full run.

## 5. What the reference actually does differently — and mostly, it does not

A second architecture read was done against the reference kernel, aimed at
cooldowns, buff application and the dungeon cases. **The dominant result is
negative, and it is worth more than the positives.**

### 5a. Cooldowns: there is no gap. We already do what it does.

The reference decides readiness by an INLINE POLL —
`scaled_cooldown + last_used > now`, recomputed from raw inputs, per ability,
per living unit, on every event, with no cache and therefore no invalidation.
A unit that wants to act and cannot **pushes nothing**: that function contains
no floating-point stores at all and cannot construct an event. What it does
push, once per SUCCESSFUL use, is a single payload-free wake-up at exactly the
ready instant, whose dispatch arm is empty — it advances the clock so the
unconditional act scan runs. It is never cancelled.

Ours is the same design, independently arrived at: `cooldownReady` is 2.07% of
dispatched events, its handler an empty case marked "Only used to check
triggers", and `Ability.shouldTrigger` polls `lastUsed + cooldownDuration`.

- [x] **Nothing to do here.** Recorded so it is not re-investigated.
- [ ] One divergence, and it is dead code: `awaitCooldownEvent` is **0 created,
      0 dispatched, 0 cancelled** over five simulated hours — mechanically
      unreachable, not merely rare. Its guard `isOutOfMana` is set in exactly
      one place, when a BLINDED unit fails to queue an ability and parks itself
      with an empty queue; the three `// when oom check ability trigger`
      comments are wrong. Delete for honesty. Expect no speed.

### 5b. Buff application: the same algorithm, at a twentieth of the cost

The reference's ability-cast effect loop is, per effect: apply the buff, consult
a changed-flag, and on change run a FULL stat recompute, then push one expiry
event. That is our `processAbilityBuffEffect` transliterated. **It does not
batch.** A three-buff ability costs it three recomputes and three pushes,
exactly as it costs us.

So there is no structural advantage to copy here. Its advantage is constant
factor, which is the same answer the first read reached about party work. Treat
that as the general finding rather than a coincidence.

Two things still worth doing, with honest labels:

- [x] **Batch our multi-buff effects.** DONE, and it beat its own forecast.
      Predicted to pay the buff-heavy solo cases and "little on the dungeons";
      it paid `selfbuff-solo` −17.4% AND every dungeon −4.3% to −7.7%. The
      `allAllies` branch is deliberately not batched — its special-ability
      multiplier reads `source.combatDetails` inside the per-buff loop, so
      batching changes later buffs' magnitudes when the caster buffs itself.
      That stays open to anyone who first proves no self-targeted `allAllies`
      special ability multiplies against a level stat.
- [x] **Skip the recompute prologue when only buffs changed. REJECTED —
      PROVEN UNSAFE, see §6.** This looked like the largest item on the board
      (12.3% of dungeon self time, per-unit) and it is not available.

### 5c. The one real structural difference, and it is ours to fix

```
addNextAttackEvent()                          combatSimulator.js:1094
    if (this.eventQueue.getMatchingEitherTypeAndSource(
            AbilityCastEndEvent.type, AutoAttackEvent.type, source)) return;
```

10 249 calls per simulated hour, each a full linear walk of the heap:
**56.5% of every heap entry the queue touches** on `dungeon-den-600` (81.8% on
`floor-solo`). More units means more calls AND a longer heap — quadratic in
party size, which is §1's term exactly.

**The reference never asks its queue this question.** It stamps `last_used` at
cast START, so "mid-cast" and "on cooldown" are the same scalar on the ability
record. We split them: the cooldown lives on `ability.lastUsed`, but "already
has an action pending" is delegated to a heap scan.

The copyable thing is the principle, not a mechanism: **state that belongs to a
unit lives on the unit, not in the event queue.**

- [x] DONE. The count lives on the UNIT, not in a `Map` in the queue — a
      `Map` was measured first and lost the cheap cases in every round, because
      a 3.9-entry heap is cheaper to scan than two `Map` operations are to
      perform. Every dungeon improved 3.7–8.9%; `mid-solo` −20.1%. The first
      stage in this project to move every dungeon, and the first aimed at
      per-unit cost. Covered by a differential test in
      `api/tests/pendingAction.test.mjs` — 4 000 randomised mutations checked
      against the scanning form after every one — which was mutation-verified
      against four deliberate breakages before being trusted.

### 5d. The "pure waste" that was not waste

All four items investigated. **Two were not bugs at all and one could not be
measured.** Recorded so nobody "fixes" them again.

- [x] `enrageTick` cleared and re-added 530 times an hour, never dispatched —
      **correct.** `ENRAGE_TICK_INTERVAL` is 60 s and a `dungeon-den-600`
      encounter lasts under 7 s.
- [x] `curseExpiration` created 1 798 times an hour, dispatched none —
      **correct.** Curse is refreshed on every hit inside its 15 s window.
      "Created and never dispatched" is what a refresh-on-hit debuff looks like
      in a fight that ends first.
- [x] The buff-refresh double scan — fused into one walk, correct and
      `sim:check` 3/3, then **reverted on the noise rule**: two counterbalanced
      measurements contradicted each other, a full candle giving
      `dungeon-fort-t2` −1.0% and a focused six-round run giving +2.8% losing
      all six rounds. See §6.
- [x] `awaitCooldownEvent` — 0 created in five simulated hours, and its guard
      `isOutOfMana` means "blinded and parked with an empty queue", not out of
      mana. The three comments that said otherwise are corrected. **Not
      deleted:** a zone with a `blindChance` ability does reach it, and no
      fixture covers one.

## 6. Rejected, with evidence — do not re-propose

- **Event object pooling.** GC is 1.2–1.5% of self time. Pooling can recover at
  most that, in exchange for use-after-free bugs that produce wrong numbers with
  no error. Note also that the reference is not allocation-free either.
- **`Float64Array` flat state.** In JS an element read costs a load *plus a
  bounds check*, where a monomorphic object field costs one load once the
  inline cache is warm. Take the *idea* — dense integer indexing — which is what
  the ordinal table already did.
  **Revision 6 puts a number on this and the rejection stands, comfortably.**
  A typed-array copy of a 63-field stat block measured 13.9 ns against
  straight-line generated field code's 21.6 ns — within a factor of 2, where the
  keyed loop both replace costs 1437 ns. The object model keeps essentially all
  of the available win, so there is no reason to pay the bounds checks, the
  parallel-view bookkeeping, or the break with every external consumer that
  reads `combatDetails.combatStats.x` — `api/lib`, `ui/src` and `simResult`
  among them. Generate the ACCESS, not a new representation.
- **Incremental add/remove of buff sums.** Float subtraction is not the inverse
  of float addition, so maintaining a running total cannot be bit-identical.
  Viable only behind an opt-in "fast, not bit-exact" mode, which is a different
  project.
- **Events stored by value.** Swapping JS object references is already strictly
  better than copying 232-byte records.
- **One giant inlined `processEvent`.** A 2000-line JS function would exceed
  TurboFan's inlining budget and deoptimise.
- **Swapping in an LCG for `Math.random()`.** Ceiling under 0.1 ms/h, and it
  invalidates `sim:check` and every recorded baseline by construction.
- **Source-to-source rewriting.** This codebase indexes stats dynamically
  (`combatStats[style + "Accuracy"]`), so a transform cannot see every access.
- **Skipping the `Player`/`Monster` recompute prologue when only buffs
  changed.** The prologue looks like dead weight — a 76-stat copy from a cache
  and a flat game-data block, both pure functions of data immutable for the run.
  **It is not a redundant copy. It is the RESET that makes the shared suffix
  correct.** `CombatUnit.updateCombatDetails` mutates `combatStats` IN PLACE
  with `+=` throughout — amplifies, crit rate and damage, life steal, thorns,
  threat, tenacity, drop rate, cast speed, the player's regen — adding each
  buff's contribution ONTO the base, and `Monster` does
  `armor *= labyrinthScaleFactor` after its copy. Skip the reset and every
  recompute compounds the last one's boosts, at ~0.9 recomputes per event.
  Tried: 2 of 3 fixtures drifted immediately. A safe variant would have to
  restore only the fields the suffix clobbers, which means auditing every `+=`
  in a 270-line method, where getting it wrong is a wrong combat number with no
  error.
- **Fusing the six buff-refresh `get` + `clear` pairs into one walk.** Correct,
  strictly less work, `sim:check` 3/3, and the pair was 25.0% of all queue
  scanning — but at this machine's noise floor, with two counterbalanced
  measurements contradicting each other. Reverted rather than tuned. The
  implementation is easy and the parity argument is sound (both scans walk
  `heapArray` from 0, so the first match is the same object, and
  collect-then-remove preserves the heap permutation); it needs a measurement
  that clears noise, not a rewrite.
- **An O(1) "does the queue contain type X" index, on the grounds that the
  reference has one.** *It does not.* The per-tag counter in its heap push is
  incremented and **never decremented** — none of its three removal or pop
  routines touches it — so it is a cumulative statistic, not a live population
  index. The adjacent call that looked like a hashmap insert is a string clone:
  it reads a (pointer, length) pair, allocates, and copies an hrid. Recorded
  because this claim was made, believed, and only caught on re-verification.

## 6a. The board this round was aimed at — and it is now stale in its turn

Revision 6's table here was taken BEFORE `81ba84e`, `db84ac7` and `a776281`
landed, and by revision 7 it had the families in the wrong order: it put the
heap largest at 16% and buff machinery at ~10%. Measured at `1492a74`
(`dungeon-den-600`, engine and heap self time only, 9 reps) it was the other way
round. The corrected board, which is what this round was aimed at:

| family | share at `1492a74` | what was done |
|---|---|---|
| buff machinery, of which `_buildBuffBoostIndex` alone **14.2%** | **22.9%** | stage 1 — the mirror |
| heap-js, of which `Heap.remove` 5.7% and `__read`/`__spreadArray` 4.5% | **13.0%** | stage 2 — the linear scan |
| trigger evaluation, `getDependencyValue` alone **8.2%** | — | stage 3 — the condition ordinal |

Two things that table taught, worth more than its numbers:

**A profile ages faster than the thing it describes.** Revision 6's ordering was
not wrong when it was taken; three stages landed on top of it and inverted it.
Anyone quoting a share here should re-take the profile first — which is the same
warning §1's ratio table carries, now earned twice.

**Look at what the cost IS, not only where it sits.** `_buildBuffBoostIndex` was
the largest item on the board and the index itself was already optimal — pooled,
ordinal-keyed, allocation-free. The cost was the dictionary-mode object it read.
A profile names a function; it does not name the reason.

**And this table is now stale as well.** All three families were moved
substantially, so the shares no longer describe HEAD and the next round's first
job is a fresh profile, not a stage chosen from this list. Nothing is written
here about what is now largest, because nothing has been measured about it.

The one entry that carries forward unchanged is result recording (`addAttack`,
~7% at revision 6): indexable, but it changes the output shape, which makes it a
behaviour-change argument rather than a performance one.

## 6b. What revision 7 did, in one line each

- **The insertion-ordered buff mirror.** `_commitInstances` deletes keys from
  `combatBuffs`, which puts the object permanently into V8's dictionary mode
  (219 of 500 units on `dungeon-den-600`), and the boost-index rebuild paid
  602 ns per `Object.values` where an array walk costs 8 ns. `combatBuffs` is
  unchanged; a mirror of its values, maintained by its two writers, is what the
  rebuild walks. The whole risk is order — the rebuild sums with `+=` and float
  addition is not associative — so the mirror reproduces JS key order exactly
  (re-assign writes in place; delete-then-re-insert moves to the end) and
  `api/tests/buffMirror.test.mjs` holds it to that over 4 000 randomised
  mutations against the object itself as oracle.

- **Linear-scan heap removal.** heap-js's `remove` re-finds, with a pruned BFS
  over `queue.shift()` and four allocations per visited node, an object the
  queue already collected and is holding. Since it compares by identity, exactly
  one index matches and a linear scan finds the same one. The MUTATION is
  upstream's byte for byte, because it is what fixes the heap permutation and
  hence the tie-break order among equal-`time` events.
  `api/tests/heapRemove.test.mjs` compares the whole backing array BY POSITION,
  which is the only comparison that would have caught the single-compaction
  failure in §3.

- **The condition-kind ordinal.** §6a's deferred stage, now taken: 55 conditions
  into nine integer arms, the grouping extracted MECHANICALLY from the switch it
  replaces rather than re-derived, generated into `generated/triggerKinds.js` by
  `tools/genTriggerKinds.mjs`, and checked against the retired switch — kept
  verbatim in the test as the oracle — over every condition and nine source
  shapes. An unknown condition still throws, still from `getDependencyValue`,
  still at evaluation, because `api/lib/triggerSearch` builds Triggers
  speculatively.

All three: `sim:check` 3/3 bit-identical and `eval:check` Tier A 464/464, Tier B
29/29, at every stage. Each shipped as one commit with one ledger entry, per §8.

## 7. Not in scope

The combat **mechanics** deltas — the 2.6–7.4% encounter-rate difference in
party cases, the inter-encounter gap, `debuffOnLevelGap` on loot. These are
**not ours to close.** This engine matches the live game, so where the
reference's encounter rate differs, the reference is the one that is wrong.
They are out of scope as a matter of fact rather than of priority, and `enc/h`
stays in the candle as a control on whether WE have broken our own mechanics —
never as a target to converge on. Worker-pool reuse (55 ms per spawn — real, but startup, which the
candle's slope cancels by design). Rewriting in AssemblyScript or Rust: finish
this list first, to find out how much of the gap is language at all.

## 8. Fork discipline

Every departure in `src/combatsimulator/` must be listed in the
`upstream-update.sh` adaptation ledger or the next sync silently reverts it. One
commit and one ledger entry per stage, in the house voice: the measurement that
justifies it and the argument for why it is safe — **including negative
results**, so nobody re-derives a discarded idea.

## 9. The back-run verdict: 34 commits, 464 hashes, no behaviour change

**2026-09-21.** Every stage in §2 passed `sim:check` 3/3 at the time it landed.
That is three scenarios at one seed each, and it was never the claim anybody
actually wanted, which is: *across the whole span, did any of this change what
the engine computes?* `api/eval/` now answers that question, and the answer for
`dabf8c9..HEAD` is **no**.

**Method.** `api/eval/backrun.mjs` extracts `<ref>:src/combatsimulator` with
`git archive` into a scratch directory and loads it through the CURRENT
`api/eval/engine.mjs` — one harness, two engines, so no part of the difference
can be harness drift. Both engines are run at the same 16 seeds per case, seeds
derived from the case id, under a seeded global `Math.random`. Before anything
runs, `git diff --quiet <ref> HEAD -- src/combatsimulator/data` must be empty
or the tool refuses: a different monster is a different fight, and no amount of
hash agreement would then say anything about the engine.

**Result.**

| scope | Tier A (bit-identical) | Tier B (ensemble mean) | worst \|Δ\| |
|---|---|---|---|
| 22 zone cases × 16 seeds | **352 / 352** | 22 / 22 | 0.00 % |
| + 4 labyrinth + 3 guild-trial cases | **464 / 464** | 29 / 29 | 0.00 % |

Not "within tolerance" — *identical*. The same random draws consumed in the
same order producing the same result tree, on every case in the catalogue.

**Speedup, on the same 352 runs through the same code path:** 98.4 s at
`dabf8c9`, 9.2 s at `HEAD` — **10.7×**. That is total corpus wall clock and
therefore includes per-run DTO construction and `Player.createFromDTO`, which
are fixed costs the candle's marginal ms/simulated-hour deliberately cancels.
It is the honest figure for "how long does the suite take", not a replacement
for §2's per-stage numbers.

**What this does and does not prove.**

- A cross-version hash MATCH is very strong evidence of behaviour preservation.
- A hash MISMATCH would prove only that RNG consumption order or the result
  tree changed — **not** that there is a bug. Hoisting an allocation can
  reorder two independent draws without touching either distribution. On a
  mismatch the verdict escalates to Tier B, and agreement there is *consistent
  with* behaviour preservation, which is a weaker claim and is labelled as one.

**Caveats, all of which would falsify or narrow the claim:**

- Bit-identity is of the **canonical `SimResult` tree**, with
  `wipeEvents[*].timestamp` redacted. `src/combatsimulator/simResult.js:197`
  stamps each wipe with `new Date().toISOString()`; a wipe-heavy case hashes
  differently on two runs at the *same* seed until that is scrubbed. Anything
  the engine computes and does not put in `SimResult` is not covered.
- Under a **seeded global `Math.random`**, on the **main-thread branch only**.
  The override does not reach a worker realm, so this says nothing directly
  about `runSimulationWithWorker`.
- **`heap-js` held at 2.7.1 for both engines.** `bb4d767` re-pinned it from
  `^2.2.0`; the loader resolves it from the current `node_modules` whichever
  engine is loaded. That is the correct control — it isolates engine source —
  but it means the verdict says nothing about the dependency bump itself.
- Recorded on **node v26.8.2 / darwin-arm64**. Cross-platform reproduction of
  the hashes is **unverified**; see "Cross-platform" in `api/eval/README.md`.

**Revision 7 has not extended this verdict, and says so rather than implying
it.** Each of the three stages passed `eval:check` — the same 29 cases x 16
seeds, Tier A 464/464 and Tier B 29/29 — against the recorded corpus, which is a
strictly stronger gate than the `sim:check` 3/3 the older stages had, and it
means no stage in this round changed what the engine computes. What has NOT been
re-run is `backrun.mjs` against `dabf8c9`, so the recorded verdict below still
names the older HEAD. Re-running it is cheap (~100 s) and would restate the span
claim over 37 commits; until someone does, quote the record for what it is.

Record: `api/eval/records/2026-09-21-dabf8c9-vs-HEAD.json`.
Re-run: `cd api && npm run eval:backrun -- --against=dabf8c9` (~100 s).
Per-commit: `--all-perf` (the 13 `perf(...)` commits) or `--bisect` (all 34).
