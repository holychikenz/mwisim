# csim React UI — the canonical frontend

A Mantine-based "workbench" UI for the MWI combat simulator, and csim's
only frontend.

## Architecture

```
ui/src/hooks/useSimulation.js ──▶ new Worker(../../src/worker.js)
ui/src/hooks/useGameData.js  ──▶ imports ../../src/combatsimulator/data/*.json
ui/src/utils/characterToPlayer.js ──▶ port of tampermonkey/src/kernel/csim-dto.js
```

- **No server required.** The engine runs in a browser Web Worker using
  the `src/worker.js` message protocol (`start_simulation` /
  `simulation_progress` / `simulation_result` / `simulation_error`).
  The Express API (`csim/api/`) still exists for headless/automation use,
  but the UI does not depend on it.
- **Layout**: AppShell workbench — sticky header (zone, tier, duration,
  buffs, All Zones, Run), left rail (party + per-player config), main area
  (results dashboard with tabs).
- **All Zones** sweeps every zone/tier combination in a pool of workers
  (`src/workers/allZonesWorker.js`, one `src/worker.js` shard per
  combination) and ranks them by XP/h and effective encounters/hour. See
  [../ALL-ZONES.md](../ALL-ZONES.md).
- **"Load my character"** re-imports a stored character from its game snapshot
  (`src/utils/characterSnapshots.js`, written by the csim-import userscript, not yet built).
- **Iron item times** are computed locally: the snapshot goes through the Rust valuation
  (`rust/crates/mwi-econ`, wasm `item_values`) in a `src/worker.js` job. Needs `./build.sh wasm`.

## Commands

```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api and /health to :3001)
npm run build    # production bundle in dist/
npm run lint
```

## Engine boundary rules

- The UI only depends on the worker message protocol and the bundled data
  JSON. Engine changes belong in `csim/src/`, in their own commits.
- The import/export "set" format (`utils/importSet.js`) stays compatible with
  upstream's simulator, so sets pasted to and from its users keep working.

## Not yet built

1. **Simulate all labyrinths** — every lab monster × room level 40…220. Copy
   the pool in `src/workers/allZonesWorker.js`, with `labyrinth` in place of
   `zone` in the shard payload.
2. **HP/MP chart** — no engine support (the unused time-series was deleted in audit2-17).
3. **Wipe-events log** — per-death diagnostics (the unread `wipeEvents` was deleted in audit2-5).
4. **Simulate from an uploaded JSON.**
5. **Dungeon start-wave override** — no engine wiring exists yet.
6. **i18n** — the UI is English-only.
