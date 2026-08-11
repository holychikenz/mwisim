# Guild Trials — Large-Scale (40+) Combat Simulation Plan

Patch reference: Major Patch — Guild Expansion (2026-07-13).
Data reference: `milkyway_client_info.json` → `guildTrialDetailMap`, `combatMonsterDetailMap` (`isGuildMonster: true`).

## Confirmed rules

| Rule | Detail | Source |
|---|---|---|
| Encounters | 5 combat trials: Badger (2× trial_badger), Chameleon, Jellyfish, Hedgehog (1 each), Swarm (beetle + dragonfly + wasp + firefly) | `guildTrialDetailMap` |
| Tier ladder | Start at level 100; clear a tier → next tier is +10 levels; cap 300. Climb as high as possible within **1 hour** or until failure. **One attempt per week; no re-clears of any tier.** Clearing the cap tier (300) completes the run. Rewards derive from tiers cleared. | patch notes + Morgan |
| Terminology | In-game **"Tier N"** is an index: Tier 0 = monster level 100, Tier 1 = Lv 110, … Tier 20 = Lv 300 (cap). **The engine's `tier`/`startTier`/`finalTier` fields hold the LEVEL** (100…300); tierIndex = (level − 100) / 10. UI displays the dual form ("T3 · Lv 130"); worker/API payloads and result fields remain level-valued. | Morgan |
| Tier scaling | Monster levels scale exactly like labyrinth room levels (`roomLevel / 100` scale factor, already in `Monster`) | Morgan |
| Participant scaling | **+1% monster HP per participant** (HP only; no damage scaling) | Morgan |
| Per-encounter timer | **None** (no lab-style 120 s cutoff) | Morgan |
| Failure | Trial **ends on wipe** (no retry of a tier) | Morgan |
| Enrage | **No enrage mechanic in trials** (despite `enrageTime: 600s` in monster data — do not schedule `EnrageTickEvent`) | Morgan |
| Death | Dead players **stay dead**; `/abilities/revive` works; no 150 s auto-respawn | Morgan |
| Consumables | **No food, no drinks, no coffee.** Food and drinks are replaced by a **flat +3% HP and MP regeneration** | official in-game docs |
| XP & loot | Combat trials grant **no XP and no regular loot** | official in-game docs |
| Loadout | Snapshot of selected loadout; equipment + abilities carry in | patch notes |
| Buffs that apply | House rooms, achievements, community buffs, guild (shrine) buffs | Morgan |
| Buffs that do NOT apply | Scrolls; labyrinth crates/upgrades; anything lab-specific | Morgan |
| Friendly AoE | No target cap | Morgan |
| Parry | **Each incoming attack can receive at most 5 parry attempts** (rolls, across all targets of one attack) | official in-game docs |
| Rewards | Combat base points = **400 first tier + 200 per additional tier** cleared. Guild Points = BasePoints × (1 + BuildersHallBonus). Guild Tokens per participant = (200 first + 100 per additional tier) × (1 + TreasuryBonus). Weekly bonus tokens = 0.5 × TotalBasePoints × (1 + TreasuryBonus) to every eligible member. | official in-game docs |

## Open questions

- [x] ~~Exact built-in bonus HP/MP regen amount~~ — **resolved: flat +3% HP and MP regen** (official docs)
- [x] ~~Parry-vs-AoE cap~~ — **resolved: at most 5 parry attempts per incoming attack** (official docs)
- [x] ~~+1% HP per participant~~ — **confirmed: each signed-up participant increases monster HP by 1%** (official docs)
- [ ] Participant bounds — min to start, max cap? (assume unbounded; UI targets 40)
- [~] Between tiers: do players reset to full HP/MP? Do cooldowns/buff stacks reset? Do dead players return for the next tier, or stay dead for the whole trial? **Engine (Phase 1) implements dungeon-wave-like continuation: players KEEP current HP/MP, buffs and cooldowns across tiers (no reset), and dead players stay dead for the whole run — revive is the only way back.** Only the enemy encounter respawns (standard 3 s delay). Confirm against in-game behaviour when available.
- [ ] Precisely what "scrolls" maps to in sim terms (which buff source to exclude; sim likely does not model them)
- [ ] Monster targeting among 40 players — standard threat mechanics unchanged? Enemy AoE hits all players?
- [ ] BuildersHallBonus / TreasuryBonus values for reward projections (accepted as inputs, default 0)

