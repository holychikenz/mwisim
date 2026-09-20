# Closing the gap to the metz kernel

**Revision 2, 2026-09-20.** Revision 1 proposed `Float64Array` stat blocks and
event-object pooling. **A CPU profile refutes both.** They are recorded in §7
as rejected, with the evidence, so they are not re-proposed.

Current state: csim is 3.2–7.1× the metz wasm reference after two rounds
(`4cf015a`). Baseline for all measurement:
`api/bench/records/2026-09-20b-buffpath.json`.

---

## 0. The evidence this revision is built on

Two independent CPU profiles (`node --cpu-prof` over the candle) plus a study
of the disassembled metz kernel at `/Users/morgan/pie/farm/metz-kernel-disasm/`
(see `FINDINGS-vs-csim.md` there — 9 ranked findings, function-level citations).

Self time, `dungeon-den-600`, my own profile:

```
 9.39%  _buildBuffBoostIndex   combatUnit.js:744
 7.18%  updateCombatDetails    player.js:151
 5.73%  getDependencyValue     trigger.js:85
 4.66%  updateCombatDetails    combatUnit.js:218
 4.16%  updateCombatDetails    monster.js:148
 3.28%  getBuffBoost           combatUnit.js:778
 2.65%  Heap.remove            heap-js
 2.58%  clearMatching          eventQueue.js:94
 1.89%  (garbage collector)
```

Families: **buff aggregation ~16.5%**, recompute ~16%, **event queue ~8.3%**,
trigger evaluation ~5.7%, **GC 1.9%**.

The metz kernel's corresponding function is **func 21 (`unit.rs`)**. It is not
absent — it is called on buff change exactly as ours is — it is roughly 30×
cheaper per call. It makes **one linear pass** over active-buff records,
bucketing into a **dense array indexed by a `u8` stat ordinal**, then writes 52
derived stats straight-line at constant offsets. No hashing. No strings.

**That is the whole lesson: dense integer indexing where we already iterate in
bulk.** Not typed arrays, not pooling, not compilation.

### Kill criteria

Unchanged from revision 1 and still binding. This branch has discarded two
measured optimisations already (a monster-stat cache that was *slower*,
203 → 242 ms; an O(1) buff-expiry early-out indistinguishable from noise).

- Every stage passes `npm run sim:check` **3/3 bit-identical**. Re-recording
  fixtures to make a stage pass is forbidden.
- A stage that regresses *any* candle case is reverted, not tuned.
- A stage that cannot be separated from noise at `--reps=9` is dropped, not
  shipped, and recorded in the ledger as a negative result.

---

## 1. Buff aggregation — intern the type hrids  *(biggest win)*

**~16.5% of self time on `dungeon-den-600`.** `_buildBuffBoostIndex`
(`combatUnit.js:744`) allocates a `Map`, an array per distinct type, **and one
`{ratioBoost, flatBoost}` object per buff**, on every write to `combatBuffs`.
`getBuffBoost` (`:778`) then allocates a fresh sum object per type and memoises
it into a second `Map`, and is called ~35 times per recompute.

Replace both `Map`s with plain arrays indexed by an integer buff-type ordinal,
and pre-allocate and reuse the sum objects.

- [ ] Ordinal table (see §5 — this is the one thing worth generating)
- [ ] `_buffBoostIndex`: `Map` → `Array(BUFF_TYPE_COUNT)`
- [ ] `_buffBoostSums`: `Map` → `Array(BUFF_TYPE_COUNT)` of reused objects
- [ ] Keep `getBuffBoost(type)` / `getBuffBoosts(type)` taking a **string**, so
      the ~35 call sites in `updateCombatDetails` need no edit. Intern at the
      boundary.
- [ ] **Bit-identical by construction** — the `Object.values` insertion-order
      argument already written at `combatUnit.js:737–743` still holds, and the
      per-type `+=` order is unchanged. Do not reorder any sum.
