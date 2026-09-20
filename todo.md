# Closing the performance gap

**Revision 3, 2026-09-20.** Reconciled against what actually shipped. Revision 2
listed six stages as pending; four shipped, two were dropped on measurement, and
two more have been tried and dropped since. The profile it was built on is now
stale — this revision replaces it with one taken on the current tree.

Revision 1's proposals (`Float64Array` stat blocks, event-object pooling) remain
rejected with evidence in §6. Do not re-propose them.

---

## 1. Where we actually are

Measured today on this machine, 22 cases, `--reps=3`, both engines interleaved.
The reference figures live outside this repository, with the harness that
produces them (see `api/bench/README.md` for why).

| | round 1 | now |
|---|---|---|
| cheapest case | 1.6× | **1.4×** |
| solo, geared | 3.3–5.3× | 3.2–5.1× |
| 3-player party | 4.1× | 3.8× |
| 5-player dungeon | 5.5–7.1× | **5.2–6.7×** |
| geometric mean | 3.85× | **3.70×** |

Two caveats, both mine to flag rather than yours to discover.

**The ratio flatters us.** The `enc/h` control shows this engine simulating
2.5–6.8% FEWER encounters per simulated hour than the reference in the party and
dungeon cases. That is the combat-mechanics delta held out of scope (§7), and it
means the per-ENCOUNTER gap is a few percent worse than the per-hour gap above.

**Cross-run drift is larger than most of these deltas.** The reference engine's
own column moved 1–2% between recordings on an unchanged binary. Any claim
smaller than that needs a paired measurement, not two recordings compared.

## 2. What shipped

| stage | result |
|---|---|
| unconditional recompute in `removeExpiredBuffs` | −20% to −32% everywhere |
| `Monster.updateCombatDetails` flat stat copy | up to −15.8% |
| buff-type ordinal table (generated) | enabling work for the next row |
| buff boost index keyed by ordinal | dungeons −7.6% to −10.8% overall |
| integer `typeId` + closure-free queue scans | small, consistent on deep queues |
| synchronous `processEvent` | `floor-solo` −6.5%, `mid-solo` −4.9%; a wash on heavy cases |

## 3. What was dropped, and why that matters

Four ideas were measured and thrown away. They are in the `upstream-update.sh`
ledger in full; the summary is here so this file stops claiming they are pending.

- **Trigger derived-key precompute.** Correct, `sim:check` 3/3, and four
  interleaved rounds could not separate it from noise. The string work is real
  but small beside the trigger evaluation around it.
- **Single-compaction heapify.** Failed the parity gate: 2 of 3 fixtures
  drifted, ability casts landing in a different order. The array one compaction
  produces is not the array N successive removals produce. Fixtures untouched.
  This is why `clearMatching`'s collect-then-remove shape is load-bearing.
- **Integer dispatch in `processEvent`.** Correct, `sim:check` 3/3, medians
  straddle zero. V8 already lowers a string switch to pointer compares; the
  reference's jump table is not available to us.
- **Cached `_nextBuffExpiry` early-out.** Dropped in an earlier round as noise.

A stage that cannot be separated from noise is a stage that costs review effort
and upstream-merge friction forever in exchange for nothing. Dropping it is the
result, not a failure to find one.

## 4. How to measure, or you will ship an artefact

**Interleaving rounds is not enough. The order WITHIN a round must alternate.**

The synchronous-`processEvent` change first measured as a consistent REGRESSION —
`melee-solo` +6.1%, `dungeon-den-600` +1.6%, losing in all three rounds. It was
an artefact. Every round ran the baseline first and the change second, and this
machine warms within a round, so the second arm was systematically penalised.
Counterbalancing the order (ABBA over four rounds) inverted both to small wins.

Three interleaved rounds looked like plenty of rigour and manufactured a
false regression out of nothing but thermal drift. Every A/B on this branch
predating this note carries that bias; treat their magnitudes as soft.

The rest of the discipline is unchanged and still binding:

- Every stage passes `npm run sim:check` **3/3 bit-identical**. Re-recording
  fixtures to make a stage pass is forbidden.
- A stage that regresses any candle case is reverted, not tuned — **after** the
  regression survives a counterbalanced re-measurement.
- Run the WHOLE candle before believing a stage. The eager-allocation
  regression in the buff-ordinal work (`starter-solo` +24%) reproduced only in a
  full run, never with that case measured alone.

## 5. What is left, ranked by the current profile

