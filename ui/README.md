# csim React UI — the canonical frontend

A Mantine-based "workbench" UI for the MWI combat simulator. This is the
frontend we own and develop; the upstream webpack UI (`csim/index.html` +
`csim/src/main.js`) is upstream property and is deliberately left untouched
so the LLM-assisted upstream rebase (`csim/upstream-update.sh`) never
conflicts on UI code.

## Architecture

```
ui/src/hooks/useSimulation.js ──▶ new Worker(../../src/worker.js)   ← upstream's own worker, verbatim
ui/src/hooks/useGameData.js  ──▶ imports ../../src/combatsimulator/data/*.json
ui/src/utils/characterToPlayer.js ──▶ port of tampermonkey/src/kernel/csim-dto.js
```

- **No server required.** The engine runs in a browser Web Worker using
  upstream's `src/worker.js` message protocol (`start_simulation` /
  `simulation_progress` / `simulation_result` / `simulation_error`).
  The Express API (`csim/api/`) still exists for headless/automation use,
  but the UI does not depend on it.
- **Layout**: AppShell workbench — sticky header (zone, tier, duration,
  buffs, Run), left rail (party + per-player config), main area (results
  dashboard with tabs).
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

- Never modify `csim/src/worker.js` or `csim/src/combatsimulator/` from UI
  work — those are upstream-tracked (plus the documented MWIX adaptations).
- The UI only depends on the worker message protocol and the bundled data
  JSON. If upstream changes either, fix forward here, not there.

## Feature parity

See [PARITY.md](./PARITY.md) for the audit against the webpack UI and the
ordered list of gaps (simulate-all-zones, market prices, labyrinth controls,
HP/MP charts, …).
