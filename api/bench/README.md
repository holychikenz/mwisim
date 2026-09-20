# The standard candle

A fixed set of character builds and scenarios, run the same way every time, so
that two performance readings taken weeks apart — or taken from two different
engines — can be put in the same table without an argument about whether they
were measuring the same thing.

```sh
npm run bench                                  # csim only, ~15 s
npm run bench -- --json=bench/records/x.json   # record it
npm run bench -- --baseline=bench/records/x.json   # show the delta since
npm run bench -- --engines=csim,metz --metz=/path/to/metz-combat-simulator
npm run bench -- --only=dungeon-den-600 --reps=9   # zoom in on one case
```

## What the number means

**Marginal milliseconds per simulated game-hour.** Each case is run at two
simulated lengths and the figure reported is the slope between them:

```
(ms at h1 − ms at h0) / (h1 − h0)
```

Differencing two lengths cancels every cost that does not scale with simulated
time — module load, game-data parse, `structuredClone` of the player DTOs,
worker spawn, V8 tier-up. What is left is the cost of simulating combat, which
is the only part a performance change is trying to move, and the only part that
is comparable between a JavaScript engine and a wasm one with entirely
different startup costs.

Each point is the **median** of `--reps` runs after one untimed warm-up.
Median, because the failure mode is an occasional long sample (GC, scheduler),
which drags a mean and leaves a median alone.

The `enc/h` column is **the control, not a score.** Two engines that agree on
encounters per hour to within a few percent are simulating the same fight. If
that column diverges, the speed column is comparing two different games and
should not be quoted until the divergence is explained.

## Rules

- **Do not edit an existing build or case to make a number look better.** Every
  prior reading becomes incomparable the moment one does. Adding a case is
  free and welcome; changing one means renaming it, so the old and the new can
  never sit in the same table.
- **Every case must be a party the game would allow.** Open zones cap the party
  at 3, single-monster zones at 1; only dungeons take 5. csim does not enforce
  this — it will cheerfully simulate five players against a fly — but metz's
  wasm kernel traps, because its *server* validates `maxPartySize` before the
  kernel sees the job. An illegal case does not compare two engines; it
  compares one engine against a crash. `validateCases()` runs at startup and
  refuses the whole run rather than let one through.
- **This is not a parity check.** `npm run sim:check` proves bit-identical
  output across an engine change. The candle proves nothing about correctness
  beyond the coarse `enc/h` control. Run both.

## The cases

Not a cross product — each case loads a different part of the engine, so a
regression lands somewhere specific instead of being smeared across a mean.

| group | what it exercises |
|---|---|
| `floor-*` | no equipment, consumables or abilities: the event loop, the heap and the damage roll and nothing else. The engine's irreducible cost. |
| `starter-`, `mid-` | partial kit — catches anything accidentally O(worn slots) that only shows on a full one. |
| `melee/ranged/magic-solo` | endgame single-target. The shape most users actually run. Ranged is two-hand, so it takes the other branch of `updateCombatDetails`; magic spends mana, so it reaches the out-of-mana paths the physical builds never do. |
| `tank-`, `healer-` | buff-heavy and cross-unit: buff scanning and target selection rather than damage. |
| `buffstack-` | five auras and nothing else. Deliberately pathological for the buff path; nobody would play it. |
| `*-swarm`, `*-abyss` | multi-spawn zones: several live monsters, deeper event queue. |
| `party2-`, `party3-` | per-unit work × party size in an open zone. |
| `dungeon-*` | the real load: 5 mixed players, 50 waves, deepest queue, most stat recomputation. This is what users wait on. |

The five-player dungeon party is `tank, healer, melee, ranged, magic` —
`MIXED_PARTY` in `builds.mjs`.

## Comparing against the web version (metz)

`--engines=csim,metz --metz=<clone>` runs both from the *same* build
declaration, so neither can be accused of having been handed different gear.
The metz adapter needs a clone of `Metzlii/metz-combat-simulator` with its
prebuilt kernel at `kernel-zone/wasm/pkg/` and its `init_client_data.json`.
That clone is deliberately not vendored here; point at your own.

## Files

- `builds.mjs` — the catalogue: builds, cases, the legality validator, and the
  two adapters that turn one declaration into each engine's input.
- `candle.mjs` — the runner, the measurement method, and the table.
- `records/` — recorded runs, for `--baseline`.
