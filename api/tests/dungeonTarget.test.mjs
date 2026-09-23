// =============================================================================
// dungeonTarget tests
//
// Run from api/:  npm test
//
// A dungeon is a zone whose unit of progress is the whole run, not the wave. The
// engine counts every cleared wave in `encounters`, so a dungeon's
// "encounters per hour" is waves per hour — a figure no player asks for, and one
// the trigger optimiser would happily maximise at the expense of finishing. These
// tests pin the three things that follow:
//
//   1. scoreSimResult reports completions (and failures) per hour on a dungeon
//      run, and says nothing about them on an ordinary zone;
//   2. a dungeon target ranks on completions per hour, never encounters;
//   3. every trigger row carries the name of the player who owns it.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { markDungeon, normaliseTarget } from '../lib/target.js';
import {
  ALL_REPORTED_METRICS,
  DUNGEON_REPORTED_METRICS,
  REPORTED_METRICS,
  defaultObjective,
  reportedMetricsFor,
  scoreSimResult,
} from '../lib/triggerSearch/score.js';
import { collectSearchParams, enumerateTriggers } from '../lib/triggerSearch/params.js';
import { optimizeTriggers } from '../lib/triggerSearch/search.js';

const ONE_HOUR_NS = 60 * 60 * 1e9;
const D = '/combat_trigger_dependencies';
const C = '/combat_trigger_conditions';
const M = '/combat_trigger_comparators';

/** Two hours in a dungeon: 6 runs finished, 2 wiped, 300 waves cleared. */
function dungeonResult(extra = {}) {
  return {
    simulatedTime: 2 * ONE_HOUR_NS,
    encounters: 300,
    isDungeon: true,
    dungeonsCompleted: 6,
    dungeonsFailed: 2,
    manaUsed: { player1: {} },
    deaths: {},
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// scoring
// -----------------------------------------------------------------------------

test('a dungeon run is scored in completed runs per hour, not waves', () => {
  const metrics = scoreSimResult(dungeonResult());
  assert.equal(metrics.dungeonsCompleted, 6);
  assert.equal(metrics.completionsPerHour, 3, 'six full runs over two hours');
  assert.equal(metrics.dungeonFailuresPerHour, 1);
  assert.equal(metrics.effectiveCompletionsPerHour, 3, 'no cost table: effective equals raw');
});

test('a dungeon completion rate is restated on total time when the food is priced', () => {
  // 3 runs/hour of combat; 1800s of production owed per combat hour, so each
  // combat hour costs 1.5 real hours and the effective rate is 2.
  const metrics = scoreSimResult(
    dungeonResult({ consumablesUsed: { player1: { '/items/marsberry_donut': 120 } } }),
    { consumableCosts: { '/items/marsberry_donut': 30 } }
  );
  assert.equal(metrics.completionsPerHour, 3);
  assert.equal(metrics.consumableSecondsPerHour, 1800);
  assert.ok(Math.abs(metrics.effectiveCompletionsPerHour - 2) < 1e-9);
});

test('an ordinary zone run carries no dungeon metrics', () => {
  const metrics = scoreSimResult({
    simulatedTime: ONE_HOUR_NS,
    encounters: 100,
    manaUsed: { player1: {} },
    deaths: {},
  });
  assert.equal(metrics.encountersPerHour, 100, 'zones keep encounters per hour');
  for (const key of ['dungeonsCompleted', 'completionsPerHour', 'effectiveCompletionsPerHour', 'dungeonFailuresPerHour']) {
    assert.equal(key in metrics, false, `${key} must not appear on a zone run`);
  }
});

// -----------------------------------------------------------------------------
// objective and reported metrics
// -----------------------------------------------------------------------------

test('a dungeon ranks on completions per hour, costed when the food can be priced', () => {
  assert.equal(defaultObjective({ dungeon: true }), 'completionsPerHour');
  assert.equal(defaultObjective({ dungeon: true, consumableCostsKnown: true }), 'effectiveCompletionsPerHour');
  // Zones are untouched.
  assert.equal(defaultObjective({ consumableCostsKnown: false }), 'encountersPerHour');
  assert.equal(defaultObjective({ consumableCostsKnown: true }), 'effectiveEncountersPerHour');
});

test('a dungeon reports completions and never encounters per hour', () => {
  const list = reportedMetricsFor({ kind: 'zone', dungeon: true });
  assert.equal(list, DUNGEON_REPORTED_METRICS);
  assert.ok(list.includes('completionsPerHour'));
  assert.ok(list.includes('effectiveCompletionsPerHour'));
  assert.equal(list.includes('encountersPerHour'), false);
  assert.equal(list.includes('effectiveEncountersPerHour'), false);
  assert.equal(reportedMetricsFor({ kind: 'zone' }), REPORTED_METRICS, 'a zone keeps its list');
  for (const key of DUNGEON_REPORTED_METRICS) assert.ok(ALL_REPORTED_METRICS.includes(key));
});

test('markDungeon flags a dungeon zone and leaves planets alone', () => {
  const dungeon = markDungeon(normaliseTarget({ zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0 } }));
  assert.equal(dungeon.dungeon, true);
  assert.equal(dungeon.kind, 'zone');

  const planet = markDungeon(normaliseTarget({ zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 } }));
  assert.equal(planet.dungeon, false);

  const unknown = markDungeon(normaliseTarget({ zone: { zoneHrid: '/actions/combat/no_such_zone' } }));
  assert.equal(unknown.dungeon, false, 'an unknown zone is not guessed to be a dungeon');
});

