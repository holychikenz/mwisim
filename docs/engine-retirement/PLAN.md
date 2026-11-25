# Implementation plan — retiring the csim Node API and the JS engine

Read first: `RESEARCH.md` (in this directory), which maps the consumers and explains each
constraint below.

Two stages, each a set of commits that can be reverted on its own. Stage 1 is **done on
`feat/yo`**. Stage 2 is **not started**: it is blocked on consumers outside this repo.

---

## Stage 1 — the UI no longer needs the API  ✅ implemented

**Goal:** all six optimiser tabs run in the browser, on a pool of Web Workers running the wasm
twin (or the JS engine when Settings selects it). The Express API keeps working, unchanged in
behaviour, for headless use.

**Design: one tool, two transports.** The optimiser logic (validation, preview, plan, search)
already sat in plain-ESM modules. Only the transport and the thread pool were Node-specific, so
those were split out instead of rewritten:

```
api/lib/tools/{triggers,equipment,loadout,abilities,progress,swaps}.js   ← logic moved from routes/*.js (portable)
api/lib/optimizerTool.js        previewTool / planTool / runPlanned / subjectTool / Refusal + cost & fidelity rules (portable)
api/lib/triggerSearch/poolCore.js   the job queue (SimulationPool over any worker), AbortError, makePoolEvaluator, clampPoolSize (portable)
api/lib/triggerSearch/runJob.js     one seeded, scored job on JS or a twin backend (portable)
api/lib/triggerSearch/rng.js        + mulberry32 (moved from determinism.mjs, which re-exports it; drops node:crypto from the browser graph)

Node transport:    routes/*.js → optimizerRoute.toolRouter (Express JSON + SSE) → pool.js (worker_threads) → poolWorker.js → runJob
Browser transport: hooks/useOptimizerRun.js → workers/optimizerHost.js (postMessage) → workers/browserPool.js (Web Workers) → workers/optimizerSim.js → runJob
```

The frames (`start`, `progress`, `result`, `error`, `cancelled`) and the preview JSON are the
same on both transports, so the panels did not change, apart from dropping the "csim API not
running" alert.

**Files changed:**

| File | Change |
|---|---|
| `api/lib/optimizerTool.js` | new: the portable half of `optimizerRoute.js`, plus the tool protocol |
| `api/lib/optimizerRoute.js` | now only Express: `toolRouter`, `streamPoolRun`, `poolSizeFor`; re-exports optimizerTool |
| `api/lib/tools/*.js` | new: the six tools, moved from `routes/*.js` without logic changes |
| `api/routes/*.js` | 5-line adapters: `toolRouter(tool)`; they re-export what the tests import |
| `api/lib/triggerSearch/{poolCore,runJob}.js` | new: moved from `pool.js` and `poolWorker.js` |
| `api/lib/triggerSearch/{pool,poolWorker,search}.js`, `equipmentScan/scan.js`, `determinism.mjs`, `rng.js` | imports re-pointed; names re-exported so SCLIRoster and the tests are unaffected |
| `api/tests/optimizerTool.test.mjs` | new: previewTool/planTool answers, runPlanned frames and teardown, startPool over a non-thread worker |
| `ui/src/workers/{optimizerHost,browserPool,optimizerSim}.js` | new |
| `ui/src/hooks/useOptimizerRun.js` | transport is the host worker: previews go to one long-lived host, and each run gets a fresh host with a heartbeat watchdog |
| `ui/src/App.jsx` | `extra.experimental` added to the optimiser payload (the engine toggle); the API comment and `apiReachable` plumbing dropped |
| `ui/src/components/{Trigger,Equipment,Candidate}OptimizerPanel.jsx` | "csim API not running" alert removed |
| `ui/src/utils/apiBase.js` | deleted (no other user) |
| `ui/vite.config.js` | `worker.format: 'es'` (top-level await in api/lib); `/api` and `/health` dev proxy removed |

**Behaviour changes (intended):**
- The in-browser optimisers honour the Settings engine toggle and `monsterStartCooldown`, as the
  Simulate tab does. The API's pool never applied `extra.experimental`, and still does not.
- The default pool size is `navigator.hardwareConcurrency - 1` (the API's rule uses the server's
  cores). The panel's "workers" field still overrides it, clamped to 16.

**Verification (done):** `npm test` 802/802 with the native twin built (784 + 15 skipped before; +3 new). `sim:check`
464/464 and `eval:check` 29/29. `lab:check` within the CI ratchet (20 ≤ 20, unchanged).
`twin-quick` 142 match on native and wasm. The twin tests (including the seeded trigger search on
JS vs native through the refactored pool) 17/17. ESLint clean. `./build.sh ui` builds. Headless
Chrome: all six tools match Node (RESEARCH.md §6), and cancellation works.

