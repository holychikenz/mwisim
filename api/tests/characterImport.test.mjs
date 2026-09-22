// =============================================================================
// characterToStore — importing a raw MWI character payload brings in EVERY
// combat loadout the character owns, with the character-owned half (levels,
// houses, achievements, ability training levels, shrines) kept strictly out of
// the loadouts.
//
// The payload is synthetic and inline: no fixture file and no network. gameData
// is passed as null, which the knownItem / knownAbility / knownHouse /
// combatConsumable helpers already treat as "allow everything".
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

// An in-memory localStorage for the orphan-migration tests below. Installed
// before the modules are imported, since they read the global lazily.
const __store = new Map();
globalThis.localStorage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear()
};

const { characterToCharacter } = await import('../../ui/src/utils/characterToStore.js');
const {
  LOADOUT_KEYS,
  resolvePlayer,
  emptyStore,
  upsertCharacter,
  setLoadout,
  sanitizeLoadout,
  deleteCharacter,
  mergeImportedCharacter
} = await import('../../ui/src/utils/characterStore.js');
const {
  migrateLegacyLoadouts,
  fingerprintCharacter,
  LEGACY_LOADOUTS_KEY,
  ORPHAN_MARKER_KEY
} = await import('../../ui/src/utils/orphanMigration.js');
const { ownsShrines } = await import('../../ui/src/utils/guildBuffs.js');
const { toPlayerDTO } = await import('../../ui/src/utils/playerDTO.js');

const SMACK_TRIGGERS = [{ dependencyHrid: '/combat_trigger_dependencies/self' }];

const char = {
  name: 'holychikenz',
  characterSkills: [
    { skillHrid: '/skills/attack', level: 90 },
    { skillHrid: '/skills/magic', level: 70 },
    { skillHrid: '/skills/stamina', level: 80 },
    { skillHrid: '/skills/intelligence', level: 75 },
    { skillHrid: '/skills/melee', level: 88 },
    { skillHrid: '/skills/defense', level: 85 },
    { skillHrid: '/skills/ranged', level: 60 }
  ],
  characterAbilities: [
    { abilityHrid: '/abilities/smack', level: 12 },
    { abilityHrid: '/abilities/cleave', level: 8 },
    { abilityHrid: '/abilities/fireball', level: 5 }
  ],
  characterHouseRoomMap: { '/house_rooms/dairy_barn': { level: 8 } },
  characterAchievements: [
    { achievementHrid: '/achievements/first_blood', isCompleted: true },
    { achievementHrid: '/achievements/never_done', isCompleted: false }
  ],
  characterSetting: { debuffOnLevelGap: true },
  // The queued action names the MAGE loadout — the strong signal for which
  // loadout the slot lands on.
  characterActions: [{ ordinal: 0, characterLoadoutID: 'l3' }],
  characterLoadoutMap: {
    l1: {
      id: 'l1',
      name: 'tank',
      isDefault: true,
      actionTypeHrid: '/action_types/combat',
      wearableMap: { '/item_locations/main_hand': 'c::/item_locations/main_hand::/items/cheese_sword::4' },
      foodItemHrids: ['/items/donut'],
      drinkItemHrids: [],
      consumableCombatTriggersMap: {},
      abilityMap: { 1: '/abilities/smack' },
      abilityCombatTriggersMap: { '/abilities/smack': SMACK_TRIGGERS }
    },
    l2: {
      id: 'l2',
      // NAME COLLISION with l1 — deduped rather than silently overwriting it.
      name: 'tank',
      actionTypeHrid: '/action_types/combat',
      wearableMap: {},
      abilityMap: {}
    },
    l3: {
      id: 'l3',
      name: 'mage',
      actionTypeHrid: '/action_types/combat',
      wearableMap: { '/item_locations/two_hand': 'c::/item_locations/two_hand::/items/cheese_spear::0' },
      abilityMap: { 1: '/abilities/fireball' },
      abilityCombatTriggersMap: {}
    },
    l4: {
      id: 'l4',
      name: 'enhance',
      // NOT combat — dropped entirely.
      actionTypeHrid: '/action_types/enhancing',
      wearableMap: {},
      abilityMap: {}
    }
  }
};

