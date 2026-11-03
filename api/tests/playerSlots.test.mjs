// audit3-6 — a player uses only the slots the game gives it: 1 + pouch food
// and drink slots, and ability slots unlocked by BASE intelligence
// (abilitySlotsLevelRequirementList: slot 1..5 at 1/1/20/50/90; index i is
// slot i + 1). The engine used every entry it was handed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const Player = (await import(join(ROOT, 'src', 'combatsimulator', 'player.js'))).default;
const { itemDetailMap: items, abilityDetailMap: abilityData } = (await loadEngine(ROOT)).gameData;

function dto({ intelligence, pouch }) {
  const d = structuredClone(toCsimPlayer(BUILDS.melee, { level: 100, index: 1, items, abilityData }));
  d.intelligenceLevel = intelligence;
  d.equipment['/equipment_types/pouch'] = pouch ? { hrid: pouch, enhancementLevel: 0 } : null;
  const ability = d.abilities.find(Boolean);
  const food = d.food.find(Boolean) ?? { hrid: '/items/cupcake', triggers: [] };
  const drink = d.drinks.find(Boolean) ?? { hrid: '/items/stamina_coffee', triggers: [] };
  d.abilities = Array.from({ length: 5 }, () => structuredClone(ability));
  d.food = Array.from({ length: 3 }, () => structuredClone(food));
  d.drinks = Array.from({ length: 3 }, () => structuredClone(drink));
  return d;
}
const filled = (xs) => xs.map((x) => (x ? 1 : 0)).join('');

test('audit3-6: food and drink slots are 1 + pouch', () => {
  const bare = Player.createFromDTO(dto({ intelligence: 100, pouch: null }));
  assert.equal(filled(bare.food), '100');
  assert.equal(filled(bare.drinks), '100');
  const small = Player.createFromDTO(dto({ intelligence: 100, pouch: '/items/small_pouch' }));
  assert.equal(filled(small.food), '110'); // small pouch: +1 food, no drink slot
  assert.equal(filled(small.drinks), '100');
  const giant = Player.createFromDTO(dto({ intelligence: 100, pouch: '/items/giant_pouch' }));
  assert.equal(filled(giant.food), '111');
  assert.equal(filled(giant.drinks), '111');
});

test('audit3-6: ability slots unlock at intelligence 1/1/20/50/90', () => {
  assert.equal(filled(Player.createFromDTO(dto({ intelligence: 19 })).abilities), '11000');
  assert.equal(filled(Player.createFromDTO(dto({ intelligence: 50 })).abilities), '11110');
  assert.equal(filled(Player.createFromDTO(dto({ intelligence: 90 })).abilities), '11111');
});

test('audit3-6: with no unlock table (MWIX vendor stubs it) no ability slot is locked', async () => {
  const dataProvider = await import(join(ROOT, 'src', 'combatsimulator', 'dataProvider.js'));
  dataProvider.setOverrides({ abilitySlotsLevelRequirementList: [] });
  // setOverrides falls back to bundled for a falsy source only; force empty.
  dataProvider.abilitySlotsLevelRequirementList.length = 0;
  try {
    assert.equal(filled(Player.createFromDTO(dto({ intelligence: 1 })).abilities), '11111');
  } finally {
    dataProvider.resetOverrides();
  }
  assert.equal(filled(Player.createFromDTO(dto({ intelligence: 1 })).abilities), '11000');
});
