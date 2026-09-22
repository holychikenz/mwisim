// =============================================================================
// characterStore — the two-level character → loadouts model.
//
// These exercise ui/src/utils/characterStore.js, which is framework-free on
// purpose (no React, no Mantine, localStorage touched only inside function
// bodies) precisely so that this existing node:test harness can import it. The
// UI has no test runner of its own and is not getting one for this.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

// An in-memory localStorage, for the two persistence tests only. Installed
// before the module is imported, since the module reads the global lazily.
const __store = new Map();
globalThis.localStorage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear()
};

const {
  LOADOUT_KEYS,
  createLoadout,
  sanitizeLoadout,
  sanitizeCharacter,
  resolvePlayer,
  splitPlayer,
  upsertCharacter,
  setLoadout,
  loadCharacters,
  saveCharacters,
  loadVersioned,
  emptyStore,
  resolveRef,
  createCharacter
} = await import('../../ui/src/utils/characterStore.js');
const {
  deleteLoadoutEverywhere,
  deleteCharacterEverywhere,
  renameLoadoutEverywhere
} = await import('../../ui/src/utils/refRepair.js');
const { ownsShrines } = await import('../../ui/src/utils/guildBuffs.js');
const { toPlayerDTO } = await import('../../ui/src/utils/playerDTO.js');

const TRIGGER = { dependencyHrid: '/combat_trigger_dependencies/self' };
const SWORD = { itemHrid: '/items/cheese_sword', enhancementLevel: 4 };

function character(extra = {}) {
  return {
    id: 'c',
    name: 'c',
    staminaLevel: 1,
    intelligenceLevel: 1,
    attackLevel: 90,
    meleeLevel: 1,
    defenseLevel: 1,
    rangedLevel: 1,
    magicLevel: 1,
    houseRooms: { H: 8 },
    achievements: { A: true },
    personalBuffs: ['/items/tarnished_seal'],
    debuffOnLevelGap: 0,
    abilityLevels: { '/abilities/smack': 12 },
    guildShrines: {},
    ...extra
  };
}

function loadout(extra = {}) {
  return {
    equipment: { '/equipment_types/main_hand': SWORD },
    food: [{ itemHrid: '/items/donut', triggers: [] }, null, null],
    drinks: [null, null, null],
    abilities: [{ hrid: '/abilities/smack', triggers: [TRIGGER] }, null, null, null, null],
    triggerMemory: { '/abilities/smack': [TRIGGER] },
    ...extra
  };
}

function storeWith(c, loadouts) {
  return { schemaVersion: 2, characters: { c: { ...c, loadouts } } };
}

test('a loadout physically carries only loadout keys', () => {
  const out = sanitizeLoadout({
    equipment: {},
    food: [],
    drinks: [],
    abilities: [],
    triggerMemory: {},
    attackLevel: 99,
    houseRooms: { a: 1 },
    guildShrines: {},
    name: 'x'
  });
  assert.deepEqual(Object.keys(out).sort(), [...LOADOUT_KEYS].sort());
  assert.ok(!('attackLevel' in out));
  assert.ok(!('guildShrines' in out));
});

test('sanitizeCharacter sanitizes nested loadouts', () => {
  const clean = sanitizeCharacter({
    ...character(),
    loadouts: { tank: { ...loadout(), attackLevel: 5, houseRooms: { X: 1 } } }
  });
  assert.ok(!('attackLevel' in clean.loadouts.tank));
  assert.ok(!('houseRooms' in clean.loadouts.tank));
  assert.equal(clean.attackLevel, 90);
  assert.deepEqual(clean.houseRooms, { H: 8 });
});

test('resolvePlayer merges character and loadout into a flat player', () => {
  const flat = resolvePlayer(character(), loadout());
  assert.equal(flat.attackLevel, 90);
  assert.equal(flat.houseRooms.H, 8);
  assert.equal(flat.equipment['/equipment_types/main_hand'].itemHrid, '/items/cheese_sword');
  assert.equal(flat.abilities[0].level, 12);
  assert.deepEqual(flat.abilities[0].triggers, [TRIGGER]);
  // `hrid` stays synthetic and is stamped at DTO assembly, not here.
  assert.ok(!('hrid' in flat));
});

