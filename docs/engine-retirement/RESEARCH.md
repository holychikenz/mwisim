# ResearchPack — retiring the csim Node API and the JS engine

Date: 2026-11-25. Branch `feat/yo` (base `780ba98`, where wasm became the UI's default engine).
Scope: who uses the csim Express API (`api/server.js`), who uses the JS combat engine
(`src/combatsimulator/*.js`), and whether each optimiser can run in a browser.

Sources: this repo's code (read directly), plus a read-only sweep of `SCLIRoster/`, `guild/` and
`cowstuff/`. No external libraries are involved. The only platform facts that mattered were
checked in a real browser (headless Chrome 158, see "Verified in a browser" below), not
recalled: module workers, nested workers, and top-level await in an ES-format worker.

## 1. Consumers of the csim API (Express, :3001)

| Consumer | Uses | Status after this branch |
|---|---|---|
| `ui/` six optimiser tabs (Triggers, Gear, Loadout, Abilities, Progress, Swaps) | `POST /api/optimize-*` and `/preview`, `GET /health`, via `ui/src/utils/apiBase.js` and `hooks/useOptimizerRun.js` | **Migrated.** They run in the browser (Stage 1). `apiBase.js` and the Vite `/api` proxy are gone |
| `api/tests/routeBadBody.test.mjs`, `candidateTools.test.mjs` | Mount the routers in Express | Kept. The routers are now thin adapters over the same tools |
| SCLIRoster, guild, cowstuff | **None.** No `:3001`, `/api/optimize-*`, `/health`, `server.js` or `cli.js` reference in code. SCLIRoster's `serve.js` says it "calls csim in process, and never over HTTP". cowstuff's `start-server.py` serves `ui/dist` only | — |

**Conclusion:** after Stage 1, nothing outside `api/` calls the HTTP API. `server.js` and `routes/`
can be deleted whenever headless HTTP use is no longer wanted. Do not delete `api/` as a whole:
SCLIRoster needs `api/loader.js`, `api/lib/simulator.js`, `api/lib/triggerSearch/rng.js`,
`api/lib/twin/native.mjs`, `api/package*.json` and `api/node_modules`.

## 2. Consumers of the JS engine (`src/combatsimulator/*.js`)

### Inside csim

| Consumer | What it uses | Can it move to the twin? |
|---|---|---|
| `src/worker.js` (Simulate tab, All Zones, trials) | Full engine when the engine setting is `js`; wasm otherwise (the default since 780ba98) | Yes. The JS branch is a fallback |
| `src/multiWorker.js` | `aggregateTrialResults` (guildTrialStats) | It is aggregation, not simulation: **port or keep** as a non-engine module |
| `ui/src/workers/optimizerSim.js` (new) | `runJob` JS branch when the engine setting is `js`; `simSettings` | Yes, as above |
| `api/lib/simulator.js` (`runSimulation`, `runGuildTrialSimulation`, `loadGameData`) | Full engine; twin when `CSIM_ENGINE=native\|wasm` | Yes for simulation. **But it imports the engine at the top of the file**, so it cannot load without it |
| `shared/guildTrialRuns.js` | CombatSimulator, Player, GuildTrial, extractTrialSummary (top of file); twin path exists | Same problem: imports load the engine before any twin is chosen |
| `api/lib/triggerSearch/runJob.js` (was poolWorker) | JS branch; twin when a backend is given | Yes |
| `api/lib/triggerSearch/bounds.js` | **`Player` and `Monster` stat computation** (not simulation) for trigger bounds | **No twin equivalent.** Needs a Rust/wasm "combat details" entry point, or keep these classes |
| `api/lib/labStats.js` | `Player`, `Monster` stats | Same |
| `api/lib/triggerSearch/score.js` | `sumDamageToEnemies` (guildTrialStats) | Aggregation: move it into `shared/` |
| `api/lib/*` (target, params, candidates, abilitySearch, swapSearch, progressSearch) | `dataProvider.js` maps only | Data, not engine: move `dataProvider.js` out of the engine directory |
| `shared/twinEngine.js` | `simSettings.js` (settings) | Settings, not engine: move with dataProvider |
| `api/cli.js`, `sim-parity.mjs`, `eval/*`, `bench/*` | `runSimulation` / engine | cli and the eval engine run on the twin with `CSIM_ENGINE`. **sim:check, eval:check and lab:check recorded their fixtures on JS**: they are the oracle |
| `api/twin-parity.mjs` (`twin:check`) | The JS engine **is the reference oracle** | Must move to frozen golden fixtures before JS can go |
| `api/eval/backrun.mjs` | Loads old engine versions | Historical tool; it dies with the JS engine |
| `tools/gen*.mjs`, `tools/refreshData.mjs` | Read engine source and data to generate tables (including Rust tables via `genRustTables.mjs`) | Must be pointed at the data directory and the Rust sources |

### Outside csim (all hard constraints)

| Consumer | What it uses | Engine choice |
|---|---|---|
| SCLIRoster `optimizer/src/csim.js` (path map, `SCLI_CSIM_ROOT`, defaults to `/Users/morgan/pie/farm/csim`) | `api/loader.js`, `api/lib/simulator.js`, `shared/guildTrialRuns.js`, `guildTrialStats.js`, `rng.js`, data JSON, `ui/src/utils/guildBuffs.js`, `rosterBridge.js`, `player.js`, `src/combatsimulator` (engineSrc), `api/node_modules` | Picks native when it is built, else JS (`csim.js:68-89`). It sets `CSIM_ENGINE` before its workers start |
| SCLIRoster `sim/engine.js`, `sim/worker.js` | `runGuildTrialSimulation`, `loadGameData`, `aggregateTrialResults`, `installSeededRandom`, `Player` | Simulation is on the twin when it is selected; the rest is JS only |
| SCLIRoster `sim/run.js`, `triggerPolicy.js` | `Player.createFromDTO().updateCombatDetails()` → max HP/MP for trigger thresholds; `aggregateTrialResults` across shards | **JS only** |
| SCLIRoster `sim/dtoCheck.js:31-42` | `Player.createFromDTO` to validate DTOs. **It builds the `player.js` path itself, which breaks the "only csim.js names csim paths" rule** | JS only |
| SCLIRoster `sim/hooks.js` | Port of `api/loader.js` that targets the engine source | Exists only to load the JS engine |
| SCLIRoster `sim/cache.js` | Fingerprints `src`, `shared`, `api/lib` | **Does not key on `rust/` or `CSIM_ENGINE`** (a risk, not caused by this branch) |
| SCLIRoster tests (csim-boundary, trial-request, tracked-set, export-roster) | Check engine paths and exports | — |
| cowstuff `tampermonkey/build-csim.py` | **Bundles every `src/combatsimulator/*.js` into `_vendor/csim-core.js`** for the MWIX userscript (`CombatSimulator`, `Player`, `Monster`, `Zone`, `Labyrinth`) and stops if one is missing | **Hard-wired JS**, in the game tab (sim-bridge, labyrinth-sim, csim-dto) |
| cowstuff `webapp-rs` | Rust `csim-twin` crate (git, pinned rev) plus the data directory `src/combatsimulator/data` | Rust already; needs the data path only |
| guild | Comments and a Python port of `computeTrialRewards` | none |

No sibling repo has CI that checks out csim.

**Conclusion:** the JS engine **cannot** be deleted yet. Three outside consumers depend on the
files themselves (SCLIRoster in-process, MWIX's vendored bundle, the data directory for
webapp-rs), and inside csim the twin has no counterpart for `Player`/`Monster` stat
computation (`bounds.js`, `labStats.js`, SCLIRoster's `triggerPolicy`/`dtoCheck`).

## 3. Twin coverage (is the Rust engine enough?)

`twin:check` (`api/twin-parity.mjs`) compares the twin with JS bit for bit (the result digest
**and** the end RNG state) on:
- every `fixtures/sim/*.json` request through `runSimulation`;
- every `fixtures/eval/*` case: 13 zone, 5 dungeon, 4 labyrinth and 3 trial cases (badger ×3 configurations), through the eval engine's `runZone`, `runLab` and `runTrial`;
- extra live cases: house rooms + achievements + guild buff, swarm and jellyfish trials (with `enemyScale`), and a labyrinth with crates.

Trial cases also compare `extractTrialSummary` and a 3-iteration `aggregateTrialResults`. Zone,
dungeon (including run mode: `runLimits`), labyrinth and trial are all covered.
`api/tests/twinTriggerSearch.test.mjs` adds a seeded trigger search through the pool on JS and
native.

Not covered: `simSettings` other than the defaults (`monsterStartCooldown` is passed through,
and the twin reads it), and a trial at every boss (hedgehog and chameleon have no case).

## 4. Optimisers: Node-only or portable?

| Module | Node-only? | Notes |
|---|---|---|
| `routes/*.js` | Yes (Express) | Logic moved to `api/lib/tools/*.js` (portable); the routes are now 5-line adapters |
| `lib/optimizerRoute.js` | Yes (Express, SSE) | Split: the portable half is now `lib/optimizerTool.js` |
| `lib/triggerSearch/pool.js` | Yes (`worker_threads`, `os`) | The queue moved to portable `poolCore.js`; `pool.js` only spawns threads |
| `lib/triggerSearch/poolWorker.js` | Yes (`parentPort`) | The job body moved to portable `runJob.js` |
| `lib/determinism.mjs` | Yes (`crypto`) | `mulberry32` moved to `rng.js` (portable) and is re-exported |
| `lib/simulator.js` | Yes (`fs`, `path`) | Not needed by the tools any more (`buildExtraBuffs` comes from `shared/communityBuffs.js`) |
| `lib/twin/*.mjs` | Yes (`child_process`, `fs`) | The browser has `src/twinWasm.js` |
| `search.js`, `scan.js`, `stats.js`, `candidates.js`, `params.js`, `grids.js`, `bounds.js`, `score.js`, `target.js`, `descent.js`, `abilitySearch.js`, `swapSearch.js`, `progressSearch.js` | **Portable** | Plain ESM. Some load data with top-level `await import(...)`, which needs ES-format workers |

All six optimisers are portable. The only Node-specific parts were the transport (Express/SSE),
the thread pool and the job's message loop.

## 5. Browser constraints found

- **Top-level await** in `api/lib` (`await import('…/dataProvider.js')`) needs `worker.format: 'es'`.
  Vite's default worker format, iife, cannot express it. Vite 7's default build target supports
  TLA. The dynamic imports stay because Node callers that register the loader at runtime
  (SCLIRoster) depend on them.
- **A module worker drops messages that arrive while its imports evaluate.** With TLA in the
  graph, a `postMessage` sent right after `new Worker()` was lost (seen in Chrome: no reply, no
  error). So the two new workers set `onmessage` first and load the heavy modules with dynamic
  `import()`.
- **Nested workers** (a worker spawning workers) already ran in production (`src/multiWorker.js`).
  Terminating the parent ends the children.
- `node:crypto` in `determinism.mjs` would break the browser bundle; hence the `rng.js` move.

## 6. Verified in a browser

Headless Chrome 158 against `vite preview` of `ui/dist`. All six tools ran through
`optimizerHost.js` on wasm and on js. The bodies used the `BUILDS.melee` L200 player, gobo T0,
`seedBase` 11 and 2 workers.
- Previews: byte-identical to Node's `previewTool`.
- Run frames: identical to Node's `runPlanned` on a `worker_threads` pool, on both engines,
  except a 1-ulp difference in a `pValue` of 0.5 (`0.5000000000000002` vs `…03`). That is the
  statistics code (`stats.js`) under V8 versions with different math libraries, not the
  simulation. Simulation metrics were identical.
- Node: wasm and js frames are identical for all six tools.
- Cancellation: a `cancel` 1.5 s into a 1000 h × 10 replicate scan answered with
  `cancelled: Equipment scan cancelled` and `done` at once.
