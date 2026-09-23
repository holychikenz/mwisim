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
  Select,
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
import {
  readRosterLinkValue,
  decodeRosterLinkValue,
  validateRosterPayload,
  clearRosterLinkHash
} from './utils/rosterBridge';
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
import { loadExperimental, saveExperimental } from './utils/experimental';
import { resolvePlayerExtraBuffs } from './utils/playerBuffs';
import {
  resolveGuildBuildingBuffs,
  GUILD_COMBAT_BUFFS,
  MAX_GUILD_BUFF_LEVEL
} from './utils/guildBuffs';
import {
  makeId,
  loadGuildTrialState,
  saveGuildTrialState,
  normalizeRoster,
  refKey,
  rosterSize,
  clampCount,
  DEFAULT_TRIAL_CONFIG
} from './utils/roster';
import {
  createCharacter,
  emptyStore,
  loadCharacters,
  makeCharacterId,
  mergeImportedCharacter,
  resolveRef,
  saveCharacters,
  setLoadout,
  splitPlayer,
  uniqueLoadoutName,
  upsertCharacter
} from './utils/characterStore';
// The ONE atomic repair: party AND roster (AND the trial selection) rewritten
// together, so neither holder can be mended at the other's expense.
import {
  deleteCharacterEverywhere,
  deleteLoadoutEverywhere,
  renameLoadoutEverywhere
} from './utils/refRepair';
import { migrateLegacyLoadouts } from './utils/orphanMigration';
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

const PARTY_SLOTS = [1, 2, 3, 4, 5];

/** Five empty slots. A slot holds a `{characterId, loadoutName}` REFERENCE. */
const createInitialParty = () => ({ 1: null, 2: null, 3: null, 4: null, 5: null });

/** Coerce a restored party blob into exactly the five slots. */
function normalizeParty(saved) {
  const party = createInitialParty();
  if (!saved || typeof saved !== 'object') return party;
  for (const id of PARTY_SLOTS) {
    const ref = saved[id];
    if (ref?.characterId && ref?.loadoutName) {
      party[id] = { characterId: ref.characterId, loadoutName: ref.loadoutName };
    }
  }
  return party;
}

