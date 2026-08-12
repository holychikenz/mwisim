// =============================================================================
// consumableCost tests
//
// Run from api/:  npm test
//
// Covers shared/consumableCost.js — the cost conventions and the effective-rate
// divisor, shared by the trigger optimiser and the zone results — and, in the
// second half, the UI's pricing layer on top of it.
//
// WHY UI CODE IS TESTED FROM api/tests. ui/ has no test runner, and the override
// resolution is the part most worth pinning: it is where a deliberate zero has to
// survive being mistaken for a missing value. api/'s runner can reach it because
// register-loader.js resolves the JSON import that ui/src/utils/prices.js makes,
// and the module itself is plain ESM with no DOM dependency. If a real UI test
// setup ever lands, this half moves there unchanged.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumableSecondsUsed,
  consumableTimeShare,
  effectiveRatePerHour,
  isKnownCost,
  sumConsumablesUsed,
} from '../../shared/consumableCost.js';

import {
  buildConsumableCosts,
  describeConsumableCosts,
  resolveItemCost,
  summariseConsumableCost,
} from '../../ui/src/utils/consumableCosts.js';

// -----------------------------------------------------------------------------
// the cost conventions
// -----------------------------------------------------------------------------

test('zero is a known cost and -1 is not', () => {
  // The whole distinction the override feature rests on. buildIronPrices stores
  // -1 for "no value known"; a user types 0 to mean "this reaches me free".
  assert.equal(isKnownCost(0), true);
  assert.equal(isKnownCost(30), true);
  assert.equal(isKnownCost(-1), false);
  assert.equal(isKnownCost(undefined), false);
  assert.equal(isKnownCost(null), false, 'null coerces to 0 numerically — must not pass');
  assert.equal(isKnownCost('abc'), false);
  assert.equal(isKnownCost(Infinity), false);
});

test('sumConsumablesUsed merges every player onto one tally', () => {
  const { byItem, total } = sumConsumablesUsed({
    player1: { '/items/donut': 40, '/items/coffee': 20 },
    player2: { '/items/donut': 5 },
  });
  assert.deepEqual(byItem, { '/items/donut': 45, '/items/coffee': 20 });
  assert.equal(total, 65);
});

test('sumConsumablesUsed tolerates an empty or absent tally', () => {
  assert.deepEqual(sumConsumablesUsed(undefined), { byItem: {}, total: 0 });
  assert.deepEqual(sumConsumablesUsed({ player1: null }), { byItem: {}, total: 0 });
});

test('consumableSecondsUsed splits priced from unpriced and counts zeroes as priced', () => {
  const { seconds, priced, unpriced } = consumableSecondsUsed(
    { '/items/donut': 40, '/items/coffee': 20, '/items/gummy': 10, '/items/mystery': 3 },
    { '/items/donut': 30, '/items/coffee': 20, '/items/gummy': 0, '/items/mystery': -1 }
  );
  assert.equal(seconds, 40 * 30 + 20 * 20, 'free gummies and unknown mysteries owe nothing');
  assert.deepEqual(priced.sort(), ['/items/coffee', '/items/donut', '/items/gummy']);
  assert.deepEqual(unpriced, ['/items/mystery']);
});

// -----------------------------------------------------------------------------
// the effective-rate divisor
// -----------------------------------------------------------------------------

test('effectiveRatePerHour restates a rate on the total clock', () => {
  // 100/h of combat time, owing 1600s/h of production: 100 encounters per 5200
  // seconds of real time.
  assert.ok(Math.abs(effectiveRatePerHour(100, 1600) - 100 / (1 + 1600 / 3600)) < 1e-9);
  assert.ok(effectiveRatePerHour(100, 1600) < 100);
});

test('effectiveRatePerHour is the identity when nothing is owed', () => {
  // Load-bearing: it is why the metric is always safe to rank or report on. With
  // no cost it simply stops discriminating rather than going wrong.
  assert.equal(effectiveRatePerHour(250.75, 0), 250.75);
  assert.equal(effectiveRatePerHour(250.75, undefined), 250.75);
  assert.equal(effectiveRatePerHour(250.75, -50), 250.75, 'a negative bill is not a bonus');
});

test('consumableTimeShare is the cooking fraction of real time', () => {
  assert.ok(Math.abs(consumableTimeShare(1600) - 1600 / 5200) < 1e-9);
  assert.equal(consumableTimeShare(0), 0);
  assert.equal(consumableTimeShare(3600), 0.5, 'an hour of cooking per hour of combat');
});

// -----------------------------------------------------------------------------
// the UI's pricing layer: fetched times, and the overrides that displace them
// -----------------------------------------------------------------------------

/** A seconds-denominated price map of the shape buildIronPrices produces. */
function ironPricing(overrides = {}) {
  return {
    unit: 'seconds',
    expenseMode: 'ask',
    prices: {
      '/items/peach_gummy': { ask: 240, bid: 240, vendor: 0 },
      '/items/marsberry_donut': { ask: 30, bid: 30, vendor: 0 },
      '/items/mystery_snack': { ask: -1, bid: -1, vendor: 0 },
    },
    itemCostOverrides: overrides,
  };
}

const PARTY = [
  {
    food: [{ hrid: '/items/peach_gummy' }, { hrid: '/items/marsberry_donut' }],
    drinks: [{ hrid: '/items/mystery_snack' }],
  },
];

