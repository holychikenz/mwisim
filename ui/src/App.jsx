import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  AppShell,
  Group,
  Stack,
  Title,
  Text,
  Badge,
  Tabs,
  Checkbox,
  ScrollArea,
  Alert,
  Center,
  Divider
} from '@mantine/core';
import { useGameData } from './hooks/useGameData';
import { useSimulation } from './hooks/useSimulation';
import { useAllZones } from './hooks/useAllZones';
import { useTriggerOptimizer } from './hooks/useTriggerOptimizer';
import { useEquipmentOptimizer } from './hooks/useEquipmentOptimizer';
import { usePrices } from './hooks/usePrices';
import { exportFormatToPlayer } from './utils/importSet';
import { readMwixBridgePayload, clearMwixBridgeHash } from './utils/mwixBridge';
import { HeaderControls } from './components/HeaderControls';
import { PlayerConfig } from './components/PlayerConfig';
import { SimulationResults } from './components/SimulationResults';
import { AllZonesModal } from './components/AllZonesModal';
import { AllZonesResults } from './components/AllZonesResults';
import { GuildTrialResults } from './components/GuildTrialResults';
import { GuildTrialPanel } from './components/GuildTrialPanel';
import { TriggerOptimizerPanel } from './components/TriggerOptimizerPanel';
import { TriggerOptimizerResults } from './components/TriggerOptimizerResults';
import { EquipmentOptimizerPanel } from './components/EquipmentOptimizerPanel';
import { EquipmentOptimizerResults } from './components/EquipmentOptimizerResults';
import { ItemCostsView } from './components/ItemCostsView';
import { TrialMonsterCards } from './components/TrialMonsterCards';
import { ImportExport } from './components/ImportExport';
import { ProgressBar } from './components/ProgressBar';
import { LoadoutManager } from './components/LoadoutManager';
import { CharacterImport } from './components/CharacterImport';
import { TextInput } from '@mantine/core';
import { toPlayerDTO } from './utils/playerDTO';
import {
  resolveGuildBuffs,
  resolveGuildBuildingBuffs,
  GUILD_COMBAT_BUFFS,
  MAX_GUILD_BUFF_LEVEL
} from './utils/guildBuffs';
import {
  makeId,
  deepClone,
  uniqueBuildName,
  loadGuildTrialState,
  saveGuildTrialState,
  normalizeRoster,
  rosterSize,
  clampCount
} from './utils/roster';
import { buildConsumableCosts, describeConsumableCosts } from './utils/consumableCosts';
import {
  loadTriggerOptState,
  saveTriggerOptState,
  toAddress,
  toStages,
  triggerKey
} from './utils/triggerOptimizer';
import {
  loadEquipmentOptState,
  saveEquipmentOptState,
  toScan
} from './utils/equipmentOptimizer';
import { loadOptTarget, saveOptTarget, toTargetPayload } from './utils/optimizerTarget';
import { loadSession } from './utils/session';
import {
  DEFAULT_ZONE_HRID,
  simulableZones,
  zoneTiers,
  maxTierFor,
  resolveZoneHrid,
  clampTier
} from './utils/zones';
import {
  comboKey,
  parseComboKey,
  loadAllZonesState,
  saveAllZonesState,
  defaultWorkerCount,
  DEFAULT_SWEEP_HOURS
} from './utils/allZones';

const ONE_HOUR = 60 * 60 * 1e9;

// -- Resizable left column (AppShell navbar) ---------------------------------
// Width is user-draggable within [NAV_MIN, NAV_MAX] and persisted so the choice
// survives reloads. Double-clicking the handle restores NAV_DEFAULT.
const NAV_MIN = 300;
const NAV_MAX = 760;
const NAV_DEFAULT = 430;
const NAV_WIDTH_KEY = 'csim_navbar_width';

function loadNavbarWidth() {
  try {
    const v = Number(localStorage.getItem(NAV_WIDTH_KEY));
    if (Number.isFinite(v) && v >= NAV_MIN && v <= NAV_MAX) return v;
  } catch {
    /* ignore — fall through to default */
  }
  return NAV_DEFAULT;
}

function saveNavbarWidth(w) {
  try {
    localStorage.setItem(NAV_WIDTH_KEY, String(w));
  } catch {
    /* ignore — persistence is best-effort */
  }
}

const createDefaultPlayer = (id) => ({
  hrid: `player${id}`,
  staminaLevel: 1,
  intelligenceLevel: 1,
  attackLevel: 1,
  meleeLevel: 1,
  defenseLevel: 1,
  rangedLevel: 1,
  magicLevel: 1,
  equipment: {},
  food: [null, null, null],
  drinks: [null, null, null],
  abilities: [null, null, null, null, null],
  houseRooms: {},
  achievements: {},
  debuffOnLevelGap: 0
});

const createInitialPlayers = () => ({
  1: createDefaultPlayer(1),
  2: createDefaultPlayer(2),
  3: createDefaultPlayer(3),
  4: createDefaultPlayer(4),
  5: createDefaultPlayer(5)
});

