# The `test` branch

This branch is csim running on the **test server's** game data. It is `main` plus:

- `tools/refreshData.mjs`: `DEFAULT_DUMP` is `cowstuff/milkyway_client_info_test.json`.
- `src/combatsimulator/data/*.json`, refreshed from that dump, along with whatever `./build.sh gen` writes from it
  (`src/combatsimulator/generated/*`, `rust/src/generated.rs`) and any re-recorded `fixtures/{sim,eval}`.
- Gates set aside here only:
  - the two Rust `item_values` market goldens (`#[ignore]`). They are frozen live-data responses of the retired Flask app,
    so they cannot be re-recorded.
  - `lab:check` in CI (`if: github.ref != 'refs/heads/test'`). It compares against live game captures.

## Rules

- **Never merge `test` into `main`.** Engine fixes are made on `main` and merged into `test`. If a fix was made here,
  cherry-pick only that commit onto `main`, never a data, generated or fixture commit.
  Check: `git diff main...test --stat` lists the data files.
- **Never refresh live data here.** A bare `node tools/refreshData.mjs` reads the test dump.
- `twin-quick` must stay green. JS and Rust see the same data, so a mismatch is a real twin bug. Fix it on `main`; never re-record it away.
- Prices stay live. The UI fetches `www.milkywayidle.com/game_data/marketplace.json`, and an item that exists only on test has no price.

## Sync ritual

Run this after each `git merge main` and after each new test dump:

```bash
# conflict in data/generated: take either side, because the refresh overwrites it
git checkout --theirs -- src/combatsimulator/data src/combatsimulator/generated rust/src/generated.rs
# conflict in tools/refreshData.mjs: keep the test-dump DEFAULT_DUMP
node tools/refreshData.mjs && ./build.sh gen
node tools/refreshData.mjs --check      # must print "0 changed"
./build.sh check && ./build.sh rust twin-quick && ./build.sh ui
# eval/sim red: read the case first. Re-record (cd api && npm run eval:record / sim:record)
# only when the game data caused it, and commit the re-record separately from data and code.
```

`refreshData` parses the current files, so it cannot run over conflict markers. That is why the checkout comes first.
Keep three kinds of commit apart: data, generated code, and tests/fixtures.

## Known open items (v1.20260927.0 test dump, 2026-11-12)

- `statSchema.test.mjs` "every numeric stat any item grants…" is **red on purpose**. The talisman belts
  (`small/medium/large_talisman_belt`) grant `talismanPower` and `talismanSlots`, and the engine does not model
  talismans (the cores and orbs build and reroll talisman modifiers). Fix it by modelling them, not by excluding the stats.
- The live and test dumps both report `gameVersion` `v1.20260927.0`, so the version string alone does not tell them apart.
