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

const { characterToCharacter } = await import('../../ui/src/utils/characterToStore.js');
const { LOADOUT_KEYS, resolvePlayer } = await import('../../ui/src/utils/characterStore.js');
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

test('an imported character owns no shrines, rather than having no opinion', () => {
  assert.deepEqual(result.character.guildShrines, {});
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
