// =============================================================================
// triggerSearch tests
//
// Run from api/:  npm test
//
// Mostly pure-unit: grids, validity filtering, bound resolution, scoring and
// ranking are all deterministic functions. The one integration test drives the
// whole funnel through a SYNTHETIC evaluator with a known optimum — no worker
// threads, no simulations — which is why search.js takes `evaluate` as a
// parameter rather than reaching for a pool itself.
//
// The ranking tests are the ones that matter most. An epsilon-based comparator is
// very easy to write in a way that is not a valid ordering at all, and the
// symptom (a list that is silently not sorted) is invisible without a property
// test. Two such bugs were caught here during development; both are covered.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  COARSE_POINTS,
  coarseAbsoluteGrid,
  coarseAbsoluteStep,
  coarseGridSize,
  coarsePercentGrid,
  countGrid,
  fineAbsoluteGrid,
  finePercentGrid,
  gridFor,
  niceStep,
} from '../lib/triggerSearch/grids.js';

import {
  SEARCHABLE_CONDITIONS,
  applyValues,
  collectSearchParams,
  countConditions,
  describeSearchability,
  enumerateTriggers,
  readValues,
  resolveMaxValue,
  validateTriggerShape,
} from '../lib/triggerSearch/params.js';

import { boundsFromSpawnInfo, deriveBounds, deriveEnemyBounds } from '../lib/triggerSearch/bounds.js';

import {
  DEFAULT_RANK_EPSILON,
  MAX_DERIVED_EPSILON,
  coefficientOfVariation,
  computeDeltas,
  defaultObjective,
  insensitiveValues,
  noiseAwareEpsilons,
  rankResults,
  scaleCoefficientOfVariation,
  scoreSimResult,
} from '../lib/triggerSearch/score.js';

import { mulberry32, withSeed } from '../lib/triggerSearch/rng.js';
import { estimateWorkload, optimizeTriggers } from '../lib/triggerSearch/search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const D = '/combat_trigger_dependencies';
const C = '/combat_trigger_conditions';
const M = '/combat_trigger_comparators';

// -----------------------------------------------------------------------------
// grids
// -----------------------------------------------------------------------------

test('niceStep rounds up to 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(1.5), 2);
  assert.equal(niceStep(4166), 5000);
  assert.equal(niceStep(168.75), 200);
  assert.equal(niceStep(0), 1, 'never returns zero — it is used as a divisor');
  assert.equal(niceStep(-5), 1);
  assert.equal(niceStep(NaN), 1);
});

test('coarsePercentGrid spans 0..100 inclusive', () => {
  assert.deepEqual(coarsePercentGrid(), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(coarsePercentGrid(25).at(-1), 100, 'always reaches 100 even when the step does not divide it');
  assert.deepEqual(coarsePercentGrid(30), [0, 30, 60, 90, 100]);
});

test('finePercentGrid brackets the incumbent and always contains it', () => {
  assert.deepEqual(finePercentGrid(47), [37, 42, 47, 52, 57]);
  // Clamped at the low edge: the window cannot reach below 0, and 3 is not on the
  // 5-grid, so it has to be inserted explicitly.
  assert.ok(finePercentGrid(3).includes(3));
  assert.equal(Math.min(...finePercentGrid(3)), 0);
  assert.ok(finePercentGrid(98).includes(98));
  assert.equal(Math.max(...finePercentGrid(98)), 100);
});

test('coarseAbsoluteGrid starts at 1, not 0', () => {
  const grid = coarseAbsoluteGrid(50000);
  assert.equal(grid[0], 1, '`current_hp >= 0` is always true and would waste a simulation');
  assert.equal(grid.at(-1), 50000, 'reaches the ceiling');
  assert.ok(grid.length <= COARSE_POINTS + 2, `grid stays bounded, got ${grid.length}`);
  assert.deepEqual([...grid].sort((a, b) => a - b), grid, 'ascending');
  assert.equal(new Set(grid).size, grid.length, 'deduplicated');
});

test('coarseAbsoluteGrid copes with a tiny ceiling', () => {
  assert.deepEqual(coarseAbsoluteGrid(1), [1]);
  const grid = coarseAbsoluteGrid(3);
  assert.ok(grid.includes(1) && grid.includes(3));
});

test('fineAbsoluteGrid centres on the incumbent and includes it', () => {
  const grid = fineAbsoluteGrid(20000, 50000);
  assert.ok(grid.includes(20000), 'a fine pass must be able to keep the value it started from');
  assert.ok(Math.min(...grid) >= 1);
  assert.ok(Math.max(...grid) <= 50000);
  assert.deepEqual([...grid].sort((a, b) => a - b), grid);
});

test('fineAbsoluteGrid step is one fifth of the coarse step', () => {
  const coarse = coarseAbsoluteStep(50000);
  const grid = fineAbsoluteGrid(20000, 50000, coarse);
  const deltas = grid.slice(1).map((value, i) => value - grid[i]);
  assert.ok(deltas.every((d) => d === Math.round(coarse / 5)), `even spacing, got ${deltas.join()}`);
});

test('countGrid is exhaustive over small integers', () => {
  assert.deepEqual(countGrid(4), [0, 1, 2, 3, 4]);
  assert.equal(countGrid(0)[0], 0);
  assert.ok(countGrid(1e6).length <= 65, 'capped so a bad ceiling cannot explode the grid');
});

test('gridFor dispatches on kind, and a count grid ignores fine/coarse', () => {
  assert.deepEqual(gridFor({ kind: 'percentage', maxValue: 100 }, { fine: false }), coarsePercentGrid());
  assert.deepEqual(gridFor({ kind: 'percentage', maxValue: 100 }, { fine: true, current: 47 }), finePercentGrid(47));

  // A count grid is already every legal value, so refining it would only
  // re-simulate points it has measured.
  const coarseCount = gridFor({ kind: 'count', maxValue: 4 }, { fine: false });
  const fineCount = gridFor({ kind: 'count', maxValue: 4 }, { fine: true, current: 2 });
  assert.deepEqual(coarseCount, fineCount);
});

test('coarseGridSize sums the coarse grids', () => {
  const params = [
    { kind: 'percentage', maxValue: 100 },
    { kind: 'count', maxValue: 3 },
  ];
  assert.equal(coarseGridSize(params), coarsePercentGrid().length + countGrid(3).length);
  assert.equal(coarseGridSize([]), 0);
});

// -----------------------------------------------------------------------------
// params — validity
// -----------------------------------------------------------------------------

test('a single-target dependency rejects a multi-target condition', () => {
  // trigger.js:18 routes on the dependency; the single-target path has no case
  // for lowest_hp_percentage and throws mid-simulation.
  const bad = validateTriggerShape(`${D}/self`, `${C}/lowest_hp_percentage`, `${M}/less_than_equal`);
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /multi-target/);

  const good = validateTriggerShape(`${D}/all_allies`, `${C}/lowest_hp_percentage`, `${M}/less_than_equal`);
  assert.equal(good.valid, true);
});

