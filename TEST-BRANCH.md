# The `test` branch

This branch is csim running on the **test server's** game data. It is `main` plus:

- `tools/refreshData.mjs`: `DEFAULT_DUMP` is `cowstuff/milkyway_client_info_test.json`.
- `src/combatsimulator/data/*.json`, refreshed from that dump, along with whatever `./build.sh gen` writes from it
  (`src/combatsimulator/generated/*`, `rust/src/generated.rs`) and any re-recorded `fixtures/{sim,eval}`.
- Gates set aside here only:
  - the two Rust `item_values` market goldens (`#[ignore]`). They are frozen live-data responses of the retired Flask app,
    so they cannot be re-recorded.
  - `lab:check` in CI, on pushes to `test` and PRs into it (`github.ref`/`github.base_ref`). It compares against live game captures.
  - The talisman stat check in `api/tests/statSchema.test.mjs`. Its talisman part is a node:test `todo`, so it is
    reported but does not fail `npm test`. Any other unmodelled stat still fails.

## Rules

- **Never merge `test` into `main`.** Engine fixes are made on `main` and merged into `test`. If a fix was made here,
  cherry-pick only that commit onto `main`. **Never cherry-pick any `(test)`-scope commit** (`chore(test)`, `feat(test)`,
  `test(test)`, `docs(test)`): they carry the test dump default, test data, and the switched-off gates.
  Check: `git diff main...test --stat` lists the data files.
- **Never refresh live data here.** A bare `node tools/refreshData.mjs` reads the test dump.
- `twin-quick` must stay green. JS and Rust see the same data, so a mismatch is a real twin bug. Fix it on `main`; never re-record it away.
- Prices stay live. The UI fetches `www.milkywayidle.com/game_data/marketplace.json`, and an item that exists only on test has no price.

## Sync ritual

Run this after each `git merge main` and after each new test dump:

```bash
# ONLY after a `git merge main` with conflicts (it discards unstaged edits otherwise):
#   data/generated: take either side, because the refresh overwrites it
git checkout --theirs -- src/combatsimulator/data src/combatsimulator/generated rust/src/generated.rs
#   tools/refreshData.mjs: keep the test-dump DEFAULT_DUMP, by hand

# every time:
node tools/refreshData.mjs | tee /dev/stderr | grep -q '^source .*_test\.json$' || { echo 'NOT the test dump'; false; }
./build.sh gen
git add tools/refreshData.mjs src/combatsimulator/data src/combatsimulator/generated rust/src/generated.rs fixtures
./build.sh rust check ui                # check includes twin-quick
# eval/sim red: read the case first. Re-record (cd api && npm run eval:record / sim:record)
# only when the game data caused it, and commit the re-record separately from data and code.
```

`refreshData` parses the current files, so it cannot run over conflict markers. That is why the checkout comes first.
The `grep` asserts the source dump is the test dump: its name is the only thing that shows the server,
because `gameVersion` is the same on both.
A merge commit that resolves conflicts carries data and generated changes together. That is unavoidable; keep every
other commit to a single kind.
Keep three kinds of commit apart: data, generated code, and tests/fixtures.

## Known open items (v1.20260927.0 test dump, 2026-11-12)

- Talismans are not modelled. The talisman belts
  (`small/medium/large_talisman_belt`) grant `talismanPower` and `talismanSlots`, and the engine does not model
  talismans (the cores and orbs build and reroll talisman modifiers). It is tracked as a `todo` test, and a guard test
  fails once they are modelled, so `UNMODELLED_ON_TEST` gets deleted then.
- The dump cross-checks in `dropCredit.test.mjs` and `guildBuffs.test.mjs` still read the **live**
  `milkyway_client_info.json`, not the test dump.
- The live and test dumps both report `gameVersion` `v1.20260927.0`, so the version string alone does not tell them apart.
