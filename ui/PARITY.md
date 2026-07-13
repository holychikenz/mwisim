# Feature parity: React UI vs upstream webpack UI

Audit of `csim/ui/` (React + Vite + Mantine workbench) against the upstream
webpack UI (`csim/index.html` + `csim/src/main.js`). The webpack UI is
**upstream-owned** (plus documented MWIX annotations) — it must not be
modified locally beyond those; every change there becomes a conflict in the
LLM-assisted `upstream-update.sh` rebase. The React UI is ours and is the
canonical frontend.

Last audited: 2026-06-02 (post feature-parity pass).

## At parity

| Feature | Notes |
|---|---|
| Zone + difficulty tier selection | Searchable select, grouped regular/dungeon |
| **Labyrinth simulation** | Zone/Lab mode switch: lab monster (isLabyrinthMonster), room level, supply crates (tea/coffee/food × basic/advanced/expert), lab-shop upgrades (+1%/lvl). Results: attempts, completion chance, clears/hr, timeouts/hr. **Better than the old UI**: food/drinks are stripped on lab entry (matching the game and MWIX labyrinth-sim) — the webpack UI keeps them and over-predicts clear rates |
| Simulation duration | Header NumberInput |
| 5-player party (group combat) | Checkboxes select who simulates; tabs select who you edit |
| Levels / equipment (+enhancement) | All 14 slots, two-hand exclusivity preserved |
| Food / drinks (3 + 3) with triggers | Trigger editor on each slot |
| Aura + 4 abilities with levels & triggers | Trigger editor on each slot |
| Houses & achievements | Combat rooms Lv 1–8; tier checkboxes |
| Community exp / drop buffs | Header "Buffs" popover |
| **MooPass + personal seals** | Buffs popover: mooPass switch, 7 seal checkboxes (`extra.personalBuffs`) |
| **Market prices** | Drops tab: live marketplace.json (CN mirror fallback), bid/ask-first modes, treasure-chest expected values |
| **Iron time-value prices** | Drops tab: cow/webapp `/api/value/market?character=…` (seconds-to-acquire), per-character |
| **Expenses & profit** | Drops tab: consumable expense table + income/expenses/profit per hour (P1), in the active unit |
| **Kills / deaths** | Kills tab (monster kills/hr, player deaths/hr) + Player Deaths/Hour KPI |
| **Restoration & mana details** | Consumables tab: health/mana restored per source, mana used, hitpoints spent |
| **Download results JSON** | Button on the Results header |
| Import / export | Same JSON format as the webpack UI (solo + group auto-detect) |
| Loadout save/load | localStorage (`csim_loadouts`) |
| Auto-save of session state | localStorage (`csim_player_data`) |
| Results: encounters, exp/hr, drops, consumables, damage breakdown | Tabbed dashboard |
| In-browser simulation | **Better than parity** — engine runs in a worker, zero server |
| Character import | **Not in webpack UI** — one-click load from cow/webapp |
| MWIX "Open in csim" bridge | `#mwiLabBridge=json:` payloads (loadout + lab context) |

## Remaining gaps

1. **Simulate-all-zones / all-labyrinths** (`src/multiWorker.js`) — fan out
   one worker per zone and compare profit/exp in a table. The worker
   protocol supports it; needs a React orchestration + comparison view.
2. **HP/MP visualization** (`hpChart`) — worker supports
   `extra.enableHpMpVisualization` + `timeSeriesData` progress events;
   needs a chart component.
3. **Equipment sets** (`equipmentSetsModal`) — superseded in practice by
   LoadoutManager + character import; revisit if missed.
4. **Dungeon start-wave override** (`startWaveInput`) — present in the old
   markup; no engine wiring found in current main.js.
5. **Wipe-events log** (`WipeEventsModal`) — per-death diagnostics.
6. **Simulate from uploaded JSON** (`buttonUploadJSONSimulate`).
7. **i18n** (en / zh) — React UI is English-only.
8. **Patch notes modal** (`patchNote.json`).

## Compatibility guarantees to preserve

- **Import/export format**: loadout strings remain interchangeable with the
  webpack UI and upstream users (`utils/importSet.js`).
- **Worker message protocol**: `start_simulation` / `simulation_progress` /
  `simulation_result` / `simulation_error`, with `zone`, `labyrinth`
  (`{labyrinthHrid, roomLevel, crates}`) and `extra`
  (`comExp/comDrop/mooPass/personalBuffs/mwixLabUpgrades/mwixMaze`) —
  identical to upstream `src/worker.js`, consumed verbatim.
- **Bridge protocol**: `#mwiLabBridge=json:<payload>` shared with
  `tampermonkey/src/kernel/sim-launch.js` and the old UI's inline bridge.
- **Pricing endpoints**: marketplace.json shape (`marketData[hrid]['0'].a/.b`)
  and cow/webapp `/api/value/market` (`{values: {hrid: seconds}}`).
