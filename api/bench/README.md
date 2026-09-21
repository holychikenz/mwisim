# The standard candle

A fixed set of character builds and scenarios, run the same way every time, so
that two performance readings taken weeks apart — or taken from two different
engines — can be put in the same table without an argument about whether they
were measuring the same thing.

```sh
npm run bench                                  # csim only, ~15 s
npm run bench -- --json=bench/records/x.json   # record it
npm run bench -- --baseline=bench/records/x.json   # show the delta since
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
is comparable across runs, machines and Node versions, whose fixed costs are
nothing alike.

Each point is the **median** of `--reps` runs after one untimed warm-up.
Median, because the failure mode is an occasional long sample (GC, scheduler),
which drags a mean and leaves a median alone.

The `enc/h` column is **the control, not a score.** Two engines that agree on
encounters per hour to within a few percent are simulating the same fight. If
that column diverges, the speed column is comparing two different games and
should not be quoted until the divergence is explained.

**It has been explained, and the explanation is not symmetric.** This engine is
validated against the live game; a comparison engine that reports a different
encounter rate is wrong, not differently-opinionated. So a divergence here is a
reason to distrust the OTHER column's owner, and never a target to converge on.
It does, however, contaminate any per-ENCOUNTER normalisation of their numbers:
dividing by encounters credits them with encounters that are cheap partly
because they are wrongly short. Compare milliseconds per simulated hour — a
simulated hour is the same quantity of simulated combat either way, however it
is divided into encounters.

## Rules

- **Do not edit an existing build or case to make a number look better.** Every
  prior reading becomes incomparable the moment one does. Adding a case is
  free and welcome; changing one means renaming it, so the old and the new can
  never sit in the same table.
- **Every case must be a party the game would allow.** Open zones cap the party
  at 3, single-monster zones at 1; only dungeons take 5. csim does not enforce
  this — it will cheerfully simulate five players against a fly — which makes
  such a case measurable but meaningless: it is not a load any player can
  produce, so a number taken from it describes nothing. `validateCases()` runs
  at startup and refuses the whole run rather than let one through.
- **This is not a parity check.** `npm run sim:check` proves bit-identical
  output across an engine change. The candle proves nothing about correctness
  beyond the coarse `enc/h` control. Run both.

## `enc/h` is now asserted as well as watched

The `enc/h` column above is still the candle's control, and still a single
unseeded sample — read it as "are these two engines simulating the same game?"
and nothing more. But the same quantity is now **pinned as a first-class
asserted number** by the evaluation suite: `fixtures/eval` records the mean and
sample sd of encounters per simulated hour over 16 seeds for every case in
`CASES`, and `npm run eval:check` fails if a case's mean moves outside a band
computed from that sd. So a divergence the candle's single sample would have
shrugged off now reddens a gate. See `api/eval/README.md`.

The eval suite imports `CASES` and `BUILDS` from `builds.mjs` **unchanged** —
there is one catalogue, not two, so the benchmark and the corpus can never fork
on what a build is. The rule at the top of this section is therefore twice as
binding: editing an existing case now invalidates a recorded corpus as well as
every prior reading.

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

## Files

- `builds.mjs` — the catalogue: builds, cases, the legality validator, and the
  adapter that turns a build declaration into engine input.
- `candle.mjs` — the runner, the measurement method, and the table.
- `records/` — recorded runs, for `--baseline`.
