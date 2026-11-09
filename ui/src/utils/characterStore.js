// =============================================================================
// characterStore — the two-level CHARACTER → LOADOUTS model (schemaVersion 2).
// -----------------------------------------------------------------------------
// A CHARACTER owns everything that is true of the person: the seven combat
// levels, house rooms, achievements, the level-gap debuff setting, guild
// shrines, seals, and the level of every ability they have TRAINED.
//
// A LOADOUT owns only what you can change by opening your bags: equipment,
// the five ability slots (their ordering and their triggers) and consumables.
// The loadout key set is EXACTLY `LOADOUT_KEYS` and `sanitizeLoadout` physically
// drops anything else, so a second copy of a level is not representable. That is
// the whole point: divergence is prevented at the store boundary rather than by
// everyone remembering not to write the wrong key.
//
// The flat player the rest of the app (and the engine DTO) still speaks is a
// transient VIEW, never stored state: `resolvePlayer(character, loadout)`
// manufactures it and `splitPlayer(flat)` takes it apart again. PlayerConfig,
// CharacterBonuses, TriggerEditor and playerDTO therefore need no changes at all.
//
// FRAMEWORK-FREE ON PURPOSE. No React, no Mantine, no import.meta.env, and
// `localStorage` is touched ONLY inside function bodies — never at module
// scope — so node's test runner can import this file directly (see
// api/tests/characterStore.test.mjs).
// =============================================================================

export const SCHEMA_VERSION = 2;
export const CHARACTERS_KEY = 'csim_characters';

/** Everything a CHARACTER may carry. Anything else is dropped on the way in. */
export const CHARACTER_KEYS = Object.freeze([
  'id',
  'name',
  // Optional { id, name } game identity (characterId + the name the last import
  // used). Never in a DTO: resolvePlayer emits explicit keys only.
  'game',
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
  'abilityLevels',
  'loadouts'
]);

/**
 * Everything a LOADOUT may carry — gear, ability slots, consumables. NO levels,
 * no houses, no achievements and, emphatically, NO `guildShrines`: the absent /
 * `{}` / populated tri-state (utils/guildBuffs.js `ownsShrines`) is a statement
 * about a PERSON, and a loadout must not be able to express one at all.
 */
export const LOADOUT_KEYS = Object.freeze([
  'equipment',
  'food',
  'drinks',
  'abilities',
  'triggerMemory'
]);

const LEVEL_FIELDS = Object.freeze([
  'staminaLevel',
  'intelligenceLevel',
  'attackLevel',
  'meleeLevel',
  'defenseLevel',
  'rangedLevel',
  'magicLevel'
]);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const sameGameId = (a, b) => a != null && b != null && String(a) === String(b);

/** Slug a display name into a stable character id. */
export function makeCharacterId(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || `character_${Date.now().toString(36)}`;
}

/**
 * A blank loadout. Five ability slots and three of each consumable, matching
 * the shapes PlayerConfig indexes into positionally.
 */
export function createLoadout() {
  return {
    equipment: {},
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    triggerMemory: {}
  };
}

/**
 * A blank character.
 *
 * `ownsShrines: false` omits the `guildShrines` key entirely, which is a
 * different answer from `{}`: absent means "defer to the trial header's
 * party-wide knobs", `{}` means "captured, owns none" and must NOT fall back.
 * The zone/lab default is `{}` (there is no fallback to defer to on that path);
 * a blank TRIAL seat wants the key absent.
 */
export function createCharacter({ name = 'New character', id, ownsShrines = true } = {}) {
  const character = {
    id: id || makeCharacterId(name),
    name,
    staminaLevel: 1,
    intelligenceLevel: 1,
    attackLevel: 1,
    meleeLevel: 1,
    defenseLevel: 1,
    rangedLevel: 1,
    magicLevel: 1,
    houseRooms: {},
    achievements: {},
    debuffOnLevelGap: 0,
    personalBuffs: [],
    abilityLevels: {},
    loadouts: { default: createLoadout() }
  };
  if (ownsShrines) character.guildShrines = {};
  return character;
}

