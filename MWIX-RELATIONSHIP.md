# csim ↔ MWIX

This directory holds **Morgan's fork** of [shykai/MWICombatSimulatorTest](https://github.com/shykai/MWICombatSimulatorTest)
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

## Tracking the upstream

The original `origin` was
`git@github.com:shykai/MWICombatSimulatorTest.git`. We have **not**
preserved the .git directory in this copy — to pull new upstream commits,
run:

```bash
./upstream-update.sh             # interactive review (default)
./upstream-update.sh --check     # diff only; no model
./upstream-update.sh --apply     # non-interactive claude -p
```

**Quirk to remember:** shykai's working branch is **`testing`**, not `main`
(the latter is rarely touched). The script defaults `UPSTREAM_BRANCH=Test`
accordingly. Override at the env if that ever flips:

```bash
UPSTREAM_BRANCH=main ./upstream-update.sh --check
```

The script:

1. Clones (or fetches) `shykai/MWICombatSimulatorTest` into
   `.upstream/MWICombatSimulatorTest/` (gitignored).
2. Diffs `src/combatsimulator/` between upstream and our copy (excluding
   `data/` and `*.test.js`).
3. If a diff exists, builds `.upstream/rebase-prompt.md` listing every
   MWIX-side adaptation we want preserved.
4. Hands the prompt to `claude` so any non-trivial conflict is resolved by
   the model with reasoning, not by a silent merge driver.

Override via env: `UPSTREAM_URL`, `UPSTREAM_BRANCH`, `CLAUDE_BIN`.

## Adaptations on top of upstream

Tracked in the rebase prompt so we don't lose them on every sync:

1. **`options.maze`** — the simulator applies labyrinth player bonuses
   internally (level +15, attack speed +15%, regen +6%, crit rate +6%,
   crit damage +10%). Caller passes `{ maze: true }` (or an object with
   custom multipliers) and csim does the rest. Today these constants live
   in `cowstuff/tampermonkey/lab-clear-rate.js`; task **#32** migrates
   them here.
2. **Headless data source** — `CombatSimulator` accepts a parsed `data`
   object at construction time (with `itemDetailMap`, `actionDetailMap`,
   `combatMonsterDetailMap`, `abilityDetailMap`, etc.). Falls back to
   `import`ing the bundled `data/*.json` when not supplied. Lets MWIX
   feed live `clientData` so we do not ship the 2–3 MB of bundled data
   inside the Tampermonkey bundle. Task **#33**.

## Repo layout

```
csim/
  src/
    combatsimulator/     ← the engine we want, vendored by MWIX sim-bridge
      data/              ← bundled JSON (fallback only once #33 lands)
      events/
      *.js
    main.js              ← csim's own browser UI entry (not vendored)
    worker.js            ← csim's web worker (not vendored)
    multiWorker.js
  shared/                ← code common to api/ and ui/ but NOT to the engine.
                           Deliberately outside src/combatsimulator/ so it never
                           appears in the upstream diff or the vendored bundle.
                           Today: consumableCost.js (production-time economics).
  api/                   ← Express server (independent product)
  ui/                    ← React UI (independent product)
  locales/               ← i18n strings for the UI
  upstream-update.sh     ← see "Tracking the upstream" above
  MWIX-RELATIONSHIP.md   ← this file
```

When the MWIX sim-bridge (task **#18**) lands, only `src/combatsimulator/`
gets vendored into the Tampermonkey bundle. `api/`, `ui/`, `main.js`, and
the build configs remain csim's own concern.
