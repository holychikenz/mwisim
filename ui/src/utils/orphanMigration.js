// =============================================================================
// orphanMigration — recovering the pre-v2 `csim_loadouts` library, ONCE.
// -----------------------------------------------------------------------------
// Before schemaVersion 2 a "loadout" was a whole flat player: the gear AND the
// levels, houses, achievements, shrines and seals of whoever was wearing it.
// The v2 model has no place to put such a thing, so the clean break left the
// blob on disk with a notice and nothing ever read it again. This recovers it.
//
// WHAT IS IN SCOPE: `csim_loadouts` ONLY. It is what "orphaned loadouts" means
// — named, deliberate, user-curated, and the only legacy source no code path
// has ever migrated. `csim_player_data.v1` is OUT (unnamed live scratch state;
// recovering it would manufacture up to five nameless characters for every user
// who ever opened the app). `csim_guild_trial.v1` masterBuilds are OUT for a
// sharper reason: a masterBuild ALREADY HAS A NAME, and folding it into the
// fingerprint grouping below would discard it — two identically-statted builds
// called "healer" and "offtank" would merge into one character called
// `orphan_1`. Recovering those honestly needs a different grouping and a
// different naming rule, which is not what this module describes.
//
// THE GROUPING RULE. Two recovered loadouts belong to the same synthetic
// character IFF their character-owned halves produce the identical fingerprint.
// Identical stats collapse into one character wearing several loadouts;
// differing stats become separate characters and are NEVER merged — merging
// would fabricate stats the user never entered.
//
// The fingerprint CANONICALISES; the STORED character does not. The stored
// character is the group representative's own values, verbatim: no key is
// reordered and no array is rewritten. So grouping is order-insensitive without
// any stored value being altered, and we never have to answer "does seal order
// matter to the engine?".
//
// `csim_loadouts` is NEVER written, cleared or deleted. It stays on disk as its
// own backup. A sibling `csim_loadouts.migrated` key — NOT a field in
// `csim_characters`, which `saveCharacters` would silently erase on the next
// save — stops this running twice.
//
// FRAMEWORK-FREE, like characterStore.js: no React, and `localStorage` is
// touched only inside function bodies.
// =============================================================================

import {
  loadCharacters,
  makeCharacterId,
  saveCharacters,
  splitPlayer,
  uniqueLoadoutName,
  upsertCharacter
} from './characterStore.js';

export const LEGACY_LOADOUTS_KEY = 'csim_loadouts';
export const ORPHAN_MARKER_KEY = 'csim_loadouts.migrated';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/**
 * The character-owned fields that decide identity: CHARACTER_KEYS minus `id`,
 * `name` and `loadouts`. Written out as a LITERAL, in a fixed order, rather
 * than derived from CHARACTER_KEYS at runtime — so a future reorder of that
 * list cannot silently change every fingerprint.
 */
export const FINGERPRINT_FIELDS = Object.freeze([
  'staminaLevel',
  'intelligenceLevel',
  'attackLevel',
  'meleeLevel',
  'defenseLevel',
  'rangedLevel',
  'magicLevel',
  'houseRooms',
  'achievements',
  'debuffOnLevelGap',
  'guildShrines',
  'personalBuffs',
  'abilityLevels'
]);

/**
 * Canonical serialisation. NOT `JSON.stringify` of an arbitrarily-ordered
 * object: two blobs holding the same data with their keys written in a
 * different order must produce the same string.
 *
 * `Object.keys(v).sort()` uses the DEFAULT comparator (UTF-16 code-unit order),
 * which is deterministic and locale-independent. Emphatically not
 * `localeCompare`, whose result depends on the user's locale and would make the
 * same data fingerprint differently on two machines.
 *
 * Values are compared EXACTLY — no coercion, no rounding. `8` and `"8"` are
 * different data and must fingerprint differently. `-0` normalises to `"0"`.
 */