- [ ] **Trap:** `boosts[i]?.ratioBoost ?? 0` at `:796–797` coerces; replicate
      the coercion exactly or a `null` entry changes a number.
- [ ] **Trap:** a `typeHrid` the ordinal table has never seen must throw, not
      silently read `undefined` and vanish. This is the stage's one real hazard.
- [ ] Candle: `buffstack-solo`, `selfbuff-solo`, `tank-solo`, `dungeon-*`

## 2. `Monster.updateCombatDetails` — the `Object.entries` copy  *(do first)*

**5.7% on `melee-solo`, 6.3% on `buffstack-solo`, 4.2% on `dungeon-den-600`.**
`monster.js:172` copies the monster's stat block with

```js
for (const [key, value] of Object.entries(gameMonster.combatDetails.combatStats))
```

— an outer array plus a two-element array **per stat, per monster, per
encounter**, at 200–800 encounters per simulated hour. metz's equivalent is a
single `memory_copy` of a flat block.

Cache a flat key array and value array per monster `hrid` and walk them.

- [ ] ~10 lines, no new data structure, **zero parity risk** (same keys, same
      order, same values)
- [ ] Highest gain ÷ difficulty on this list. **Start here** — it is the
      cheapest way to prove the profile is actionable before touching buffs.
- [ ] Candle: `melee-solo`, `melee-swarm`, and every case

*Honesty note: the kernel study put this at 9.56% on `melee-solo`; my own
profile says 5.7%. Directionally right, magnitude overstated. Trust the
candle, not either profile.*

## 3. Trigger evaluation — stop rebuilding strings

**5.7% on `dungeon-den-600`.** `getDependencyValue` (`trigger.js:85`) does
`lastIndexOf` + `slice` + concatenation, and an `Object.keys().filter()`, on
**every trigger evaluation** — and `checkTriggers()` runs after every event.
metz's equivalent (func 35) does no string work at all.

- [ ] Precompute the derived keys once per `Trigger`, at construction
- [ ] Bit-identical: same values, computed earlier
- [ ] Candle: `dungeon-*` (deepest trigger sets), `selfbuff-solo`

## 4. Event queue — integer tags, then fewer heapifies

**~8.3%** (`Heap.remove` 2.65 + `clearMatching` 2.58 + `getMatching` 1.58 +
heap-js `__read` 1.51). `eventQueue.js:94–119` invokes a **JS closure per heap
entry** — its own header records 2,305,965 entry visits per simulated hour —
then calls heap-js `remove()` **once per match**, each re-heapifying.

metz has both a predicate removal (func 268) and a **tag-specialised** one
(func 272, an inline byte compare, one compaction pass, one re-heapify), and
uses the specialised one on the hot death path.

- [ ] **4a — integer `typeId` on events, closure-free scans.** Bit-identical.
- [ ] **4b — single compaction pass + one heapify** instead of N removals.
      **Flagged:** this changes the heap permutation, so the tie-break order
      among equal-`time` events can change. Gate on `sim:check` 3/3 and
      **drop it if it fails** — do not "fix" the fixtures.
- [ ] Candle: `dungeon-*`, `melee-swarm`

---

## 5. The build-time layer — scoped down, but the instinct was right

Revision 1 proposed generating a 110-slot stat layout. That is no longer
needed. What *is* needed is the **buff-type ordinal table** for §1, and that
still must be generated rather than typed, for exactly the original reason:
this codebase has already had a stat list silently corrupted by a regex that
dropped `hpRegenPer10` and `mpRegenPer10` and moved kills/hr by 2%.

`tools/genBuffTypes.mjs` → **committed** `src/combatsimulator/generated/buffTypes.js`:

```
export const BUFF_TYPE        // frozen { "/buff_types/armor": 0, ... }
export const BUFF_TYPE_NAMES  // ordinal -> hrid
export const BUFF_TYPE_COUNT
```

- [ ] **Derive** from `abilityDetailMap` + `itemDetailMap` + house / achievement
      / zone / guild buff sources. Abilities and consumables alone give 53
      distinct `typeHrid`s today; the true set is larger and grows with data.