test('one character, two loadouts, one set of levels — no copy step', () => {
  let store = storeWith(character(), {
    tank: loadout(),
    mage: loadout({ equipment: {}, abilities: [null, null, null, null, null] })
  });
  const read = (name) =>
    resolvePlayer(store.characters.c, store.characters.c.loadouts[name]);
  assert.equal(read('tank').attackLevel, 90);
  assert.equal(read('mage').attackLevel, 90);

  // A SINGLE WRITE, touching no loadout at all.
  store = upsertCharacter(store, { ...store.characters.c, attackLevel: 99 });
  assert.equal(read('tank').attackLevel, 99);
  assert.equal(read('mage').attackLevel, 99);
  assert.ok(!('attackLevel' in store.characters.c.loadouts.tank));
});

test('a level cannot be written into a loadout', () => {
  let store = storeWith(character(), { tank: loadout() });
  store = setLoadout(store, 'c', 'tank', { ...loadout(), attackLevel: 5, guildShrines: { X: 9 } });
  const stored = store.characters.c.loadouts.tank;
  assert.ok(!('attackLevel' in stored));
  assert.ok(!('guildShrines' in stored));
  assert.equal(resolvePlayer(store.characters.c, stored).attackLevel, 90);
});

test('the character→loadouts structure round-trips through persistence', () => {
  localStorage.clear();
  const store = storeWith(character(), { tank: loadout(), mage: createLoadout() });
  saveCharacters(store);
  const reloaded = loadCharacters();
  assert.deepEqual(reloaded, store);
  assert.equal(reloaded.schemaVersion, 2);
  assert.deepEqual(Object.keys(reloaded.characters.c.loadouts), ['tank', 'mage']);
});

test('splitPlayer is the inverse of resolvePlayer', () => {
  const c = character();
  const l = loadout();
  const { character: back, loadout: backLoadout } = splitPlayer(resolvePlayer(c, l));
  assert.deepEqual(backLoadout, l);
  const { id, name, ...own } = c;
  assert.deepEqual(back, own);
});

test('the guildShrines tri-state survives the merge', () => {
  const absent = character();
  delete absent.guildShrines;
  const flatAbsent = resolvePlayer(absent, loadout());
  assert.equal('guildShrines' in flatAbsent, false);
  assert.equal(ownsShrines(flatAbsent), false);

  const flatEmpty = resolvePlayer(character({ guildShrines: {} }), loadout());
  assert.deepEqual(flatEmpty.guildShrines, {});
  assert.equal(ownsShrines(flatEmpty), true);

  const levels = { '/buff_types/guild_force': 5 };
  const flatOwned = resolvePlayer(character({ guildShrines: levels }), loadout());
  assert.deepEqual(flatOwned.guildShrines, levels);
  assert.equal(ownsShrines(flatOwned), true);
});

test('ability levels are character-owned, triggers are loadout-owned', () => {
  const otherTrigger = { dependencyHrid: '/combat_trigger_dependencies/target' };
  let store = storeWith(character(), {
    tank: loadout(),
    mage: loadout({
      abilities: [{ hrid: '/abilities/smack', triggers: [otherTrigger] }, null, null, null, null],
      triggerMemory: { '/abilities/smack': [otherTrigger] }
    })
  });
  const read = (n) => resolvePlayer(store.characters.c, store.characters.c.loadouts[n]);
  assert.equal(read('tank').abilities[0].level, 12);
  assert.equal(read('mage').abilities[0].level, 12);
  assert.deepEqual(read('tank').abilities[0].triggers, [TRIGGER]);
  assert.deepEqual(read('mage').abilities[0].triggers, [otherTrigger]);

  // One write to the CHARACTER moves both.
  store = upsertCharacter(store, {
    ...store.characters.c,
    abilityLevels: { '/abilities/smack': 20 }
  });
  assert.equal(read('tank').abilities[0].level, 20);
  assert.equal(read('mage').abilities[0].level, 20);

  // One write to a LOADOUT moves only that loadout.
  const third = { dependencyHrid: '/combat_trigger_dependencies/party' };
  store = setLoadout(store, 'c', 'tank', {
    ...store.characters.c.loadouts.tank,
    abilities: [{ hrid: '/abilities/smack', triggers: [third] }, null, null, null, null]
  });
  assert.deepEqual(read('tank').abilities[0].triggers, [third]);
  assert.deepEqual(read('mage').abilities[0].triggers, [otherTrigger]);
});