test('a comparator outside allowedComparatorHrids is rejected', () => {
  const bad = validateTriggerShape(`${D}/self`, `${C}/berserk`, `${M}/greater_than_equal`);
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /not permitted/);

  assert.equal(validateTriggerShape(`${D}/self`, `${C}/berserk`, `${M}/is_inactive`).valid, true);
});

test('unknown hrids are rejected rather than thrown on', () => {
  assert.equal(validateTriggerShape('/nope', `${C}/current_hp`, `${M}/less_than_equal`).valid, false);
  assert.equal(validateTriggerShape(`${D}/self`, '/nope', `${M}/less_than_equal`).valid, false);
  assert.equal(validateTriggerShape(`${D}/self`, `${C}/current_hp`, '/nope').valid, false);
});

test('exactly the seven allowValue conditions are searchable', () => {
  assert.equal(Object.keys(SEARCHABLE_CONDITIONS).length, 7);

  const numeric = describeSearchability({
    dependencyHrid: `${D}/self`,
    conditionHrid: `${C}/current_hp`,
    comparatorHrid: `${M}/less_than_equal`,
    value: 100,
  });
  assert.deepEqual(numeric, { searchable: true, kind: 'absolute', boundKey: 'hp' });

  // A buff check reduces through !!value in trigger.js, so its number is ignored.
  const buff = describeSearchability({
    dependencyHrid: `${D}/self`,
    conditionHrid: `${C}/mystic_aura`,
    comparatorHrid: `${M}/is_inactive`,
    value: 0,
  });
  assert.equal(buff.searchable, false);
  assert.match(buff.reason, /ignores the value/);

  const count = describeSearchability({
    dependencyHrid: `${D}/all_enemies`,
    conditionHrid: `${C}/number_of_active_units`,
    comparatorHrid: `${M}/greater_than_equal`,
    value: 2,
  });
  assert.equal(count.kind, 'count');
});

// -----------------------------------------------------------------------------
// params — bound resolution
// -----------------------------------------------------------------------------

const BOUNDS_FIXTURE = {
  players: [
    { hrid: 'player1', maxHitpoints: 2025, maxManapoints: 1750 },
    { hrid: 'player2', maxHitpoints: 900, maxManapoints: 400 },
  ],
  party: { maxHitpoints: 2925, maxManapoints: 2150, size: 2 },
  enemies: {
    totalHitpoints: 40000,
    totalManapoints: 12000,
    targetHitpoints: 9000,
    targetManapoints: 3000,
    maxSpawnCount: 5,
  },
};

test('self bounds come from the OWNING player, not the enemy', () => {
  // The peer fork defaults anything that is not targeted_enemy / all_allies to the
  // enemy total, which is simply the wrong quantity for `self` + current_hp.
  assert.equal(resolveMaxValue(`${D}/self`, 'hp', BOUNDS_FIXTURE, 0), 2025);
  assert.equal(resolveMaxValue(`${D}/self`, 'hp', BOUNDS_FIXTURE, 1), 900);
  assert.equal(resolveMaxValue(`${D}/self`, 'mp', BOUNDS_FIXTURE, 1), 400);
});

test('each dependency resolves to its own ceiling', () => {
  assert.equal(resolveMaxValue(`${D}/targeted_enemy`, 'hp', BOUNDS_FIXTURE), 9000);
  assert.equal(resolveMaxValue(`${D}/targeted_enemy`, 'mp', BOUNDS_FIXTURE), 3000);
  assert.equal(resolveMaxValue(`${D}/all_enemies`, 'hp', BOUNDS_FIXTURE), 40000);
  assert.equal(resolveMaxValue(`${D}/all_enemies`, 'units', BOUNDS_FIXTURE), 5);
  assert.equal(resolveMaxValue(`${D}/all_allies`, 'hp', BOUNDS_FIXTURE), 2925);
  assert.equal(resolveMaxValue(`${D}/all_allies`, 'units', BOUNDS_FIXTURE), 2);
  assert.equal(resolveMaxValue(`${D}/all_allies`, 'percent', BOUNDS_FIXTURE), 100);
  assert.equal(resolveMaxValue('/unknown', 'hp', BOUNDS_FIXTURE), 1);
});

// -----------------------------------------------------------------------------
// params — DTO walking
// -----------------------------------------------------------------------------