// -----------------------------------------------------------------------------
// player name on every trigger row
// -----------------------------------------------------------------------------

function namedParty() {
  const heal = (value) => ({
    hrid: '/abilities/heal',
    level: 1,
    triggers: [
      { dependencyHrid: `${D}/all_allies`, conditionHrid: `${C}/lowest_hp_percentage`, comparatorHrid: `${M}/less_than_equal`, value },
    ],
  });
  return [
    { hrid: 'player1', name: 'Alice', abilities: [heal(50)], food: [], drinks: [] },
    // No name at all: an older client, or a character nobody named.
    { hrid: 'player2', abilities: [heal(40)], food: [], drinks: [] },
  ];
}

test('enumerateTriggers names the player who owns each trigger', () => {
  const rows = enumerateTriggers(namedParty());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].playerName, 'Alice');
  assert.equal(rows[0].playerHrid, 'player1');
  assert.equal(rows[1].playerName, null, 'absent, not invented');
  assert.equal(rows[1].playerHrid, 'player2');
});

test('collectSearchParams and the finished rows carry the player name through', async () => {
  const playerDTOs = namedParty();
  const selection = enumerateTriggers(playerDTOs).map(({ playerIndex, slotKind, slotIndex, triggerIndex }) => ({
    playerIndex,
    slotKind,
    slotIndex,
    triggerIndex,
  }));
  const bounds = { players: [{ maxHp: 1000, maxMp: 1000 }, { maxHp: 1000, maxMp: 1000 }], partyMissingHp: 2000 };
  const { params } = collectSearchParams(playerDTOs, selection, bounds);
  assert.deepEqual(params.map((param) => param.playerName), ['Alice', null]);

  const evaluate = async (jobs) =>
    jobs.map((job) => ({ id: job.id, metrics: { completionsPerHour: 3, deathsPerHour: 0 } }));
  const result = await optimizeTriggers({
    playerDTOs,
    params,
    evaluate,
    objective: 'completionsPerHour',
    stages: {
      calibration: { repeats: 0 },
      initial: { hours: 1, keepPerParam: 2 },
      coarse: { hours: 1, beamWidth: 2 },
      fine: { hours: 1, keep: 2 },
      verify: { hours: 1 },
    },
    seedBase: 7,
  });
  assert.deepEqual(result.rows[0].triggers.map((trigger) => trigger.playerName), ['Alice', null]);
});

test('the search ranks a dungeon on completions even when encounters disagree', async () => {
  // Waves per hour peak at 20; finished runs peak at 70. A dungeon must follow
  // the runs — the bug being fixed is exactly the optimiser chasing the waves.
  const playerDTOs = [namedParty()[0]];
  const bounds = { players: [{ maxHp: 1000, maxMp: 1000 }], partyMissingHp: 1000 };
  const { params } = collectSearchParams(
    playerDTOs,
    [{ playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 }],
    bounds
  );
  const evaluate = async (jobs) =>
    jobs.map((job) => {
      const value = job.playerDTOs[0].abilities[0].triggers[0].value;
      return {
        id: job.id,
        metrics: {
          encountersPerHour: 1000 - Math.abs(value - 20),
          completionsPerHour: 1000 - Math.abs(value - 70),
          deathsPerHour: 0,
        },
      };
    });
  const result = await optimizeTriggers({
    playerDTOs,
    params,
    evaluate,
    objective: defaultObjective({ dungeon: true }),
    stages: {
      calibration: { repeats: 0 },
      initial: { hours: 1, keepPerParam: 3 },
      coarse: { hours: 2, beamWidth: 4 },
      fine: { hours: 3, keep: 3 },
      verify: { hours: 4 },
    },
    seedBase: 7,
  });
  assert.equal(result.objective, 'completionsPerHour');
  assert.equal(result.rows[0].triggers[0].value, 70);
});