test('a resolved player produces a clean DTO', () => {
  const dto = toPlayerDTO(resolvePlayer(character(), loadout()), { hrid: 'player3' });
  assert.equal(dto.hrid, 'player3');
  assert.ok(!('abilityMemory' in dto));
  assert.ok(!('loadouts' in dto));
  assert.ok(!('name' in dto));
  assert.ok(!('id' in dto));
  assert.equal(dto.abilities[0].level, 12);
  assert.equal(dto.equipment['/equipment_types/main_hand'].hrid, '/items/cheese_sword');
});

test('the version gate backs up rather than mangles', () => {
  localStorage.clear();
  const FALLBACK = { schemaVersion: 2, party: {}, selectedPlayers: [1] };
  const legacy = JSON.stringify({ players: { 1: { attackLevel: 7 } }, selectedPlayers: [1] });
  localStorage.setItem('csim_player_data', legacy);

  const first = loadVersioned('csim_player_data', 2, FALLBACK);
  assert.deepEqual(first.data, FALLBACK);
  assert.equal(first.status, 'incompatible');
  assert.equal(localStorage.getItem('csim_player_data.v1'), legacy);

  // Now a v2 blob: read straight through, backup untouched.
  const fresh = JSON.stringify({ schemaVersion: 2, party: { 1: null } });
  localStorage.setItem('csim_player_data', fresh);
  const second = loadVersioned('csim_player_data', 2, FALLBACK);
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.data, JSON.parse(fresh));
  assert.equal(localStorage.getItem('csim_player_data.v1'), legacy);
  assert.deepEqual(emptyStore(), { schemaVersion: 2, characters: {} });
});

// =============================================================================
// REFERENCE REPAIR (utils/refRepair.js) — the two holders, mended together.
//
// A `{characterId, loadoutName}` reference is held in exactly two places: the
// five party slots and the guild-trial roster (with `selectedEntryId` riding
// along). Before refRepair.js each mutation site mended one of them and forgot
// the other, in opposite directions. These pin the one rule.
// =============================================================================

/** Every live reference in a world, both holders at once. */
const allRefs = (world) =>
  Object.values(world.party || {}).filter(Boolean).concat(world.roster || []);

function refWorld() {
  const store = storeWith(character(), { tank: loadout(), mage: loadout({ equipment: {} }) });
  return {
    characters: store,
    party: {
      1: { characterId: 'c', loadoutName: 'tank' },
      2: { characterId: 'c', loadoutName: 'tank' },
      3: { characterId: 'c', loadoutName: 'mage' },
      4: null,
      5: null
    },
    roster: [
      { id: 'r1', characterId: 'c', loadoutName: 'tank', count: 20 },
      { id: 'r2', characterId: 'c', loadoutName: 'mage', count: 1 }
    ],
    selectedEntryId: 'r1'
  };
}

