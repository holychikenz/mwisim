# The flat-state layer

A plan to close a further 2–3× of the gap to the metz wasm kernel by adopting
its *discipline* — flat numeric state, pooled objects, ordinal-indexed buffs —
without adopting its language.

Status: **not started.** Written 2026-09-20, after the buff-path round
(`4cf015a`) took csim from 7–8× the wasm reference to 5–7×.

---

## 0. The premise, and the conditions under which this plan is abandoned

The claim this plan rests on is that csim is slow not because it is
interpreted but because of **how it stores per-unit state**. The evidence is
the shape of the gap, not its size:

| candle case | csim | metz | gap | |
|---|---|---|---|---|
| `floor-solo` | 1.1 | 0.7 | **1.6×** | nothing equipped, no buffs, no abilities |
| `melee-solo` | 9.8 | 2.6 | 3.7× | |
| `buffstack-solo` | 10.0 | 1.9 | 5.3× | five auras |
| `selfbuff-solo` | 13.8 | 2.6 | 5.3× | fourteen self-buffs |
| `dungeon-fort-t2` | 130.2 | 18.3 | **7.1×** | five players |

With nothing equipped we are within 1.6× of compiled code, which is roughly
the floor for JavaScript and not worth attacking. The gap opens as buffs and
party members are added. That is a data-structure gradient, not a compilation
one.

**This is a hypothesis, and it is not obviously true.** A `Float64Array` read
is *not* automatically faster than a property read: V8 gives a monomorphic
object with a stable hidden class very nearly array-speed scalar access. The
reasons to expect a win are narrower and must be stated so they can be tested:

1. **Bulk operations.** Copying 70 equipment sums becomes one `.set()`; zeroing
   the block becomes one `.fill(0)`. Today both are loops over named keys.
2. **No allocation per reset.** A pooled typed array is reused; a fresh object
   literal is not.
3. **Representation.** `combatStats` has **80 fields, four of them strings**.
   An object that wide spills past V8's in-object slots into a backing store,
   and mixed string/number fields prevent the unboxed-double representation.
   A `Float64Array` is contiguous unboxed doubles by construction.
4. **No hidden-class churn** from `+=` across 70 differently-typed fields.

### Kill criteria — read this before writing any code

**Stage 0 is a throwaway spike and it has veto power over the entire plan.**
This codebase has already produced two optimisations that were measured,
found wanting, and correctly discarded: a monster-stat cache that made things
*slower* (203 → 242 ms), and an O(1) buff-expiry early-out that passed parity
but could not be separated from noise. Assume this plan is the third until the
candle says otherwise.

- If the Stage 0 spike does not move `buffstack-solo` and `dungeon-den-600` by
  **at least 10%**, stop. Delete the branch. Record the negative result in the
  `upstream-update.sh` ledger so nobody re-derives it.
- If any stage produces a regression on *any* candle case, that stage is
  reverted, not tuned.
- Every stage must pass `npm run sim:check` **3/3 bit-identical**.
  Re-recording fixtures to make a stage pass is forbidden.

---

## 1. The build-time question, answered

> *"Create a layer to do that level of optimization (build time?)"*

**Yes, but only for the layout — never for the code.** Three options were
considered:

| | what it is | verdict |
|---|---|---|
| **A. Hand-written constants** | Type `S.stabAccuracy = 17` by hand in a header file. | **Rejected.** 110 indices maintained by hand, against a 70-name list that has *already* been silently corrupted once by a regex that dropped `hpRegenPer10` and `mpRegenPer10` and moved kills/hr by 2%. A hand-maintained index table is that bug waiting to happen with no test that can see it. |
| **B. Generated layout, hand-written access** | A generator derives the index table from the canonical lists and emits a committed file. Source reads `stats[S.stabAccuracy]`. | **Adopted.** See below. |
| **C. Source-to-source transform** | Write `combatStats.stabAccuracy`, have a build step rewrite it to `combatStats[17]`. | **Rejected, despite being the most seductive.** It would let upstream's own code keep working untouched, which is genuinely valuable for a fork. But it cannot see dynamic access (`combatStats[style + "Accuracy"]`, which this codebase *does* use — see `combatUnit.js:15`), it makes every stack trace and debugger session lie, and a mis-rewrite is silent. The parity harness would catch a wrong *number*; it would not catch a rewrite that quietly stops applying. Too much risk for a fork we must keep merging. |

### What "build time" means here, precisely

