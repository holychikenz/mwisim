// =============================================================================
// Drop credit — the consumables a run drops offset its consumable bill in every
// effective rate: shared/consumableCost.js (the class, the per-player credit, the
// net clock and its floor), score.js (opt-in, byte-identical without it), the
// equipment route's gating, and the UI's pricing layer and bear preset.
//
// Run from api/:  npm test
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  MIN_CLOCK_DIVISOR,
  consumableClassHrids,
  dropCreditSeconds,
  effectiveNetRatePerHour,
  effectiveRatePerHour,
  partyConsumableSeconds,
  partyNetConsumableSeconds,
} from '../../shared/consumableCost.js';
import { rankResults, scoreSimResult } from '../lib/triggerSearch/score.js';
import { prepareEquipmentRun } from '../routes/optimizeEquipment.js';
import {
  BEAR_ZONE_ZEROED,
  buildDropCreditCosts,
  describeDropCredit,
  summariseConsumableCost,
} from '../../ui/src/utils/consumableCosts.js';

const { itemDetailMap, actionDetailMap } = await import('../../src/combatsimulator/dataProvider.js');
const CLASS = consumableClassHrids(itemDetailMap, actionDetailMap);

/** One player, one hour, `kills` gummy bears (sugar 1 × 20-100, five gummies 0.5 × 1), 120 donuts eaten. */
const bear = (encounters, kills) => ({
  simulatedTime: 3600e9, encounters, manaUsed: { player1: 0 }, deaths: { '/monsters/gummy_bear': kills },
  numberOfPlayers: 1, difficultyTier: 0, dropRateMultiplier: { player1: 1 }, rareFindMultiplier: { player1: 1 },
  combatDropQuantity: { player1: 0 }, debuffOnLevelGap: { player1: 0 }, consumablesUsed: { player1: { '/items/donut': 120 } },
});
const COSTS = { '/items/donut': 30 }; // 120 donuts an hour: a 3600 s bill

test('the consumable class is food, drink and every cooking or brewing input, derived from the game data', () => {
  assert.ok(CLASS.has('/items/sugar'), 'a cooking input with no consumableDetail');
  assert.ok(CLASS.has('/items/apple_gummy') && CLASS.has('/items/stamina_coffee') && CLASS.has('/items/green_tea_leaf'));
  assert.equal(CLASS.has('/items/cheese_sword'), false);
  assert.equal(CLASS.has('/items/coin'), false);
  for (const hrid of CLASS) assert.ok(itemDetailMap[hrid], hrid);
});

test('credit is each player\'s own expected drops: their drop rate and quantity, the quantity split across the party', () => {
  const monsters = { '/monsters/m': { dropTable: [
    { itemHrid: '/items/sugar', dropRate: 1, minCount: 10, maxCount: 30 },
    { itemHrid: '/items/apple_gummy', dropRate: 0.5, minCount: 1, maxCount: 1 },
  ] } };
  const run = { deaths: { '/monsters/m': 100, player1: 3 }, numberOfPlayers: 2, difficultyTier: 0,
    dropRateMultiplier: { player1: 1, player2: 1.5 }, rareFindMultiplier: {}, combatDropQuantity: { player1: 0, player2: 0.2 },
    debuffOnLevelGap: {} };
  const costs = { '/items/sugar': 2, '/items/apple_gummy': 60 };
  // player1: 100 × 20 / 2 sugar × 2 s + 100 × 0.5 / 2 gummies × 60 s. player2's 1.5 drop rate lifts only the gummy
  // (sugar is already certain), and their +20% quantity lifts both.
  assert.deepEqual(dropCreditSeconds(run, monsters, costs, ['player1', 'player2']), { player1: 3500, player2: 5100 });
  assert.deepEqual(dropCreditSeconds({ ...run, numberOfPlayers: 1 }, monsters, costs, ['player1']), { player1: 7000 });
  assert.deepEqual(dropCreditSeconds(run, monsters, { ...costs, '/items/sugar': -1 }, ['player1']), { player1: 1500 },
    'an unknown cost counts nothing');
});