const result = characterToCharacter(char, null, 'holychikenz');

test('every combat loadout is imported, the skilling one dropped, collisions deduped', () => {
  assert.deepEqual(Object.keys(result.character.loadouts), ['tank', 'tank (2)', 'mage']);
});

test('the queued action still picks which loadout you land on', () => {
  assert.equal(result.defaultLoadoutName, 'mage');
});

test('levels, houses, achievements and settings land on the CHARACTER', () => {
  assert.equal(result.character.attackLevel, 90);
  assert.equal(result.character.magicLevel, 70);
  assert.deepEqual(result.character.houseRooms, { '/house_rooms/dairy_barn': 8 });
  assert.deepEqual(result.character.achievements, { '/achievements/first_blood': true });
  assert.equal(result.character.debuffOnLevelGap, 1);
});

test('the WHOLE trained ability list is character-owned', () => {
  assert.deepEqual(result.character.abilityLevels, {
    '/abilities/smack': 12,
    '/abilities/cleave': 8,
    '/abilities/fireball': 5
  });
});

test('no loadout carries a character-owned key', () => {
  for (const lo of Object.values(result.character.loadouts)) {
    assert.ok(Object.keys(lo).every(k => LOADOUT_KEYS.includes(k)));
    assert.ok(!('attackLevel' in lo));
    assert.ok(!('houseRooms' in lo));
    assert.ok(!('abilityLevels' in lo));
    assert.ok(!('guildShrines' in lo));
  }
});

test('the loadouts genuinely differ, and no slot carries a level', () => {
  const tank = result.character.loadouts.tank;
  const mage = result.character.loadouts.mage;
  assert.equal(tank.equipment['/equipment_types/main_hand'].itemHrid, '/items/cheese_sword');
  assert.equal(mage.equipment['/equipment_types/two_hand'].itemHrid, '/items/cheese_spear');
  assert.equal(tank.abilities[0].hrid, '/abilities/smack');
  assert.equal(mage.abilities[0].hrid, '/abilities/fireball');
  assert.ok(!('level' in tank.abilities[0]));
  assert.ok(!('level' in mage.abilities[0]));
});

test('the producer does not answer the shrine question at all', () => {
  // It used to hard-code `guildShrines: {}` and `personalBuffs: []`, which
  // destroyed both on every RE-import. The game API carries neither, so both
  // keys are now OMITTED and the caller decides: see mergeImportedCharacter,
  // whose first-import branch supplies exactly the `{}` this used to assert —
  // pinned end to end in 'a first import lands shrines as {}' below.
  assert.ok(!('guildShrines' in result.character));
  assert.ok(!('personalBuffs' in result.character));
});

test('ability triggers seed both the slot and the loadout trigger memory', () => {
  const tank = result.character.loadouts.tank;
  assert.deepEqual(tank.abilities[0].triggers, SMACK_TRIGGERS);
  assert.deepEqual(tank.triggerMemory['/abilities/smack'], SMACK_TRIGGERS);
});

test('an imported character reaches the engine intact', () => {
  const dto = toPlayerDTO(
    resolvePlayer(result.character, result.character.loadouts.tank),
    { hrid: 'player1' }
  );
  assert.equal(dto.staminaLevel, 80);
  assert.equal(dto.intelligenceLevel, 75);
  assert.equal(dto.attackLevel, 90);
  assert.equal(dto.meleeLevel, 88);
  assert.equal(dto.defenseLevel, 85);
  assert.equal(dto.rangedLevel, 60);
  assert.equal(dto.magicLevel, 70);
  assert.equal(dto.equipment['/equipment_types/main_hand'].hrid, '/items/cheese_sword');
  assert.equal(dto.abilities[0].level, 12);
});

// =============================================================================
// MERGE-IMPORT — a re-import updates what it knows and destroys nothing else.
//
// `upsertCharacter` is a WHOLESALE REPLACE and the import id is deterministic
// (`makeCharacterId(name)`), so re-importing the same character used to wipe
// every shrine level, every seal and every hand-made loadout. These four pin
// the merge that replaced it.
// =============================================================================