A generator — `tools/genStatLayout.mjs` — that reads the canonical stat lists
and the game data, and **emits a file that is committed to the repository**:

```
src/combatsimulator/generated/statLayout.js
  export const S          // { stabAccuracy: 0, slashAccuracy: 1, ... } frozen
  export const STAT_COUNT // the array width
  export const STAT_NAMES // index -> name, for the UI facade and serialisation
  export const BUFF_TYPE  // { "/buff_types/armor": 0, ... } frozen
  export const BUFF_TYPE_COUNT
```

Committed, not built on demand. This matters:

- The webpack browser build and the node harness import the identical file;
  no build-step coupling, no chance of the two disagreeing.
- A layout change shows up **as a diff in review**, which is the only way
  anybody will notice that a stat moved.
- `npm test` asserts that re-running the generator reproduces the committed
  file byte for byte. That is the guard that makes generation safe: the file
  cannot drift from its source without a failing test.

The generator must **derive** the buff-type enumeration from
`abilityDetailMap` + `itemDetailMap` + house/achievement/zone/guild buff
sources — not hardcode it. Abilities and consumables alone yield 53 distinct
`typeHrid`s today; the true set is larger and will grow with game data.

- [ ] `tools/genStatLayout.mjs`
- [ ] `src/combatsimulator/generated/statLayout.js` (committed output)
- [ ] `api/tests/statLayout.test.mjs` — regenerate and compare byte for byte;
      assert the stat list is complete, duplicate-free, and **contains both
      `hpRegenPer10` and `mpRegenPer10`** (the standing trap)
- [ ] Register the generated directory in the `upstream-update.sh` ledger

---

## 2. Stage 0 — the spike that decides everything

**Throwaway. Not for merge. One sitting.**

Replace *only* the numeric half of `combatDetails` + `combatStats` with a
single `Float64Array(110)` on `CombatUnit`, keep the four string fields
(`combatStyleHrid`, `damageType`, `primaryTraining`, `focusTraining`) as plain
properties, and leave everything else alone. Ugly is fine; hardcoded indices
are fine; it is going in the bin either way.

- [ ] Spike it on a scratch branch
- [ ] `npm run sim:check` — must be 3/3, or the representation change is not
      value-preserving and we need to know *why* before going further
- [ ] `npm run bench -- --only=floor-solo,buffstack-solo,selfbuff-solo,tank-solo,dungeon-den-600 --reps=9 --baseline=api/bench/records/2026-09-20b-buffpath.json`
- [ ] **Decision point.** ≥10% on the buff and dungeon cases → proceed.
      Otherwise stop, and write the negative result into the ledger.

---

## 3. Stage 1 — event object pooling *(do this first regardless)*

**This stage is independent of the flat-state work and should be attempted
even if Stage 0 vetoes the rest.** It is the lowest-risk item in the plan: it
touches no arithmetic, so bit-identical parity is close to guaranteed.

There are 20 event classes and 35 `new …Event(` sites in `combatSimulator.js`
alone. Every event processed allocates an object that is used once and dropped.

- [ ] Measure first: how many events are allocated per simulated hour, per
      case? (Instrument the constructors; the buff-path round showed
      instrumented counts are the fastest route to a real diagnosis.)
- [ ] Free-list per event class, or one shared pool with a type tag
- [ ] Release point: the main loop, after `processEvent` returns
- [ ] **Risk to name explicitly:** an event held past its release — by the
      queue, by a closure, by `simResult` — becomes a use-after-free with no
      error, just wrong numbers. Prefer a debug-mode poison field over
      cleverness. `sim:check` is the net.
- [ ] Candle cases it should move: everything, but especially `melee-swarm`
      and the `dungeon-*` band, where the queue is deepest.

---

## 4. Stage 2 — buffs in a fixed-width array by type ordinal

Today `combatBuffs` is an object keyed by `uniqueHrid`, with a
typeHrid→boosts `Map` index rebuilt on any write (added in the last round).
With `BUFF_TYPE` ordinals from the generated layout, the index becomes a
fixed-width array — `boosts[BUFF_TYPE_COUNT]` — with O(1) access and no Map,
no rebuild allocation, and no hashing.

This is the stage that should most directly answer the `buffstack-solo` /
`selfbuff-solo` gap, which is the one the user actually noticed in the wild.

- [ ] Ordinals from the generated layout, **derived from game data**
- [ ] Unknown `typeHrid` must not be silently dropped — a buff type that
      appears in data the generator did not see has to fail loudly, not
      vanish. This is the single most dangerous failure mode in the stage.
