# `fixtures/sim` — bit-identical SimResult replays

Recorded and checked by `api/sim-parity.mjs`:

```
cd api
npm run sim:check     # replay every fixture, exit 1 on ANY difference
npm run sim:record    # (re-)record all three from the current engine
npm run sim:record geared-party   # just one
```

## What these prove, and what `fixtures/lab` proves

`fixtures/lab` asks *is the simulator right about the game?* — it compares
derived stats against numbers read in-game, within a tolerance.

These ask a narrower and much stricter question: *does the engine still do
exactly what it did before I changed it?* The engine seeds nothing (it calls
bare `Math.random()` at 26 sites), so two runs of the same input already
differ and "the numbers look similar" proves nothing. The harness installs a
seeded PRNG over `Math.random` for the duration of a run, which makes the whole
simulation a pure function of `(inputs, seed)`. Each fixture therefore pins the
**exact** `SimResult`: a sha256 over a canonical, key-sorted serialisation,
plus a few headline numbers and the full tree so a failure can be diffed rather
than merely reported.

They exist because the performance work in `player.js`, `combatUnit.js`,
`equipment.js` and `events/eventQueue.js` replaced recomputation with caches.
A stale cache is a wrong combat number with no error anywhere. Run
`npm run sim:check` after touching any of those files.

## The three scenarios

| fixture | shape | what it stresses |
|---|---|---|
| `bare-solo` | no equipment, `fly` T0, L40 | the equipment-sum cache with nothing to sum |
| `geared-solo` | full kit, `infernal_abyss` T0, L100 | a zone that actually hurts, so defensive stats reach the result; death and respawn |
| `geared-party` | 5 players, `chimerical_den` dungeon T0, L600 | a deep event heap and the stat-recompute churn the optimisation targets — the workload the work was aimed at |

`geared-solo` fights something dangerous on purpose. On an easy zone the player
is never meaningfully hit, and the fixture goes blind to a dropped
armor/evasion/resistance term — verified by deleting stats from the list one at
a time and confirming each deletion drifts at least one fixture.

## Re-recording

Re-record when the **game data** changes (`src/combatsimulator/data/*.json`, an
upstream client pull) or when a combat **rule** deliberately changes. Note the
reason in the commit message.

Re-recording is **not** how you make a failing optimisation pass. If
`sim:check` drifts after a change that was supposed to be behaviour-preserving,
the change altered behaviour.