test('after renameLoadout no live reference anywhere still names the old key', () => {
  const world = refWorld();
  const next = renameLoadoutEverywhere(world, 'c', 'tank', 'bruiser');

  assert.equal(next.name, 'bruiser');
  const loadouts = next.characters.characters.c.loadouts;
  assert.ok(!('tank' in loadouts));
  assert.ok('bruiser' in loadouts);
  // Renaming must not reshuffle the picker.
  assert.deepEqual(Object.keys(loadouts), ['bruiser', 'mage']);

  // THE PARTY — the holder the app's only rename entry point never touched.
  assert.equal(next.party[1].loadoutName, 'bruiser');
  assert.equal(next.party[2].loadoutName, 'bruiser');
  assert.equal(next.party[3].loadoutName, 'mage');
  assert.equal(next.party[4], null);

  assert.equal(next.roster.find(r => r.id === 'r1').loadoutName, 'bruiser');
  assert.deepEqual(next.roster.find(r => r.id === 'r2'), world.roster[1]);
  assert.equal(next.selectedEntryId, 'r1');

  assert.ok(allRefs(next).every(r => r.loadoutName !== 'tank'));
  assert.ok(allRefs(next).every(r => resolveRef(next.characters, r) !== null));
});

test('after deleteLoadout every reference to it is dropped from BOTH holders', () => {
  const world = refWorld();
  const next = deleteLoadoutEverywhere(world, 'c', 'tank');

  assert.deepEqual(Object.keys(next.characters.characters.c.loadouts), ['mage']);
  // DROPPED, never repointed: a slot that wore it goes empty rather than being
  // silently re-geared into a loadout the user never chose for it.
  assert.equal(next.party[1], null);
  assert.equal(next.party[2], null);
  assert.deepEqual(next.party[3], { characterId: 'c', loadoutName: 'mage' });
  assert.deepEqual(next.roster.map(r => r.id), ['r2']);
  assert.equal(next.selectedEntryId, 'r2');
  assert.ok(allRefs(next).every(r => resolveRef(next.characters, r) !== null));
});

test('deleting the last loadout leaves a wearable character and no dangling refs', () => {
  const store = storeWith({ ...character(), id: 'd', name: 'd' }, { solo: loadout() });
  const world = {
    characters: { schemaVersion: 2, characters: { d: store.characters.c } },
    party: { 1: { characterId: 'd', loadoutName: 'solo' }, 2: null, 3: null, 4: null, 5: null },
    roster: [{ id: 'r', characterId: 'd', loadoutName: 'solo', count: 1 }],
    selectedEntryId: 'r'
  };
  const next = deleteLoadoutEverywhere(world, 'd', 'solo');

  // deleteLoadout recreates `default` so the character stays wearable — but
  // that is NOT a place to repoint the old references at. The user re-binds.
  assert.deepEqual(Object.keys(next.characters.characters.d.loadouts), ['default']);
  assert.equal(next.party[1], null);
  assert.deepEqual(next.roster, []);
  assert.equal(next.selectedEntryId, null);
});

test('after deleteCharacter no reference to it survives', () => {
  const c = { ...character(), loadouts: { tank: loadout() } };
  const d = { ...character(), id: 'd', name: 'd', loadouts: { default: loadout() } };
  const world = {
    characters: { schemaVersion: 2, characters: { c, d } },
    party: {
      1: { characterId: 'c', loadoutName: 'tank' },
      2: { characterId: 'd', loadoutName: 'default' },
      3: null,
      4: null,
      5: null
    },
    roster: [
      { id: 'r1', characterId: 'c', loadoutName: 'tank', count: 20 },
      { id: 'r2', characterId: 'd', loadoutName: 'default', count: 1 }
    ],
    selectedEntryId: 'r1'
  };
  const next = deleteCharacterEverywhere(world, 'c');

  assert.ok(!('c' in next.characters.characters));
  assert.ok('d' in next.characters.characters);
  assert.equal(next.party[1], null);
  assert.deepEqual(next.party[2], { characterId: 'd', loadoutName: 'default' });
  assert.deepEqual(next.roster.map(r => r.id), ['r2']);
  assert.equal(next.selectedEntryId, 'r2');
  assert.ok(allRefs(next).every(r => resolveRef(next.characters, r) !== null));
});