/**
 * Pick exactly LOADOUT_KEYS off `raw` and nothing else. EVERY write into the
 * store goes through here — that is the structural enforcement. An
 * `attackLevel` handed to this function is dropped before it can be stored, so
 * a level has nowhere to land twice.
 */
export function sanitizeLoadout(raw) {
  const base = createLoadout();
  if (!isObject(raw)) return base;
  const out = {};
  for (const key of LOADOUT_KEYS) {
    out[key] = has(raw, key) && raw[key] != null ? raw[key] : base[key];
  }
  return out;
}

/** Pick exactly CHARACTER_KEYS, sanitizing every nested loadout as we go. */
export function sanitizeCharacter(raw) {
  const base = createCharacter();
  if (!isObject(raw)) return base;
  const out = {};
  for (const key of CHARACTER_KEYS) {
    // The tri-state again: only copy `guildShrines` if the source actually has
    // it, so "no opinion" survives a round trip through the store. `game` is
    // likewise optional and never defaulted.
    if (key === 'guildShrines' || key === 'game') {
      if (has(raw, key) && isObject(raw[key])) out[key] = raw[key];
      continue;
    }
    if (key === 'loadouts') continue;
    out[key] = has(raw, key) && raw[key] != null ? raw[key] : base[key];
  }
  out.id = out.id || makeCharacterId(out.name);
  const loadouts = {};
  for (const [name, loadout] of Object.entries(isObject(raw.loadouts) ? raw.loadouts : {})) {
    loadouts[name] = sanitizeLoadout(loadout);
  }
  out.loadouts = Object.keys(loadouts).length ? loadouts : { default: createLoadout() };
  return out;
}

/**
 * The flat view PlayerConfig's applyAbilities / handleAbilityChange expect:
 * { [abilityHrid]: { level, triggers } }. The LEVEL half comes from the
 * character (it is the same whichever loadout you are wearing); the TRIGGERS
 * half comes from this loadout. Slotted abilities' own triggers win, since the
 * slot is what the user is looking at. An ability never set up in this loadout
 * has no triggers here (undefined, not []): [] means "cast whenever ready".
 */
function buildAbilityMemory(character, loadout) {
  const levels = isObject(character.abilityLevels) ? character.abilityLevels : {};
  const triggers = isObject(loadout.triggerMemory) ? loadout.triggerMemory : {};
  const memory = {};
  for (const [hrid, level] of Object.entries(levels)) {
    memory[hrid] = { level: Number(level) || 1, triggers: triggers[hrid] };
  }
  for (const [hrid, trigs] of Object.entries(triggers)) {
    if (!memory[hrid]) memory[hrid] = { level: Number(levels[hrid]) || 1, triggers: trigs };
  }
  for (const slot of loadout.abilities || []) {
    if (!slot?.hrid) continue;
    memory[slot.hrid] = {
      level: Number(levels[slot.hrid]) || 1,
      triggers: slot.triggers || memory[slot.hrid]?.triggers || []
    };
  }
  return memory;
}

/**
 * THE SINGLE MERGE FUNCTION. A character plus one of its loadouts becomes the
 * flat player every DTO site, panel and optimiser payload already speaks.
 *
 * It deliberately does NOT stamp `hrid` — that stays synthetic and is applied
 * at DTO assembly, which `toPlayerDTO(player, { hrid })` already does at all six
 * call sites. It emits ONLY engine/UI-consumed keys and never `id`, `name` or
 * `loadouts`, because playerDTO.js spreads this object wholesale into every DTO
 * — including the optimiser POSTs that re-fire 350ms after each keystroke.
 */