## Implementation checklist

### Phase 1 — Engine (`src/combatsimulator/`)

- [x] `guildTrial.js` — new `GuildTrial` class (sibling of `Labyrinth`/`Zone`):
  - [x] constructor(trialHrid, startTier, participantCount, options)
  - [x] `getEncounter()` → monsters from `guildTrialDetailMap[trialHrid].monsterHrids`, each `new Monster(hrid, 0, tier)` with HP × `(1 + 0.01 × participantCount)` (applied in `Monster.updateCombatDetails` via `trialHpScaleFactor` so it survives stat recomputes)
  - [x] tier ladder state: current tier, tiers cleared, +10 on clear, cap 300
  - [x] hard stop at 1 hour of simulated trial time (`TRIAL_DURATION_NS`, enforced in `CombatSimulator.simulate`)
- [x] Expose `guildTrialDetailMap` via `dataProvider.js` (+ new `data/guildTrialDetailMap.json`; 8 `trial_*` monsters merged into `combatMonsterDetailMap.json`)
- [x] `CombatSimulator` trial mode (via `options.guildTrial`):
  - [x] do **not** schedule `EnrageTickEvent`
  - [x] do **not** schedule `ConsumableTickEvent` / ignore food & drink loadouts (`checkTriggersForUnit` early-returns in trial mode)
  - [x] built-in bonus HP/MP regen — `GuildTrial.DEFAULT_BONUS_{HP,MP}_REGEN_RATIO = 0.03`, overridable via `options`, added in `processRegenTickEvent`
  - [x] do **not** schedule `PlayerRespawnEvent`; dead players remain dead; revive ability still functions (revive does not depend on respawn events)
  - [x] wipe (all players dead) → trial ends immediately, max tier recorded
  - [x] tier clear → spawn next tier's encounter (standard 3 s `EnemyRespawnEvent`)
  - [x] keep house/achievement/community/guild buffs; exclude lab crates/upgrades (scrolls not modelled by the sim)
- [x] Player buff plumbing: guild (shrine) buffs supplied as buff objects via `extraBuffs` / the worker+API `guildBuffs[]` field (same shape as community buffs)
- [~] Verify hot paths behave with 40 `CombatUnit`s — engine runs 40-player trials; no O(n²) blow-ups observed. Formal perf pass deferred to Phase 2 tuning.
- [x] Verify parry-vs-AoE behaviour; enforce the official 5-attempt cap — see notes below
- [x] `SimResult` extensions: per-tier clear/time, max-tier, per-player death-tier; aggregation in `guildTrialStats.js`

### Phase 2 — Worker & API plumbing

- [x] `worker.js`: `start_guild_trial` payload `{ players[], guildTrial:{trialHrid,startTier,participantCount,trialOptions}, guildBuffs[], extra, iterations }` → returns `{ summaries[] }`
- [x] `multiWorker.js`: `start_simulation_guild_trial` shards iterations across workers; aggregates per-tier results via `aggregateTrialResults`
- [~] Performance pass: profile 40-player, 1-hour ladders; pick default iteration count (deferred; API/worker support arbitrary `iterations`)
- [x] `api/` route (`POST /api/simulate-guild-trial`) + `runGuildTrialSimulation` for headless trial sims

### Engine implementation notes (Phase 1/2)