const PVP = {
  equipment: { '/equipment_types/two_hand': { itemHrid: '/items/cheese_spear', enhancementLevel: 3 } },
  food: [null, null, null],
  drinks: [null, null, null],
  abilities: [null, null, null, null, null],
  triggerMemory: {}
};
const HAND = {
  equipment: { '/equipment_types/main_hand': { itemHrid: '/items/HAND_EDITED_sword', enhancementLevel: 9 } },
  food: [null, null, null],
  drinks: [null, null, null],
  abilities: [null, null, null, null, null],
  triggerMemory: {}
};

/** A character payload with one extra combat loadout the first import lacked. */
const charWithRanged = {
  ...char,
  characterLoadoutMap: {
    ...char.characterLoadoutMap,
    l5: {
      id: 'l5',
      name: 'ranged',
      actionTypeHrid: '/action_types/combat',
      wearableMap: { '/item_locations/two_hand': 'c::/item_locations/two_hand::/items/cheese_bow::1' },
      abilityMap: {}
    }
  }
};

let mergeStore = emptyStore();

test('a first import lands shrines as {} — owns none, not absent', () => {
  const incoming = characterToCharacter(char, null, 'holychikenz').character;
  const merged = mergeImportedCharacter(emptyStore(), incoming);
  const stored = merged.store.characters.holychikenz;

  assert.equal(merged.created, true);
  // The FIRST-IMPORT defaults, exactly as the producer used to hard-code them —
  // now supplied by the only caller that knows nothing has ever been said.
  assert.deepEqual(stored.guildShrines, {});
  assert.deepEqual(stored.personalBuffs, []);
  // The real consumer of the tri-state: "captured, owns none" must not fall
  // back to the trial header's party-wide knobs.
  assert.equal(ownsShrines(resolvePlayer(stored, stored.loadouts.tank)), true);
  assert.deepEqual(merged.added.slice().sort(), ['mage', 'tank', 'tank (2)']);
  assert.deepEqual(merged.kept, []);

  mergeStore = merged.store;
});

test('a re-import preserves the shrines and seals the import knows nothing about', () => {
  // The user does what the game cannot tell us: sets shrine levels and a seal.
  mergeStore = upsertCharacter(mergeStore, {
    ...mergeStore.characters.holychikenz,
    guildShrines: { '/buff_types/guild_force': 5 },
    personalBuffs: ['/items/seal_of_pain']
  });

  const incoming = characterToCharacter(char, null, 'holychikenz').character;
  assert.ok(!('guildShrines' in incoming));
  assert.ok(!('personalBuffs' in incoming));

  const merged = mergeImportedCharacter(mergeStore, incoming);
  const stored = merged.store.characters.holychikenz;
  assert.equal(merged.created, false);
  assert.deepEqual(stored.guildShrines, { '/buff_types/guild_force': 5 });
  assert.deepEqual(stored.personalBuffs, ['/items/seal_of_pain']);
  assert.equal(ownsShrines(resolvePlayer(stored, stored.loadouts.tank)), true);

  mergeStore = merged.store;
});

test('a re-import merges loadouts BY NAME', () => {
  // A hand-made loadout the game has never heard of, and a hand-edited weapon
  // in one it has.
  mergeStore = setLoadout(mergeStore, 'holychikenz', 'pvp', PVP);
  mergeStore = setLoadout(mergeStore, 'holychikenz', 'tank', HAND);

  const incoming = characterToCharacter(char, null, 'holychikenz').character;
  const merged = mergeImportedCharacter(mergeStore, incoming);
  const stored = merged.store.characters.holychikenz;

  assert.deepEqual(merged.replaced.slice().sort(), ['mage', 'tank', 'tank (2)']);
  assert.deepEqual(merged.added, []);
  assert.deepEqual(merged.kept, ['pvp']);
  // Existing WITHOUT incoming: preserved byte for byte.
  assert.deepEqual(stored.loadouts.pvp, sanitizeLoadout(PVP));
  // Same-named incoming REPLACES — "re-import my gear" means exactly that.
  assert.notDeepEqual(stored.loadouts.tank, sanitizeLoadout(HAND));
  assert.deepEqual(stored.loadouts.tank, sanitizeLoadout(incoming.loadouts.tank));
  assert.deepEqual(Object.keys(stored.loadouts).sort(), ['mage', 'pvp', 'tank', 'tank (2)']);

  // Incoming WITHOUT existing: added.
  const second = mergeImportedCharacter(
    merged.store,
    characterToCharacter(charWithRanged, null, 'holychikenz').character
  );
  assert.deepEqual(second.added, ['ranged']);
  assert.ok(second.kept.includes('pvp'));
  assert.ok('ranged' in second.store.characters.holychikenz.loadouts);

  mergeStore = second.store;
});