export function resolvePlayer(character, loadout) {
  const c = isObject(character) ? character : createCharacter();
  const l = isObject(loadout) ? loadout : createLoadout();
  const player = {
    houseRooms: isObject(c.houseRooms) ? c.houseRooms : {},
    achievements: isObject(c.achievements) ? c.achievements : {},
    personalBuffs: Array.isArray(c.personalBuffs) ? c.personalBuffs : [],
    debuffOnLevelGap: c.debuffOnLevelGap || 0,
    equipment: isObject(l.equipment) ? l.equipment : {},
    food: Array.isArray(l.food) ? l.food : [null, null, null],
    drinks: Array.isArray(l.drinks) ? l.drinks : [null, null, null],
    // Ability LEVEL from the character, SLOT and TRIGGERS from the loadout.
    abilities: (Array.isArray(l.abilities) ? l.abilities : [null, null, null, null, null]).map(a =>
      a?.hrid
        ? {
            hrid: a.hrid,
            level: Number(c.abilityLevels?.[a.hrid]) || 1,
            triggers: a.triggers || []
          }
        : null
    ),
    abilityMemory: buildAbilityMemory(c, l)
  };
  for (const field of LEVEL_FIELDS) player[field] = Number(c[field]) || 1;
  // TRI-STATE. The key appears ONLY if the character has it, and is NEVER
  // defaulted to `{}`: a `{}` is not an absent key. `{}` means "captured, owns
  // none" to utils/guildBuffs.js `ownsShrines`, absent means "defer to the trial
  // header's party-wide knobs", and manufacturing one from the other is the bug
  // this whole distinction exists to prevent.
  if (has(c, 'guildShrines')) player.guildShrines = c.guildShrines;
  return player;
}

/**
 * `player` with `abilities` in its slots and the per-ability memory refreshed
 * for each filled one — level and triggers stick to the ABILITY, so A → B → A
 * restores A (PlayerConfig). splitPlayer turns the memory into abilityLevels
 * and triggerMemory, which keeps the store in sync.
 */
export function withAbilities(player, abilities) {
  const abilityMemory = { ...(player?.abilityMemory || {}) };
  for (const slot of abilities) {
    if (slot?.hrid) abilityMemory[slot.hrid] = { level: slot.level, triggers: slot.triggers || [] };
  }
  return { ...player, abilities, abilityMemory };
}

/**
 * The inverse of resolvePlayer: two PARTIALS to be merged onto the stored
 * halves. Ability levels route to the character, slot ordering and triggers to
 * the loadout, and the guildShrines tri-state is mirrored rather than defaulted.
 */
export function splitPlayer(flat) {
  const p = isObject(flat) ? flat : {};
  const memory = isObject(p.abilityMemory) ? p.abilityMemory : {};

  const abilityLevels = {};
  const triggerMemory = {};
  for (const [hrid, entry] of Object.entries(memory)) {
    abilityLevels[hrid] = Number(entry?.level) || 1;
    if (Array.isArray(entry?.triggers)) triggerMemory[hrid] = entry.triggers;
  }
  const abilities = (Array.isArray(p.abilities) ? p.abilities : []).map(a => {
    if (!a?.hrid) return null;
    abilityLevels[a.hrid] = Number(a.level) || abilityLevels[a.hrid] || 1;
    triggerMemory[a.hrid] = a.triggers || triggerMemory[a.hrid] || [];
    return { hrid: a.hrid, triggers: a.triggers || [] };
  });
  while (abilities.length < 5) abilities.push(null);

  const character = {
    houseRooms: isObject(p.houseRooms) ? p.houseRooms : {},
    achievements: isObject(p.achievements) ? p.achievements : {},
    personalBuffs: Array.isArray(p.personalBuffs) ? p.personalBuffs : [],
    debuffOnLevelGap: p.debuffOnLevelGap || 0,
    abilityLevels
  };
  for (const field of LEVEL_FIELDS) character[field] = Number(p[field]) || 1;
  // Mirror of resolvePlayer's guard — see the tri-state note there.
  if (has(p, 'guildShrines')) character.guildShrines = p.guildShrines;

  const loadout = {
    equipment: isObject(p.equipment) ? p.equipment : {},
    food: Array.isArray(p.food) ? p.food : [null, null, null],
    drinks: Array.isArray(p.drinks) ? p.drinks : [null, null, null],
    abilities,
    triggerMemory
  };
  return { character, loadout };
}

// -- store operations ---------------------------------------------------------
// All pure: they take a store and return a NEW store, so React state updates
// stay functional and nothing is mutated underfoot.

export function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, characters: {} };
}