- **Parry**: the **official model is implemented in guild-trial mode** (gated on `options.guildTrial`; sites marked `OFFICIAL_PARRY_GATE` in `combatSimulator.js`). Per attack event (one auto-attack swing incl. pierce chain, or one ability cast incl. all AoE targets): targets roll their own parry in hit order, every roll (success or failure) consumes one of **5 attempts**; zero-parry and dead targets consume nothing; after 5 attempts remaining targets take damage normally. A success negates **only that target's instance** and triggers that target's parry counter — the cast is NOT broken; multiple targets may parry within the budget. Trial monsters have `parry: null` so monsters never parry in trials today (model is symmetric if that changes). **Legacy behaviour (single roll, cast-break) is preserved exactly for zone/labyrinth** to protect parity; if the official rule proves universal in-game, remove the gate per the `OFFICIAL_PARRY_GATE` comments.
- **Rewards**: `computeTrialRewards` / `aggregateTrialResults` compute expected guild points and tokens/participant from the **distinct** tiers cleared (derived from max tier). **Confirmed by Morgan: there are no re-clears at all** — one weekly attempt, ladder once, rewards from tiers cleared. Clearing the cap tier (300) ends the run with endReason "completed" (alongside "wipe" / "timeout"; aggregate gains `completedRate`).
- **XP / loot**: trial mode skips the XP grant and the drop-rate-multiplier bookkeeping so results report no bogus XP/drops. (The sim never generated actual loot drops anyway.)

### Phase 3 — UI: 40-character roster (`ui/src/`)

- [x] Trial mode adds a dynamic roster (kept SEPARATE from the preserved 5-slot zone/lab `players` state):
  - [x] **master builds** (named, editable) + **roster entries** that *link* to a master build (`ui/src/utils/roster.js`, App `masterBuilds`/`roster` state)
  - [x] editing a master build propagates to all linked roster entries (editor writes `masterBuilds[buildId]`; all entries read it)
  - [x] **"Save as new"** on any entry → deep-copies its build into a fresh master build and relinks the entry
  - [~] stable unique ids for the trial roster; the zone/lab `{1..5}` slots (and their literals) are intentionally kept to preserve that workflow (see brief priority)
- [x] **Roster list view** (trial mode, `GuildTrialPanel.jsx`): compact scrollable list of all characters —
  - [x] row: derived entry name, linked-build badge, cheap weapon + dominant-combat-level summary (no engine call). (A dedicated combat-style glyph was folded into the weapon/level summary.)
  - [x] per-row **Duplicate** (adds a linked clone), **Save-as-new**, and **Delete** buttons
  - [x] "Duplicate selected × N" for stamping out ~20 clones at once
  - [x] participant count displayed (badge; drives the +1% HP scaling, labelled in Trial options)
- [x] Kept the existing 5-slot tab workflow intact for zone/labyrinth sims; trial mode is its own navbar view; builds can be seeded from P1–P5
- [x] Trial mode controls (`HeaderControls.jsx`): trial picker (5 combat encounters), starting tier (100–300 step 10), iterations, participant-count override, Builders' Hall / Treasury % bonuses
- [x] Guild shrine-buff levels input: one guild-wide per-combat-buff level (0 = off) applied to all, resolved to finished buff objects (`ui/src/utils/guildBuffs.js`)
- [x] Character import (MWIX/paste) into a new master build; roster import/export as JSON
- [x] Results view (`GuildTrialResults.jsx`): headline KPIs, tier-ladder table (tier vs P(clear), avg time, deaths at tier), max-tier distribution bars, completed/wipe/timeout rates
  - [ ] Per-player contribution breakdown deferred to Phase 4 (aggregate exposes `deathsByTier`, not per-player; the raw `summaries[].playerDeaths` are available to build it)

### Phase 4 — Tests & parity

- [ ] Unit tests: HP scaling (+1% per participant), tier ladder progression, 1-hour cutoff, wipe ends trial
- [ ] Unit tests: no consumables consumed, no enrage buffs applied, dead-stay-dead + revive path
- [ ] Fixture: known 40-clone roster vs expected tier-100 encounter stats
- [ ] Cross-check vs in-game results once the guild runs its first trials (record actual tier clears as fixtures)
- [ ] Parity note in `ui/PARITY.md` / `MWIX-RELATIONSHIP.md` if upstream adds trial support later