function makeDTO() {
  return {
    hrid: 'player1',
    abilities: [
      { hrid: '/abilities/mystic_aura', level: 1, triggers: [
        { dependencyHrid: `${D}/self`, conditionHrid: `${C}/mystic_aura`, comparatorHrid: `${M}/is_inactive`, value: 0 },
      ] },
      { hrid: '/abilities/fireball', level: 1, triggers: [
        { dependencyHrid: `${D}/targeted_enemy`, conditionHrid: `${C}/current_hp`, comparatorHrid: `${M}/greater_than_equal`, value: 1 },
      ] },
      null,
    ],
    food: [
      { hrid: '/items/marsberry_donut', triggers: [
        { dependencyHrid: `${D}/self`, conditionHrid: `${C}/missing_hp`, comparatorHrid: `${M}/greater_than_equal`, value: 350 },
      ] },
      null,
    ],
    drinks: [
      { hrid: '/items/wisdom_coffee', triggers: [
        { dependencyHrid: `${D}/self`, conditionHrid: `${C}/wisdom_coffee`, comparatorHrid: `${M}/is_inactive`, value: 0 },
      ] },
    ],
  };
}

test('enumerateTriggers covers abilities, food AND drinks', () => {
  const rows = enumerateTriggers([makeDTO()]);
  assert.deepEqual([...new Set(rows.map((r) => r.slotKind))].sort(), ['abilities', 'drinks', 'food']);
  assert.equal(rows.length, 4);
  // Consumable thresholds are the archetypal tunable value — they must be offered.
  const donut = rows.find((r) => r.slotHrid === '/items/marsberry_donut');
  assert.equal(donut.searchable, true);
  assert.equal(donut.slotKind, 'food');
  assert.equal(rows.filter((r) => r.searchable).length, 2);
  assert.ok(rows.filter((r) => !r.searchable).every((r) => r.reason), 'every rejection carries a reason for the UI');
});

test('empty slots are skipped without throwing', () => {
  const dto = makeDTO();
  assert.equal(enumerateTriggers([dto]).filter((r) => r.slotHrid == null).length, 0);
  assert.doesNotThrow(() => enumerateTriggers([{ hrid: 'p', abilities: [null, undefined], food: [], drinks: null }]));
  assert.deepEqual(enumerateTriggers(null), []);
});

test('applyValues clones and never mutates the baseline', () => {
  const dtos = [makeDTO()];
  const { params } = collectSearchParams(
    dtos,
    enumerateTriggers(dtos)
      .filter((r) => r.searchable)
      .map(({ playerIndex, slotKind, slotIndex, triggerIndex }) => ({ playerIndex, slotKind, slotIndex, triggerIndex })),
    BOUNDS_FIXTURE
  );

  assert.equal(params.length, 2);
  assert.deepEqual(readValues(dtos, params), [1, 350]);

  const changed = applyValues(dtos, params, [42, 900]);
  assert.deepEqual(readValues(changed, params), [42, 900]);
  assert.deepEqual(readValues(dtos, params), [1, 350], 'baseline untouched — Ability state is per-run');
  assert.notEqual(changed[0], dtos[0]);
});

test('collectSearchParams reports rejections instead of dropping them silently', () => {
  const dtos = [makeDTO()];
  const { params, rejected } = collectSearchParams(
    dtos,
    [
      { playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 }, // is_inactive
      { playerIndex: 0, slotKind: 'abilities', slotIndex: 9, triggerIndex: 0 }, // no such slot
      { playerIndex: 0, slotKind: 'nonsense', slotIndex: 0, triggerIndex: 0 }, // bad slot kind
      { playerIndex: 0, slotKind: 'food', slotIndex: 0, triggerIndex: 0 }, // valid
    ],
    BOUNDS_FIXTURE
  );
  assert.equal(params.length, 1);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((r) => r.reason));
});

test('countConditions counts every slot kind', () => {
  assert.equal(countConditions([makeDTO()]), 4);
  assert.equal(countConditions([]), 0);
});

// -----------------------------------------------------------------------------
// bounds
// -----------------------------------------------------------------------------

test('boundsFromSpawnInfo respects the strength budget', () => {
  const spawnInfo = {
    maxSpawnCount: 3,
    maxTotalStrength: 1,
    spawns: [{ combatMonsterHrid: '/monsters/fly', difficultyTier: 0, rate: 1, strength: 1 }],
  };
  const bounds = boundsFromSpawnInfo(spawnInfo, 0);
  assert.equal(bounds.maxSpawnCount, 1, 'a budget of 1 admits exactly one spawn of strength 1');
  assert.equal(bounds.totalHitpoints, bounds.targetHitpoints);
});

test('boundsFromSpawnInfo degrades gracefully', () => {
  for (const input of [null, undefined, {}, { spawns: [] }]) {
    const bounds = boundsFromSpawnInfo(input, 0);
    assert.ok(bounds.totalHitpoints >= 1 && bounds.maxSpawnCount >= 1);
  }
});

test('deriveEnemyBounds flags an unresolved zone rather than pretending', () => {
  const unknown = deriveEnemyBounds('/actions/combat/does_not_exist', 0);
  assert.equal(unknown.resolved, false);

  const known = deriveEnemyBounds('/actions/combat/fly', 0);
  assert.equal(known.resolved, true);
  assert.ok(known.totalHitpoints >= known.targetHitpoints);
  assert.ok(known.targetHitpoints > 0);
});

test('deriveEnemyBounds scales with difficulty tier', () => {
  const t0 = deriveEnemyBounds('/actions/combat/fly', 0);
  const t2 = deriveEnemyBounds('/actions/combat/fly', 2);
  assert.ok(t2.targetHitpoints > t0.targetHitpoints, 'a higher tier means tougher monsters');
});

