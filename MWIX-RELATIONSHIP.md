# csim ↔ MWIX

This directory began as a fork of [shykai/MWICombatSimulatorTest](https://github.com/shykai/MWICombatSimulatorTest)
plus a React UI / Express API of our own. It is now owned by the
`cowstuff` repository — what used to live at `/Users/morgan/pie/csim/` is
here.

## Why it's in cowstuff

The Tampermonkey extension (`cowstuff/tampermonkey/`) is going to call
into this simulator for the labyrinth clear-rate computation and a future
combat simulator panel. Keeping the engine alongside the consumer:

- Lets us **change csim and MWIX in the same commit** when the simulator
  contract evolves.
- Means there is a single repository to clone for a new dev environment.
- Lets `tampermonkey/build.py` reach across into `csim/src/combatsimulator/`
  for the vendor step (planned — see task #18 "sim-bridge").

## Repo layout

```
csim/
  src/
    combatsimulator/     ← the engine we want, vendored by MWIX sim-bridge
      data/              ← bundled JSON (fallback only once #33 lands)
      events/
      *.js
    worker.js            ← csim's web worker (not vendored)
    multiWorker.js
  shared/                ← code common to api/ and ui/ but NOT to the engine.
                           Deliberately outside src/combatsimulator/ so it never
                           appears in the vendored bundle.
                           Today: consumableCost.js (production-time economics),
                           dungeonRuns.js (dungeon runs split across workers).
  api/                   ← Express server (independent product)
  ui/                    ← React UI (independent product)
  MWIX-RELATIONSHIP.md   ← this file
```

When the MWIX sim-bridge (task **#18**) lands, only `src/combatsimulator/`
gets vendored into the Tampermonkey bundle. `api/`, `ui/` and
the build configs remain csim's own concern.