test('own drops offset own eating on the per-player clock; a surplus lifts the rate above EPH, never past the floor', () => {
  // player1 ate 300 s and dropped 3500 s; player2 ate nothing and dropped 5100 s, below the floor.
  const party = partyNetConsumableSeconds({ player1: { '/items/donut': 10 } }, COSTS, { player1: 3500, player2: 5100 },
    { players: ['player1', 'player2'], hours: 1 }).seconds;
  assert.ok(Math.abs(party - 3600 * (1 / ((1 / (1 + (300 - 3500) / 3600) + 1 / MIN_CLOCK_DIVISOR) / 2) - 1)) < 1e-9);
  assert.ok(effectiveNetRatePerHour(100, party) > 100);
  assert.equal(effectiveNetRatePerHour(100, -1800), 200);
  assert.equal(effectiveNetRatePerHour(100, -1e9), 100 / MIN_CLOCK_DIVISOR);
  assert.equal(partyNetConsumableSeconds({}, {}, { p: 1e9 }, { players: ['p'], hours: 2 }).seconds, (MIN_CLOCK_DIVISOR - 1) * 3600 * 2);
});

test('with no credit the net clock is the old one, and the new divisor agrees with the old on any bill', () => {
  const used = { player1: { '/items/peach_gummy': 20 }, player2: { '/items/marsberry_donut': 40 } };
  const costs = { '/items/peach_gummy': 240, '/items/marsberry_donut': 30 };
  assert.ok(Math.abs(partyNetConsumableSeconds(used, costs, {}, { hours: 1 }).seconds
    - partyConsumableSeconds(used, costs, { hours: 1 }).seconds) < 1e-9);
  for (const seconds of [0, 1, 1600, 3600, 1e6, undefined]) {
    assert.equal(effectiveNetRatePerHour(123.4, seconds), effectiveRatePerHour(123.4, seconds), String(seconds));
  }
});

test('scoreSimResult: without the table the output is byte-identical; with it, the breakdown and the net rate', () => {
  const off = scoreSimResult(bear(110, 10), { consumableCosts: COSTS });
  assert.equal(JSON.stringify(scoreSimResult(bear(110, 10), { consumableCosts: COSTS, dropCreditCosts: null })), JSON.stringify(off));
  assert.equal(off.effectiveEncountersPerHour, effectiveRatePerHour(110, 3600));
  assert.equal('dropCreditSecondsPerHour' in off, false);
  assert.equal('netConsumableSecondsPerHour' in off, false);

  const on = scoreSimResult(bear(110, 10), { consumableCosts: COSTS, dropCreditCosts: { '/items/sugar': 1 } });
  assert.equal(on.consumableSecondsPerHour, 3600, 'the bill itself is unchanged');
  assert.equal(on.dropCreditSecondsPerHour, 600, '10 bears × 60 sugar × 1 s');
  assert.equal(on.netConsumableSecondsPerHour, 3000);
  assert.equal(on.effectiveEncountersPerHour, 110 / (1 + 3000 / 3600));
});

test('credit can flip a ranking: the build that kills more bears wins once their sugar counts', () => {
  const rank = (opts) => rankResults([
    { id: 'faster', metrics: scoreSimResult(bear(110, 10), opts) },
    { id: 'more bears', metrics: scoreSimResult(bear(100, 60), opts) },
  ], { objective: 'effectiveEncountersPerHour' }).map((entry) => entry.id);
  assert.deepEqual(rank({ consumableCosts: COSTS }), ['faster', 'more bears']); // 55 against 50
  assert.deepEqual(rank({ consumableCosts: COSTS, dropCreditCosts: { '/items/sugar': 1 } }), ['more bears', 'faster']); // 100 against 60
});

test('the credit table rides only beside a cost table, never alone and never into a labyrinth', () => {
  const player = { hrid: 'player1', equipment: {}, abilities: [], food: [], drinks: [] };
  const zone = { zoneHrid: '/actions/combat/gummy_bear', difficultyTier: 0 };
  const dropCreditCosts = { '/items/sugar': 2, '/items/wheat': -1, '/items/egg': null };
  assert.deepEqual(prepareEquipmentRun({ players: [player], zone, consumableCosts: COSTS, dropCreditCosts }).dropCreditCosts,
    { '/items/sugar': 2 });
  assert.equal(prepareEquipmentRun({ players: [player], zone, consumableCosts: COSTS }).dropCreditCosts, null);
  assert.equal(prepareEquipmentRun({ players: [player], zone, dropCreditCosts }).dropCreditCosts, null);
  assert.equal(prepareEquipmentRun({ players: [player], labyrinth: { labyrinthHrid: '/monsters/cyclops', roomLevel: 100 },
    consumableCosts: COSTS, dropCreditCosts }).dropCreditCosts, null);
});