test('deriveBounds produces every field resolveMaxValue reads', () => {
  const fixturePath = join(__dirname, '../../fixtures/lab/cyclops.holychikenz.game.json');
  const dto = JSON.parse(readFileSync(fixturePath, 'utf8')).player.dto;
  dto.hrid = 'player1';

  // deriveBounds takes a TARGET (zone or labyrinth), not a bare zone — see
  // api/lib/target.js. Passing the old shape would silently fall through to the
  // unresolved-zone fallback and this test would still pass, so assert
  // `resolved` explicitly rather than trusting a positive hitpoint count.
  const bounds = deriveBounds({
    playerDTOs: [dto],
    target: { kind: 'zone', zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 }, labyrinth: null },
  });
  assert.ok(bounds.players[0].maxHitpoints > 1, 'a real build has real hitpoints');
  assert.ok(bounds.players[0].maxManapoints > 1);
  assert.equal(bounds.party.size, 1);
  assert.equal(bounds.party.maxHitpoints, bounds.players[0].maxHitpoints);
  assert.ok(bounds.enemies.totalHitpoints > 0);
  assert.equal(bounds.enemies.resolved, true, 'the zone was actually read, not defaulted');
});

// -----------------------------------------------------------------------------
// rng
// -----------------------------------------------------------------------------

test('mulberry32 is deterministic per seed and differs across seeds', () => {
  const draw = (seed) => {
    const rng = mulberry32(seed);
    return [rng(), rng(), rng(), rng()];
  };
  assert.deepEqual(draw(42), draw(42));
  assert.notDeepEqual(draw(42), draw(43));
  assert.ok(draw(42).every((value) => value >= 0 && value < 1));
});

