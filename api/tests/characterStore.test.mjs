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
  emptyStore
} = await import('../../ui/src/utils/characterStore.js');
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
