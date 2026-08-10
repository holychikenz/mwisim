import { useState, useCallback, useEffect } from 'react';
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
import { usePrices } from './hooks/usePrices';
import { exportFormatToPlayer } from './utils/importSet';
import { readMwixBridgePayload, clearMwixBridgeHash } from './utils/mwixBridge';
import { HeaderControls } from './components/HeaderControls';
import { PlayerConfig } from './components/PlayerConfig';
import { SimulationResults } from './components/SimulationResults';
import { GuildTrialResults } from './components/GuildTrialResults';
import { GuildTrialPanel } from './components/GuildTrialPanel';
import { TrialMonsterCards } from './components/TrialMonsterCards';
import { ImportExport } from './components/ImportExport';
import { ProgressBar } from './components/ProgressBar';
import { LoadoutManager } from './components/LoadoutManager';
import { CharacterImport } from './components/CharacterImport';
import { TextInput } from '@mantine/core';
import { toPlayerDTO } from './utils/playerDTO';
import { resolveGuildBuffs, resolveGuildBuildingBuffs } from './utils/guildBuffs';
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

  const [players, setPlayers] = useState(createInitialPlayers);
  const [navbarWidth, setNavbarWidth] = useState(loadNavbarWidth);
  const [activeTab, setActiveTab] = useState(1);
  const [selectedPlayers, setSelectedPlayers] = useState([1]);
  const [simMode, setSimMode] = useState('zone');

  // Guild-trial state (separate from the fixed 5-slot zone/lab `players`).
  // masterBuilds: { [id]: { id, name, ...playerFields } }  — named editable builds
  // roster:       [ { id, buildId, count } ]               — ONE counted row per build
  const [masterBuilds, setMasterBuilds] = useState(() => loadGuildTrialState().masterBuilds);
  const [roster, setRoster] = useState(() => loadGuildTrialState().roster);
  const [selectedEntryId, setSelectedEntryId] = useState(() => loadGuildTrialState().selectedEntryId);
  const [trialConfig, setTrialConfig] = useState(() => loadGuildTrialState().trialConfig);
  const [zone, setZone] = useState('/actions/combat/fly');
  const [difficultyTier, setDifficultyTier] = useState(0);
  const [labConfig, setLabConfig] = useState({
    monsterHrid: '/monsters/cyclops',
    roomLevel: 100,
    crates: { tea: null, coffee: null, food: null },
    upgrades: { combatDamage: 0, attackSpeed: 0, castSpeed: 0, criticalRate: 0 }
  });
  const [duration, setDuration] = useState(100);
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

      const bits = [];
      if (payload.loadout?.name) bits.push(payload.loadout.name);
      if (maze?.enabled) bits.push('maze on');
      if (labUpgrades && (labUpgrades.combatDamage || labUpgrades.attackSpeed || labUpgrades.castSpeed || labUpgrades.criticalRate)) {
        bits.push('lab upgrades applied');
      }
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

  const handleStartSimulation = useCallback(() => {
    if (simMode === 'guildTrial') {
      handleStartTrial();
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
  }, [players, selectedPlayers, simMode, zone, difficultyTier, labConfig, mazeContext, duration, extraOptions, trialConfig, runSimulation, handleStartTrial]);

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
            {(mazeContext || simMode === 'labyrinth') && (
              <Badge variant="light" color="grape" size="sm" title="Labyrinth context active">
                maze
              </Badge>
            )}
          </Group>
          <HeaderControls
            simMode={simMode}
            onSimModeChange={setSimMode}
            zones={gameData?.zones}
            zone={zone}
            onZoneChange={setZone}
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
            onStop={clearResults}
            loading={simLoading}
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
                  setSelectedPlayers={setSelectedPlayers}
                  activeTab={activeTab}
                  zone={zone}
                  setZone={setZone}
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

          {simLoading && (
            <ProgressBar
              progress={simProgress}
              status={
                simMode === 'guildTrial'
                  ? `Running ${trialConfig.iterations} trial iterations… ${simProgress.toFixed(1)}%`
                  : `Simulating ${duration} hours of combat… ${simProgress.toFixed(1)}%`
              }
            />
          )}

          {simError && (
            <Alert color="red" title="Simulation error" variant="light">
              {simError.message}
            </Alert>
          )}

          {simMode === 'guildTrial' && gameData && (
            <TrialMonsterCards
              trial={selectedTrialDetail}
              monsters={gameData.monsters}
              abilities={gameData.abilities}
            />
          )}

          {results && results.__kind === 'guildTrial' ? (
            <GuildTrialResults result={results} />
          ) : (
            <SimulationResults
              results={results}
              monsters={gameData?.monsters}
              items={gameData?.items}
              pricing={pricing}
            />
          )}

          {!results && !simLoading && (
            <Center mih={300}>
              <Text c="dimmed">
                {simMode === 'guildTrial'
                  ? 'Build a roster on the left, then press Run.'
                  : 'Configure your party on the left, then press Run.'}
              </Text>
            </Center>
          )}
        </Stack>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;