test('withSeed restores Math.random even when the body throws', async () => {
  const original = Math.random;
  await assert.rejects(
    withSeed(1, () => {
      assert.notEqual(Math.random, original, 'pinned inside');
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(Math.random, original, 'restored after');
});

// -----------------------------------------------------------------------------
// score — metrics
// -----------------------------------------------------------------------------

const ONE_HOUR_NS = 60 * 60 * 1e9;

test('scoreSimResult normalises by simulated time and separates player deaths', () => {
  const metrics = scoreSimResult({
    simulatedTime: 2 * ONE_HOUR_NS,
    encounters: 300,
    // manaUsed keys are the canonical roster; every other death key is a monster.
    manaUsed: { player1: { '/abilities/fireball': 10 } },
    deaths: { player1: 4, '/monsters/fly': 600 },
    experienceGained: { player1: { attack: 1000, magic: 500 } },
    attacks: { player1: { '/monsters/fly': { '/abilities/fireball': { 50: 10, miss: 3 } } } },
    playerRanOutOfMana: { player1: true },
    playerRanOutOfManaTime: { player1: { totalTimeForOutOfMana: 3600 * 1e9 } },
  });

  assert.equal(metrics.hoursSimulated, 2);
  assert.equal(metrics.encountersPerHour, 150);
  assert.equal(metrics.deathsPerHour, 2, 'player deaths only');
  assert.equal(metrics.enemyKillsPerHour, 300, 'monster deaths only');
  assert.equal(metrics.experiencePerHour, 750);
  assert.equal(metrics.damagePerSecond, 500 / (2 * 3600), 'misses contribute no damage');
  assert.equal(metrics.ranOutOfMana, true);
  assert.equal(metrics.outOfManaSecondsPerHour, 1800);
});

// -----------------------------------------------------------------------------
// score — consumable cost in production time (the ironcow currency)
// -----------------------------------------------------------------------------

/**
 * One hour, 100 encounters, 40 donuts and 20 coffees eaten.
 * At 30s and 20s each that is 40*30 + 20*20 = 1600 seconds of production owed.
 */
function consumableResult() {
  return {
    simulatedTime: ONE_HOUR_NS,
    encounters: 100,
    manaUsed: { player1: {} },
    deaths: {},
    consumablesUsed: {
      player1: { '/items/marsberry_donut': 40, '/items/wisdom_coffee': 20 },
    },
  };
}

test('scoreSimResult counts consumables even with no cost table', () => {
  const metrics = scoreSimResult(consumableResult());
  assert.equal(metrics.consumablesPerHour, 60);
  assert.equal(metrics.consumablesByItemPerHour['/items/marsberry_donut'], 40);
  assert.equal(metrics.consumableSecondsPerHour, 0, 'no prices, no cost');
  assert.equal(metrics.consumableCostsKnown, false);
  assert.equal(
    metrics.effectiveEncountersPerHour,
    metrics.encountersPerHour,
    'with no cost table the effective rate must equal the raw one, so it is always safe to rank on'
  );
});

test('scoreSimResult converts consumption into production seconds', () => {
  const metrics = scoreSimResult(consumableResult(), {
    consumableCosts: { '/items/marsberry_donut': 30, '/items/wisdom_coffee': 20 },
  });
  assert.equal(metrics.consumableSecondsPerHour, 1600);
  assert.equal(metrics.consumableCostsKnown, true);

  // 100 encounters per (3600 + 1600) seconds, expressed per hour.
  const expected = 100 / (1 + 1600 / 3600);
  assert.ok(Math.abs(metrics.effectiveEncountersPerHour - expected) < 1e-9);
  assert.ok(metrics.effectiveEncountersPerHour < metrics.encountersPerHour);

  // 1600 of every 5200 seconds go on cooking rather than fighting.
  assert.ok(Math.abs(metrics.consumableTimeShare - 1600 / 5200) < 1e-9);
});

test('an unknown or negative consumable cost contributes nothing', () => {
  // buildIronPrices stores -1 for "no value known"; treating that as a cost of
  // minus one second would make eating look like a saving.
  const metrics = scoreSimResult(consumableResult(), {
    consumableCosts: { '/items/marsberry_donut': -1, '/items/wisdom_coffee': 20 },
  });
  assert.equal(metrics.consumableSecondsPerHour, 400, 'only the coffee is priced');
});

test('an explicit zero cost is honoured, not read as unknown', () => {
  // A user may override an item to 0 to say "this one reaches me free" — a daily, a
  // guild handout, a stockpile already paid for. Numerically that costs the same as
  // an omission, but it must not be SCREENED OUT as if the price were missing: the
  // route keeps a zero in the table precisely so `consumableCostsKnown` stays true
  // and the objective stays time-denominated.
  const metrics = scoreSimResult(consumableResult(), {
    consumableCosts: { '/items/marsberry_donut': 0, '/items/wisdom_coffee': 20 },
  });
  assert.equal(metrics.consumableSecondsPerHour, 400, 'free donuts owe no production time');
  assert.equal(metrics.consumableCostsKnown, true);

  // 100 encounters per (3600 + 400) seconds — the coffee still has to be paid for.
  const expected = 100 / (1 + 400 / 3600);
  assert.ok(Math.abs(metrics.effectiveEncountersPerHour - expected) < 1e-9);
});

test('a build whose every consumable is free ranks on undiscounted throughput', () => {
  // The degenerate case of the above, and the reason zero is kept rather than
  // dropped: with everything free the effective rate must equal the raw one — not
  // because the cost is unknown, but because it is known to be nil.
  const metrics = scoreSimResult(consumableResult(), {
    consumableCosts: { '/items/marsberry_donut': 0, '/items/wisdom_coffee': 0 },
  });
  assert.equal(metrics.consumableSecondsPerHour, 0);
  assert.equal(metrics.consumableCostsKnown, true, 'declared free is not the same as unpriced');
  assert.equal(metrics.effectiveEncountersPerHour, metrics.encountersPerHour);
  assert.equal(metrics.consumableTimeShare, 0);
  assert.equal(metrics.consumablesPerHour, 60, 'usage is still reported for the tie-break');
});

test('defaultObjective is time-denominated only when the food can be priced', () => {
  assert.equal(defaultObjective({ consumableCostsKnown: true }), 'effectiveEncountersPerHour');
  assert.equal(defaultObjective({ consumableCostsKnown: false }), 'encountersPerHour');
  assert.equal(defaultObjective(), 'encountersPerHour');
});

test('costing food in time reverses the eat-constantly recommendation', () => {
  // The measured pathology, reproduced as a unit test. Eating far more often buys
  // a little throughput (250.75 vs 249.83, +0.37%) at 44 extra donuts an hour.
  const greedy = scoreSimResult({
    simulatedTime: ONE_HOUR_NS,
    encounters: 250.75,
    manaUsed: { player1: {} },
    consumablesUsed: { player1: { '/items/marsberry_donut': 44.3, '/items/wisdom_coffee': 160.3 } },
  }, { consumableCosts: { '/items/marsberry_donut': 30, '/items/wisdom_coffee': 20 } });

  const thrifty = scoreSimResult({
    simulatedTime: ONE_HOUR_NS,
    encounters: 249.83,
    manaUsed: { player1: {} },
    consumablesUsed: { player1: { '/items/wisdom_coffee': 160.3 } },
  }, { consumableCosts: { '/items/marsberry_donut': 30, '/items/wisdom_coffee': 20 } });

  assert.ok(greedy.encountersPerHour > thrifty.encountersPerHour, 'greedy wins on raw throughput');
  assert.ok(
    thrifty.effectiveEncountersPerHour > greedy.effectiveEncountersPerHour,
    'and loses decisively once the cooking time is counted'
  );

  const ranked = rankResults(
    [
      { id: 'greedy', metrics: greedy, conditionCount: 1, changedFromBaseline: 1 },
      { id: 'thrifty', metrics: thrifty, conditionCount: 1, changedFromBaseline: 0 },
    ],
    { objective: 'effectiveEncountersPerHour', epsilon: 0.0036 }
  );
  assert.equal(ranked[0].id, 'thrifty');
});

/** Metrics for an unpriced run: consumption counted, cost unknown. */
const unpriced = (encounters, donuts) =>
  scoreSimResult({
    simulatedTime: ONE_HOUR_NS,
    encounters,
    manaUsed: { player1: {} },
    consumablesUsed: { player1: { '/items/marsberry_donut': donuts } },
  });

test('consumption breaks a throughput tie when no prices are available', () => {
  // The graceful-degradation path. Inside the epsilon, prefer the cheaper option.
  const ranked = rankResults(
    [
      { id: 'greedy', metrics: unpriced(250.0, 44.3), conditionCount: 1, changedFromBaseline: 1 },
      { id: 'thrifty', metrics: unpriced(249.83, 0), conditionCount: 1, changedFromBaseline: 0 },
    ],
    { objective: 'encountersPerHour', epsilon: 0.0036 }
  );
  assert.equal(ranked[0].id, 'thrifty');
});

test('the consumption tie-break does NOT rescue an unpriced run at the measured margin', () => {
  // This is the argument for pricing food in production time rather than relying on
  // the tie-break. Measured on jungle_planet: driving the food threshold to 1 buys
  // 250.75 vs 249.83 encounters/hour — a 0.367% gain — against a measured noise
  // floor of 0.362% at the same fidelity. The gain sits a hair OUTSIDE the epsilon,
  // so the objective cluster splits, the tie-break never fires, and raw throughput
  // duly recommends 44 donuts an hour.
  //
  // If this test ever starts failing because 'thrifty' wins, the epsilon or the
  // clustering has changed — check that it changed for a good reason, because the
  // knife-edge here is real and the honest fix is to count the cooking time.
  const ranked = rankResults(
    [
      { id: 'greedy', metrics: unpriced(250.75, 44.3), conditionCount: 1, changedFromBaseline: 1 },
      { id: 'thrifty', metrics: unpriced(249.83, 0), conditionCount: 1, changedFromBaseline: 0 },
    ],
    { objective: 'encountersPerHour', epsilon: 0.0036 }
  );
  assert.equal(ranked[0].id, 'greedy', 'raw throughput cannot see the food bill — by design of the metric');

  // The same two candidates, once the cooking time is priced in.
  const costs = { '/items/marsberry_donut': 30 };
  const priced = (encounters, donuts) =>
    scoreSimResult({
      simulatedTime: ONE_HOUR_NS,
      encounters,
      manaUsed: { player1: {} },
      consumablesUsed: { player1: { '/items/marsberry_donut': donuts } },
    }, { consumableCosts: costs });

  const costedRanking = rankResults(
    [
      { id: 'greedy', metrics: priced(250.75, 44.3), conditionCount: 1, changedFromBaseline: 1 },
      { id: 'thrifty', metrics: priced(249.83, 0), conditionCount: 1, changedFromBaseline: 0 },
    ],
    { objective: 'effectiveEncountersPerHour', epsilon: 0.0036 }
  );
  assert.equal(costedRanking[0].id, 'thrifty', 'and the answer flips the moment it can');
});

test('consumption never overrides a genuine throughput gain', () => {
  const metrics = (encounters, donuts) =>
    scoreSimResult({
      simulatedTime: ONE_HOUR_NS,
      encounters,
      manaUsed: { player1: {} },
      consumablesUsed: { player1: { '/items/marsberry_donut': donuts } },
    });

  const ranked = rankResults(
    [
      { id: 'much-faster', metrics: metrics(400, 44.3), conditionCount: 1, changedFromBaseline: 1 },
      { id: 'thrifty', metrics: metrics(250, 0), conditionCount: 1, changedFromBaseline: 0 },
    ],
    { objective: 'encountersPerHour', epsilon: 0.0036 }
  );
  assert.equal(ranked[0].id, 'much-faster', '60% more throughput is worth some donuts');
});

test('scoreSimResult survives an empty or partial result', () => {
  for (const input of [{}, null, { simulatedTime: 0 }]) {
    const metrics = scoreSimResult(input);
    assert.equal(metrics.encountersPerHour, 0, 'no divide-by-zero blow-up');
    assert.ok(Number.isFinite(metrics.damagePerSecond));
  }
});

// -----------------------------------------------------------------------------
// score — noise
// -----------------------------------------------------------------------------

test('coefficientOfVariation needs two samples to mean anything', () => {
  assert.equal(coefficientOfVariation([]).samples, 0);
  assert.equal(coefficientOfVariation([5]).cv, 0);
  const stats = coefficientOfVariation([100, 100, 100]);
  assert.equal(stats.cv, 0);
  assert.ok(coefficientOfVariation([90, 100, 110]).cv > 0);
});

test('CV scales as 1/sqrt(t) — the law the funnel relies on', () => {
  // Measured: 5.730% at 6h on enchanted_fortress predicted 2.865% at 24h; the
  // observed figure was 2.942%.
  const scaled = scaleCoefficientOfVariation(0.0573, 6, 24);
  assert.ok(Math.abs(scaled - 0.02865) < 1e-6);
  assert.ok(scaleCoefficientOfVariation(0.05, 6, 24) < 0.05, 'longer runs are quieter');
  assert.equal(scaleCoefficientOfVariation(0, 6, 24), 0);
});

test('noiseAwareEpsilons respects the floor and the cap', () => {
  // A quiet zone must not make us LESS discriminating than the peer's fixed value.
  const quiet = noiseAwareEpsilons({ cv: 0, fromHours: 6, toHours: 24 });
  assert.equal(quiet.rank, DEFAULT_RANK_EPSILON);

  // A loud one must not produce an epsilon so wide that ranking is meaningless.
  const loud = noiseAwareEpsilons({ cv: 5, fromHours: 6, toHours: 6 });
  assert.equal(loud.rank, MAX_DERIVED_EPSILON);

  const middling = noiseAwareEpsilons({ cv: 0.05, fromHours: 6, toHours: 6 });
  assert.ok(middling.rank > DEFAULT_RANK_EPSILON && middling.rank < MAX_DERIVED_EPSILON);
  assert.ok(middling.insensitivity > middling.rank, 'the band is a wider claim than the ranking');
});

// -----------------------------------------------------------------------------
// score — ranking. The properties that matter.
// -----------------------------------------------------------------------------

const entry = (id, objective, deaths = 0, changed = 1, conditions = 10) => ({
  id,
  metrics: { encountersPerHour: objective, deathsPerHour: deaths },
  conditionCount: conditions,
  changedFromBaseline: changed,
});

test('rankResults orders a clear winner first', () => {
  const ranked = rankResults([entry('low', 700), entry('high', 745)], { epsilon: 0.001 });
  assert.deepEqual(ranked.map((e) => e.id), ['high', 'low']);
});

test('rankResults is a TOTAL ORDER — a chain of overlapping ties still sorts', () => {
  // Each neighbour is within epsilon of the next but the ends are not. A pairwise
  // epsilon comparator is non-transitive here and Array.sort returns garbage; this
  // caught a real bug that produced the order 29.75, 31.37, 32.12, 30.12.
  const chain = [entry('x', 100), entry('y', 100.9), entry('z', 101.8)];
  const ranked = rankResults(chain, { epsilon: 0.01 });
  const values = ranked.map((e) => e.metrics.encountersPerHour);
  assert.deepEqual([...values].sort((a, b) => b - a), values, `expected descending, got ${values.join()}`);
});

test('rankResults is independent of input order', () => {
  const list = [entry('a', 745, 0, 1), entry('base', 744.75, 0, 0), entry('b', 745, 0, 2), entry('c', 746, 0, 3)];
  const forward = rankResults(list, { epsilon: 0.00123 }).map((e) => e.id);
  const backward = rankResults([...list].reverse(), { epsilon: 0.00123 }).map((e) => e.id);
  assert.deepEqual(forward, backward);
});

test('rankResults prefers the incumbent when the difference is inside the epsilon', () => {
  // Without this the optimiser advises changing a threshold it has measured as
  // indistinguishable — churn presented as insight.
  const ranked = rankResults(
    [entry('changed-one', 745, 0, 1), entry('baseline', 744.75, 0, 0), entry('changed-two', 745, 0, 2)],
    { epsilon: 0.05 }
  );
  assert.equal(ranked[0].id, 'baseline');
});

test('a real gain still beats the incumbent', () => {
  const ranked = rankResults([entry('better', 800, 0, 1), entry('baseline', 700, 0, 0)], { epsilon: 0.01 });
  assert.equal(ranked[0].id, 'better');
});

test('rankResults prefers fewer conditions before preferring the incumbent', () => {
  const ranked = rankResults(
    [entry('complex', 745, 0, 0, 14), entry('simple', 745, 0, 3, 9)],
    { epsilon: 0.05 }
  );
  assert.equal(ranked[0].id, 'simple', "the peer's best idea, kept");
});

test('deaths only break a tie when they differ by more than the epsilon', () => {
  // 0.01 deaths/hour is noise on any zone where the player dies at all, and must
  // not be allowed to decide the ranking.
  const noise = rankResults([entry('a', 745, 5.0, 1), entry('baseline', 745, 5.01, 0)], { epsilon: 0.05 });
  assert.equal(noise[0].id, 'baseline', 'a 0.2% death difference is not a finding');

  const real = rankResults([entry('safe', 745, 1, 1), entry('baseline', 745, 20, 0)], { epsilon: 0.05 });
  assert.equal(real[0].id, 'safe', 'twenty times the deaths certainly is');
});

test('rankResults tolerates empty and malformed input', () => {
  assert.deepEqual(rankResults([]), []);
  assert.deepEqual(rankResults(null), []);
  assert.equal(rankResults([{ id: 'x' }, { id: 'y' }]).length, 2, 'missing metrics do not throw');
});

// -----------------------------------------------------------------------------
// score — insensitivity band and deltas
// -----------------------------------------------------------------------------

test('insensitiveValues reports every value indistinguishable from the winner', () => {
  const sweep = [
    { value: 10, metrics: { encountersPerHour: 90 } },
    { value: 20, metrics: { encountersPerHour: 100 } },
    { value: 30, metrics: { encountersPerHour: 99.8 } },
    { value: 40, metrics: { encountersPerHour: 50 } },
  ];
  const band = insensitiveValues(sweep, sweep[1], { epsilon: 0.005 });
  assert.deepEqual(band, [20, 30], 'within 0.5%: 100 and 99.8; not 90 or 50');
  assert.ok(band.includes(20), 'the winner is always in its own band');
});

test('insensitiveValues copes with a zero objective', () => {
  const sweep = [
    { value: 1, metrics: { encountersPerHour: 0 } },
    { value: 2, metrics: { encountersPerHour: 0 } },
  ];
  assert.deepEqual(insensitiveValues(sweep, sweep[0], { epsilon: 0.005 }), [1, 2]);
});

test('computeDeltas gives absolute and relative change, and null pct at a zero baseline', () => {
  const deltas = computeDeltas({ encountersPerHour: 110 }, { encountersPerHour: 100 });
  assert.equal(deltas.encountersPerHour.value, 10);
  assert.ok(Math.abs(deltas.encountersPerHour.pct - 0.1) < 1e-9);
  assert.equal(computeDeltas({ encountersPerHour: 5 }, { encountersPerHour: 0 }).encountersPerHour.pct, null);
});

// -----------------------------------------------------------------------------
// search — workload estimate and the full funnel against a synthetic evaluator
// -----------------------------------------------------------------------------

test('estimateWorkload is an upper bound that accounts for every stage', () => {
  const params = [
    { kind: 'percentage', maxValue: 100, initialValue: 50 },
    { kind: 'count', maxValue: 4, initialValue: 2 },
  ];
  const workload = estimateWorkload(params);
  assert.equal(
    workload.total,
    workload.calibration + workload.initial + workload.coarse + workload.fine + workload.verify
  );
  assert.ok(workload.total > 0);

  // No parameters means nothing to search but still one baseline to report.
  const empty = estimateWorkload([]);
  assert.equal(empty.verify, 1);

  const noCalibration = estimateWorkload(params, { calibration: { repeats: 0 } });
  assert.equal(noCalibration.calibration, 0);
});

/**
 * A synthetic search problem: a single percentage threshold whose score peaks at
 * a known value. Noiseless and instant, so the funnel's logic can be asserted
 * without simulating anything.
 */
function syntheticSetup({ optimum = 60, initial = 0 } = {}) {
  const playerDTOs = [
    {
      hrid: 'player1',
      abilities: [
        { hrid: '/abilities/heal', level: 1, triggers: [
          { dependencyHrid: `${D}/all_allies`, conditionHrid: `${C}/lowest_hp_percentage`, comparatorHrid: `${M}/less_than_equal`, value: initial },
        ] },
      ],
      food: [],
      drinks: [],
    },
  ];

  const params = [
    {
      playerIndex: 0,
      slotKind: 'abilities',
      slotIndex: 0,
      triggerIndex: 0,
      playerHrid: 'player1',
      slotHrid: '/abilities/heal',
      dependencyHrid: `${D}/all_allies`,
      conditionHrid: `${C}/lowest_hp_percentage`,
      comparatorHrid: `${M}/less_than_equal`,
      dependencyName: "Allies' Total",
      conditionName: 'Lowest HP %',
      comparatorName: '<=',
      kind: 'percentage',
      boundKey: 'percent',
      maxValue: 100,
      initialValue: initial,
    },
  ];

  const evaluate = async (jobs) =>
    jobs.map((job) => {
      const value = job.playerDTOs[0].abilities[0].triggers[0].value;
      return {
        id: job.id,
        metrics: { encountersPerHour: 1000 - Math.abs(value - optimum), deathsPerHour: 0 },
      };
    });

  const stages = {
    calibration: { repeats: 0 }, // noiseless, so use the epsilon floors
    initial: { hours: 1, keepPerParam: 3 },
    coarse: { hours: 2, beamWidth: 4 },
    fine: { hours: 3, keep: 3 },
    verify: { hours: 4 },
  };

  return { playerDTOs, params, evaluate, stages };
}

test('the funnel finds a known optimum', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup({ optimum: 60, initial: 0 });
  const result = await optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 7 });

  assert.equal(result.rows[0].triggers[0].value, 60);
  assert.equal(result.rows[0].isBaseline, false);
  assert.equal(result.rows[0].significant, true, 'a 60-point gain is well outside the floor epsilon');
  assert.equal(result.inconclusive, false);
  assert.ok(result.simulationsRun > 0);
  assert.ok(result.simulationsRun <= result.estimatedSimulations, 'the estimate is an upper bound');
});