test('renaming a character needs no repair — references key off id, not name', () => {
  const world = refWorld();
  // The exact App.jsx handleRenameCharacter idiom.
  const next = upsertCharacter(world.characters, {
    ...world.characters.characters.c,
    name: 'Renamed'
  });

  assert.equal(next.characters.c.id, 'c');
  assert.equal(next.characters.c.name, 'Renamed');
  assert.ok(!('renamed' in next.characters));
  assert.deepEqual(Object.keys(next.characters), ['c']);
  // Every reference still resolves, so there is nothing for a
  // `renameCharacterEverywhere` to do — and none is written.
  assert.ok(allRefs(world).every(r => resolveRef(next, r) !== null));
  assert.equal(resolveRef(next, world.party[1]).attackLevel, 90);
  assert.ok(createCharacter({ ownsShrines: false }).guildShrines === undefined);
});

test('both former half-repairs, one rule', () => {
  const base = {
    characters: {
      schemaVersion: 2,
      characters: { e: { ...character(), id: 'e', name: 'e', loadouts: { a: loadout(), b: loadout() } } }
    },
    party: { 1: { characterId: 'e', loadoutName: 'a' }, 2: null, 3: null, 4: null, 5: null },
    roster: [{ id: 'x', characterId: 'e', loadoutName: 'b', count: 1 }],
    selectedEntryId: 'x'
  };

  // (a) referenced ONLY by a party slot — the holder App's handler forgot.
  const a = deleteLoadoutEverywhere(base, 'e', 'a');
  assert.equal(a.party[1], null);
  assert.deepEqual(a.roster, base.roster);

  // (b) referenced ONLY by a roster row — the holder LoadoutManager forgot.
  const b = deleteLoadoutEverywhere(base, 'e', 'b');
  assert.deepEqual(b.roster, []);
  assert.deepEqual(b.party[1], { characterId: 'e', loadoutName: 'a' });
  assert.equal(b.selectedEntryId, null);
});

// REGRESSION (P1-A). `deleteLoadout` keeps a character wearable by re-creating
// a blank `default` when its last loadout goes. A sweep that drops references
// by RESOLVABILITY therefore drops nothing here — the name springs back before
// the sweep runs — and every reference stays bound to empty gear. That is the
// ordinary state of a freshly imported character, and it simulates silently
// wrong rather than failing: no crash, no empty slot, just naked numbers.
test('deleting a sole `default` loadout drops its references despite the blank re-creation', () => {
  const store = upsertCharacter(
    { schemaVersion: 2, characters: {} },
    { ...createCharacter({ name: 'hero', id: 'hero' }), attackLevel: 90 }
  );
  assert.deepEqual(Object.keys(store.characters.hero.loadouts), ['default']);

  const world = {
    characters: store,
    party: {
      1: { characterId: 'hero', loadoutName: 'default' },
      2: { characterId: 'hero', loadoutName: 'default' },
      3: null, 4: null, 5: null
    },
    roster: [{ id: 'r1', characterId: 'hero', loadoutName: 'default', count: 20 }],
    selectedEntryId: 'r1'
  };

  const next = deleteLoadoutEverywhere(world, 'hero', 'default');

  // The blank re-creation still happens — the character stays wearable, and
  // this test pins that interaction rather than wishing it away.
  assert.deepEqual(Object.keys(next.characters.characters.hero.loadouts), ['default']);
  assert.ok(next.characters.characters.hero.loadouts.default);

  // But NOTHING may still be bound to it, in EITHER holder.
  assert.equal(next.party[1], null);
  assert.equal(next.party[2], null);
  assert.deepEqual(next.roster, []);
  assert.equal(next.selectedEntryId, null);
  assert.equal(allRefs(next).length, 0);

  // The character itself survives, levels intact — a delete of one loadout is
  // not a delete of the character.
  assert.equal(next.characters.characters.hero.attackLevel, 90);
});
