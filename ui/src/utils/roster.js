// =============================================================================
// roster — pure state helpers for the guild-trial roster model.
// -----------------------------------------------------------------------------
// Since schemaVersion 2 the trial roster holds REFERENCES into the shared
// character store (utils/characterStore.js) rather than copies of whole flat
// players. `masterBuilds` is gone: a "build" was always a character wearing a
// loadout, and keeping a private copy of one is exactly how a level forked.
//
//   roster : [ { id, characterId, loadoutName, count } ]
//       ONE row per (character, loadout) pair, with a participant COUNT (>= 1).
//       "20 clones" is a single row with count 20, not 20 rows. Invariant:
//       at most one row per pair — normalizeRoster enforces it on load /
//       import, and every add-affordance increments an existing row instead
//       of appending a duplicate.
//
// Deleting a row does NOT delete the loadout it points at — it stays on the
// character and can be re-added from the picker.
// =============================================================================

import { loadVersioned, resolveRef } from './characterStore.js';

const STORAGE_KEY = 'csim_guild_trial';
export const TRIAL_SCHEMA_VERSION = 2;

/** The composite identity of a roster row: which character, wearing what. */
export function refKey(ref) {
  return `${ref?.characterId || ''}\u0000${ref?.loadoutName || ''}`;
}

export const MAX_ROW_COUNT = 99;

export const DEFAULT_TRIAL_CONFIG = {
  trialHrid: '/guild_combat/badger',
  startTier: 100,
  // Trials are deterministic-ish and slow per run — default to a single pass so
  // a fresh session gives instant feedback; users can crank iterations for a
  // smoother distribution. (Persisted csim_guild_trial keeps any saved value.)
  iterations: 1,
  participantCount: null, // null ⇒ auto (roster size = sum of row counts)
  buildersHallBonus: 0, // percent
  treasuryBonus: 0, // percent
  guildBuffLevels: {}, // { [buffHrid]: level }, 0/absent = off — shrines, ALL combat
  // { [buildingHrid]: level }, 0/absent = off. Guild BUILDING buffs apply to
  // guild trials only, never to zone/dungeon combat, so they are read solely by
  // the trial path in App.jsx.
  guildBuildingLevels: {},
  // Debugging / what-if knob (PERCENT): scales the enemies' effective level
  // (tier × enemyScale/100) without changing ladder or reward tiers.
  // 100 = official. Shipped to the engine as trialOptions.enemyScale (ratio).
  enemyScale: 100,
};

let __seq = 0;
/** Collision-resistant id without leaning on any specific browser global. */
export function makeId(prefix = 'id') {
  __seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${__seq.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** Deep clone of plain JSON-serialisable state (builds carry no functions). */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Clamp a roster-row count into [1, MAX_ROW_COUNT]. */
export function clampCount(n) {
  return Math.max(1, Math.min(MAX_ROW_COUNT, Math.round(Number(n) || 1)));
}

/** Total participants = sum of row counts (drives the +1% HP scaling). */
export function rosterSize(roster) {
  return (roster || []).reduce((sum, e) => sum + clampCount(e.count ?? 1), 0);
}

/**
 * Normalise a roster to the counted model:
 *   - rows without `count` become count 1;
 *   - rows sharing a (characterId, loadoutName) pair merge into one row
 *     (first-occurrence order, counts summed) — lossless, since two rows
 *     pointing at the same pair are identical by construction.
 */
export function normalizeRoster(roster) {
  const byRef = new Map(); // refKey -> merged row (insertion-ordered)
  for (const entry of roster || []) {
    if (!entry || !entry.characterId || !entry.loadoutName) continue;
    const count = clampCount(entry.count ?? 1);
    const key = refKey(entry);
    const existing = byRef.get(key);
    if (existing) {
      existing.count = Math.min(MAX_ROW_COUNT, existing.count + count);
    } else {
      byRef.set(key, {
        id: entry.id || makeId('re'),
        characterId: entry.characterId,
        loadoutName: entry.loadoutName,
        count,
      });
    }
  }
  return [...byRef.values()];
}

/**
 * Annotate roster rows with the RESOLVED player their reference names. The row
 * carries no copy of anything: `build` is manufactured on the spot by
 * resolvePlayer, so a level edited anywhere is seen here with no sync step. A
 * dangling reference (character or loadout deleted) resolves to null and the
 * row renders as unknown rather than disappearing.
 */
export function listRosterEntries(roster, characters) {
  return (roster || []).map(entry => {
    const build = resolveRef(characters, entry);
    const character = characters?.characters?.[entry.characterId] || null;
    const displayName = character
      ? `${character.name || character.id} — ${entry.loadoutName}`
      : 'Unknown build';
    return {
      ...entry,
      count: clampCount(entry.count ?? 1),
      build,
      buildName: displayName,
      displayName,
    };
  });
}

const COMBAT_LEVEL_KEYS = [
  ['attackLevel', 'Atk'],
  ['magicLevel', 'Mag'],
  ['rangedLevel', 'Rng'],
];

/**
 * Cheap one-line combat summary for a roster row: equipped weapon name (from
 * the bundled item map) plus the dominant combat skill. No engine call.
 */
export function buildSummary(build, items) {
  if (!build) return '';
  const weaponSlot =
    build.equipment?.['/equipment_types/main_hand'] ||
    build.equipment?.['/equipment_types/two_hand'] ||
    null;
  const weaponName = weaponSlot?.itemHrid
    ? items?.[weaponSlot.itemHrid]?.name || 'Weapon'
    : 'Unarmed';

  let best = { label: 'Atk', level: 0 };
  for (const [key, label] of COMBAT_LEVEL_KEYS) {
    const level = Number(build[key]) || 0;
    if (level > best.level) best = { label, level };
  }
  return `${weaponName} · ${best.label} ${best.level}`;
}

/**
 * The stored trial state, plus how the read went. A pre-v2 blob embedded whole
 * master builds, which the reference model cannot express, so the version gate
 * sets it aside at `csim_guild_trial.v1` and we start empty rather than guess.
 * @returns {{data: object, status: 'empty'|'ok'|'incompatible'}}
 */
export function loadGuildTrialState() {
  const fallback = {
    schemaVersion: TRIAL_SCHEMA_VERSION,
    roster: [],
    selectedEntryId: null,
    trialConfig: { ...DEFAULT_TRIAL_CONFIG },
  };
  const { data, status } = loadVersioned(STORAGE_KEY, TRIAL_SCHEMA_VERSION, fallback);
  const roster = normalizeRoster(Array.isArray(data.roster) ? data.roster : []);
  const selectedEntryId =
    data.selectedEntryId != null && roster.some(e => e.id === data.selectedEntryId)
      ? data.selectedEntryId
      : (roster[0]?.id ?? null);
  return {
    data: {
      roster,
      selectedEntryId,
      trialConfig: { ...DEFAULT_TRIAL_CONFIG, ...(data.trialConfig || {}) },
    },
    status,
  };
}

export function saveGuildTrialState(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, schemaVersion: TRIAL_SCHEMA_VERSION })
    );
  } catch (e) {
    console.error('Failed to save guild-trial state:', e);
  }
}