test('the funnel finds an optimum that is off the coarse grid', async () => {
  // 63 is not a multiple of 10, so only the fine pass can reach it.
  const { playerDTOs, params, evaluate, stages } = syntheticSetup({ optimum: 63, initial: 0 });
  const result = await optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 7 });
  const found = result.rows[0].triggers[0].value;
  assert.ok(Math.abs(found - 63) <= 2, `fine grid resolution is 5, got ${found}`);
});

test('the funnel recommends no change when the incumbent is already optimal', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup({ optimum: 60, initial: 60 });
  const result = await optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 7 });
  assert.equal(result.rows[0].isBaseline, true);
  assert.equal(result.rows[0].changedCount, 0);
  assert.equal(result.inconclusive, true, 'nothing beat doing nothing, and it says so');
});

test('the funnel emits a resumable checkpoint per phase', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup();
  const checkpoints = [];
  await optimizeTriggers({
    playerDTOs, params, evaluate, stages, seedBase: 7,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.deepEqual(checkpoints.map((c) => c.completedPhase), ['initial', 'coarse', 'fine']);
  assert.ok(Array.isArray(checkpoints[0].survivingValues));
  assert.ok(Array.isArray(checkpoints[1].beam));
  assert.ok(Array.isArray(checkpoints[2].finalists));
});

test('resuming from a checkpoint skips the completed phases', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup();
  const checkpoints = [];
  const full = await optimizeTriggers({
    playerDTOs, params, evaluate, stages, seedBase: 7,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  });

  const resumed = await optimizeTriggers({
    playerDTOs, params, evaluate, stages, seedBase: 7,
    resumeCheckpoint: checkpoints.at(-1),
  });

  assert.ok(resumed.simulationsRun < full.simulationsRun, 'a resumed run does less work');
  assert.equal(resumed.rows[0].triggers[0].value, full.rows[0].triggers[0].value, 'and reaches the same answer');
});