- [ ] Keep `getBuffBoosts` / `getBuffBoost` signatures unchanged so the ~40
      call sites in `updateCombatDetails` need no edit
- [ ] Candle: `buffstack-solo`, `selfbuff-solo`, `tank-solo`, `healer-solo`

---

## 5. Stage 3 — the real flat-state layer

Only if Stage 0 passed. Do it *after* Stages 1 and 2, so their wins are
already banked and this stage is measured against a stable floor.

- [ ] `StatBlock` backed by `Float64Array(STAT_COUNT)`, the four string fields
      alongside as plain properties
- [ ] Equipment sums copied with `.set()` rather than a 70-iteration loop
- [ ] Reset via `.fill(0)` rather than object reconstruction
- [ ] **A named-property facade for everything outside the hot loop** —
      `src/main.js`, `simResult.js`, the API routes and the whole browser UI
      read `combatStats.foo` by name. Build the facade on demand at the
      serialisation boundary. **Not a `Proxy`** — a Proxy on the hot path
      would undo the entire exercise.
- [ ] The browser swaps gear on a **live** `Player` between recomputes
      (`src/main.js` `updateEquipmentState`). Whatever is built must stay
      correct there, not merely in the headless harness. The existing
      `_equipmentChanged` signature check in `player.js` is the precedent to
      follow.
- [ ] Candle: all 22 cases, against `2026-09-20b-buffpath.json`

---

## 6. Parity risk register

`sim:check` proves bit-identical output under a seeded PRNG. These are the
ways this plan could break it, listed so they are checked rather than
discovered:

| risk | why | mitigation |
|---|---|---|
| **`undefined` vs `0`** | An absent object property reads `undefined`; an untouched `Float64Array` slot reads `+0`. Any site that distinguishes them changes behaviour. | Grep for `=== undefined`, `?? `, `\|\| ` on stat reads before converting. |
| **`-0` and `NaN`** | `Float64Array` round-trips both, but `Object.is(-0, 0)` is false and `deepStrictEqual` distinguishes them. The fixture comparator may or may not. | Check how `sim-parity.mjs` canonicalises before trusting a pass. |
| **Summation order** | Float addition is not associative. `.set()` and `.fill()` do not reorder anything, but "while we are here" refactors of the sum loops do. | Change storage *only*. Do not touch the order of any `+=`. |
| **String fields** | Four of the 80 `combatStats` fields are strings and cannot live in the array. | Explicitly enumerated in the generator; asserted in test. |
| **Stale ordinal** | A regenerated layout that renumbers stats while a cached array persists. | Layout is committed and compared byte for byte in test; caches are per-run. |

---

## 7. Fork discipline — the constraint that shapes all of the above

csim syncs from upstream via `upstream-update.sh`, whose **adaptation ledger
must list every departure in `src/combatsimulator/` or the next sync silently
reverts it.** This is precisely why option C (source rewriting) was rejected
and why the generated layout is committed rather than built.

Each stage lands as its own commit with its own ledger entry, in the house
voice: the measurement that justifies it, and the argument for why it is safe.

- [ ] Ledger entry per stage, including **negative results** — a discarded
      idea recorded is an idea nobody re-derives

---

## 8. Explicitly not in this plan

- The combat **mechanics** deltas (the ~3–7% encounter-rate difference against
  metz in party cases, the inter-encounter gap, `debuffOnLevelGap` on loot).
  Held back deliberately; a separate question.
- Removing the per-event `await` (measured: ~1 ms of 318).
- Worker-pool reuse (measured: 55 ms per spawn) — real, but it is startup
  cost, and the candle deliberately measures the marginal slope.
- Rewriting anything in AssemblyScript or Rust. If we are going to compile,
  that is a different plan with a different budget, and this one should be
  finished first to find out how much of the gap is language at all.

---

## 9. Open — pending the metz kernel study

A read of `/Users/morgan/pie/farm/metz-kernel-disasm/` is in flight, aimed at
exactly these questions: whether the kernel holds state at fixed offsets,
whether it has any equivalent of `updateCombatDetails` at all, whether it
allocates per event, and what shape its event queue is.

**The stage order above is provisional until that lands.** If the kernel turns
out to apply buffs as deltas into derived fields — i.e. to have no full
recompute whatsoever — that is a larger and different prize than flat storage,
and this plan should be reordered around it.

- [ ] Fold the findings in; re-rank by (expected gain ÷ risk) before starting
      Stage 0
