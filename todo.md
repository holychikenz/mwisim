# Closing the performance gap

**Revision 4, 2026-09-20.** Revision 3 reconciled the plan against what had
shipped. This revision replaces its *framing*, which was wrong in a way that
explains why the last stage paid nothing on the cases we care about.

Revision 1's proposals (`Float64Array` stat blocks, event-object pooling) remain
rejected with evidence in §6. Do not re-propose them.

---

## 1. The reframing: our problem is per-unit cost, not per-encounter cost

Measured today, 22 cases, both engines interleaved. The reference figures live
outside this repository with the harness that produces them (see
`api/bench/README.md` for why).

| | round 1 | now |
|---|---|---|
| cheapest case | 1.6× | **1.4×** |
| solo, geared | 3.3–5.3× | 3.2–5.1× |
| 3-player party | 4.1× | 3.8× |
| 5-player dungeon | 5.5–7.1× | **5.2–6.7×** |
| geometric mean | 3.85× | **3.70×** |

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
  csim              12.6 µs                 20.2 µs
  reference          9.7 µs                  2.6 µs
                    ──────                  ──────
  ratio              1.30×                   7.77×
```

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

- [ ] **Batch our multi-buff effects.** One line. This is us going BEYOND the
      reference, not copying it — say so. Measured (counter deltas are exact;
      the timing is from the contaminated window and needs re-measuring):
      rebuilds −29.5% on `selfbuff-solo`, −6.4% on `dungeon-den-600`;
      `sim:check` 3/3. It is per-CAST work, so §1's rule predicts it will pay
      the buff-heavy solo cases and little on the dungeons.
      **Flag:** the `allAllies` branch reads `source.combatDetails` INSIDE the
      buff loop for the special-ability multiplier, so batching it would change
      which snapshot later buffs see when the caster is also a target. Do the
      `self` path only, unless someone proves no self-targeted `allAllies`
      special ability buffs a level stat.
- [ ] **Skip the recompute prologue when only buffs changed.** `Player`
      re-copies 76 equipment stats per call and `Monster` re-derives its whole
      flat block — values that cannot have changed, since equipment is immutable
      for the run and monster game data is constant. **12.3% of dungeon self
      time.** Per-UNIT work, so §1's rule says this one can move a dungeon.
      **Flag:** the guild-trial path grows monster max HP on top on every
      recompute, so it is not a pure copy there and must keep the full path.

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

- [ ] Maintain the pending-action count as an invariant of `EventQueue`. The
      surface is small: the heap is mutated in exactly four places —
      `addEvent`, `getNextEvent`, `clear`, and `_removeCollected`, which every
      cancellation funnels through.

### 5d. Pure waste, found while counting events

Neither is a structural finding; both are own-goals.

- [ ] `enrageTick` is cleared and immediately re-added 530 times an hour and
      **never once dispatched** — plus ~55 000 heap entries scanned for it.
- [ ] `curseExpiration` creates 1 798 events an hour and dispatches **none**.
- [ ] The buff-refresh paths scan the queue TWICE for the same predicate
      (`getMatchingTypeAndSource` then `clearMatchingTypeAndSource`, always
      back to back on the same key) — 25.0% of all scanning, halvable by having
      the clear return what it removed.

## 6. Rejected, with evidence — do not re-propose

- **Event object pooling.** GC is 1.2–1.5% of self time. Pooling can recover at
  most that, in exchange for use-after-free bugs that produce wrong numbers with
  no error. Note also that the reference is not allocation-free either.
- **`Float64Array` flat state.** In JS an element read costs a load *plus a
  bounds check*, where a monomorphic object field costs one load once the
  inline cache is warm. Take the *idea* — dense integer indexing — which is what
  the ordinal table already did.
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
- **An O(1) "does the queue contain type X" index, on the grounds that the
  reference has one.** *It does not.* The per-tag counter in its heap push is
  incremented and **never decremented** — none of its three removal or pop
  routines touches it — so it is a cumulative statistic, not a live population
  index. The adjacent call that looked like a hashmap insert is a string clone:
  it reads a (pointer, length) pair, allocates, and copies an hrid. Recorded
  because this claim was made, believed, and only caught on re-verification.

## 7. Not in scope

The combat **mechanics** deltas — the 2.5–6.8% encounter-rate difference in
party cases, the inter-encounter gap, `debuffOnLevelGap` on loot — held back
deliberately, and the reason the gap table understates the per-encounter
difference. Worker-pool reuse (55 ms per spawn — real, but startup, which the
candle's slope cancels by design). Rewriting in AssemblyScript or Rust: finish
this list first, to find out how much of the gap is language at all.

## 8. Fork discipline

Every departure in `src/combatsimulator/` must be listed in the
`upstream-update.sh` adaptation ledger or the next sync silently reverts it. One
commit and one ledger entry per stage, in the house voice: the measurement that
justifies it and the argument for why it is safe — **including negative
results**, so nobody re-derives a discarded idea.
