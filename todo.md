# Closing the performance gap

**Revision 6, 2026-09-20.** Revision 5 recorded that the problem is per-UNIT
cost. This revision records the round that acted on it hardest, and the
measurement that made it possible — one that should have been taken in round
one and was not.

**Five stages shipped, compounding to -23.3% on the candle's geometric mean**
(-16.8%, then -6.0%, then -1.9%, each over four counterbalanced rounds). The
first of them improved all 22 cases and won every round on all 22, which no
earlier stage had come close to.

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

## 6a. What is left, with sizes measured rather than guessed

A CPU profile of `geared-party` over one simulated hour, engine self time only,
after this round. Engine self time fell 331 ms -> 242 ms across it.

| family | share | indexable? |
|---|---|---|
| heap operations (`Heap.remove` alone ~9%) | **16%** | **no** — this is queue design, not representation |
| trigger evaluation (`getDependencyValue` ~8%) | 12–17% | partly: a 50-case string switch remains |
| buff machinery (`_buildBuffBoostIndex`, `_buffBoostFor`, `_makeBuffInstance`) | ~10% | partly |
| result recording (`addAttack` ~4%) | ~7% | yes, but it changes the output shape |
| stat recompute (all three levels) | ~8% | mostly done |

Two things follow.

**The largest single item left is not an indexing problem.** `heap-js` is 16% of
engine self time and `Heap.remove` alone is 9% — it does a BFS from the root
with `queue.shift()` and a spread per visited node. No amount of build-time
indexing touches it. §5c's principle is the relevant one: state that belongs to
a unit lives on the unit, not in the event queue.

**The next indexing stage was deliberately NOT taken, and here is why.**
`getDependencyValue`'s remaining cost is a 50-case string switch, and a
generated condition-kind ordinal would reduce it to about nine integer arms —
worth perhaps 3%. It was left because testing it honestly means mechanically
extracting the existing switch's grouping to compare against, the failure mode
is reading a DIFFERENT buff and reporting a plausible wrong number with no
error, and it permanently diverges a readable upstream switch. Worth doing;
worth doing carefully, with the differential harness built first.

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