/** Resolve a `{ characterId, loadoutName }` reference. A dangling ref is null. */
export function resolveRef(store, ref) {
  if (!ref?.characterId) return null;
  const character = store?.characters?.[ref.characterId];
  if (!character) return null;
  const loadout = character.loadouts?.[ref.loadoutName];
  if (!loadout) return null;
  return resolvePlayer(character, loadout);
}

/** Every (character, loadout) pair in the store, sorted for a stable picker. */
export function listLoadoutRefs(store) {
  const rows = [];
  for (const character of Object.values(store?.characters || {})) {
    for (const loadoutName of Object.keys(character.loadouts || {})) {
      rows.push({
        characterId: character.id,
        characterName: character.name || character.id,
        loadoutName,
        label: `${character.name || character.id} — ${loadoutName}`
      });
    }
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

export function upsertCharacter(store, character) {
  const clean = sanitizeCharacter(character);
  return {
    ...store,
    schemaVersion: SCHEMA_VERSION,
    characters: { ...(store?.characters || {}), [clean.id]: clean }
  };
}

/** Merge a character PARTIAL onto the stored character (levels, buffs, …). */
export function patchCharacter(store, characterId, partial) {
  const existing = store?.characters?.[characterId];
  if (!existing) return store;
  return upsertCharacter(store, { ...existing, ...partial, id: existing.id, name: existing.name });
}

/** The stored character an import lands on: same game characterId (an in-game
 *  rename re-imports onto its old record), else the name's slug — unless that
 *  slug is a different game character's, which then gets a record of its own. */
function importTargetId(store, incoming) {
  const characters = store?.characters || {};
  const gameId = incoming?.game?.id;
  const same = Object.values(characters).find(c => sameGameId(c?.game?.id, gameId));
  if (same) return same.id;
  const slug = incoming?.id || makeCharacterId(incoming?.name);
  return characters[slug]?.game?.id != null && gameId != null && !sameGameId(characters[slug].game.id, gameId)
    ? makeCharacterId(`${slug} ${gameId}`) : slug;
}

/**
 * Merge an IMPORTED character onto whatever is already stored.
 *
 * EXISTING means the stored character with the same game characterId, else the
 * one at the name's slug (see importTargetId).
 *
 *  - NEW character: stored as-is, plus the FIRST-IMPORT defaults for anything
 *    the import omitted. `{}` means "captured, owns none" and `[]` means "no
 *    seals" — the honest answers when nothing has ever been said, because an
 *    imported character DEFERRING to someone else's shrines would be a lie.
 *    (A payload with no `characterGuildBuffMap` — one captured before shrines
 *    existed — and every payload, for seals, carry no answer, so
 *    `characterToCharacter` omits the key rather than answering a question it
 *    cannot answer. Only the caller knows whether this is a first import.)
 *  - EXISTING character: every character field the import CARRIES is updated;
 *    every field it OMITS keeps the stored value — so shrines and seals the
 *    user has since entered survive a re-import, which is the whole point.
 *    Loadouts merge BY NAME: same-named incoming replaces, existing-without-
 *    incoming is PRESERVED, incoming-without-existing is ADDED. An in-game
 *    rename is followed unless the character was renamed here.
 *
 * It operates on the RAW `incoming`, before `sanitizeCharacter` — which fills
 * `base[key]` for any absent non-`guildShrines` key and would manufacture the
 * very `personalBuffs: []` we are avoiding. `upsertCharacter` sanitizes at the
 * end, as always.
 *
 * `{ id }` lands the import on exactly that record, skipping importTargetId, for a
 * caller that already bound a slot to a preview's id.
 *
 * @returns {{store, id: string, created: boolean, replaced: string[], added: string[], kept: string[]}}
 */
export function mergeImportedCharacter(store, incoming, { id: landing } = {}) {
  const id = landing || importTargetId(store, incoming);
  const existing = store?.characters?.[id];
  const incomingLoadouts = isObject(incoming?.loadouts) ? incoming.loadouts : {};

  if (!existing) {
    const character = { ...incoming, id };
    if (!has(incoming, 'guildShrines')) character.guildShrines = {};
    if (!has(incoming, 'personalBuffs')) character.personalBuffs = [];
    return {
      store: upsertCharacter(store, character),
      id,
      created: true,
      replaced: [],
      added: Object.keys(incomingLoadouts),
      kept: []
    };
  }

  // Only the keys the import actually carries. `loadouts` is deliberately NOT
  // in the partial: the spread below is shallow and would clobber them.
  const partial = {};
  for (const key of CHARACTER_KEYS) {
    if (key === 'id' || key === 'name' || key === 'loadouts') continue;
    if (has(incoming, key)) partial[key] = incoming[key];
  }
  // Follow an in-game rename only while the stored name is still the one the
  // last import gave it: a name chosen here stands, as it always has.
  const follows = incoming?.game?.name && existing.game?.name != null && existing.name === existing.game.name;
  let next = upsertCharacter(store, { ...existing, ...partial, id, name: follows ? incoming.game.name : existing.name });

  const replaced = [];
  const added = [];
  for (const [name, loadout] of Object.entries(incomingLoadouts)) {
    (has(existing.loadouts || {}, name) ? replaced : added).push(name);
    next = setLoadout(next, id, name, loadout);
  }
  const kept = Object.keys(existing.loadouts || {}).filter(n => !has(incomingLoadouts, n));
  return { store: next, id, created: false, replaced, added, kept };
}

export function setLoadout(store, characterId, loadoutName, loadout) {
  const existing = store?.characters?.[characterId];
  if (!existing || !loadoutName) return store;
  return upsertCharacter(store, {
    ...existing,
    loadouts: { ...(existing.loadouts || {}), [loadoutName]: sanitizeLoadout(loadout) }
  });
}

/** Ensure `base` is unique among a character's loadout names. */
export function uniqueLoadoutName(base, loadouts) {
  const taken = new Set(Object.keys(loadouts || {}));
  const name = String(base || 'loadout').trim() || 'loadout';
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

/** @returns {{store, name}} — `name` is the name actually used after deduping. */
export function renameLoadout(store, characterId, from, to) {
  const existing = store?.characters?.[characterId];
  if (!existing || !existing.loadouts?.[from] || !to || from === to) {
    return { store, name: from };
  }
  const name = uniqueLoadoutName(to, existing.loadouts);
  const loadouts = {};
  // Rebuild in order so renaming does not reshuffle the picker.
  for (const [key, value] of Object.entries(existing.loadouts)) {
    loadouts[key === from ? name : key] = value;
  }
  return { store: upsertCharacter(store, { ...existing, loadouts }), name };
}

export function deleteLoadout(store, characterId, loadoutName) {
  const existing = store?.characters?.[characterId];
  if (!existing?.loadouts?.[loadoutName]) return store;
  const loadouts = { ...existing.loadouts };
  delete loadouts[loadoutName];
  // A character with no loadouts cannot be worn; keep a blank one.
  if (!Object.keys(loadouts).length) loadouts.default = createLoadout();
  return upsertCharacter(store, { ...existing, loadouts });
}

export function deleteCharacter(store, characterId) {
  const characters = { ...(store?.characters || {}) };
  delete characters[characterId];
  return { ...store, schemaVersion: SCHEMA_VERSION, characters };
}

/** THE MAIN CHARACTER (header chip): `ref` = remembered { id, gameId }. Game id
 *  first (survives a re-import onto another record), then store id. No match:
 *  the ONLY character if exactly one, else null — never written back, so a stale
 *  choice returns with its character; never a guess, because main drives an
 *  automatic price fetch. */
export function mainCharacter(store, ref) {
  const characters = store?.characters || {};
  const all = Object.values(characters);
  return all.find(c => sameGameId(c?.game?.id, ref?.gameId))
    || (ref?.id && has(characters, ref.id) ? characters[ref.id] : null)
    || (all.length === 1 ? all[0] : null);
}

/** P1 for a session with nothing stored: main in its first loadout, else null. */
export function mainSlotRef(store, ref) {
  const main = mainCharacter(store, ref);
  const loadoutName = main && Object.keys(main.loadouts || {})[0];
  return loadoutName ? { characterId: main.id, loadoutName } : null;
}

// -- persistence --------------------------------------------------------------

/**
 * Read a versioned localStorage blob. A CLEAN BREAK, with no shim:
 *   - no blob            → the fallback, status 'empty'
 *   - schemaVersion match → the blob, status 'ok'
 *   - anything else      → the RAW STRING is copied verbatim to `${key}.v1`
 *                          and the fallback is returned, status 'incompatible'.
 * Nothing is mangled and nothing is silently reinterpreted; the old data sits
 * on disk, byte for byte, as its own backup.
 */
export function loadVersioned(key, expectedVersion, fallback) {
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { data: fallback, status: 'empty' };
  }
  if (raw == null || raw === '') return { data: fallback, status: 'empty' };
  let blob = null;
  try {
    blob = JSON.parse(raw);
  } catch {
    blob = null;
  }
  if (isObject(blob) && blob.schemaVersion === expectedVersion) return { data: blob, status: 'ok' };
  try {
    localStorage.setItem(`${key}.v1`, raw);
  } catch {
    // Quota or private browsing. The original key is still untouched.
  }
  return { data: fallback, status: 'incompatible' };
}

/**
 * The stored characters, plus how the read went: an 'incompatible' (corrupt or
 * future-version) store has been copied to `csim_characters.v1` and the caller
 * gets an empty one, which it must not save over the original unasked.
 *
 * @returns {{schemaVersion: number, characters: object, status: 'empty'|'ok'|'incompatible'}}
 */
export function loadCharacters() {
  const { data, status } = loadVersioned(CHARACTERS_KEY, SCHEMA_VERSION, emptyStore());
  let characters = isObject(data?.characters) ? data.characters : {};
  // An empty store is marked too: what is saved from now on is written under the new rule.
  if (status !== 'incompatible') characters = cleanLegacyTriggersOnce({ characters }, status === 'ok').characters;
  return { schemaVersion: SCHEMA_VERSION, characters, status };
}

/** Sibling marker (not a field in the store, which saveCharacters rewrites): the legacy trigger cleanup has run. */
export const TRIGGER_MEMORY_MARKER_KEY = 'csim_characters.triggerMemoryCleaned';

/**
 * Before [] meant "cast whenever ready", every sheet edit wrote [] into
 * triggerMemory for every trained ability never set up in that loadout. Those
 * cannot be told from a deliberate [], so the old reading (the game's defaults)
 * is kept: [] is dropped for abilities NOT slotted in that loadout. Slotted
 * ones are untouched. Pure; returns a new store.
 */
export function dropLegacyEmptyTriggers(store) {
  const characters = {};
  for (const [id, c] of Object.entries(isObject(store?.characters) ? store.characters : {})) {
    if (!isObject(c?.loadouts)) { characters[id] = c; continue; }
    const loadouts = {};
    for (const [name, l] of Object.entries(c.loadouts)) {
      if (!isObject(l?.triggerMemory)) { loadouts[name] = l; continue; }
      const slotted = new Set((Array.isArray(l.abilities) ? l.abilities : []).map(a => a?.hrid).filter(Boolean));
      const triggerMemory = Object.fromEntries(Object.entries(l.triggerMemory)
        .filter(([hrid, t]) => slotted.has(hrid) || !(Array.isArray(t) && t.length === 0)));
      loadouts[name] = { ...l, triggerMemory };
    }
    characters[id] = { ...c, loadouts };
  }
  return { ...store, characters };
}

/** dropLegacyEmptyTriggers at most once ever, saved (when there was a stored blob) before the marker is written. */
function cleanLegacyTriggersOnce(store, stored) {
  try {
    if (localStorage.getItem(TRIGGER_MEMORY_MARKER_KEY)) return store;
  } catch {
    return store; // No storage: nothing was saved under the old rule either.
  }
  const cleaned = stored ? dropLegacyEmptyTriggers(store) : store;
  if (stored) saveCharacters(cleaned);
  try {
    localStorage.setItem(TRIGGER_MEMORY_MARKER_KEY, new Date().toISOString());
  } catch {
    // Quota or private browsing: it will simply run again.
  }
  return cleaned;
}

export function saveCharacters(store) {
  try {
    localStorage.setItem(
      CHARACTERS_KEY,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, characters: store?.characters || {} })
    );
  } catch {
    // Quota or private browsing — the app still works, it just will not persist.
  }
}