const VERSION_NOTICE =
  'Saved data from an older version was set aside (csim_player_data.v1, ' +
  'csim_guild_trial.v1) and your old flat loadouts are untouched in csim_loadouts. ' +
  'Starting fresh — import a character to begin.';

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
  const session = useMemo(() => loadSession(), []);
  const savedSession = session.data;

  // THE ONE STORE. A character owns its levels, houses, achievements, shrines,
  // seals and ability training levels; each of its named loadouts owns only
  // gear, ability slots and consumables. See utils/characterStore.js.
  // Recover a pre-v2 `csim_loadouts` library, at most once ever, before the
  // store is first handed to React. See utils/orphanMigration.js — the original
  // blob is never written, cleared or deleted.
  const restored = useMemo(() => migrateLegacyLoadouts(loadCharacters()), []);
  const [characters, setCharacters] = useState(() => restored.store);
  // Five slots, each a {characterId, loadoutName} REFERENCE — so two slots can
  // be the same character in different gear with no copy of anything.
  const [party, setParty] = useState(() => normalizeParty(savedSession.party));
  const [navbarWidth, setNavbarWidth] = useState(loadNavbarWidth);
  const [activeTab, setActiveTab] = useState(1);
  const [selectedPlayers, setSelectedPlayers] = useState(
    () => (Array.isArray(savedSession?.selectedPlayers) && savedSession.selectedPlayers.length
      ? savedSession.selectedPlayers
      : [1])
  );
  const [simMode, setSimMode] = useState('zone');

  // Guild-trial state. Read ONCE (it used to be read four times over) — rows
  // are REFERENCES into the same character store the zone slots use, so a trial
  // seat and a party slot can be the same character and cannot disagree.
  // roster: [ { id, characterId, loadoutName, count } ] — ONE counted row per pair.
  const trialState = useMemo(() => loadGuildTrialState(), []);
  const [roster, setRoster] = useState(() => trialState.data.roster);
  const [selectedEntryId, setSelectedEntryId] = useState(() => trialState.data.selectedEntryId);
  const [trialConfig, setTrialConfig] = useState(() => trialState.data.trialConfig);
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
  // Genuinely account- or server-wide only. Seals used to live here and are now
  // a per-character field on each player (see createDefaultPlayer), because a
  // seal is an item ONE character equips.
  const [extraOptions, setExtraOptions] = useState({
    comExp: 0,
    comDrop: 0,
    mooPass: false
  });
  // Experimental engine knobs. Their own localStorage key, deliberately NOT
  // part of the session blob or an exported build — a bench setting must not
  // travel with a loadout (see utils/experimental.js). Every run path folds
  // them into `extra.experimental`, which worker.js applies to the engine.
  const [experimental, setExperimental] = useState(loadExperimental);
  const handleExperimentalChange = useCallback((next) => {
    setExperimental(next);
    saveExperimental(next);
  }, []);
  // Set when an MWIX bridge payload carries labyrinth context (maze on) —
  // zone sims then still apply the lab-shop upgrades, like the old UI.
  const [mazeContext, setMazeContext] = useState(false);
  // One honest notice when a pre-v2 blob was set aside rather than guessed at.
  // It rides the EXISTING alert; no new UI plumbing for a once-per-user message.
  // Both notices can fire on the same load, so they compose rather than
  // competing for the one alert.
  const [bridgeMessage, setBridgeMessage] = useState(
    () => [
      session.status === 'incompatible' || trialState.status === 'incompatible'
        ? VERSION_NOTICE
        : null,
      restored.recovered
        ? `Recovered ${restored.recovered} saved loadout${restored.recovered === 1 ? '' : 's'} ` +
          `from the previous version into ${restored.created} character` +
          `${restored.created === 1 ? '' : 's'} (${restored.names.join(', ')}). ` +
          'Their stats differed where they were split apart — nothing was merged. ' +
          'Rename or delete them freely; they are ordinary characters. ' +
          'Your original data is untouched in csim_loadouts.'
        : null
    ].filter(Boolean).join(' ') || null
  );

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
      const ctx = payload.mwixContext;

      // Guild shrines: the character's own purchased shrine levels, keyed by
      // guild-buff hrid. They are a PER-MEMBER purchase, so they are folded
      // onto the player being imported — that is where the zone, labyrinth,
      // sweep and optimiser paths now read them from.
      //
      // They are ALSO still written to the shared `trialConfig.guildBuffLevels`
      // knobs. Those knobs are no longer what the zone path reads; they survive
      // as the party-wide fallback for trial builds that carry no shrines of
      // their own (utils/guildBuffs.js resolveUnitShrineBuffs), and keeping the
      // write means a bridged character still populates a sensible default for
      // a trial roster assembled afterwards.
      //
      // The payload REPLACES the stored levels rather than merging into them:
      // it is the authoritative statement of what this character owns, and a
      // character with no shrines must not silently inherit whatever the last
      // session had dialled in. An absent `guildShrines` key (an older MWIX
      // build) leaves the knobs alone — only a present object replaces them; see
      // the else branch for what the imported player gets instead. Unknown keys
      // are dropped by iterating our own definition list, so a future skilling
      // shrine leaking into the payload cannot reach either.
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
        player.guildShrines = levels;
        setTrialConfig(prev => ({ ...prev, guildBuffLevels: levels }));
      } else {
        // No shrine object in the payload: an older MWIX build, which says
        // nothing about shrines rather than saying the character owns none.
        // Seed the imported player from the stored party-wide knobs, for the
        // same reason the old session migration did — before that change those
        // knobs WERE this character's shrines, and a bridge import that silently
        // zeroed them would quietly understate every number the app then prints.
        player.guildShrines = { ...(loadGuildTrialState().data.trialConfig?.guildBuffLevels || {}) };
      }

      // ADAPTED ON ARRIVAL. The payload is a flat loadout and carries no
      // character grouping to begin with, so there is nothing richer upstream
      // to carry and no reason to break tampermonkey/src/kernel/sim-launch.js:
      // it becomes a character with a single loadout named `bridge`.
      const characterName = payload.loadout?.name || 'MWIX import';
      const characterId = makeCharacterId(`mwix ${characterName}`);
      const split = splitPlayer(player);
      setCharacters(prev => upsertCharacter(prev, {
        ...split.character,
        id: characterId,
        name: characterName,
        loadouts: { bridge: split.loadout }
      }));
      setParty(prev => ({ ...prev, 1: { characterId, loadoutName: 'bridge' } }));
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

  useEffect(() => {
    saveCharacters(characters);
  }, [characters]);

  // The five slots as flat players, manufactured on demand. This is THE view
  // every DTO site, panel and optimiser payload reads; nothing downstream knows
  // the model is two-level. A dangling reference resolves to null.
  const resolvedParty = useMemo(
    () => Object.fromEntries(PARTY_SLOTS.map(id => [id, resolveRef(characters, party[id])])),
    [characters, party]
  );

  /**
   * Write a flat player edit back through the split. The character half lands
   * on the character and the loadout half on the loadout, so editing P1's
   * attack level is OBSERVED BY P2 with no copy step when both wear the same
   * character — and a level has nowhere to be written twice.
   *
   * One handler for both modes: a party slot and a trial row are the same kind
   * of reference, so they cannot drift apart.
   */
  const applyPlayerEdit = useCallback((ref, updated) => {
    if (!ref?.characterId || !ref?.loadoutName) return;
    const { character, loadout } = splitPlayer(updated);
    setCharacters(prev => {
      const existing = prev.characters?.[ref.characterId];
      if (!existing) return prev;
      const merged = upsertCharacter(prev, { ...existing, ...character });
      return setLoadout(merged, ref.characterId, ref.loadoutName, loadout);
    });
  }, []);

  const handleResolvedPlayerChange = useCallback(
    (slotId, updated) => applyPlayerEdit(party[slotId], updated),
    [party, applyPlayerEdit]
  );

  // The selection, filtered down to slots that actually resolve. An unbound or
  // dangling slot is a NEW failure mode (the old copy-everything model could
  // not produce one), and the answer is simply that it contributes no DTO.
  const selectedParty = useMemo(
    () => selectedPlayers.filter(id => resolvedParty[id]),
    [selectedPlayers, resolvedParty]
  );

  /** Bind a slot to a (character, loadout) pair. No copying, ever. */
  const bindSlot = useCallback((slotId, ref) => {
    setParty(prev => ({ ...prev, [slotId]: ref }));
  }, []);

  /** A freshly-imported flat player becomes its own character, adapted on arrival. */
  const importedSeq = useRef(0);
  const handleImportPlayer = useCallback((slotId, flat) => {
    importedSeq.current += 1;
    const name = importedSeq.current === 1 ? 'Imported' : `Imported ${importedSeq.current}`;
    const id = makeId('char');
    const { character, loadout } = splitPlayer(flat);
    setCharacters(prev => upsertCharacter(prev, {
      ...character,
      id,
      name,
      loadouts: { default: loadout }
    }));
    setParty(prev => ({ ...prev, [slotId]: { characterId: id, loadoutName: 'default' } }));
  }, []);

  /**
   * A full character import: every combat loadout it owns, MERGED onto whatever
   * is already stored rather than replacing it. The import id is deterministic
   * (`makeCharacterId(name)`), so re-importing the same character always lands
   * on the same key — and used to destroy every shrine level, every seal and
   * every hand-made loadout on the way in. See `mergeImportedCharacter`.
   *
   * The WRITE goes through a functional updater, and must stay that way.
   * `CharacterImport` awaits a network round trip before calling back, so the
   * `characters` captured in this closure is a PRE-FETCH snapshot: anything the
   * user changed while the import was in flight — a level, a shrine, a gear
   * swap, a deletion, a second import — would be overwritten by a wholesale
   * `setCharacters(result.store)` and then autosaved, making the loss permanent.
   * A functional updater re-running under StrictMode is harmless here, because
   * `mergeImportedCharacter` is idempotent on the same base.
   */
  const handleImportCharacter = useCallback((slotId, character, defaultLoadoutName) => {
    const id = character.id || makeCharacterId(character.name);
    setCharacters(prev => mergeImportedCharacter(prev, character).store);

    // Which loadout to bind depends only on the INCOMING character, never on
    // the base: the merge is a union, so any loadout the import carries is in
    // the result whatever was there before. That keeps the binding correct even
    // when the snapshot below is stale.
    const incoming = character.loadouts || {};
    const loadoutName = (defaultLoadoutName && incoming[defaultLoadoutName])
      ? defaultLoadoutName
      : Object.keys(incoming)[0];
    if (loadoutName) {
      setParty(prev => ({ ...prev, [slotId]: { characterId: id, loadoutName } }));
    }

    // The notice is COSMETIC, so it may be computed against the snapshot: in
    // the rare in-flight race its counts can lag by an edit, which is a wrong
    // sentence rather than wrong data. The merge is pure, so previewing it here
    // changes nothing.
    const preview = mergeImportedCharacter(characters, character);
    if (!preview.created) {
      setBridgeMessage(
        `Re-imported ${preview.store.characters[id]?.name || character.name} — ` +
        `${preview.replaced.length} loadout(s) updated, ` +
        `${preview.added.length} added, ${preview.kept.length} of your own kept. ` +
        'Shrines and seals preserved.'
      );
    }
  }, [characters]);

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
    saveGuildTrialState({ roster, selectedEntryId, trialConfig });
  }, [roster, selectedEntryId, trialConfig]);

  const selectedEntry = roster.find(e => e.id === selectedEntryId) || null;
  const selectedCharacter = selectedEntry
    ? characters.characters?.[selectedEntry.characterId] || null
    : null;
  // The selected seat as a flat player — the same manufactured view the zone
  // slots get, so PlayerConfig is handed one shape and edits it one way.
  const selectedTrialPlayer = useMemo(
    () => resolveRef(characters, selectedEntry),
    [characters, selectedEntry]
  );
  // Participants = SUM of row counts (each participant adds +1% monster HP),
  // unless explicitly overridden in trial options.
  const participantCount = trialConfig.participantCount ?? rosterSize(roster);
  // The selected trial's monster reference (rendered as cards in the viewport).
  const selectedTrialDetail = (gameData?.guildTrials || []).find(t => t.hrid === trialConfig.trialHrid) || null;

  // -- Guild-trial roster operations ----------------------------------------

  /** Add (or select) a row for a (character, loadout) reference. */
  const addRowFromRef = useCallback((ref) => {
    if (!ref?.characterId || !ref?.loadoutName) return;
    const key = refKey(ref);
    const existing = roster.find(e => refKey(e) === key);
    if (existing) {
      setSelectedEntryId(existing.id);
      return;
    }
    const entryId = makeId('re');
    setRoster(prev => [
      ...prev,
      { id: entryId, characterId: ref.characterId, loadoutName: ref.loadoutName, count: 1 }
    ]);
    setSelectedEntryId(entryId);
  }, [roster]);

  // A blank TRIAL character drops `guildShrines` rather than carrying the zone
  // slot's `{}`. The two spellings are not the same question here: `{}` means
  // "owns none" to resolveUnitShrineBuffs, whereas an absent key defers to the
  // trial header's party-wide knobs — which is the right default for a seat
  // nobody has said anything about yet. The zone-slot default stays `{}`,
  // since on that path there is no fallback to defer to. The key is now never
  // SET rather than set and deleted, which is the same fact said once.
  const addBlankBuild = useCallback(() => {
    const id = makeId('char');
    const character = { ...createCharacter({ name: 'New build', id, ownsShrines: false }), id };
    setCharacters(prev => upsertCharacter(prev, character));
    addRowFromRef({ characterId: id, loadoutName: 'default' });
  }, [addRowFromRef]);

  // A zone/lab slot joins the trial as a REFERENCE, not a deep clone: the seat
  // and the slot are now the same character wearing the same loadout, and
  // editing either is editing both.
  const addBuildFromSlot = useCallback((slotId) => {
    addRowFromRef(party[slotId]);
  }, [party, addRowFromRef]);

  // Add N participants of an EXISTING (character, loadout) pair. Counted model:
  // if the pair already has a row, its count grows; otherwise one row appears.
  const addEntriesForRef = useCallback((ref, count = 1) => {
    if (!ref?.characterId || !ref?.loadoutName) return;
    const key = refKey(ref);
    const n = Math.max(1, Math.round(Number(count) || 1));
    setRoster(prev => {
      const existing = prev.find(e => refKey(e) === key);
      if (existing) {
        return prev.map(e =>
          refKey(e) === key ? { ...e, count: clampCount((e.count ?? 1) + n) } : e
        );
      }
      return [...prev, {
        id: makeId('re'),
        characterId: ref.characterId,
        loadoutName: ref.loadoutName,
        count: clampCount(n)
      }];
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

  // Save-as-new: DETACH ONE UNIT INTO A NEW LOADOUT ON THE SAME CHARACTER.
  // It copies the gear, the ability slots and the consumables — and, being a
  // loadout, is structurally unable to copy a level. Two seats that differ only
  // in gear can no longer end up disagreeing about who their character is.
  //   count > 1 → decrement the source row, add a NEW count-1 row (right after
  //               it) pointing at the copy, and select it.
  //   count = 1 → repoint the row in place at the copy.
  const handleSaveAsNew = useCallback((entryId) => {
    const entry = roster.find(e => e.id === entryId);
    if (!entry) return;
    const character = characters.characters?.[entry.characterId];
    const source = character?.loadouts?.[entry.loadoutName];
    if (!source) return;
    const newName = uniqueLoadoutName(entry.loadoutName, character.loadouts);
    setCharacters(prev => setLoadout(prev, entry.characterId, newName, source));
    const count = clampCount(entry.count ?? 1);
    if (count > 1) {
      const newEntryId = makeId('re');
      setRoster(prev => {
        const idx = prev.findIndex(e => e.id === entryId);
        if (idx === -1) return prev;
        const next = prev.map(e =>
          e.id === entryId ? { ...e, count: count - 1 } : e
        );
        next.splice(idx + 1, 0, {
          id: newEntryId,
          characterId: entry.characterId,
          loadoutName: newName,
          count: 1
        });
        return next;
      });
      setSelectedEntryId(newEntryId);
    } else {
      setRoster(prev => prev.map(e => (e.id === entryId ? { ...e, loadoutName: newName } : e)));
    }
  }, [roster, characters]);

  /**
   * The four reference-holding slices, rewritten TOGETHER. A
   * `{characterId, loadoutName}` reference lives in the party AND in the trial
   * roster, and every mutation site used to mend one and forget the other —
   * in opposite directions, depending on which site you reached it from. See
   * utils/refRepair.js for the DROP rule and the history.
   */
  const applyWorld = useCallback((next) => {
    setCharacters(next.characters);
    setParty(next.party);
    setRoster(next.roster);
    setSelectedEntryId(next.selectedEntryId);
  }, []);
  const worldNow = useCallback(
    () => ({ characters, party, roster, selectedEntryId }),
    [characters, party, roster, selectedEntryId]
  );

  // Permanently delete a LOADOUT (not just a roster row). Unlike
  // handleDeleteEntry — which keeps the loadout as a re-addable orphan — this
  // removes it from the character AND drops every roster row pointing at it,
  // mending the selection if the selected row was one of them. The CHARACTER
  // survives: its levels are not this loadout's to take away.
  const handleDeleteLoadout = useCallback((ref) => {
    if (!ref?.characterId || !ref?.loadoutName) return;
    applyWorld(deleteLoadoutEverywhere(worldNow(), ref.characterId, ref.loadoutName));
  }, [applyWorld, worldNow]);

  /**
   * Permanently delete a CHARACTER and everything it owns. There was no UI for
   * this at all before — which made a recovered orphan un-removable in practice
   * — so it is wired through the same one helper from the start.
   */
  const handleDeleteCharacter = useCallback((characterId) => {
    if (!characterId) return;
    applyWorld(deleteCharacterEverywhere(worldNow(), characterId));
  }, [applyWorld, worldNow]);

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

  // PlayerConfig edits the selected entry; the character half propagates to
  // every seat and party slot wearing that character, the loadout half to every
  // roster row pointing at that loadout.
  // ONE handler for both modes — a trial seat is the same kind of reference a
  // party slot is, so the edit path cannot fork.
  const handleBuildChange = useCallback(
    (updated) => applyPlayerEdit(selectedEntry, updated),
    [selectedEntry, applyPlayerEdit]
  );

  // Renaming a seat renames the LOADOUT it wears (the character's own name is
  // edited beside it), rewriting every row that pointed at the old name.
  const handleRenameLoadout = useCallback((name) => {
    if (!selectedEntry || !name?.trim()) return;
    const next = renameLoadoutEverywhere(
      worldNow(),
      selectedEntry.characterId,
      selectedEntry.loadoutName,
      name.trim()
    );
    if (next.name === selectedEntry.loadoutName) return;
    applyWorld(next);
  }, [selectedEntry, applyWorld, worldNow]);

  /**
   * Renaming a CHARACTER needs no reference repair: `sanitizeCharacter` copies
   * the existing `id` rather than re-deriving it from the name, and both
   * holders reference `characterId`. Only the display name changes, so there is
   * deliberately no `renameCharacterEverywhere` — the property is pinned by a
   * regression test instead of guarded by dead code.
   */
  const handleRenameCharacter = useCallback((characterId, name) => {
    if (!characterId || !name) return;
    setCharacters(prev => {
      const existing = prev.characters?.[characterId];
      return existing ? upsertCharacter(prev, { ...existing, name }) : prev;
    });
  }, []);

  /**
   * Clearing is a STATE reset first and a storage wipe second. Removing the
   * keys alone was undone milliseconds later by the autosave effects (this
   * file's saveCharacters and saveGuildTrialState, ImportExport's saveSession),
   * which rewrote every key from the still-in-memory state. ImportExport keeps
   * its removeItem calls as belt-and-braces for effects that may not have run.
   */
  const handleClearSaved = useCallback(() => {
    setCharacters(emptyStore());
    setParty(createInitialParty());
    setSelectedPlayers([1]);
    setRoster([]);
    setSelectedEntryId(null);
    setTrialConfig({ ...DEFAULT_TRIAL_CONFIG });
  }, []);

  // WIRE FORMAT UNCHANGED, adapted on arrival. The {masterBuilds, roster}
  // payload is a two-repo protocol (utils/rosterBridge.js) and carries no
  // character grouping to begin with, so each master build becomes a character
  // of its own with a single loadout named `default`.
  const handleImportRoster = useCallback((data) => {
    const builds = data.masterBuilds || {};
    setCharacters(prev => {
      let next = prev;
      for (const [buildId, build] of Object.entries(builds)) {
        if (!build || typeof build !== 'object') continue;
        const { character, loadout } = splitPlayer(build);
        next = upsertCharacter(next, {
          ...character,
          id: buildId,
          name: build.name || buildId,
          loadouts: { default: loadout }
        });
      }
      return next;
    });
    const rows = normalizeRoster(
      (Array.isArray(data.roster) ? data.roster : []).map(r => ({
        id: r.id,
        characterId: r.characterId || r.buildId,
        loadoutName: r.loadoutName || 'default',
        count: r.count
      }))
    );
    setRoster(rows);
    setSelectedEntryId(rows[0]?.id ?? null);
    if (data.trialConfig) {
      setTrialConfig(prev => ({ ...prev, ...data.trialConfig }));
    }
  }, []);

  /** A single build pasted into the trial panel: one character, one loadout. */
  const handleImportBuild = useCallback((flat, name) => {
    const id = makeId('char');
    const { character, loadout } = splitPlayer(flat);
    setCharacters(prev => upsertCharacter(prev, {
      ...character,
      id,
      name: name || 'Imported build',
      loadouts: { default: loadout }
    }));
    addRowFromRef({ characterId: id, loadoutName: 'default' });
  }, [addRowFromRef]);

  // SCLIRoster roster link: the dashboard's "open in csim" is a plain <a> at
  // `#rosterBridge=gz:<base64url>` carrying the whole trial roster. Decoding
  // lives in utils/rosterBridge.js, which is one half of a two-repo protocol —
  // the other half is optimizer/src/model/rosterLink.js in SCLIRoster.
  //
  // Two cases, one handler. On MOUNT the hash is already there, and this effect
  // is declared AFTER handleImportRoster deliberately so the dependency reads
  // top-down and the callback cannot be consumed before it exists — the mount
  // race the MWIX bridge effect above had to be positioned around too. On a
  // RELAUNCH the tab is already open and the browser only fires `hashchange`,
  // with no remount at all, so a mount-only import would silently do nothing
  // the second time the reader clicked. Both paths run `consume`.
  //
  // The hash is cleared on the way out, success or failure. It has to be: an
  // uncleared fragment makes the NEXT click on the same link a navigation to
  // the URL already displayed, which fires no event and loads no roster.
  useEffect(() => {
    let cancelled = false;

    const consume = async () => {
      const value = readRosterLinkValue(window.location.hash);
      // `null` and `''` are different answers and only one of them is "do
      // nothing". ABSENT (null) means this is not a roster link at all — an
      // ordinary visit, or someone else's fragment — so return before touching
      // the hash. PRESENT-BUT-EMPTY (`#rosterBridge=`, what a truncated or
      // hand-mangled link looks like) means this IS a roster link and it is
      // broken, which is exactly the case the whole design set out to make
      // diagnosable: it falls through to the `try`, where the `gz:` prefix
      // check produces "unrecognised roster link encoding" and the `finally`
      // clears the hash. A falsy test here swallowed it — no message, and an
      // uncleared fragment that made the reader's second click a no-op.
      if (value === null) return;
      try {
        const data = validateRosterPayload(await decodeRosterLinkValue(value));
        if (cancelled) return;
        handleImportRoster(data);
        setSimMode('guildTrial');
        const seats = (data.roster || []).reduce((n, r) => n + (Number(r.count) || 1), 0);
        const trial = String(data.trialConfig?.trialHrid || '').split('/').pop() || 'trial';
        const tier = data.trialConfig?.startTier ?? '?';
        setBridgeMessage(`roster link imported — ${seats} seats · ${trial} · tier ${tier}`);
      } catch (err) {
        if (cancelled) return;
        // The word "failed" is load-bearing: the alert below colours on it.
        setSimMode('guildTrial');
        setBridgeMessage(
          `roster link failed — ${err?.message || 'unknown error'}. ` +
          'Use Import roster and paste the JSON.'
        );
      } finally {
        clearRosterLinkHash();
      }
    };

    consume();
    window.addEventListener('hashchange', consume);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', consume);
    };
  }, [handleImportRoster]);

  const handleStartTrial = useCallback(() => {
    if (roster.length === 0) return;
    // Counted rows expand into `count` DTOs each, with UNIQUE hrids
    // (player1..playerN) so per-unit trial death stats don't collide. Trials
    // disable consumables, so strip food/drinks (the engine ignores them too).
    // hridToLoadout records which (character, loadout) each unit came from so
    // the results view can group per-hrid stats (avgPlayerDps etc.) back.
    const playerDTOs = [];
    const hridToLoadout = {};
    for (const entry of roster) {
      // Resolved per row, as it must be: this is the ONE DTO site the shared
      // resolvedParty memo cannot serve. A dangling reference is skipped.
      const build = resolveRef(characters, entry);
      if (!build) continue;
      const label = `${characters.characters[entry.characterId]?.name || entry.characterId} — ${entry.loadoutName}`;
      const n = clampCount(entry.count ?? 1);
      for (let i = 0; i < n; i++) {
        const hrid = `player${playerDTOs.length + 1}`;
        hridToLoadout[hrid] = {
          characterId: entry.characterId,
          loadoutName: entry.loadoutName,
          label
        };
        // Shrines ride on the UNIT, not on the party. The guild buys the
        // ceiling, the member buys the level (the game's own wording, quoted at
        // sim/engine.js:attachShrineBuffs in SCLIRoster), so two seats in the
        // same trial legitimately carry different shrine levels. The worker
        // concatenates this onto the trial-wide buffs; a DTO without the field
        // is unchanged.
        playerDTOs.push({
          ...toPlayerDTO(build, { hrid, stripConsumables: true }),
          // `includeSeals: false` because the game grants no seals inside a
          // trial — same reason the neutral `extra` below zeroes the community
          // buffs. `partyShrineLevels` is the trial's own fallback and is passed
          // ONLY here; every other path resolves shrines strictly per player.
          extraBuffs: resolvePlayerExtraBuffs(build, {
            partyShrineLevels: trialConfig.guildBuffLevels,
            includeSeals: false
          })
        });
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
      // BUILDINGS only. Buildings are genuinely guild-wide — every
      // participant stands in the same guild hall — so they belong on the
      // trial-wide list. Shrines used to be here too and no longer are: they
      // are a per-member purchase and now travel on each unit's DTO as
      // `extraBuffs` (see the roster loop above). Buildings remain trial-only;
      // the zone/labyrinth path deliberately ships shrines alone.
      guildBuffs: resolveGuildBuildingBuffs(trialConfig.guildBuildingLevels),
      // Community buffs / seals / MooPass do NOT apply inside guild trials —
      // the game does not grant them, so the UI hides the Buffs control in
      // trial mode and sends a neutral extra here to match.
      extra: {
        comExp: 0,
        comDrop: 0,
        mooPass: false,
        personalBuffs: [],
        // Experimental knobs are not buffs — they are which engine you are
        // running, so they travel even on the otherwise-neutral trial extra.
        experimental
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
        // Unit-hrid → { characterId, loadoutName, label } for the DPS grouping.
        hridToLoadout
      }
    });
  }, [roster, characters, trialConfig, gameData, runGuildTrial, experimental]);

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
    const playerDTOs = selectedParty.map(playerId => ({
      ...toPlayerDTO(resolvedParty[playerId], { hrid: `player${playerId}` }),
      // Display only — the engine never reads it. The optimiser lists triggers
      // for the whole party, and "player2" does not say whose heal threshold a
      // row is; the character's name does. Echoed back on every trigger row.
      name: characters.characters?.[party[playerId]?.characterId]?.name || undefined,
      // Shrines and seals ride on the UNIT, exactly as the trial path has done
      // since 2026-09-18. The API concatenates this tail onto its shared buff
      // list in api/lib/triggerSearch/poolWorker.js and bounds.js, and the
      // candidate DTOs are deep clones of these (triggerSearch/params.js
      // applyValues), so every candidate is scored on the real character.
      extraBuffs: resolvePlayerExtraBuffs(resolvedParty[playerId])
    }));
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
      // The API's buildExtraBuffs honours mooPass / comExp / comDrop, which is
      // now the whole of `extra` worth sending: seals moved onto the player DTOs
      // above, and the mwix lab keys are a browser-worker concern.
      extra: {
        comExp: extraOptions.comExp,
        comDrop: extraOptions.comDrop,
        mooPass: extraOptions.mooPass
      },
      // Empty, and deliberately still sent: this field is the PARTY-WIDE buff
      // list, and shrines are no longer party-wide. The server composes
      // buildExtraBuffs(extra).concat(guildBuffs), so omitting it would work
      // too — sending [] says the emptiness is meant.
      guildBuffs: [],
      // Objective is left to the server: it picks the time-denominated one when the
      // consumable costs above are present, and raw throughput when they are not.
      stages: toStages(triggerOptConfig),
      workers: triggerOptConfig.workers || undefined
    };
  }, [
    simMode,
    optTarget,
    labConfig,
    resolvedParty,
    selectedParty,
    characters,
    party,
    zone,
    difficultyTier,
    extraOptions,
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
    // Same per-unit buffs as the trigger optimiser: the scan's candidate DTOs
    // are structuredClones of these (equipmentScan/candidates.js
    // applyEnhancement), so `extraBuffs` survives into every probe.
    const playerDTOs = selectedParty.map(playerId => ({
      ...toPlayerDTO(resolvedParty[playerId], { hrid: `player${playerId}` }),
      extraBuffs: resolvePlayerExtraBuffs(resolvedParty[playerId])
    }));
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
      // As with the trigger optimiser: what is left in `extra` is the genuinely
      // account-wide part, and `guildBuffs` is empty because shrines travel per
      // unit now.
      extra: {
        comExp: extraOptions.comExp,
        comDrop: extraOptions.comDrop,
        mooPass: extraOptions.mooPass
      },
      guildBuffs: [],
      scan: toScan(equipOptConfig),
      workers: equipOptConfig.workers || undefined
    };
  }, [
    simMode,
    optTarget,
    labConfig,
    resolvedParty,
    selectedParty,
    zone,
    difficultyTier,
    extraOptions,
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
    () => selectedParty.map(playerId =>
      toPlayerDTO(resolvedParty[playerId], { hrid: `player${playerId}` })
    ),
    [resolvedParty, selectedParty]
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
    if (selectedParty.length === 0) return;

    // Exactly the party, buffs and shrines a single Run would send — the sweep
    // is the same simulation done many times, not a different one. That
    // includes each player's own shrines and seals, which ride on the DTO.
    const playerDTOs = selectedParty.map(playerId => ({
      ...toPlayerDTO(resolvedParty[playerId], {
        hrid: `player${playerId}`,
        stripConsumables: mazeContext
      }),
      extraBuffs: resolvePlayerExtraBuffs(resolvedParty[playerId])
    }));

    runAllZones({
      players: playerDTOs,
      combos,
      simulationTimeLimit: allZonesHours * ONE_HOUR,
      hours: allZonesHours,
      workers: allZonesWorkers,
      extra: {
        ...extraOptions,
        experimental,
        mwixLabUpgrades: labConfig.upgrades,
        mwixMaze: { enabled: mazeContext }
      },
      // Party-wide shrines are gone; each DTO carries its own. See the single
      // Run below for the full account.
      guildBuffs: []
    });
    setAllZonesOpen(false);
    setAllZonesView(true);
  }, [
    gameData,
    allZonesSelection,
    allZonesHours,
    allZonesWorkers,
    resolvedParty,
    selectedParty,
    mazeContext,
    extraOptions,
    experimental,
    labConfig,
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
    // Every selected slot is empty or dangling: there is nothing to simulate.
    if (selectedParty.length === 0) return;
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
    const playerDTOs = selectedParty.map(playerId => ({
      ...toPlayerDTO(resolvedParty[playerId], { hrid: `player${playerId}`, stripConsumables }),
      extraBuffs: resolvePlayerExtraBuffs(resolvedParty[playerId])
    }));
    const extra = {
      ...extraOptions,
      experimental,
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
      // Shrine buffs are still permanent character buffs that apply to every
      // fight (the game exposes them via
      // guildActionTypeBuffsMap["/action_types/combat"]) — but they are bought
      // per MEMBER, so they are no longer a party-wide list. Each player's own
      // shrines, and their own seals, ride on their DTO as `extraBuffs`, which
      // src/worker.js concatenates onto this list. This field now carries
      // nothing on the zone/labyrinth path, and is kept explicit so that a
      // reader does not have to wonder whether it was forgotten.
      guildBuffs: []
    });
  }, [resolvedParty, selectedParty, simMode, zone, difficultyTier, labConfig, mazeContext, duration, extraOptions, experimental, runSimulation, handleStartTrial, handleStartTriggerOpt, handleStartEquipOpt]);

  // Pickers for the slot binder, and the label the party checkboxes wear.
  const characterOptions = useMemo(
    () => Object.values(characters.characters || {})
      .map(c => ({ value: c.id, label: c.name || c.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [characters]
  );
  const activeLoadoutOptions = useMemo(() => {
    const id = party[activeTab]?.characterId;
    return Object.keys(characters.characters?.[id]?.loadouts || {});
  }, [characters, party, activeTab]);
  const slotLabel = useCallback((id) => {
    const ref = party[id];
    if (!ref) return 'empty';
    const character = characters.characters?.[ref.characterId];
    if (!character) return 'missing';
    return `${character.name || character.id}/${ref.loadoutName}`;
  }, [characters, party]);

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
            experimental={experimental}
            onExperimentalChange={handleExperimentalChange}
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
                  characters={characters}
                  roster={roster}
                  selectedEntryId={selectedEntryId}
                  participantCount={participantCount}
                  items={gameData?.items}
                  party={party}
                  trialConfig={trialConfig}
                  onSelectEntry={setSelectedEntryId}
                  onDuplicate={handleDuplicate}
                  onSetCount={handleSetCount}
                  onSaveAsNew={handleSaveAsNew}
                  onDelete={handleDeleteEntry}
                  onDeleteLoadout={handleDeleteLoadout}
                  onAddEntryFromRef={addEntriesForRef}
                  onAddBuildFromSlot={addBuildFromSlot}
                  onAddRowFromRef={addRowFromRef}
                  onAddBlankBuild={addBlankBuild}
                  onImportRoster={handleImportRoster}
                  onImportBuild={handleImportBuild}
                />

                <Divider />

                {selectedTrialPlayer ? (
                  <>
                    <TextInput
                      label="Character name"
                      value={selectedCharacter?.name || ''}
                      onChange={(e) =>
                        handleRenameCharacter(selectedCharacter?.id, e.currentTarget.value)}
                      size="xs"
                    />
                    {/* Uncontrolled and committed on blur/Enter, unlike the
                        character name: a loadout's name is also its KEY in the
                        store, so renaming on every keystroke would rewrite the
                        key (and every roster row pointing at it) four times to
                        type "tank". `key` resets the field when the selection
                        moves. */}
                    <TextInput
                      key={selectedEntryId}
                      label="Loadout name"
                      defaultValue={selectedEntry?.loadoutName || ''}
                      onBlur={(e) => handleRenameLoadout(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      size="xs"
                    />
                    <Text size="xs" c="dimmed">
                      Levels, houses, shrines and seals belong to the CHARACTER and
                      are shared by every seat and party slot wearing it; only gear,
                      abilities and consumables belong to this loadout.
                    </Text>
                    <PlayerConfig
                      gameData={gameData}
                      player={selectedTrialPlayer}
                      onPlayerChange={handleBuildChange}
                      playerId={roster.findIndex(e => e.id === selectedEntryId) + 1}
                      hideConsumables
                      hideSeals
                    />
                  </>
                ) : (
                  <Text size="sm" c="dimmed">
                    Select a roster entry to edit its character and loadout.
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
                      {PARTY_SLOTS.map(id => (
                        <Checkbox
                          key={id}
                          value={String(id)}
                          label={`P${id} — ${slotLabel(id)}`}
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
                    {PARTY_SLOTS.map(id => (
                      <Tabs.Tab key={id} value={String(id)}>
                        P{id}
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs>

                {/* The slot binder: pick a CHARACTER, then one of ITS loadouts.
                    Two slots may name the same character — that is the point:
                    they then share one set of levels, with no copy step. */}
                <Group gap={6} grow>
                  <Select
                    label={`P${activeTab} character`}
                    data={characterOptions}
                    value={party[activeTab]?.characterId ?? null}
                    onChange={(characterId) => {
                      if (!characterId) return bindSlot(activeTab, null);
                      const names = Object.keys(
                        characters.characters[characterId]?.loadouts || {}
                      );
                      bindSlot(activeTab, { characterId, loadoutName: names[0] || 'default' });
                    }}
                    placeholder={characterOptions.length ? 'Character…' : 'Import a character first'}
                    disabled={characterOptions.length === 0}
                    clearable
                    size="xs"
                    comboboxProps={{ withinPortal: false }}
                  />
                  <Select
                    label="Loadout"
                    data={activeLoadoutOptions}
                    value={party[activeTab]?.loadoutName ?? null}
                    onChange={(loadoutName) => {
                      const characterId = party[activeTab]?.characterId;
                      if (!characterId || !loadoutName) return;
                      bindSlot(activeTab, { characterId, loadoutName });
                    }}
                    placeholder="Loadout…"
                    disabled={activeLoadoutOptions.length === 0}
                    size="xs"
                    comboboxProps={{ withinPortal: false }}
                  />
                </Group>

                <CharacterImport
                  activeTab={activeTab}
                  onLoadCharacter={(character, defaultLoadoutName) =>
                    handleImportCharacter(activeTab, character, defaultLoadoutName)}
                />

                <ImportExport
                  resolvedParty={resolvedParty}
                  party={party}
                  onImportPlayer={handleImportPlayer}
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
                  onClearSaved={handleClearSaved}
                />

                <LoadoutManager
                  characters={characters}
                  setCharacters={setCharacters}
                  slotRef={party[activeTab]}
                  slotId={activeTab}
                  setParty={setParty}
                  player={resolvedParty[activeTab]}
                  onDeleteLoadout={handleDeleteLoadout}
                  onDeleteCharacter={handleDeleteCharacter}
                  onRenameCharacter={handleRenameCharacter}
                />

                <Divider />

                {resolvedParty[activeTab] ? (
                  <PlayerConfig
                    gameData={gameData}
                    player={resolvedParty[activeTab]}
                    onPlayerChange={(updatedPlayer) =>
                      handleResolvedPlayerChange(activeTab, updatedPlayer)}
                    playerId={activeTab}
                  />
                ) : (
                  <Text size="sm" c="dimmed">
                    P{activeTab} is empty. Bind a character and loadout above, or
                    import one — levels, houses, shrines and seals then belong to
                    that character and are shared by every slot wearing it.
                  </Text>
                )}
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
              // Whose loot the Drops tab shows. Same convention as the All Zones
              // table: the party's members do not share a drop table — drop
              // rate and rare find are per-character stats — so the panel
              // answers for the player open in the P-tab, and follows it
              // immediately without a re-run.
              focusHrid={`player${activeTab}`}
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