export function canon(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v === 0 ? 0 : v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`;
  }
  return 'null';
}

/**
 * The identity string for a character half.
 *
 * THE TRI-STATE, fingerprinted distinctly:
 *   key absent  -> `"guildShrines":#absent`
 *   `{}`        -> `"guildShrines":{}`
 *   populated   -> `"guildShrines":{"/buff_types/guild_force":5}`
 *
 * `#absent` is an UNQUOTED BARE TOKEN. `canon` emits only `null`, `true`,
 * `false`, a decimal number, a `JSON.stringify`'d string (always quoted), `[…]`
 * or `{…}` — it can never produce a leading `#`. So absent and `{}` cannot
 * collide, by construction rather than by luck.
 *
 * `personalBuffs` is the only array here and it is a SET of seal hrids: order
 * carries no meaning, so it is deduped and sorted FOR THE FINGERPRINT ONLY.
 * Every other array keeps its order.
 */
export function fingerprintCharacter(character) {
  const c = isObject(character) ? character : {};
  const parts = [];
  for (const key of FINGERPRINT_FIELDS) {
    const label = JSON.stringify(key);
    if (!has(c, key)) {
      parts.push(`${label}:#absent`);
    } else if (key === 'personalBuffs') {
      const seals = Array.isArray(c[key]) ? c[key] : [];
      const set = [...new Set(seals.map(String))].sort();
      parts.push(`${label}:${canon(set)}`);
    } else {
      parts.push(`${label}:${canon(c[key])}`);
    }
  }
  return parts.join('|');
}

/**
 * Group a legacy `csim_loadouts` blob into synthetic characters and upsert them
 * onto `store`. PURE — no storage is read or written here.
 *
 * Names are iterated SORTED, so both the group order and each group's
 * representative are independent of the JSON's text order: the migration is
 * stable across runs over the same data even if the blob is re-serialised.
 *
 * With exactly one group the character is named plain `orphan`; the numeric
 * suffix exists only to disambiguate, and with nothing to disambiguate it is
 * noise.
 *
 * @returns {{store, recovered: number, created: number, names: string[], skipped: number}}
 */
export function buildOrphanCharacters(blob, store) {
  if (!isObject(blob)) return { store, recovered: 0, created: 0, names: [], skipped: 0 };

  const groups = new Map(); // fingerprint -> { character, loadouts }
  let recovered = 0;
  let skipped = 0;

  for (const name of Object.keys(blob).sort()) {
    const entry = blob[name];
    if (!isObject(entry) || !isObject(entry.player)) {
      skipped += 1;
      continue;
    }
    const { character, loadout } = splitPlayer(entry.player);
    const fp = fingerprintCharacter(character);
    let group = groups.get(fp);
    if (!group) {
      group = { character, loadouts: {} };
      groups.set(fp, group);
    }
    // Belt and braces: legacy names are object keys and so are already unique
    // blob-wide, hence unique within a group.
    group.loadouts[uniqueLoadoutName(name, group.loadouts)] = loadout;
    recovered += 1;
  }

  const total = groups.size;
  let next = store;
  const names = [];
  let n = 0;
  for (const group of groups.values()) {
    n += 1;
    const base = total === 1 ? 'orphan' : `orphan_${n}`;
    // Deterministic given the same store: bump only on a real collision.
    let id = makeCharacterId(base);
    let label = base;
    let bump = 2;
    while (next?.characters?.[id]) {
      label = `${base}_${bump}`;
      id = makeCharacterId(label);
      bump += 1;
    }
    next = upsertCharacter(next, { ...group.character, id, name: label, loadouts: group.loadouts });
    names.push(label);
  }

  return { store: next, recovered, created: total, names, skipped };
}

/**
 * Recover `csim_loadouts` into `store`, at most once, ever.
 *
 * The marker is written LAST and only after the store write is VERIFIED by a
 * read-back: `saveCharacters` swallows quota errors, and that read-back is what
 * turns a silent failure into a re-runnable one instead of data loss.
 *
 * @returns {{store, recovered: number, created: number, names: string[], skipped: number}}
 */
export function migrateLegacyLoadouts(store) {
  const nothing = { store, recovered: 0, created: 0, names: [], skipped: 0 };

  let marker = null;
  try {
    marker = localStorage.getItem(ORPHAN_MARKER_KEY);
  } catch {
    return nothing; // No storage at all: do nothing rather than risk a re-run.
  }
  if (marker) return nothing;

  const writeMarker = (recovered, created, names) => {
    try {
      localStorage.setItem(
        ORPHAN_MARKER_KEY,
        JSON.stringify({
          schemaVersion: 2,
          at: new Date().toISOString(),
          recovered,
          created,
          characters: names
        })
      );
    } catch {
      // Quota or private browsing. The migration will simply run again.
    }
  };

  let raw = null;
  try {
    raw = localStorage.getItem(LEGACY_LOADOUTS_KEY);
  } catch {
    return nothing;
  }
  let blob = null;
  if (raw != null && raw !== '') {
    try {
      blob = JSON.parse(raw);
    } catch {
      blob = null;
    }
  }
  if (!isObject(blob) || !Object.keys(blob).length) {
    // Absent, empty, unparseable or not an object: mark it done so we do not
    // re-parse a corrupt blob on every load.
    writeMarker(0, 0, []);
    return nothing;
  }

  const result = buildOrphanCharacters(blob, store);
  if (!result.created) {
    writeMarker(result.recovered, 0, []);
    return { ...nothing, skipped: result.skipped };
  }

  saveCharacters(result.store);
  const readBack = loadCharacters();
  if (!result.names.every(name => readBack.characters?.[makeCharacterId(name)])) {
    // The write did not stick. Leave the marker unset so this runs again, and
    // hand back the in-memory store so the session is still usable.
    return result;
  }
  writeMarker(result.recovered, result.created, result.names);
  return result;
}
