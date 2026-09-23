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
  objectiveSaturation,
  rankResults,
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

// -----------------------------------------------------------------------------
// review follow-ups: rates below one an hour, and dungeons never finished
// -----------------------------------------------------------------------------

test('completion rates below one an hour are still compared relatively', () => {
  // A hard dungeon: 0.20 vs 0.24 runs/hour is a 20% gain. With the objective's
  // scale floored at 1 (right for encounters, which run in the hundreds) a 5%
  // epsilon would treat it as a 0.04 absolute gap and call it a tie.
  const objective = defaultObjective({ dungeon: true });
  const ranked = rankResults(
    [
      { id: 'baseline', metrics: { [objective]: 0.2, deathsPerHour: 0 }, changedFromBaseline: 0 },
      { id: 'improved', metrics: { [objective]: 0.24, deathsPerHour: 0 }, changedFromBaseline: 1 },
    ],
    { objective, epsilon: 0.05 }
  );
  assert.equal(ranked[0].id, 'improved');
});

test('a dungeon nobody finishes is reported as pinned at the floor', () => {
  assert.equal(objectiveSaturation('completionsPerHour', 0), 'floor');
  assert.equal(objectiveSaturation('effectiveCompletionsPerHour', 0), 'floor');
  assert.equal(objectiveSaturation('completionsPerHour', 2.5), null, 'no ceiling on a rate');
  assert.equal(objectiveSaturation('encountersPerHour', 0), null, 'zones unchanged');
});

test('the floor is not claimed when some candidate did finish a run', async () => {
  const playerDTOs = [namedParty()[0]];
  const bounds = { players: [{ maxHp: 1000, maxMp: 1000 }], partyMissingHp: 1000 };
  const { params } = collectSearchParams(
    playerDTOs,
    [{ playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 }],
    bounds
  );
  const stages = {
    calibration: { repeats: 0 },
    initial: { hours: 1, keepPerParam: 3 },
    coarse: { hours: 2, beamWidth: 4 },
    fine: { hours: 3, keep: 3 },
    verify: { hours: 4 },
  };
  const run = (rate) =>
    optimizeTriggers({
      playerDTOs,
      params,
      objective: 'completionsPerHour',
      stages,
      seedBase: 7,
      evaluate: async (jobs) =>
        jobs.map((job) => ({
          id: job.id,
          metrics: { completionsPerHour: rate(job.playerDTOs[0].abilities[0].triggers[0].value), deathsPerHour: 0 },
        })),
    });

  const never = await run(() => 0);
  assert.equal(never.saturated, 'floor', 'nothing ever completes: say so');

  // The incumbent (50) finishes nothing; a lower threshold does.
  const rescued = await run((value) => (value <= 20 ? 0.5 : 0));
  assert.equal(rescued.saturated, null);
  assert.equal(rescued.inconclusive, false);
});

test('an unmeasured baseline is not a zero to be rescued from', async () => {
  // The baseline's simulation fails (the evaluator reports an error for it), so
  // there is no measured starting point, and a candidate that completes runs
  // must not be declared a rescue "from zero".
  const playerDTOs = [namedParty()[0]];
  const bounds = { players: [{ maxHp: 1000, maxMp: 1000 }], partyMissingHp: 1000 };
  const { params } = collectSearchParams(
    playerDTOs,
    [{ playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 }],
    bounds
  );
  const result = await optimizeTriggers({
    playerDTOs,
    params,
    objective: 'completionsPerHour',
    stages: {
      calibration: { repeats: 0 },
      initial: { hours: 1, keepPerParam: 3 },
      coarse: { hours: 2, beamWidth: 4 },
      fine: { hours: 3, keep: 3 },
      verify: { hours: 4 },
    },
    seedBase: 7,
    evaluate: async (jobs) =>
      jobs.map((job) => {
        const value = job.playerDTOs[0].abilities[0].triggers[0].value;
        return value === 50
          ? { id: job.id, error: 'simulated worker failure' }
          : { id: job.id, metrics: { completionsPerHour: 0.5, deathsPerHour: 0 } };
      }),
  });
  assert.equal(result.rows.some((row) => row.significant), false);
  assert.equal(result.inconclusive, true);
});

test('a rescue needs the baseline measured at verification, not an earlier stage', async () => {
  // The incumbent finishes nothing in the short early stages, then its
  // verification run fails. The fallback baseline is that earlier zero — over a
  // different window and seed — and must not license a "from zero" gain.
  const playerDTOs = [namedParty()[0]];
  const bounds = { players: [{ maxHp: 1000, maxMp: 1000 }], partyMissingHp: 1000 };
  const { params } = collectSearchParams(
    playerDTOs,
    [{ playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 }],
    bounds
  );
  const result = await optimizeTriggers({
    playerDTOs,
    params,
    objective: 'completionsPerHour',
    stages: {
      calibration: { repeats: 0 },
      initial: { hours: 1, keepPerParam: 3 },
      coarse: { hours: 2, beamWidth: 4 },
      fine: { hours: 3, keep: 3 },
      verify: { hours: 4 },
    },
    seedBase: 7,
    evaluate: async (jobs, meta) =>
      jobs.map((job) => {
        const value = job.playerDTOs[0].abilities[0].triggers[0].value;
        if (value === 50) {
          return meta?.stage === 'verify'
            ? { id: job.id, error: 'simulated worker failure' }
            : { id: job.id, metrics: { completionsPerHour: 0, deathsPerHour: 0 } };
        }
        return { id: job.id, metrics: { completionsPerHour: value <= 20 ? 0.5 : 0, deathsPerHour: 0 } };
      }),
  });
  assert.equal(result.rows.some((row) => row.significant), false);
  assert.equal(result.inconclusive, true);
});

test('a failed verification does not claim that no run ever completes', async () => {
  const playerDTOs = [namedParty()[0]];
  const bounds = { players: [{ maxHp: 1000, maxMp: 1000 }], partyMissingHp: 1000 };
  const { params } = collectSearchParams(
    playerDTOs,
    [{ playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 }],
    bounds
  );
  const result = await optimizeTriggers({
    playerDTOs,
    params,
    objective: 'completionsPerHour',
    stages: {
      calibration: { repeats: 0 },
      initial: { hours: 1, keepPerParam: 3 },
      coarse: { hours: 2, beamWidth: 4 },
      fine: { hours: 3, keep: 3 },
      verify: { hours: 4 },
    },
    seedBase: 7,
    // Zero completions everywhere early; every verification run fails.
    evaluate: async (jobs, meta) =>
      jobs.map((job) =>
        meta?.stage === 'verify'
          ? { id: job.id, error: 'simulated worker failure' }
          : { id: job.id, metrics: { completionsPerHour: 0, deathsPerHour: 0 } }
      ),
  });
  assert.equal(result.saturated, null, 'nothing was verified, so nothing is claimed');
});