test('progress is monotonic and bounded', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup();
  const seen = [];
  await optimizeTriggers({
    playerDTOs, params, evaluate, stages, seedBase: 7,
    onProgress: (progress) => seen.push(progress.progress),
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((p) => p >= 0 && p <= 1), 'never outside 0..1');
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'never goes backwards');
});

test('an abort signal stops the funnel', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 7, signal: controller.signal }),
    (error) => error.name === 'AbortError'
  );
});

test('a candidate whose simulation fails does not sink the run', async () => {
  const { playerDTOs, params, stages } = syntheticSetup({ optimum: 60 });
  // Every value above 80 "fails"; the optimum at 60 must still be found.
  const evaluate = async (jobs) =>
    jobs.map((job) => {
      const value = job.playerDTOs[0].abilities[0].triggers[0].value;
      if (value > 80) return { id: job.id, error: 'MAX_TICKS exceeded' };
      return { id: job.id, metrics: { encountersPerHour: 1000 - Math.abs(value - 60), deathsPerHour: 0 } };
    });

  const result = await optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 7 });
  assert.equal(result.rows[0].triggers[0].value, 60);
});

test('no searchable parameters still yields a baseline row', async () => {
  const { playerDTOs, evaluate, stages } = syntheticSetup();
  const result = await optimizeTriggers({ playerDTOs, params: [], evaluate, stages, seedBase: 7 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].isBaseline, true);
  assert.equal(result.inconclusive, true);
});