**Rollback:** `git revert` the Stage 1 commit(s). It touches no data or fixtures. The API was
never down, so a revert only sends the UI back to calling it (`npm start` in `api/`). Partial
rollback (keep the refactor, restore the UI's API transport): revert only the `ui/` paths from
the commit (`git checkout <base> -- ui/`); the `api/` refactor is behaviour-identical by its tests.

**Stage 1 follow-ups (small, optional):**
1. Delete `api/server.js`, `api/routes/` and the `express`/`cors` dependencies once nobody uses
   the HTTP API headlessly. Keep `toolRouter` only if a test still needs it.
   `routeBadBody.test.mjs` would become a previewTool/planTool test. **Not `api/` as a whole:**
   SCLIRoster needs `loader.js`, `lib/simulator.js`, `rng.js`, `twin/native.mjs`, `node_modules`.
2. Pool calibration as the peer fork does it (TRIGGER-OPTIMIZER.md §7) if `hardwareConcurrency - 1`
   oversubscribes on some machines.
3. A per-job timeout in the pool (`poolCore.js`): the host's heartbeat, like the API's SSE one, shows the host is alive, not that a job is progressing, so a hung candidate is never timed out (found by review; this predates the branch).
4. A Playwright smoke test of the six tabs in CI (the browser check above was a one-off CDP
   script and is not in the repo).

---

## Stage 2 — retire the JS engine  ⏸ blocked; do not start until the gates below are green

**Gate (every row must be true before deletion):**

| # | Consumer | Needed before JS can go | Owner repo |
|---|---|---|---|
| G1 | `twin:check` uses JS as the oracle | Freeze golden fixtures (2a) | csim |
| G2 | `sim:check`, `eval:check`, `lab:check` fixtures recorded on JS | Re-point them at the twin; re-record **only** after G1 proves twin == JS | csim |
| G3 | `bounds.js`, `labStats.js`: `Player`/`Monster` stats | A wasm/native `combat_details(player DTO, buffs)` and `monster_details(hrid, tier, roomLevel)` entry point, checked against JS on every fixture build | csim (rust) |
| G4 | `shared/guildTrialRuns.js`, `api/lib/simulator.js` import the engine at the top of the file | Load the engine lazily (only on the JS path), so a twin-only caller never touches it | csim |
| G5 | `dataProvider.js`, `simSettings.js`, `guildTrialStats.js` (aggregation) live in the engine directory | Move them to `shared/` or `data/` and leave re-export stubs for one release | csim |
| G6 | SCLIRoster: `Player` stats (triggerPolicy, dtoCheck), `aggregateTrialResults`, `hooks.js`, path map, cache key | Use G3/G5 through `csim.js` only; add `rust/` and `CSIM_ENGINE` to the cache fingerprint; route `dtoCheck.js` through `csim.js` | SCLIRoster |
| G7 | cowstuff MWIX `build-csim.py` vendors the JS engine into the userscript | Either vendor the wasm twin (with `Player`/`Monster` from G3), or **freeze** `_vendor/csim-core.js` and stop rebuilding it from csim | cowstuff |
| G8 | cowstuff webapp-rs default `CSIM_DATA_DIR` = `src/combatsimulator/data` | Follow the data move in G5, or keep the data where it is (recommended: **the data stays**; only the `.js` files go) | cowstuff |
| G9 | `tools/gen*.mjs`, `refreshData.mjs` read engine sources | Point them at the data and the Rust sources | csim |

### 2a. Golden fixtures for `twin:check` (can start now; no deletion)
1. Add `npm run twin:freeze`: run every current twin:check case on **JS** under its seeds and write
   `fixtures/twin/<case>.json` = `{ request, seed, digest, endRngState, trialSummaryDigest?, aggDigest? }`.
2. Make `twin:check` compare the twin against these files by default; keep `--oracle=js` while JS exists.
3. CI: `twin-quick` reads the goldens. A golden change needs a reviewed `twin:freeze`, like `eval:record`.
- Rollback: delete `fixtures/twin/` and the flag; `twin:check` falls back to the JS oracle.

### 2b. Move the twin-only callers off JS (csim)
1. G4: inside `simulator.js` and `guildTrialRuns.js`, import the engine dynamically, only on the JS
   branch. Twin callers then load no JS engine code. SCLIRoster on native benefits at once.
2. G5: move `dataProvider.js`, `simSettings.js`, `guildTrialStats.js` (and `sumDamageToEnemies`) to
   `shared/`; leave one-line re-exports in `src/combatsimulator/` so MWIX's bundler and SCLIRoster
   keep working.
3. G3: add `combat_details` / `monster_details` to `rust/src/lib.rs` (wasm + `csim-native serve`),
   plus a parity test against JS `Player`/`Monster` on every fixture build; then switch `bounds.js`
   and `labStats.js` to it behind the twin backend.
4. Switch defaults: `CSIM_ENGINE` unset means native-if-built, else wasm (not JS); the UI's
   `js` option is removed from Settings and `wantsWasmTwin` becomes always-true.
- Rollback per step: revert the commit; the JS engine still exists throughout 2b.

### 2c. Outside repos (each in its own repo, each reversible)
- SCLIRoster (G6) and cowstuff (G7, G8) as in the gate table. Until G7 lands, csim must keep every
  `.js` file `build-csim.py` requires (it stops when a name disappears).

### 2d. Delete (only when G1–G9 are all green)
1. `git rm src/combatsimulator/*.js` except what G5 left as stubs (delete those one release later);
   drop the JS branches in `src/worker.js`, `runJob.js`, `simulator.js`, `twinEngine.js`
   (`poisonSeededStream` and friends), `api/eval/backrun.mjs`, `twin:trace`'s JS side.
2. Remove the `experimental.engine` setting.
3. Run: `./build.sh check`, `./build.sh twin` (goldens), `lab:check`, SCLIRoster `npm test`,
   cowstuff `node --test tampermonkey/tests/*.test.js` and `uv run build.py`.
- Rollback: `git revert` the deletion commit. The goldens and the twin are unaffected, and outside
  repos keep the vendored/pinned copies they had.

### Risks
- **R1:** freezing goldens freezes today's JS behaviour, including its known quirks (CLAUDE.md
  "Known quirks"). Fixing a quirk later means changing Rust and re-freezing on purpose.
- **R2:** `pow(x, 1.4)` must stay bit-equal per platform (`native.mjs` checks this at startup). With
  JS gone, wasm becomes the cross-platform reference and native must keep its guard.
- **R3:** SCLIRoster's sim cache does not key on the engine today, so cached JS and native
  results mix (pre-existing; fixing G6 closes it).