test('a fetched time is used when there is no override', () => {
  const row = resolveItemCost('/items/peach_gummy', ironPricing());
  assert.deepEqual(row, {
    hrid: '/items/peach_gummy',
    fetched: 240,
    override: null,
    effective: 240,
  });
});

test('an override of zero displaces the fetched time', () => {
  // The motivating case: peach gummy arrives free, so its four minutes of
  // production time is not a cost the player actually pays.
  const row = resolveItemCost('/items/peach_gummy', ironPricing({ '/items/peach_gummy': 0 }));
  assert.equal(row.fetched, 240, 'the displaced figure is kept for display');
  assert.equal(row.override, 0);
  assert.equal(row.effective, 0, '?? must not treat a zero override as absent');
});

test('an override prices an item the source knows nothing about', () => {
  const row = resolveItemCost('/items/mystery_snack', ironPricing({ '/items/mystery_snack': 90 }));
  assert.equal(row.fetched, null);
  assert.equal(row.effective, 90);
});

test('a negative or unparseable override is ignored', () => {
  for (const bad of [-1, 'free', null, undefined, NaN]) {
    const row = resolveItemCost('/items/peach_gummy', ironPricing({ '/items/peach_gummy': bad }));
    assert.equal(row.override, null, `${String(bad)} must not become an override`);
    assert.equal(row.effective, 240, 'and the fetched time must stand');
  }
});

test('coins are not commensurable with combat time', () => {
  const coins = { unit: 'coins', expenseMode: 'ask', prices: ironPricing().prices };
  assert.equal(resolveItemCost('/items/peach_gummy', coins).fetched, null);
  assert.equal(buildConsumableCosts(PARTY, coins), null, 'and no table is built at all');
});

test('describeConsumableCosts lists the slotted items once each', () => {
  const rows = describeConsumableCosts(
    [...PARTY, { food: [{ hrid: '/items/peach_gummy' }] }],
    ironPricing({ '/items/peach_gummy': 0 })
  );
  assert.deepEqual(
    rows.map((row) => row.hrid),
    ['/items/peach_gummy', '/items/marsberry_donut', '/items/mystery_snack'],
    'deduplicated across players, in slot order'
  );
  assert.equal(rows[0].effective, 0);
  assert.equal(rows[2].effective, null, 'an unknown item stays unknown');
});

test('the posted cost table keeps a zero and drops an unknown', () => {
  const costs = buildConsumableCosts(PARTY, ironPricing({ '/items/peach_gummy': 0 }));
  assert.deepEqual(costs, { '/items/peach_gummy': 0, '/items/marsberry_donut': 30 });
});

test('a table of nothing but zeroes is still a table', () => {
  // If this returned null the server would fall back to raw throughput and the UI
  // would warn that the food bill is uncounted — when in fact the user has told us
  // precisely what it is.
  const costs = buildConsumableCosts(
    PARTY,
    ironPricing({ '/items/peach_gummy': 0, '/items/marsberry_donut': 0 })
  );
  assert.deepEqual(costs, { '/items/peach_gummy': 0, '/items/marsberry_donut': 0 });
});

// -----------------------------------------------------------------------------
// the zone results' after-the-fact summary
// -----------------------------------------------------------------------------

/** Two hours of combat: 10 gummies and 20 donuts an hour. */
const USED = { player1: { '/items/peach_gummy': 20, '/items/marsberry_donut': 40 } };

test('summariseConsumableCost prices what was consumed, not what was slotted', () => {
  const summary = summariseConsumableCost({ consumablesUsed: USED, hours: 2, pricing: ironPricing() });
  // (20 * 240 + 40 * 30) / 2 hours = 3000 seconds per hour.
  assert.equal(summary.secondsPerHour, 3000);
  assert.equal(summary.known, true);
  assert.equal(summary.unitsPerHour, 30);
  assert.ok(Math.abs(summary.timeShare - 3000 / 6600) < 1e-9);
  assert.deepEqual(summary.unpriced, []);
  assert.deepEqual(summary.overrides, []);
});

test('an override moves the effective rate on the zone tab', () => {
  const summary = summariseConsumableCost({
    consumablesUsed: USED,
    hours: 2,
    pricing: ironPricing({ '/items/peach_gummy': 0 }),
  });
  assert.equal(summary.secondsPerHour, 600, 'only the donuts are still owed');
  assert.deepEqual(summary.overrides, ['/items/peach_gummy']);

  // 250 encounters/hour of combat, restated on the real clock both ways.
  assert.ok(effectiveRatePerHour(250, 600) > effectiveRatePerHour(250, 3000));
});

test('an unpriceable run reports itself unknown rather than free', () => {
  // The caller omits the card entirely on this, rather than printing a number
  // equal to the raw rate — which would read as "your food costs nothing".
  const summary = summariseConsumableCost({
    consumablesUsed: { player1: { '/items/mystery_snack': 12 } },
    hours: 2,
    pricing: ironPricing(),
  });
  assert.equal(summary.known, false);
  assert.equal(summary.secondsPerHour, 0);
  assert.deepEqual(summary.unpriced, ['/items/mystery_snack']);
});

test('a run that consumed nothing is unknown, not free', () => {
  const summary = summariseConsumableCost({ consumablesUsed: {}, hours: 2, pricing: ironPricing() });
  assert.equal(summary.known, false);
  assert.equal(summary.unitsPerHour, 0);
});