test('the reported band and per-stage epsilons reach the caller', async () => {
  const { playerDTOs, params, evaluate, stages } = syntheticSetup();
  const result = await optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 7 });
  assert.ok(Array.isArray(result.rows[0].triggers[0].insensitiveValues));
  for (const stage of ['initial', 'coarse', 'fine', 'verify']) {
    assert.ok(result.epsilons.byStage[stage].rank > 0, `${stage} epsilon present`);
  }
  assert.equal(result.noise.calibrated, false, 'calibration was switched off for this fixture');
  assert.ok(result.epsilons.significanceBar > 0);
});

test('noise calibration widens the epsilons it derives', async () => {
  const { playerDTOs, params, stages } = syntheticSetup({ optimum: 60 });
  // A noisy evaluator: the score depends on the seed as much as on the value, so
  // calibration should measure a real spread and widen the epsilons accordingly.
  const evaluate = async (jobs) =>
    jobs.map((job) => {
      const value = job.playerDTOs[0].abilities[0].triggers[0].value;
      const jitter = mulberry32(job.seed)() * 200;
      return { id: job.id, metrics: { encountersPerHour: 1000 - Math.abs(value - 60) + jitter, deathsPerHour: 0 } };
    });

  const noisy = await optimizeTriggers({
    playerDTOs, params, evaluate, seedBase: 7,
    stages: { ...stages, calibration: { repeats: 6 } },
  });

  assert.equal(noisy.noise.calibrated, true);
  assert.ok(noisy.noise.samples >= 2);
  assert.ok(noisy.noise.coefficientOfVariation > 0, 'a spread was actually measured');
  assert.ok(
    noisy.epsilons.byStage.verify.rank > DEFAULT_RANK_EPSILON,
    'the derived epsilon is wider than the floor'
  );
});