test('a re-import updates what it knows and does not rename the character', () => {
  mergeStore = upsertCharacter(mergeStore, {
    ...mergeStore.characters.holychikenz,
    attackLevel: 1,
    name: 'main'
  });

  const incoming = characterToCharacter(char, null, 'holychikenz').character;
  const stored = mergeImportedCharacter(mergeStore, incoming).store.characters.holychikenz;

  assert.equal(stored.attackLevel, 90);
  assert.deepEqual(stored.houseRooms, incoming.houseRooms);
  assert.deepEqual(stored.achievements, incoming.achievements);
  assert.deepEqual(stored.abilityLevels, incoming.abilityLevels);
  assert.equal(stored.debuffOnLevelGap, 1);
  // patchCharacter's forced name, kept DELIBERATELY: a re-import must not
  // silently rename the character the user renamed.
  assert.equal(stored.name, 'main');
  assert.equal(stored.id, 'holychikenz');
});

// =============================================================================
// ORPHAN MIGRATION — the pre-v2 `csim_loadouts` library, recovered once.
// =============================================================================

const TANK_PLAYER = {
  staminaLevel: 105, intelligenceLevel: 100, attackLevel: 110,
  meleeLevel: 108, defenseLevel: 102, rangedLevel: 60, magicLevel: 95,
  equipment: { '/equipment_types/main_hand': { itemHrid: '/items/cheese_sword', enhancementLevel: 4 } },
  food: [{ itemHrid: '/items/donut', triggers: [] }, null, null],
  drinks: [null, null, null],
  abilities: [
    { hrid: '/abilities/smack', level: 12, triggers: SMACK_TRIGGERS },
    null, null, null, null
  ],
  houseRooms: { '/house_rooms/dairy_barn': 8, '/house_rooms/gym': 3 },
  achievements: { '/achievements/first_blood': true },
  guildShrines: { '/buff_types/guild_force': 5 },
  personalBuffs: ['/items/seal_of_attack_speed', '/items/seal_of_pain'],
  abilityMemory: {
    '/abilities/smack': { level: 12, triggers: [] },
    '/abilities/cleave': { level: 8, triggers: [] }
  }
};

// Same character half as TANK_PLAYER, written with different JSON key order and
// different array order — the whole point of a canonical fingerprint.
const SWORD_PLAYER = {
  attackLevel: 110, meleeLevel: 108, defenseLevel: 102, rangedLevel: 60,
  magicLevel: 95, staminaLevel: 105, intelligenceLevel: 100,
  equipment: { '/equipment_types/two_hand': { itemHrid: '/items/cheese_spear', enhancementLevel: 2 } },
  food: [null, null, null],
  drinks: [{ itemHrid: '/items/power_coffee', triggers: [] }, null, null],
  abilities: [{ hrid: '/abilities/cleave', level: 8, triggers: [] }, null, null, null, null],
  achievements: { '/achievements/first_blood': true },
  houseRooms: { '/house_rooms/gym': 3, '/house_rooms/dairy_barn': 8 },
  guildShrines: { '/buff_types/guild_force': 5 },
  personalBuffs: ['/items/seal_of_pain', '/items/seal_of_attack_speed'],
  abilityMemory: {
    '/abilities/cleave': { level: 8, triggers: [] },
    '/abilities/smack': { level: 12, triggers: [] }
  }
};

