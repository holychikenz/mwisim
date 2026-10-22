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
- **"Load my character"** talks to cow/webapp (port 12345) through the Vite
  proxy (`/cow` → `http://localhost:12345`): `GET /api/characters` and
  `GET /api/character/raw?character=<name>`.

## Commands

```bash
npm install
npm run dev      # http://localhost:5173 (proxy expects cow webapp on :12345)
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
2. **HP/MP chart** — the worker already supports
   `extra.enableHpMpVisualization` and emits `timeSeriesData` progress events.
3. **Wipe-events log** — per-death diagnostics.
4. **Simulate from an uploaded JSON.**
5. **Dungeon start-wave override** — no engine wiring exists yet.
6. **i18n** — the UI is English-only.