// -----------------------------------------------------------------------------
// the UI's layer: the table, the zone results, the Costs page
// -----------------------------------------------------------------------------

/** Iron times for sugar, an apple gummy and a sword; the credit on unless `extra` says otherwise. */
const pricing = (itemCostOverrides = {}, extra = {}) => ({
  unit: 'seconds', expenseMode: 'ask', dropCredit: true, itemCostOverrides,
  fetchedPrices: {
    '/items/sugar': { ask: 2, bid: 2, vendor: 0 },
    '/items/apple_gummy': { ask: 60, bid: 60, vendor: 0 },
    '/items/cheese_sword': { ask: 900, bid: 900, vendor: 0 },
  },
  ...extra,
});
/** What summariseConsumableCost reads for drop credit: one hour, ten gummy bears, nothing eaten. */
const DROPS = bear(0, 10);
const summary = (p, drops = DROPS) => summariseConsumableCost({ consumablesUsed: {}, hours: 1, pricing: p, players: ['player1'], drops });

test('the posted table: the consumable class at its times; nothing with the credit off or a coin source', () => {
  assert.deepEqual(buildDropCreditCosts(pricing()), { '/items/sugar': 2, '/items/apple_gummy': 60 }, 'a sword is no consumable');
  assert.equal(buildDropCreditCosts(pricing({}, { dropCredit: false })), null);
  assert.equal(buildDropCreditCosts(pricing({}, { unit: 'coins' })), null);
});

test('a zero override removes an item\'s credit, and the credit off leaves the summary exactly as before', () => {
  // 10 bears: 600 sugar × 2 s + 5 apple gummies × 60 s.
  assert.equal(summary(pricing()).creditSecondsPerHour, 1500);
  assert.equal(summary(pricing()).netSecondsPerHour, -1500);
  assert.equal(summary(pricing({ '/items/sugar': 0 })).creditSecondsPerHour, 300);
  const before = summary(pricing(), null);
  assert.deepEqual(summary(pricing({}, { dropCredit: false })), before);
  assert.equal('netSecondsPerHour' in before, false);
});

test('the Costs page lists what one character is expected to receive, consumables only, most credit first', () => {
  const rows = describeDropCredit(DROPS, pricing(), 'player1');
  assert.ok(rows.every((row) => CLASS.has(row.hrid)));
  assert.equal(rows[0].hrid, '/items/sugar');
  assert.equal(rows[0].creditPerHour, 1200);
  assert.equal(rows.find((row) => row.hrid === '/items/apple_gummy').creditPerHour, 300);
});

test('the bear preset zeroes sugar and the low gummies, real consumables all, and keeps the useful ones', () => {
  assert.deepEqual(BEAR_ZONE_ZEROED, ['/items/sugar', '/items/gummy', '/items/apple_gummy', '/items/orange_gummy']);
  for (const hrid of BEAR_ZONE_ZEROED) assert.ok(CLASS.has(hrid), hrid);
  for (const kept of ['plum', 'peach', 'dragon_fruit', 'star_fruit']) {
    assert.ok(itemDetailMap[`/items/${kept}_gummy`], kept);
    assert.equal(BEAR_ZONE_ZEROED.includes(`/items/${kept}_gummy`), false);
  }
});

// The game's own dump lives in the sibling cowstuff repo (found from any ancestor,
// so a worktree works too); skipped where that is not checked out.
let DUMP = null;
for (let dir = dirname(new URL(import.meta.url).pathname); dir !== dirname(dir) && !DUMP; dir = dirname(dir)) {
  const candidate = join(dir, 'cowstuff', 'milkyway_client_info.json');
  if (existsSync(candidate)) DUMP = candidate;
}

test('the bear preset names items the game dump has', { skip: DUMP ? false : 'cowstuff/milkyway_client_info.json not found' }, () => {
  const items = JSON.parse(readFileSync(DUMP, 'utf8')).itemDetailMap;
  for (const hrid of BEAR_ZONE_ZEROED) assert.ok(items[hrid], `${hrid} missing from the dump`);
});