// A genuinely DIFFERENT person: other magic level, houses, achievements,
// ability levels — and no `guildShrines` key at all.
const MAGE_PLAYER = {
  staminaLevel: 105, intelligenceLevel: 100, attackLevel: 110,
  meleeLevel: 108, defenseLevel: 102, rangedLevel: 60, magicLevel: 120,
  equipment: { '/equipment_types/two_hand': { itemHrid: '/items/cheese_spear', enhancementLevel: 0 } },
  food: [null, null, null],
  drinks: [null, null, null],
  abilities: [{ hrid: '/abilities/fireball', level: 5, triggers: [] }, null, null, null, null],
  houseRooms: {},
  achievements: {},
  personalBuffs: [],
  abilityMemory: { '/abilities/fireball': { level: 5, triggers: [] } }
};

const LEGACY_BLOB = {
  tank: { savedAt: '2025-01-04T10:12:00.000Z', player: TANK_PLAYER },
  sword: { savedAt: '2025-01-05T09:00:00.000Z', player: SWORD_PLAYER },
  mage: { savedAt: '2025-02-01T18:30:00.000Z', player: MAGE_PLAYER }
};

test('mixed-stat legacy loadouts become separate orphan characters', () => {
  localStorage.clear();
  localStorage.setItem(LEGACY_LOADOUTS_KEY, JSON.stringify(LEGACY_BLOB));

  const out = migrateLegacyLoadouts(emptyStore());
  assert.equal(out.recovered, 3);
  assert.equal(out.created, 2);
  assert.equal(out.skipped, 0);
  assert.deepEqual(Object.keys(out.store.characters).sort(), ['orphan_1', 'orphan_2']);
  assert.deepEqual(out.names, ['orphan_1', 'orphan_2']);

  const one = out.store.characters.orphan_1;
  const two = out.store.characters.orphan_2;
  assert.deepEqual(Object.keys(one.loadouts), ['mage']);
  assert.deepEqual(Object.keys(two.loadouts).sort(), ['sword', 'tank']);

  // DIFFERING STATS ARE NEVER MERGED — merging would fabricate stats the user
  // never entered.
  assert.equal(one.magicLevel, 120);
  assert.equal(two.magicLevel, 95);
  assert.equal(two.attackLevel, 110);
  // The redundant `abilities[i].level` copies folded into the character's one
  // list, where a level can live exactly once.
  assert.deepEqual(two.abilityLevels, { '/abilities/cleave': 8, '/abilities/smack': 12 });

  for (const character of [one, two]) {
    for (const lo of Object.values(character.loadouts)) {
      assert.ok(Object.keys(lo).every(k => LOADOUT_KEYS.includes(k)));
      assert.ok(!('attackLevel' in lo));
      assert.ok(!('guildShrines' in lo));
      assert.ok(lo.abilities.filter(Boolean).every(a => !('level' in a)));
    }
  }

  // THE TRI-STATE SURVIVED: absent never became `{}`.
  assert.deepEqual(two.guildShrines, { '/buff_types/guild_force': 5 });
  assert.ok(!('guildShrines' in one));
});

test("identical stats collapse to a single character named plain 'orphan'", () => {
  localStorage.clear();
  // Canonically identical character halves, textually different in every way a
  // JSON.stringify of an arbitrarily-ordered object would notice.
  const alpha = {
    staminaLevel: 10, intelligenceLevel: 10, attackLevel: 10, meleeLevel: 10,
    defenseLevel: 10, rangedLevel: 10, magicLevel: 10,
    houseRooms: { '/house_rooms/gym': 3, '/house_rooms/dairy_barn': 8 },
    achievements: { '/achievements/first_blood': true },
    personalBuffs: ['/items/seal_of_pain', '/items/seal_of_attack_speed'],
    equipment: { '/equipment_types/main_hand': { itemHrid: '/items/cheese_sword', enhancementLevel: 1 } },
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [{ hrid: '/abilities/smack', triggers: [] }, null, null, null, null],
    abilityMemory: {
      '/abilities/smack': { level: 3, triggers: [] },
      '/abilities/cleave': { level: 4, triggers: [] }
    }
  };
  const beta = {
    magicLevel: 10, rangedLevel: 10, defenseLevel: 10, meleeLevel: 10,
    attackLevel: 10, intelligenceLevel: 10, staminaLevel: 10,
    houseRooms: { '/house_rooms/dairy_barn': 8, '/house_rooms/gym': 3 },
    achievements: { '/achievements/first_blood': true },
    personalBuffs: ['/items/seal_of_attack_speed', '/items/seal_of_pain'],
    equipment: { '/equipment_types/two_hand': { itemHrid: '/items/cheese_spear', enhancementLevel: 0 } },
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [{ hrid: '/abilities/cleave', triggers: [] }, null, null, null, null],
    abilityMemory: {
      '/abilities/cleave': { level: 4, triggers: [] },
      '/abilities/smack': { level: 3, triggers: [] }
    }
  };
  localStorage.setItem(LEGACY_LOADOUTS_KEY, JSON.stringify({
    alpha: { player: alpha },
    beta: { player: beta }
  }));

  const out = migrateLegacyLoadouts(emptyStore());
  assert.equal(out.recovered, 2);
  assert.equal(out.created, 1);
  // With nothing to disambiguate, the numeric suffix is noise.
  assert.deepEqual(Object.keys(out.store.characters), ['orphan']);
  assert.equal(out.store.characters.orphan.name, 'orphan');
  assert.deepEqual(Object.keys(out.store.characters.orphan.loadouts).sort(), ['alpha', 'beta']);
});