Self time on `dungeon-den-600`, taken on the current tree and aggregated across
duplicate frames:

| family | share | attacked? |
|---|---|---|
| buff aggregation | 17.4% | twice — still the largest |
| trigger evaluation | 16.6% | **never successfully** |
| stat recompute | 15.1% | yes |
| event queue / heap | 8.2% | partly — **and unmoved** |
| result accounting | 3.4% | never looked at |
| GC | 1.2% | — |

### 5a. Trigger evaluation — the one large family never touched

`getDependencyValue` 6.1%, `shouldTrigger` (`consumable.js:53`) 4.0%,
`isActiveSingleTarget` 2.3%, `checkTriggersForUnit` 2.7%.

`checkTriggers()` (`combatSimulator.js:1350`) allocates **two arrays and four
closures per fixpoint pass, per event**, via `filter().forEach()`. The same
shape recurs at eight other hot sites (`:595`, `:639`, `:1603`, `:1676`,
`:1685`, `:1766`, `:2010`, `:2021`).

- [ ] Indexed `for` loops with an inline aliveness test. `filter` preserves
      order, so a `for` with an `if` is the same sequence — bit-identical.
- [ ] **Trap:** `getTarget(enemies)` must stay INSIDE the per-unit loop. A
      trigger firing mid-pass can kill the current target; hoisting it changes
      behaviour, not just speed.
- [ ] Candle: `party3-sorcerer`, then `floor-party`, `dungeon-den-600`
- [ ] Note that the earlier trigger stage failed on magnitude, not on
      correctness. This one attacks allocation rather than string work, which
      is a different mechanism — but budget for it also being noise.

### 5b. The heap's N removals — 8.2% and completely unmoved

`Heap.remove` alone is 3.0%. Shipping integer type ids removed the per-entry
closure and did not touch this: the queue still re-heapifies once per match.
The obvious fix is the single-compaction pass, which failed parity.

- [ ] **Experiment, not a plan.** Tombstone cancelled events — mark them and
      skip on pop — leaving the heap permutation alone rather than rebuilding
      it. It changes ordering in its own way and must be gated on `sim:check`
      exactly as the compaction was, and dropped just as readily.
- [ ] Do not attempt this before 5a; it is the riskier of the two.

### 5c. Result accounting — 3.4%, and nobody has ever looked

`addExperienceGain` 2.0%, `addAttack` 1.4% (`simResult.js`). Pure bookkeeping,
no arithmetic on the simulation's own state, so the parity surface is small.
Cheapest remaining item by difficulty.

### 5d. Buff aggregation — still 17.4%, and there is a wall

`_buildBuffBoostIndex` is 8.3% because it is rebuilt IN FULL on every write to
`combatBuffs`. The reference does one linear pass on change, which we now match
in shape; what we do not match is doing it incrementally.

**Incremental add/remove cannot be bit-identical.** Float subtraction is not
the inverse of float addition, so removing a buff by subtracting its
contribution does not restore the sum that re-adding the survivors produces.
This is a wall, not a difficulty. Any attempt here is a decision to break parity
and must be argued as such, in public, before any code is written.

## 6. Rejected, with evidence — do not re-propose

- **Event object pooling.** GC is 1.2% of self time on `dungeon-den-600`.
  Pooling can recover at most that, in exchange for use-after-free bugs that
  produce wrong numbers with no error.
- **`Float64Array` flat state.** In JS an element read costs a load *plus a
  bounds check*, where a monomorphic object field costs one load once the
  inline cache is warm. It is genuinely why the reference scales per unit and
  it is the one thing that does not port honestly. Take the *idea* — dense
  integer indexing — which is what the ordinal table already did.
- **Events stored by value.** Swapping JS object references is already strictly
  better than copying 232-byte records.
- **One giant inlined `processEvent`.** A 2000-line JS function would exceed
  TurboFan's inlining budget and deoptimise. LLVM's constraints are not ours.
- **Swapping in an LCG for `Math.random()`.** Ceiling under 0.1 ms/h, and it
  invalidates `sim:check` and every recorded baseline by construction. The real
  case for a seeded PRNG is reproducibility — a different project.
- **Source-to-source rewriting.** This codebase indexes stats dynamically
  (`combatStats[style + "Accuracy"]`, `combatUnit.js:15`), so a transform cannot
  see every access, and a mis-rewrite is silent where a wrong number is not.

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
results**, so nobody re-derives a discarded idea. Four are recorded there now.