- [ ] Committed output, not built on demand: webpack and the node harness
      import the identical file, and a layout change appears as a reviewable
      diff.
- [ ] `api/tests/buffTypes.test.mjs` — re-run the generator, compare **byte for
      byte**. That test is what makes generation safe.
- [ ] Ordinals must be **stable** (sorted, not insertion-ordered) so a game-data
      update does not renumber the world.

**Source-to-source rewriting remains rejected** (revision 1, §1C): this
codebase indexes stats dynamically (`combatStats[style + "Accuracy"]`,
`combatUnit.js:15`), so a transform cannot see every access, and a mis-rewrite
is silent where a wrong number is not.

---

## 6. Parity risk register

| risk | mitigation |
|---|---|
| Summation order (float `+` is not associative) | Change *storage*, never the order of a `+=`. §1 and §2 are storage-only. |
| `?? 0` coercion at `combatUnit.js:796–797` | Replicate exactly. |
| Unseen `typeHrid` reads `undefined` instead of throwing | Explicit throw; test with a synthetic hrid. |
| Heap permutation (§4b only) | Gate on `sim:check`; drop on failure. The only stage that reorders anything. |
| Live-`Player` gear swap in the browser (`src/main.js` `updateEquipmentState`) | Nothing here caches equipment; the existing `_equipmentChanged` signature check is untouched. |

## 7. Rejected, with evidence — do not re-propose

- **Event object pooling.** Revision 1 called this "do this first regardless".
  **Wrong.** GC is **1.9%** of self time on `dungeon-den-600` and 3.2% on
  `melee-solo`. Pooling can recover at most that, in exchange for
  use-after-free bugs that produce wrong numbers with no error.
- **`Float64Array` flat state.** In JS an element read costs a load *plus a
  bounds check*, where a monomorphic object field costs one load once the
  inline cache is warm. It is genuinely why metz scales per unit and it is the
  one thing that does not port honestly. Take the *idea* — dense integer
  indexing — via §1 and §2 instead.
- **Events stored by value.** metz copies 232 bytes per heap swap; swapping JS
  object references is already strictly better.
- **One giant inlined `processEvent`.** metz's func 4 is 20 KB in one body
  because LLVM can do that. A 2000-line JS function would exceed TurboFan's
  inlining budget and deoptimise.
- **Swapping in an LCG for `Math.random()`.** Ceiling under 0.1 ms/h, and it
  invalidates `sim:check` and every recorded baseline by construction. The real
  case for a seeded PRNG is reproducibility — a different project.
- **A cached `_nextBuffExpiry` early-out.** Already tried and discarded last
  round as indistinguishable from noise at `--reps=9`; it is in the ledger. The
  kernel study re-proposes it (metz func 134). Leave it discarded unless §1
  changes the arithmetic behind it.
- **metz func 618** — a shadow-stack round trip to compute `a + b`, called 26×
  per recompute. That is a metz *bug*, not a technique.

## 8. Not in scope

The combat **mechanics** deltas (the 3–7% encounter-rate difference in party
cases, the inter-encounter gap, `debuffOnLevelGap` on loot) — held back
deliberately. Removing the per-event `await` (~1 ms of 318). Worker-pool reuse
(55 ms per spawn — real, but startup, which the candle's slope cancels).
Rewriting in AssemblyScript or Rust: finish this plan first, to find out how
much of the gap is language at all.

## 9. Fork discipline

Every departure in `src/combatsimulator/` must be listed in the
`upstream-update.sh` adaptation ledger or the next sync silently reverts it.
One commit and one ledger entry per stage, in the house voice: the measurement
that justifies it and the argument for why it is safe — **including negative
results**, so nobody re-derives a discarded idea.

---

## Suggested order

**§2** (cheapest, zero risk, proves the profile is actionable) → **§5** (the
generator) → **§1** (the biggest win) → **§3** → **§4a** → **§4b** (gated).