test('absent guildShrines and {} never fingerprint the same', () => {
  const half = {
    staminaLevel: 1, intelligenceLevel: 1, attackLevel: 1, meleeLevel: 1,
    defenseLevel: 1, rangedLevel: 1, magicLevel: 1,
    houseRooms: {}, achievements: {}, debuffOnLevelGap: 0,
    personalBuffs: [], abilityLevels: {}
  };
  const withAbsent = { ...half };
  const withEmpty = { ...half, guildShrines: {} };

  assert.notEqual(fingerprintCharacter(withAbsent), fingerprintCharacter(withEmpty));
  // `#absent` is an unquoted bare token; `canon` can never emit a leading '#',
  // so the two cannot collide by construction rather than by luck.
  assert.ok(fingerprintCharacter(withAbsent).includes('"guildShrines":#absent'));
  assert.ok(fingerprintCharacter(withEmpty).includes('"guildShrines":{}'));

  localStorage.clear();
  const player = {
    staminaLevel: 5, intelligenceLevel: 5, attackLevel: 5, meleeLevel: 5,
    defenseLevel: 5, rangedLevel: 5, magicLevel: 5,
    houseRooms: {}, achievements: {}, personalBuffs: [],
    equipment: {}, food: [null, null, null], drinks: [null, null, null],
    abilities: [null, null, null, null, null], abilityMemory: {}
  };
  localStorage.setItem(LEGACY_LOADOUTS_KEY, JSON.stringify({
    quiet: { player },
    owns_none: { player: { ...player, guildShrines: {} } }
  }));

  const out = migrateLegacyLoadouts(emptyStore());
  assert.equal(out.created, 2);
  const [a, b] = Object.values(out.store.characters);
  assert.notEqual('guildShrines' in a, 'guildShrines' in b);
});

test('the migration runs once, changes nothing on a second pass, and never touches the backup', () => {
  localStorage.clear();
  const RAW = JSON.stringify(LEGACY_BLOB);
  localStorage.setItem(LEGACY_LOADOUTS_KEY, RAW);

  const first = migrateLegacyLoadouts(emptyStore());
  assert.equal(first.created, 2);
  const markerAfterFirst = localStorage.getItem(ORPHAN_MARKER_KEY);
  assert.ok(markerAfterFirst);

  const second = migrateLegacyLoadouts(first.store);
  assert.equal(second.recovered, 0);
  assert.equal(second.created, 0);
  assert.deepEqual(second.names, []);
  assert.deepEqual(second.store, first.store);
  assert.equal(localStorage.getItem(ORPHAN_MARKER_KEY), markerAfterFirst);

  // The legacy library is its own backup, byte for byte. Never written, never
  // cleared, never deleted.
  assert.equal(localStorage.getItem(LEGACY_LOADOUTS_KEY), RAW);

  // THE MARKER WINS: a character the user deleted stays deleted. This is what
  // makes "you can later remove these" true rather than merely intended.
  const pruned = deleteCharacter(first.store, 'orphan_1');
  const third = migrateLegacyLoadouts(pruned);
  assert.equal(third.created, 0);
  assert.ok(!('orphan_1' in third.store.characters));
});