function App() {
  const { data: gameData } = useGameData();
  const {
    loading: simLoading,
    progress: simProgress,
    results,
    error: simError,
    runSimulation,
    runGuildTrial,
    clearResults
  } = useSimulation();

  // The trigger optimiser is the only feature that runs on the csim API rather
  // than in a browser worker — the search is hundreds of simulations and belongs
  // on a machine with real threads. See utils/apiBase.js.
  const triggerOpt = useTriggerOptimizer();
  const [triggerOptConfig, setTriggerOptConfig] = useState(() => loadTriggerOptState().config);
  const [triggerOptSelection, setTriggerOptSelection] = useState([]);

  const equipOpt = useEquipmentOptimizer();
  const [equipOptConfig, setEquipOptConfig] = useState(() => loadEquipmentOptState().config);
  // Row ids ("0:/equipment_types/head"), not objects: an equipment address is a
  // stable (player, slot) pair rather than a positional index, so a plain string
  // survives edits that would invalidate a trigger address.
  const [equipOptSelection, setEquipOptSelection] = useState([]);

  // Zone or labyrinth for BOTH optimisers — see utils/optimizerTarget.js for why
  // the choice is shared rather than held per-optimiser.
  const [optTarget, setOptTarget] = useState(loadOptTarget);

  // The auto-saved session, read ONCE at initialisation — see utils/session.js
  // for why this is not an effect (it was, and the save above it erased the
  // session on every mount before the restore could read it).
  const savedSession = useMemo(() => loadSession(), []);

  const [players, setPlayers] = useState(
    () => savedSession?.players || createInitialPlayers()
  );
  const [navbarWidth, setNavbarWidth] = useState(loadNavbarWidth);
  const [activeTab, setActiveTab] = useState(1);
  const [selectedPlayers, setSelectedPlayers] = useState(
    () => (Array.isArray(savedSession?.selectedPlayers) && savedSession.selectedPlayers.length
      ? savedSession.selectedPlayers
      : [1])
  );
  const [simMode, setSimMode] = useState('zone');

  // Guild-trial state (separate from the fixed 5-slot zone/lab `players`).
  // masterBuilds: { [id]: { id, name, ...playerFields } }  — named editable builds
  // roster:       [ { id, buildId, count } ]               — ONE counted row per build
  const [masterBuilds, setMasterBuilds] = useState(() => loadGuildTrialState().masterBuilds);
  const [roster, setRoster] = useState(() => loadGuildTrialState().roster);
  const [selectedEntryId, setSelectedEntryId] = useState(() => loadGuildTrialState().selectedEntryId);
  const [trialConfig, setTrialConfig] = useState(() => loadGuildTrialState().trialConfig);
  // A planet, not a solo monster: '/actions/combat/fly' is a spawn inside Smelly
  // Planet rather than a destination, and solo actions are no longer selectable
  // (utils/zones.js). A restored or imported solo hrid — and any tier past the
  // zone's ceiling — is repaired by the effect below.
  const [zone, setZone] = useState(() => savedSession?.zone || DEFAULT_ZONE_HRID);
  const [difficultyTier, setDifficultyTier] = useState(
    () => (typeof savedSession?.difficultyTier === 'number' ? savedSession.difficultyTier : 0)
  );
  const [labConfig, setLabConfig] = useState({
    monsterHrid: '/monsters/cyclops',
    roomLevel: 100,
    // Expert on all three, because nobody carries anything else — one crate of
    // each type is consumed on entry regardless of tier, so bringing a basic
    // crate is simply a worse run for the same cost. Defaulting them to empty
    // modelled a player who had brought no supplies at all, which is not a
    // situation anyone is in, and it understated the clear rate accordingly.
    // Still clearable in the Supplies popover for the rare run without them.
    crates: {
      tea: '/items/expert_tea_crate',
      coffee: '/items/expert_coffee_crate',
      food: '/items/expert_food_crate'
    },
    upgrades: { combatDamage: 0, attackSpeed: 0, castSpeed: 0, criticalRate: 0 }
  });
  const [duration, setDuration] = useState(
    () => (typeof savedSession?.duration === 'number' ? savedSession.duration : 100)
  );
  const [extraOptions, setExtraOptions] = useState({
    comExp: 0,
    comDrop: 0,
    mooPass: false,
    personalBuffs: []
  });
  // Set when an MWIX bridge payload carries labyrinth context (maze on) —
  // zone sims then still apply the lab-shop upgrades, like the old UI.
  const [mazeContext, setMazeContext] = useState(false);
  const [bridgeMessage, setBridgeMessage] = useState(null);

  // -- All Zones sweep -------------------------------------------------------
  // Its own engine (a worker pool, hooks/useAllZones.js) rather than a sim mode:
  // the sweep answers "which zone", using exactly the party, buffs and shrines
  // the single-zone Run would use. Only the hours are its own — see
  // DEFAULT_SWEEP_HOURS for why they are not the header's.
  const allZones = useAllZones();
  const [allZonesOpen, setAllZonesOpen] = useState(false);
  const [allZonesView, setAllZonesView] = useState(false);
  const storedSweep = useMemo(() => loadAllZonesState(), []);
  const [allZonesSelection, setAllZonesSelection] = useState(
    () => new Set(storedSweep?.selection || [])
  );
  const [allZonesHours, setAllZonesHours] = useState(
    () => storedSweep?.hours || DEFAULT_SWEEP_HOURS
  );
  const [allZonesWorkers, setAllZonesWorkers] = useState(
    () => storedSweep?.workers || defaultWorkerCount()
  );
  // First visit (or a session saved before the sweep existed): select the lot.
  // A button called "All Zones" that opens an empty grid is a riddle.
  const sweepInitialised = useRef(storedSweep?.selection != null);

  const pricing = usePrices(gameData);

  // MWIX in-game bridge: "Open in csim" lands here with a #mwiLabBridge=
  // payload. Runs after child effects (ImportExport's localStorage restore),
  // so the imported loadout wins over the previous session.
  useEffect(() => {
    const payload = readMwixBridgePayload();
    if (!payload) return;
    try {
      const importSet = payload.importSet || payload;
      const player = exportFormatToPlayer(importSet, 1);
      setPlayers(prev => ({ ...prev, 1: player }));
      setSelectedPlayers([1]);
      setActiveTab(1);
      if (importSet.zone) setZone(importSet.zone);
      if (importSet.difficultyTier != null) {
        setDifficultyTier(Number(importSet.difficultyTier) || 0);
      }
      if (importSet.simulationTime != null) {
        setDuration(Math.max(1, Number(importSet.simulationTime) || 24));
      }
      // Labyrinth context: the worker understands extra.mwixLabUpgrades and
      // extra.mwixMaze (the lab-shop combat upgrades apply only when the
      // maze toggle is on — see csim/src/worker.js).
      const ctx = payload.mwixContext;
      const labUpgrades = ctx?.labUpgrades || null;
      const maze = ctx?.maze || null;
      if (labUpgrades) {
        setLabConfig(prev => ({
          ...prev,
          upgrades: {
            combatDamage: Math.max(0, Number(labUpgrades.combatDamage) || 0),
            attackSpeed: Math.max(0, Number(labUpgrades.attackSpeed) || 0),
            castSpeed: Math.max(0, Number(labUpgrades.castSpeed) || 0),
            criticalRate: Math.max(0, Number(labUpgrades.criticalRate) || 0)
          }
        }));
      }
      setMazeContext(!!maze?.enabled);

      // Guild shrines: the character's own purchased shrine levels, keyed by
      // guild-buff hrid. They are permanent character buffs — every fight gets
      // them — so they land in the SHARED `trialConfig.guildBuffLevels` knobs
      // that the zone, labyrinth and trial paths all read.
      //
      // The payload REPLACES the stored levels rather than merging into them:
      // it is the authoritative statement of what this character owns, and a
      // character with no shrines must not silently inherit whatever the last
      // session had dialled in. An absent `guildShrines` key (an older MWIX
      // build) is left alone — only a present object triggers the replacement.
      // Unknown keys are dropped by iterating our own definition list, so a
      // future skilling shrine leaking into the payload cannot reach the knobs.
      const shrineLevels = ctx?.guildShrines;
      const shrineBits = [];
      if (shrineLevels && typeof shrineLevels === 'object') {
        const levels = {};
        for (const def of GUILD_COMBAT_BUFFS) {
          const raw = Math.floor(Number(shrineLevels[def.hrid]) || 0);
          const level = Math.max(0, Math.min(MAX_GUILD_BUFF_LEVEL, raw));
          if (level <= 0) continue;
          levels[def.hrid] = level;
          shrineBits.push(`${def.name} ${level}`);
        }
        setTrialConfig(prev => ({ ...prev, guildBuffLevels: levels }));
      }

      const bits = [];
      if (payload.loadout?.name) bits.push(payload.loadout.name);
      if (maze?.enabled) bits.push('maze on');
      if (labUpgrades && (labUpgrades.combatDamage || labUpgrades.attackSpeed || labUpgrades.castSpeed || labUpgrades.criticalRate)) {
        bits.push('lab upgrades applied');
      }
      if (shrineBits.length) bits.push('shrines: ' + shrineBits.join(', '));
      setBridgeMessage(
        `MWIX loadout imported into P1${bits.length ? ' — ' + bits.join(' · ') : ''}`
      );
      console.info('[mwix-bridge] imported payload from', payload.source, payload);
    } catch (err) {
      console.error('[mwix-bridge] import failed:', err);
      setBridgeMessage('MWIX import failed — see console.');
    } finally {
      clearMwixBridgeHash();
    }
  }, []);

  // Every route into `zone` — the header select, an import, the MWIX bridge,
  // the localStorage restore — goes through here, so a solo-monster hrid from an
  // older session becomes the planet it belongs to instead of leaving the select
  // blank. The tier is clamped in the same breath: T5 is meaningless on a
  // dungeon, which stops at T2.
  const handleZoneChange = useCallback((hrid) => {
    const list = gameData?.zones;
    const next = resolveZoneHrid(list, hrid);
    setZone(next);
    setDifficultyTier(tier => clampTier(list, next, tier));
  }, [gameData]);

  // The same repair, applied to whatever else writes zone OR tier: the
  // localStorage restore, the MWIX bridge and ImportExport all set them from
  // their own effects, which run before this one. Both are watched, because a
  // set exported before the tier list became data-driven can name T7 on a zone
  // the user is ALREADY standing on — the zone never changes, so watching the
  // zone alone would never re-run, and Mantine renders an unmatched Select value
  // as an empty box while Run happily simulates a tier the game does not have.
  // Setting an already-valid value is a no-op (React bails out on an identical
  // value), so this converges rather than loops.
  useEffect(() => {
    if (!gameData?.zones) return;
    const repaired = resolveZoneHrid(gameData.zones, zone);
    setZone(repaired);
    setDifficultyTier(tier => clampTier(gameData.zones, repaired, tier));
  }, [gameData, zone, difficultyTier]);

  // Default sweep selection: every zone at every tier it offers.
  useEffect(() => {
    if (sweepInitialised.current || !gameData?.zones) return;
    sweepInitialised.current = true;
    const keys = [];
    for (const z of simulableZones(gameData.zones)) {
      for (const tier of zoneTiers(z)) keys.push(comboKey(z.hrid, tier));
    }
    setAllZonesSelection(new Set(keys));
  }, [gameData]);

  useEffect(() => {
    saveAllZonesState({
      selection: [...allZonesSelection],
      hours: allZonesHours,
      workers: allZonesWorkers
    });
  }, [allZonesSelection, allZonesHours, allZonesWorkers]);

  const handlePlayerChange = useCallback((playerId, updatedPlayer) => {
    setPlayers(prev => ({
      ...prev,
      [playerId]: updatedPlayer
    }));
  }, []);

  const handleSelectedPlayersChange = useCallback((values) => {
    if (values.length === 0) return; // Must have at least one player
    setSelectedPlayers(values.map(Number).sort((a, b) => a - b));
  }, []);

  // Drag-to-resize the left column. The navbar hugs the viewport's left edge,
  // so pointer clientX IS the desired width (clamped). We persist only on
  // pointer-up (via the functional setState) to avoid a localStorage write per
  // mouse-move frame.
  const handleNavbarResizeStart = useCallback((e) => {
    e.preventDefault();
    const onMove = (ev) => {
      const w = Math.max(NAV_MIN, Math.min(NAV_MAX, Math.round(ev.clientX)));
      setNavbarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setNavbarWidth(w => { saveNavbarWidth(w); return w; });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const handleNavbarResizeReset = useCallback(() => {
    setNavbarWidth(NAV_DEFAULT);
    saveNavbarWidth(NAV_DEFAULT);
  }, []);

  // -- Guild-trial persistence (mirrors ImportExport's localStorage pattern) --
  useEffect(() => {
    saveGuildTrialState({ masterBuilds, roster, selectedEntryId, trialConfig });
  }, [masterBuilds, roster, selectedEntryId, trialConfig]);

  const selectedEntry = roster.find(e => e.id === selectedEntryId) || null;
  const selectedBuild = selectedEntry ? masterBuilds[selectedEntry.buildId] || null : null;
  // Participants = SUM of row counts (each participant adds +1% monster HP),
  // unless explicitly overridden in trial options.
  const participantCount = trialConfig.participantCount ?? rosterSize(roster);
  // The selected trial's monster reference (rendered as cards in the viewport).
  const selectedTrialDetail = (gameData?.guildTrials || []).find(t => t.hrid === trialConfig.trialHrid) || null;

  // -- Guild-trial roster operations ----------------------------------------

  // Create a master build from a player-shaped object and (optionally) a
  // linked roster row (count 1). Returns the new build id.
  const addBuildFromPlayer = useCallback((playerObj, name, { withEntry = true } = {}) => {
    const buildId = makeId('mb');
    setMasterBuilds(prev => ({
      ...prev,
      [buildId]: { ...deepClone(playerObj), id: buildId, name: uniqueBuildName(name, prev) }
    }));
    if (withEntry) {
      const entryId = makeId('re');
      setRoster(prev => [...prev, { id: entryId, buildId, count: 1 }]);
      setSelectedEntryId(entryId);
    }
    return buildId;
  }, []);

  const addBlankBuild = useCallback(() => {
    addBuildFromPlayer(createDefaultPlayer('build'), 'New build');
  }, [addBuildFromPlayer]);

  const addBuildFromSlot = useCallback((slotId) => {
    const src = players[slotId];
    if (!src) return;
    addBuildFromPlayer(src, `P${slotId} build`);
  }, [players, addBuildFromPlayer]);

  // Saved zone/lab loadout (LoadoutManager store) → new master build + row.
  // The stored player object is already in the UI-internal shape; hrid is
  // stamped at DTO time, so only debuffOnLevelGap needs a default.
  const addBuildFromLoadout = useCallback((loadout) => {
    if (!loadout?.player) return;
    addBuildFromPlayer(
      { debuffOnLevelGap: 0, ...loadout.player },
      loadout.name || 'Loadout build'
    );
  }, [addBuildFromPlayer]);

  // Add N participants of an EXISTING master build. Counted model: if the
  // build already has a row, its count grows; otherwise one new row appears.
  const addEntriesForBuild = useCallback((buildId, count = 1) => {
    if (!buildId) return;
    const n = Math.max(1, Math.round(Number(count) || 1));
    setRoster(prev => {
      const existing = prev.find(e => e.buildId === buildId);
      if (existing) {
        return prev.map(e =>
          e.buildId === buildId ? { ...e, count: clampCount((e.count ?? 1) + n) } : e
        );
      }
      return [...prev, { id: makeId('re'), buildId, count: clampCount(n) }];
    });
  }, []);

  // Duplicate = grow the row's count (no new rows for the same build).
  const handleDuplicate = useCallback((entryId, count = 1) => {
    const n = Math.max(1, Math.round(Number(count) || 1));
    setRoster(prev => prev.map(e =>
      e.id === entryId ? { ...e, count: clampCount((e.count ?? 1) + n) } : e
    ));
  }, []);

  // Direct edit of a row's ×N input (min 1 — removing is explicit via delete).
  const handleSetCount = useCallback((entryId, count) => {
    setRoster(prev => prev.map(e =>
      e.id === entryId ? { ...e, count: clampCount(count) } : e
    ));
  }, []);

  // Save-as-new: detach ONE unit into its own build.
  //   count > 1 → decrement the source row, add a NEW count-1 row (right after
  //               it) linked to a deep copy of the build, and select it.
  //   count = 1 → relink the row in place to the copy (as before).
  const handleSaveAsNew = useCallback((entryId) => {
    const entry = roster.find(e => e.id === entryId);
    if (!entry) return;
    const src = masterBuilds[entry.buildId];
    if (!src) return;
    const newBuildId = makeId('mb');
    setMasterBuilds(prev => ({
      ...prev,
      [newBuildId]: { ...deepClone(src), id: newBuildId, name: uniqueBuildName(src.name, prev) }
    }));
    const count = clampCount(entry.count ?? 1);
    if (count > 1) {
      const newEntryId = makeId('re');
      setRoster(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const next = prev.map(e =>
          e.id === entryId ? { ...e, count: count - 1 } : e
        );
        next.splice(idx + 1, 0, { id: newEntryId, buildId: newBuildId, count: 1 });
        return next;
      });
      setSelectedEntryId(newEntryId);
    } else {
      setRoster(prev => prev.map(e => (e.id === entryId ? { ...e, buildId: newBuildId } : e)));
    }
  }, [roster, masterBuilds]);

  // Permanently delete a MASTER BUILD (not just a roster row). Unlike
  // handleDeleteEntry — which keeps the build as a re-addable orphan — this
  // removes the build from the store AND drops every roster row linked to it,
  // mending the selection if the selected row was one of them.
  const handleDeleteBuild = useCallback((buildId) => {
    if (!buildId) return;
    const nextRoster = roster.filter(e => e.buildId !== buildId);
    setMasterBuilds(prev => {
      const next = { ...prev };
      delete next[buildId];
      return next;
    });
    setRoster(nextRoster);
    // If the currently-selected row linked to this build, it no longer exists —
    // fall back to the first remaining row (or nothing on an empty roster).
    if (selectedEntry && selectedEntry.buildId === buildId) {
      setSelectedEntryId(nextRoster[0]?.id ?? null);
    }
  }, [roster, selectedEntry]);

  // Remove a whole row (all N participants). The master build is intentionally
  // KEPT even when this was its only row (it becomes a re-addable orphan).
  const handleDeleteEntry = useCallback((entryId) => {
    const idx = roster.findIndex(e => e.id === entryId);
    if (idx === -1) return;
    const next = roster.filter(e => e.id !== entryId);
    setRoster(next);
    if (selectedEntryId === entryId) {
      // Move the selection to the entry that shifted into this slot, else the
      // previous one, else the first, else nothing (empty roster).
      const fallback = next[idx] || next[idx - 1] || next[0] || null;
      setSelectedEntryId(fallback ? fallback.id : null);
    }
  }, [roster, selectedEntryId]);

  // PlayerConfig edits the selected entry's master build; changes propagate to
  // every roster entry linked to that build.
  const handleBuildChange = useCallback((updated) => {
    if (!selectedBuild) return;
    setMasterBuilds(prev => ({
      ...prev,
      [selectedBuild.id]: { ...updated, id: selectedBuild.id, name: selectedBuild.name }
    }));
  }, [selectedBuild]);

  const handleRenameBuild = useCallback((name) => {
    if (!selectedBuild) return;
    setMasterBuilds(prev => ({
      ...prev,
      [selectedBuild.id]: { ...prev[selectedBuild.id], name }
    }));
  }, [selectedBuild]);

  const handleImportRoster = useCallback((data) => {
    // Accepts BOTH roster formats: legacy [{id, buildId}] rows become count 1
    // and rows sharing a buildId collapse into one counted row.
    const roster = normalizeRoster(Array.isArray(data.roster) ? data.roster : []);
    setMasterBuilds(data.masterBuilds || {});
    setRoster(roster);
    setSelectedEntryId(roster[0]?.id ?? null);
    if (data.trialConfig) {
      setTrialConfig(prev => ({ ...prev, ...data.trialConfig }));
    }
  }, []);

  const handleStartTrial = useCallback(() => {
    if (roster.length === 0) return;
    // Counted rows expand into `count` DTOs each, with UNIQUE hrids
    // (player1..playerN) so per-unit trial death stats don't collide. Trials
    // disable consumables, so strip food/drinks (the engine ignores them too).
    // hridToBuild records which build each unit came from so the results view
    // can group per-hrid stats (avgPlayerDps etc.) back into builds.
    const playerDTOs = [];
    const hridToBuild = {};
    for (const entry of roster) {
      const build = masterBuilds[entry.buildId];
      if (!build) continue;
      const n = clampCount(entry.count ?? 1);
      for (let i = 0; i < n; i++) {
        const hrid = `player${playerDTOs.length + 1}`;
        hridToBuild[hrid] = { buildId: build.id, buildName: build.name };
        playerDTOs.push(toPlayerDTO(build, { hrid, stripConsumables: true }));
      }
    }

    if (playerDTOs.length === 0) return;

    const effectiveParticipants = trialConfig.participantCount ?? playerDTOs.length;
    const trialDetail = (gameData?.guildTrials || []).find(t => t.hrid === trialConfig.trialHrid);
    // Debugging knob: UI stores PERCENT (default 100), engine wants a ratio.
    // Scales enemy effective level (tier × enemyScale) without moving the
    // ladder/reward tiers. Older engine builds simply ignore the option.
    const enemyScale = (trialConfig.enemyScale ?? 100) / 100;

    runGuildTrial({
      players: playerDTOs,
      guildTrial: {
        trialHrid: trialConfig.trialHrid,
        startTier: trialConfig.startTier,
        participantCount: effectiveParticipants,
        trialOptions: { enemyScale }
      },
      // Trials get shrine buffs AND guild building buffs. Buildings are
      // trial-only — the zone/labyrinth path above deliberately ships shrines
      // alone, because building buffs do not apply to ordinary combat.
      guildBuffs: [
        ...resolveGuildBuffs(trialConfig.guildBuffLevels),
        ...resolveGuildBuildingBuffs(trialConfig.guildBuildingLevels)
      ],
      // Community buffs / seals / MooPass do NOT apply inside guild trials —
      // the game does not grant them, so the UI hides the Buffs control in
      // trial mode and sends a neutral extra here to match.
      extra: {
        comExp: 0,
        comDrop: 0,
        mooPass: false,
        personalBuffs: []
      },
      iterations: trialConfig.iterations,
      aggregateOptions: {
        buildersHallBonus: (trialConfig.buildersHallBonus || 0) / 100,
        treasuryBonus: (trialConfig.treasuryBonus || 0) / 100
      },
      meta: {
        trialName: trialDetail?.name || trialConfig.trialHrid,
        trialHrid: trialConfig.trialHrid,
        participantCount: effectiveParticipants,
        startTier: trialConfig.startTier,
        iterations: trialConfig.iterations,
        // Captured at run time so the results view can flag debugging runs
        // even after the knob is changed back.
        enemyScale,
        // Unit-hrid → { buildId, buildName } for the DPS-by-build grouping.
        hridToBuild
      }
    });
  }, [roster, masterBuilds, trialConfig, gameData, runGuildTrial]);

  // ---------------------------------------------------------------------------
  // Trigger optimiser
  // ---------------------------------------------------------------------------
  // Destructured so the callbacks below have stable identities — the hook returns
  // a fresh object literal every render, which would otherwise churn every deps
  // array that mentions it.
  const {
    fetchPreview: fetchTriggerPreview,
    runOptimizer: runTriggerOptimizer,
    cancel: cancelTriggerOpt,
    preview: triggerOptPreview
  } = triggerOpt;

  const triggerOptPayload = useMemo(() => {
    if (simMode !== 'triggerOpt') return null;
    // NOT stripped for a labyrinth target, deliberately. The server does the
    // stripping (api/lib/target.js), and it needs to SEE the food and drink
    // triggers in order to list them back with "stripped on labyrinth entry"
    // beside them — a user who set those thresholds is owed the explanation.
    const playerDTOs = selectedPlayers.map(playerId =>
      toPlayerDTO(players[playerId], { hrid: `player${playerId}` })
    );
    return {
      players: playerDTOs,
      ...toTargetPayload(optTarget, { zone, difficultyTier, labConfig }),
      // Consumable production times, in seconds — the ironcow currency. Present
      // only on the `iron` price source; without them the optimiser cannot see the
      // food bill and would drive every consumable threshold toward "eat
      // constantly". See buildConsumableCosts. Sent regardless of target: the
      // server ignores them for a labyrinth, where nothing is eaten.
      consumableCosts: buildConsumableCosts(playerDTOs, {
        prices: pricing.prices,
        unit: pricing.unit,
        expenseMode: pricing.expenseMode,
        // Hand-entered per-item costs win over the fetched ones. A 0 here is a
        // deliberate "free at the margin", not a missing value.
        itemCostOverrides: pricing.itemCostOverrides
      }),
      // NOTE: the API's buildExtraBuffs honours mooPass / comExp / comDrop only.
      // extra.personalBuffs (seals) and the mwix lab keys are understood by the
      // BROWSER worker (src/worker.js) and not by the API path, so a build using
      // seals is optimised without them — the panel warns about it.
      extra: {
        comExp: extraOptions.comExp,
        comDrop: extraOptions.comDrop,
        mooPass: extraOptions.mooPass
      },
      guildBuffs: resolveGuildBuffs(trialConfig.guildBuffLevels),
      // Objective is left to the server: it picks the time-denominated one when the
      // consumable costs above are present, and raw throughput when they are not.
      stages: toStages(triggerOptConfig),
      workers: triggerOptConfig.workers || undefined
    };
  }, [
    simMode,
    optTarget,
    labConfig,
    players,
    selectedPlayers,
    zone,
    difficultyTier,
    extraOptions,
    trialConfig,
    triggerOptConfig,
    // usePrices returns a fresh object literal each render, so depend on the stable
    // values inside it rather than the wrapper — otherwise the preview refetches on
    // every keystroke anywhere in the app.
    pricing.prices,
    pricing.unit,
    pricing.expenseMode,
    pricing.itemCostOverrides
  ]);

  // Re-preview on every configuration change, debounced: it is a cheap
  // server-side call, but editing a threshold fires this on each keystroke.
  useEffect(() => {
    if (!triggerOptPayload) return undefined;
    const timer = setTimeout(() => {
      fetchTriggerPreview(triggerOptPayload);
    }, 350);
    return () => clearTimeout(timer);
  }, [triggerOptPayload, fetchTriggerPreview]);

  // Reconcile the selection against the latest preview. Trigger addresses are
  // positional, so editing an ability can invalidate a stored selection; drop
  // anything stale, and fall back to "everything searchable" when nothing is left.
  useEffect(() => {
    const rows = triggerOptPreview?.triggers;
    if (!rows) return;
    const searchable = rows.filter(row => row.searchable);
    const valid = new Set(searchable.map(triggerKey));
    setTriggerOptSelection(previous => {
      const kept = previous.filter(entry => valid.has(triggerKey(entry)));
      return kept.length ? kept : searchable;
    });
  }, [triggerOptPreview]);

  useEffect(() => {
    saveTriggerOptState({ config: triggerOptConfig });
  }, [triggerOptConfig]);

  const handleStartTriggerOpt = useCallback(() => {
    if (!triggerOptPayload || triggerOptSelection.length === 0) return;
    runTriggerOptimizer({
      ...triggerOptPayload,
      selection: triggerOptSelection.map(toAddress),
      meta: { optTarget, zone, difficultyTier, labConfig }
    });
  }, [triggerOptPayload, triggerOptSelection, runTriggerOptimizer, optTarget, zone, difficultyTier, labConfig]);

  // -- Equipment optimizer ---------------------------------------------------
  // Same API transport and the same consumable-cost currency as the trigger
  // optimiser, so most of this mirrors the block above. The two differences worth
  // noticing: `scan` replaces `stages` (one stage, not four), and the selection is
  // a list of stable row ids rather than positional addresses.
  const {
    fetchPreview: fetchEquipPreview,
    runOptimizer: runEquipOptimizer,
    cancel: cancelEquipOpt,
    preview: equipOptPreview
  } = equipOpt;

  const equipOptPayload = useMemo(() => {
    if (simMode !== 'equipOpt') return null;
    const playerDTOs = selectedPlayers.map(playerId =>
      toPlayerDTO(players[playerId], { hrid: `player${playerId}` })
    );
    return {
      players: playerDTOs,
      ...toTargetPayload(optTarget, { zone, difficultyTier, labConfig }),
      // Without these the scan ranks on raw encounters per hour, which cannot see
      // the food bill — so an enhancement that lets the build eat less goes
      // unrewarded. Same table, same seconds, as the trigger optimiser. Ignored
      // by the server for a labyrinth target, where nothing is eaten at all.
      consumableCosts: buildConsumableCosts(playerDTOs, {
        prices: pricing.prices,
        unit: pricing.unit,
        expenseMode: pricing.expenseMode,
        itemCostOverrides: pricing.itemCostOverrides
      }),
      // As with the trigger optimiser: the API's buildExtraBuffs honours
      // mooPass / comExp / comDrop only, so seals are not applied and the panel
      // says so.
      extra: {
        comExp: extraOptions.comExp,
        comDrop: extraOptions.comDrop,
        mooPass: extraOptions.mooPass
      },
      guildBuffs: resolveGuildBuffs(trialConfig.guildBuffLevels),
      scan: toScan(equipOptConfig),
      workers: equipOptConfig.workers || undefined
    };
  }, [
    simMode,
    optTarget,
    labConfig,
    players,
    selectedPlayers,
    zone,
    difficultyTier,
    extraOptions,
    trialConfig,
    equipOptConfig,
    pricing.prices,
    pricing.unit,
    pricing.expenseMode,
    pricing.itemCostOverrides
  ]);

  useEffect(() => {
    if (!equipOptPayload) return undefined;
    const timer = setTimeout(() => {
      fetchEquipPreview(equipOptPayload);
    }, 350);
    return () => clearTimeout(timer);
  }, [equipOptPayload, fetchEquipPreview]);

  // Reconcile the selection against the latest preview: swapping an item can make
  // a previously scannable slot unscannable (a charm with no combat stats, an item
  // already at +20). Falls back to "everything scannable" when nothing is left,
  // which is also the first-run default.
  useEffect(() => {
    const rows = equipOptPreview?.equipment;
    if (!rows) return;
    const scannable = rows.filter(row => row.scannable).map(row => row.id);
    const valid = new Set(scannable);
    setEquipOptSelection(previous => {
      const kept = previous.filter(id => valid.has(id));
      return kept.length ? kept : scannable;
    });
  }, [equipOptPreview]);

  useEffect(() => {
    saveEquipmentOptState({ config: equipOptConfig });
  }, [equipOptConfig]);

  useEffect(() => {
    saveOptTarget(optTarget);
  }, [optTarget]);

  const handleStartEquipOpt = useCallback(() => {
    if (!equipOptPayload || equipOptSelection.length === 0) return;
    runEquipOptimizer({
      ...equipOptPayload,
      selection: equipOptSelection,
      meta: { optTarget, zone, difficultyTier, labConfig }
    });
  }, [equipOptPayload, equipOptSelection, runEquipOptimizer, optTarget, zone, difficultyTier, labConfig]);

  // Rows for the panels' override editor: the party's slotted consumables, each
  // with its fetched time and whatever the user has said instead. Derived from the
  // payload so it cannot drift from the cost table actually being sent — and
  // declared after BOTH payloads, since it reads whichever one is live.
  const consumableCostRows = useMemo(
    () =>
      describeConsumableCosts(triggerOptPayload?.players ?? equipOptPayload?.players, {
        prices: pricing.prices,
        unit: pricing.unit,
        expenseMode: pricing.expenseMode,
        itemCostOverrides: pricing.itemCostOverrides
      }),
    [
      triggerOptPayload,
      equipOptPayload,
      pricing.prices,
      pricing.unit,
      pricing.expenseMode,
      pricing.itemCostOverrides
    ]
  );

  // The selected party as engine DTOs, independent of mode. The optimiser payload
  // memos each return null outside their own mode, so the Costs tab — which is not
  // a simulation mode at all — needs its own view of the party.
  const selectedPlayerDTOs = useMemo(
    () => selectedPlayers.map(playerId =>
      toPlayerDTO(players[playerId], { hrid: `player${playerId}` })
    ),
    [players, selectedPlayers]
  );

  // -- All Zones sweep -------------------------------------------------------
  // Destructured for stable identities: the hook returns a fresh object literal
  // every render, which would otherwise churn every deps array mentioning it.
  const { run: runAllZones, cancel: cancelAllZones } = allZones;

  const handleRunAllZones = useCallback(() => {
    // Game order (sortIndex), then tier — the pool consumes the list in order,
    // so the table fills roughly easiest-first rather than in Set insertion
    // order.
    //
    // The selection is persisted and is the sole input to the run, so it is
    // validated rather than trusted: an unknown hrid or an out-of-range tier (a
    // hand-edited store, or a data drop that lowers a ceiling) would otherwise
    // reach the engine, which scales monsters by formula rather than by table and
    // would return a plausible-looking row for a tier the game does not offer.
    const order = new Map();
    const tierCeiling = new Map();
    simulableZones(gameData?.zones).forEach((z, index) => {
      order.set(z.hrid, index);
      tierCeiling.set(z.hrid, maxTierFor(z));
    });
    const combos = [...allZonesSelection]
      .map(parseComboKey)
      .filter(
        combo =>
          order.has(combo.zoneHrid) &&
          combo.difficultyTier >= 0 &&
          combo.difficultyTier <= tierCeiling.get(combo.zoneHrid)
      )
      .sort(
        (a, b) =>
          order.get(a.zoneHrid) - order.get(b.zoneHrid) || a.difficultyTier - b.difficultyTier
      );
    if (combos.length === 0) return;

    // Exactly the party, buffs and shrines a single Run would send — the sweep
    // is the same simulation done many times, not a different one.
    const playerDTOs = selectedPlayers.map(playerId =>
      toPlayerDTO(players[playerId], {
        hrid: `player${playerId}`,
        stripConsumables: mazeContext
      })
    );

    runAllZones({
      players: playerDTOs,
      combos,
      simulationTimeLimit: allZonesHours * ONE_HOUR,
      hours: allZonesHours,
      workers: allZonesWorkers,
      extra: {
        ...extraOptions,
        mwixLabUpgrades: labConfig.upgrades,
        mwixMaze: { enabled: mazeContext }
      },
      guildBuffs: resolveGuildBuffs(trialConfig.guildBuffLevels)
    });
    setAllZonesOpen(false);
    setAllZonesView(true);
  }, [
    gameData,
    allZonesSelection,
    allZonesHours,
    allZonesWorkers,
    players,
    selectedPlayers,
    mazeContext,
    extraOptions,
    labConfig,
    trialConfig,
    runAllZones
  ]);

  const handleStartSimulation = useCallback(() => {
    // A single run replaces the sweep table with its own results — two answers
    // in one pane, one of them stale, helps nobody.
    setAllZonesView(false);
    if (simMode === 'guildTrial') {
      handleStartTrial();
      return;
    }
    if (simMode === 'triggerOpt') {
      handleStartTriggerOpt();
      return;
    }
    if (simMode === 'equipOpt') {
      handleStartEquipOpt();
      return;
    }
    const isLab = simMode === 'labyrinth';
    // The game STRIPS every consumable (food, drinks, teas) on labyrinth
    // entry — the player walks in with gear and abilities only; the supply
    // crates are the sole nutrition inside. MWIX's labyrinth-sim enforces
    // the same rule (tampermonkey/src/modules/labyrinth-sim). NOTE: the old
    // webpack UI does NOT strip consumables for lab sims, which inflates
    // its predicted clear rates — we deliberately match the game instead.
    const stripConsumables = isLab || mazeContext;

    // Build player DTOs for all selected players (shared transform — see
    // utils/playerDTO.js — so zone/lab and trials never drift apart).
    const playerDTOs = selectedPlayers.map(playerId =>
      toPlayerDTO(players[playerId], { hrid: `player${playerId}`, stripConsumables })
    );
    const extra = {
      ...extraOptions,
      // Lab-shop upgrades apply only when the maze context is on; the
      // worker gates them on extra.mwixMaze.enabled (see csim/src/worker.js).
      mwixLabUpgrades: labConfig.upgrades,
      mwixMaze: { enabled: isLab || mazeContext }
    };

    runSimulation({
      players: playerDTOs,
      zone: isLab ? null : { zoneHrid: zone, difficultyTier },
      labyrinth: isLab
        ? {
            labyrinthHrid: labConfig.monsterHrid,
            roomLevel: labConfig.roomLevel,
            crates: Object.values(labConfig.crates).filter(Boolean)
          }
        : null,
      simulationTimeLimit: duration * ONE_HOUR,
      extra,
      // Guild shrine buffs are permanent character buffs and apply to every
      // fight, not just trials (the game exposes them via
      // guildActionTypeBuffsMap["/action_types/combat"]). Levels are shared
      // with trial mode, so a shrine set once is reflected in both.
      guildBuffs: resolveGuildBuffs(trialConfig.guildBuffLevels)
    });
  }, [players, selectedPlayers, simMode, zone, difficultyTier, labConfig, mazeContext, duration, extraOptions, trialConfig, runSimulation, handleStartTrial, handleStartTriggerOpt, handleStartEquipOpt]);

  // The header, progress bar and results pane read from whichever engine the
  // current mode uses. Both optimisers go through an API hook; every other mode
  // uses the browser worker.
  const isTriggerOpt = simMode === 'triggerOpt';
  const isEquipOpt = simMode === 'equipOpt';
  const isApiOpt = isTriggerOpt || isEquipOpt;
  const apiEngine = isEquipOpt ? equipOpt : triggerOpt;
  // The sweep shows its table in zone mode only; switching to Lab or Trials
  // hides it without discarding it, so coming back finds it where you left it.
  const showAllZones = simMode === 'zone' && allZonesView;
  // A running sweep counts as loading in EVERY mode, including the optimisers:
  // it owns the machine's cores until it finishes, so a Run button that invited a
  // second engine to start beside it would be lying — and with Stop hidden, the
  // sweep could not be called off from the mode the user happened to be in.
  const sweeping = allZones.running;
  const activeLoading = (isApiOpt ? apiEngine.loading : simLoading) || sweeping;
  // The label and the number must describe the SAME engine. Gating the label on
  // `sweeping` while the number fell through to whichever engine ran last printed
  // "Sweeping zones — 12/78 done · 100.0%" from a single run finished minutes ago.
  const activeProgress = sweeping
    ? allZones.progress
    : isApiOpt
      ? apiEngine.progress
      : simProgress;
  const activeResults = isApiOpt ? apiEngine.results : results;
  const activeError = isApiOpt ? apiEngine.error : simError;
  // The sweep wins: it is the only engine that can be running while the user is
  // looking at a different mode, so Stop must reach it from anywhere.
  const handleStop = sweeping
    ? cancelAllZones
    : isEquipOpt
      ? cancelEquipOpt
      : isTriggerOpt
        ? cancelTriggerOpt
        : clearResults;

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: navbarWidth, breakpoint: 'sm' }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Title order={4} style={{ whiteSpace: 'nowrap' }}>
              MWI Combat Simulator
            </Title>
            <Badge variant="light" color="teal" size="sm">
              in-browser
            </Badge>
            {(mazeContext || simMode === 'labyrinth' || (isApiOpt && optTarget === 'labyrinth')) && (
              <Badge variant="light" color="grape" size="sm" title="Labyrinth context active">
                maze
              </Badge>
            )}
          </Group>
          <HeaderControls
            simMode={simMode}
            onSimModeChange={setSimMode}
            optTarget={optTarget}
            onOptTargetChange={setOptTarget}
            zones={gameData?.zones}
            zone={zone}
            onZoneChange={handleZoneChange}
            difficultyTier={difficultyTier}
            onDifficultyChange={setDifficultyTier}
            monsters={gameData?.monsters}
            labConfig={labConfig}
            onLabConfigChange={setLabConfig}
            duration={duration}
            onDurationChange={setDuration}
            extraOptions={extraOptions}
            onExtraChange={setExtraOptions}
            onStart={handleStartSimulation}
            onStop={handleStop}
            onOpenAllZones={() => setAllZonesOpen(true)}
            loading={activeLoading}
            guildTrials={gameData?.guildTrials}
            trialConfig={trialConfig}
            onTrialConfigChange={setTrialConfig}
            rosterLength={rosterSize(roster)}
          />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        {/* Drag-to-resize handle pinned to the navbar's right edge. Double-click
            restores the default width. Hidden below the navbar breakpoint,
            where the column collapses and dragging is meaningless. */}
        <div
          className="nav-resize-handle"
          onPointerDown={handleNavbarResizeStart}
          onDoubleClick={handleNavbarResizeReset}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar (double-click to reset)"
          title="Drag to resize · double-click to reset"
        />
        <ScrollArea type="hover" style={{ height: '100%' }}>
          <Stack gap="sm" p="md">
            {simMode === 'guildTrial' ? (
              <>
                <GuildTrialPanel
                  masterBuilds={masterBuilds}
                  roster={roster}
                  selectedEntryId={selectedEntryId}
                  participantCount={participantCount}
                  items={gameData?.items}
                  players={players}
                  trialConfig={trialConfig}
                  onSelectEntry={setSelectedEntryId}
                  onDuplicate={handleDuplicate}
                  onSetCount={handleSetCount}
                  onSaveAsNew={handleSaveAsNew}
                  onDelete={handleDeleteEntry}
                  onDeleteBuild={handleDeleteBuild}
                  onAddEntryFromBuild={addEntriesForBuild}
                  onAddBuildFromSlot={addBuildFromSlot}
                  onAddBuildFromLoadout={addBuildFromLoadout}
                  onAddBlankBuild={addBlankBuild}
                  onImportRoster={handleImportRoster}
                  onImportBuild={(player, name) => addBuildFromPlayer(player, name || 'Imported build')}
                />

                <Divider />

                {selectedBuild ? (
                  <>
                    <TextInput
                      label="Build name"
                      value={selectedBuild.name}
                      onChange={(e) => handleRenameBuild(e.currentTarget.value)}
                      size="xs"
                    />
                    <Text size="xs" c="dimmed">
                      Editing this build updates every roster entry linked to it.
                    </Text>
                    <PlayerConfig
                      gameData={gameData}
                      player={selectedBuild}
                      onPlayerChange={handleBuildChange}
                      playerId={roster.findIndex(e => e.id === selectedEntryId) + 1}
                      hideConsumables
                    />
                  </>
                ) : (
                  <Text size="sm" c="dimmed">
                    Select a roster entry to edit its master build.
                  </Text>
                )}
              </>
            ) : (
              <>
                {/* Trigger Optimizer sits ABOVE the party editor rather than
                    replacing it: the whole point is to tune the triggers the user
                    can see and edit in PlayerConfig below, and the panel's preview
                    re-reads them on every change. */}
                {simMode === 'triggerOpt' && (
                  <>
                    <TriggerOptimizerPanel
                      preview={triggerOpt.preview}
                      previewing={triggerOpt.previewing}
                      apiReachable={triggerOpt.apiReachable}
                      selection={triggerOptSelection}
                      onSelectionChange={setTriggerOptSelection}
                      config={triggerOptConfig}
                      onConfigChange={setTriggerOptConfig}
                      loading={triggerOpt.loading}
                      onRun={handleStartTriggerOpt}
                      onCancel={cancelTriggerOpt}
                      sealCount={extraOptions.personalBuffs?.length || 0}
                      pricing={pricing}
                      consumableCostRows={consumableCostRows}
                    />
                    <Divider />
                  </>
                )}

                {/* Same placement and the same reason as the trigger panel: the
                    scan reads the very equipment the user edits in PlayerConfig
                    below, and re-previews on every change. */}
                {simMode === 'equipOpt' && (
                  <>
                    <EquipmentOptimizerPanel
                      preview={equipOpt.preview}
                      previewing={equipOpt.previewing}
                      apiReachable={equipOpt.apiReachable}
                      selection={equipOptSelection}
                      onSelectionChange={setEquipOptSelection}
                      config={equipOptConfig}
                      onConfigChange={setEquipOptConfig}
                      loading={equipOpt.loading}
                      onRun={handleStartEquipOpt}
                      onCancel={cancelEquipOpt}
                      sealCount={extraOptions.personalBuffs?.length || 0}
                      pricing={pricing}
                      consumableCostRows={consumableCostRows}
                    />
                    <Divider />
                  </>
                )}

                <div>
                  <Text size="sm" fw={600} mb={4}>
                    Party
                  </Text>
                  <Checkbox.Group
                    value={selectedPlayers.map(String)}
                    onChange={handleSelectedPlayersChange}
                  >
                    <Group gap="sm">
                      {[1, 2, 3, 4, 5].map(id => (
                        <Checkbox
                          key={id}
                          value={String(id)}
                          label={`P${id}`}
                          size="xs"
                        />
                      ))}
                    </Group>
                  </Checkbox.Group>
                  <Text size="xs" c="dimmed" mt={4}>
                    {selectedPlayers.length} player{selectedPlayers.length !== 1 ? 's' : ''} in simulation
                  </Text>
                </div>

                <Tabs
                  value={String(activeTab)}
                  onChange={(v) => setActiveTab(Number(v))}
                  variant="pills"
                  radius="md"
                >
                  <Tabs.List grow>
                    {[1, 2, 3, 4, 5].map(id => (
                      <Tabs.Tab key={id} value={String(id)}>
                        P{id}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs>

                <CharacterImport
                  activeTab={activeTab}
                  onLoadPlayer={(loadedPlayer) => handlePlayerChange(activeTab, loadedPlayer)}
                />

                <ImportExport
                  players={players}
                  setPlayers={setPlayers}
                  selectedPlayers={selectedPlayers}
                  activeTab={activeTab}
                  zone={zone}
                  // Coercing setter: an exported set may name a solo monster
                  // ("/actions/combat/fly"), which is no longer selectable.
                  setZone={handleZoneChange}
                  difficultyTier={difficultyTier}
                  setDifficultyTier={setDifficultyTier}
                  duration={duration}
                  setDuration={setDuration}
                />

                <LoadoutManager
                  player={players[activeTab]}
                  onLoadPlayer={(loadedPlayer) => handlePlayerChange(activeTab, loadedPlayer)}
                  playerId={activeTab}
                />

                <Divider />

                <PlayerConfig
                  gameData={gameData}
                  player={players[activeTab]}
                  onPlayerChange={(updatedPlayer) => handlePlayerChange(activeTab, updatedPlayer)}
                  playerId={activeTab}
                />
              </>
            )}
          </Stack>
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <Stack gap="md">
          {bridgeMessage && (
            <Alert
              color={bridgeMessage.includes('failed') ? 'red' : 'teal'}
              variant="light"
              withCloseButton
              onClose={() => setBridgeMessage(null)}
            >
              {bridgeMessage}
            </Alert>
          )}

          {activeLoading && (
            <ProgressBar
              progress={activeProgress}
              status={
                isApiOpt
                  ? // The stage label carries the real information here — a
                    // percentage alone tells the user nothing about whether the
                    // run is screening cheaply or verifying at 72 simulated hours.
                    `${apiEngine.stage ? `${apiEngine.stage}: ` : ''}${apiEngine.label || 'Optimising…'} · ${activeProgress.toFixed(1)}%`
                  : sweeping
                    ? // Combinations finished, not percent alone: a sweep's bar
                      // moves slowly and the count is what tells you where it is.
                      // Reports the hours the RUN was started with, not the knob's
                      // current value, which the user may have edited since.
                      `Sweeping zones — ${allZones.meta?.completed ?? 0}/${allZones.meta?.total ?? 0} done ` +
                      `(${allZones.meta?.hours ?? allZonesHours} h each) · ${activeProgress.toFixed(1)}%`
                    : simMode === 'guildTrial'
                      ? `Running ${trialConfig.iterations} trial iterations… ${activeProgress.toFixed(1)}%`
                      : `Simulating ${duration} hours of combat… ${activeProgress.toFixed(1)}%`
              }
            />
          )}

          {activeError && (
            <Alert color="red" title={isApiOpt ? 'Optimiser error' : 'Simulation error'} variant="light">
              {activeError.message}
            </Alert>
          )}

          {/* Not gated on the sweep being the visible pane: a sweep that stalls
              while the user is reading the Lab tab would otherwise just stop,
              silently, with nothing anywhere to say why. */}
          {allZones.error && (
            <Alert color="red" title="Zone sweep error" variant="light">
              {allZones.error.message}
            </Alert>
          )}

          {simMode === 'guildTrial' && gameData && (
            <TrialMonsterCards
              trial={selectedTrialDetail}
              monsters={gameData.monsters}
              abilities={gameData.abilities}
            />
          )}

          {simMode === 'itemCosts' ? (
            <ItemCostsView
              playerDTOs={selectedPlayerDTOs}
              gameItems={gameData?.items}
              pricing={pricing}
              protectionPricing={equipOptConfig.protectionPricing}
            />
          ) : showAllZones ? (
            <AllZonesResults
              rows={allZones.rows}
              zones={gameData?.zones}
              pricing={pricing}
              meta={allZones.meta}
              running={allZones.running}
              onOpenPicker={() => setAllZonesOpen(true)}
              // Whose numbers the table shows. The sweep measures every member,
              // but a party is five characters and their experience is not one
              // pool — the table answers for the player whose config is open in
              // the left panel, and follows the P-tab without re-running.
              focusHrid={`player${activeTab}`}
            />
          ) : activeResults && activeResults.__kind === 'triggerOpt' ? (
            <TriggerOptimizerResults results={activeResults} />
          ) : activeResults && activeResults.__kind === 'equipOpt' ? (
            <EquipmentOptimizerResults
              results={activeResults}
              gameItems={gameData?.items}
              pricing={pricing}
              protectionPricing={equipOptConfig.protectionPricing}
              protectAt={equipOptConfig.protectAt}
              onProtectionPricingChange={(value) =>
                setEquipOptConfig(prev => ({ ...prev, protectionPricing: value }))
              }
              onProtectAtChange={(value) =>
                setEquipOptConfig(prev => ({ ...prev, protectAt: value }))
              }
            />
          ) : activeResults && activeResults.__kind === 'guildTrial' ? (
            <GuildTrialResults result={activeResults} />
          ) : (
            <SimulationResults
              results={activeResults}
              monsters={gameData?.monsters}
              items={gameData?.items}
              pricing={pricing}
            />
          )}

          {!activeResults && !activeLoading && !showAllZones && simMode !== 'itemCosts' && (
            <Center mih={300}>
              <Text c="dimmed">
                {simMode === 'guildTrial'
                  ? 'Build a roster on the left, then press Run.'
                  : isTriggerOpt
                    ? 'Pick which trigger thresholds to search on the left, then press Run.'
                    : isEquipOpt
                      ? 'Pick which equipment slots to probe on the left, then press Run.'
                      : 'Configure your party on the left, then press Run — or press All Zones to sweep every zone and tier at once.'}
              </Text>
            </Center>
          )}
        </Stack>
      </AppShell.Main>

      <AllZonesModal
        opened={allZonesOpen}
        onClose={() => setAllZonesOpen(false)}
        zones={gameData?.zones}
        selection={allZonesSelection}
        onSelectionChange={setAllZonesSelection}
        hours={allZonesHours}
        onHoursChange={setAllZonesHours}
        workers={allZonesWorkers}
        onWorkersChange={setAllZonesWorkers}
        onRun={handleRunAllZones}
        running={allZones.running}
      />
    </AppShell>
  );
}

export default App;
