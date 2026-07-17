// =============================================================================
// roster — pure state helpers for the guild-trial roster model.
// -----------------------------------------------------------------------------
// The trial mode uses a two-level model, distinct from the fixed 5-slot
// zone/lab `players` state:
//
//   masterBuilds : { [buildId]: { id, name, ...playerFields } }
//       A named, editable character build. Editing one propagates to every
//       roster row that links to it.
//   roster       : [ { id, buildId, count } ]
//       ONE row per build in the trial, with a participant COUNT (>= 1).
//       "20 clones" is a single row with count 20, not 20 rows. Invariant:
//       at most one row per buildId — normalizeRoster enforces it on load /
//       import, and every add-affordance increments an existing row instead
//       of appending a duplicate.
//
// Deleting a row does NOT delete its master build — the build becomes an
// orphan that can be re-added from the "existing build" picker.
// =============================================================================

const STORAGE_KEY = 'csim_guild_trial';

// LoadoutManager's persistence key (ui/src/components/LoadoutManager.jsx).
// Loadouts are saved as { [name]: { savedAt, player: { ...playerFields } } }
// in the UI-internal player shape — directly usable as a master build.
const LOADOUTS_KEY = 'csim_loadouts';

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
  guildBuffLevels: {}, // { [buffHrid]: level }, 0/absent = off
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
 *   - legacy rows without `count` become count 1;
 *   - rows sharing a buildId are merged into one row (first-occurrence order,
 *     counts summed) — lossless, since linked clones are identical by
 *     construction.
 * Accepts both the legacy `[{id, buildId}]` and counted formats, so it also
 * serves as the import/migration path.
 */
export function normalizeRoster(roster) {
  const byBuild = new Map(); // buildId -> merged row (insertion-ordered)
  for (const entry of roster || []) {
    if (!entry || !entry.buildId) continue;
    const count = clampCount(entry.count ?? 1);
    const existing = byBuild.get(entry.buildId);
    if (existing) {
      existing.count = Math.min(MAX_ROW_COUNT, existing.count + count);
    } else {
      byBuild.set(entry.buildId, {
        id: entry.id || makeId('re'),
        buildId: entry.buildId,
        count,
      });
    }
  }
  return [...byBuild.values()];
}

/** Ensure `base` is unique among existing build names, appending " copy"/N. */
export function uniqueBuildName(base, masterBuilds) {
  const names = new Set(Object.values(masterBuilds || {}).map(b => b.name));
  if (!names.has(base)) return base;
  let candidate = `${base} copy`;
  let n = 2;
  while (names.has(candidate)) {
    candidate = `${base} copy ${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * Annotate roster rows with their linked build. One row per build; the row's
 * display name IS the build name (always current, so renames flow through).
 */
export function listRosterEntries(roster, masterBuilds) {
  return (roster || []).map(entry => {
    const build = masterBuilds?.[entry.buildId] || null;
    const buildName = build?.name || 'Unknown build';
    return {
      ...entry,
      count: clampCount(entry.count ?? 1),
      build,
      buildName,
      displayName: buildName,
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
 * Saved zone/lab loadouts (LoadoutManager's localStorage store), as
 * [{ name, savedAt, player }] sorted by name. The stored player object is in
 * the UI-internal shape and deep-copies directly into a master build.
 */
export function loadSavedLoadouts() {
  try {
    const map = JSON.parse(localStorage.getItem(LOADOUTS_KEY)) || {};
    return Object.entries(map)
      .filter(([, v]) => v && typeof v === 'object' && v.player)
      .map(([name, v]) => ({ name, savedAt: v.savedAt, player: v.player }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function loadGuildTrialState() {
  const fallback = {
    masterBuilds: {},
    roster: [],
    selectedEntryId: null,
    trialConfig: { ...DEFAULT_TRIAL_CONFIG },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    // normalizeRoster also migrates legacy pre-count rosters (many single
    // rows sharing a buildId collapse into one counted row).
    const roster = normalizeRoster(Array.isArray(data.roster) ? data.roster : []);
    const selectedEntryId =
      data.selectedEntryId != null && roster.some(e => e.id === data.selectedEntryId)
        ? data.selectedEntryId
        : (roster[0]?.id ?? null);
    return {
      masterBuilds: data.masterBuilds && typeof data.masterBuilds === 'object' ? data.masterBuilds : {},
      roster,
      selectedEntryId,
      trialConfig: { ...DEFAULT_TRIAL_CONFIG, ...(data.trialConfig || {}) },
    };
  } catch (e) {
    console.error('Failed to load guild-trial state:', e);
    return fallback;
  }
}

export function saveGuildTrialState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save guild-trial state:', e);
  }
}
