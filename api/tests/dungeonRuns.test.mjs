// =============================================================================
// shared/dungeonRuns.js — planning dungeon runs across workers and batches, and
// merging the results back into one SimResult.
//
// Run from api/:  npm test
//
// Pure: no engine. The engine-backed checks live in dungeonRunMode.test.mjs.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONE_HOUR_NS,
  DEFAULT_MAX_RUN_HOURS,
  MIN_RUN_HOURS,
  MAX_RUN_HOURS,
  MERGE_RULES,
  addRunIdleTime,
  normaliseRunLimits,
  planShards,
  planBatches,
  mergeSimResults,
  runDungeonRunsSerial,
  workerBatchRunner,
} from '../../shared/dungeonRuns.js';

const H = ONE_HOUR_NS;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// -- limits --------------------------------------------------------------------

test('normaliseRunLimits defaults a run to 3 hours', () => {
  assert.equal(DEFAULT_MAX_RUN_HOURS, 3);
  assert.equal(ONE_HOUR_NS, 3600e9);
  assert.deepEqual(normaliseRunLimits({ maxRuns: 10 }), { maxRuns: 10, maxRunDurationNs: 3 * 3600e9 });
  assert.deepEqual(normaliseRunLimits({ maxRuns: 10, maxRunHours: 1.5 }), { maxRuns: 10, maxRunDurationNs: 1.5 * 3600e9 });
});

test('normaliseRunLimits allows a run of 1 to 10 hours, both ends included', () => {
  assert.equal(MIN_RUN_HOURS, 1);
  assert.equal(MAX_RUN_HOURS, 10);
  assert.equal(normaliseRunLimits({ maxRuns: 1, maxRunHours: 1 }).maxRunDurationNs, 1 * 3600e9);
  assert.equal(normaliseRunLimits({ maxRuns: 1, maxRunHours: 10 }).maxRunDurationNs, 10 * 3600e9);
  for (const h of [0.5, 0.99, 10.01, 11]) {
    assert.throws(() => normaliseRunLimits({ maxRuns: 5, maxRunHours: h }), RangeError, String(h));
  }
});

test('normaliseRunLimits is null without maxRuns', () => {
  assert.equal(normaliseRunLimits({}), null);
  assert.equal(normaliseRunLimits({ maxRunHours: 2 }), null);
  assert.equal(normaliseRunLimits(undefined), null);
});

test('normaliseRunLimits refuses bad runs and durations', () => {
  for (const bad of [{ maxRuns: 0 }, { maxRuns: 1.5 }, { maxRuns: 10001 }, { maxRuns: '5' },
    { maxRuns: 5, maxRunHours: 0.05 }, { maxRuns: 5, maxRunHours: 25 }, { maxRuns: 5, maxRunHours: NaN }]) {
    assert.throws(() => normaliseRunLimits(bad), RangeError, JSON.stringify(bad));
  }
});

// -- planning ------------------------------------------------------------------

test('planShards splits runs evenly, larger shards first, and always sums', () => {
  const cases = [
    [[100, 8], [13, 13, 13, 13, 12, 12, 12, 12]],
    [[100, 32], Array(10).fill(10)],
    [[1, 8], [1]],
    [[5, 8], [5]],
    [[25, 8], [9, 8, 8]],
  ];
  for (const [[runs, conc], want] of cases) {
    assert.deepEqual(planShards(runs, conc), want, `${runs}/${conc}`);
  }
  const big = planShards(1000, 32);
  assert.equal(big.length, 16);
  assert.equal(sum(big), 1000);
  const dflt = planShards(100, undefined);
  assert.equal(dflt.length, 4);
  assert.equal(sum(dflt), 100);
});

test('planShards refuses a run count that is not a positive integer', () => {
  assert.throws(() => planShards(0, 8), RangeError);
  assert.throws(() => planShards(NaN, 8), RangeError);
  assert.throws(() => planShards(2.5, 8), RangeError);
});

test('planBatches keeps each batch within the simulated-time budget', () => {
  assert.deepEqual(planBatches(10, 3 * H), [10]);
  assert.deepEqual(planBatches(100, 3 * H), [25, 25, 25, 25]);
  assert.deepEqual(planBatches(5, 40 * H), [2, 2, 1]);
  assert.deepEqual(planBatches(3, 150 * H), [1, 1, 1]);
});

// -- merging -------------------------------------------------------------------

function shardA() {
  return {
    simulatedTime: 100, encounters: 10, dungeonsCompleted: 2, dungeonsFailed: 1, dungeonsTimedOut: 1,
    labyAttemptCount: 0,
    deaths: { player1: 1, boss: 2 },
    experienceGained: { player1: { melee: 10, stamina: 5 } },
    attacks: { player1: { boss: { '/abilities/a': { hit: 3, miss: 1 } } } },
    consumablesUsed: { player1: { food: 2 } },
    hitpointsGained: {}, healingDone: {}, manapointsGained: {}, hitpointsSpent: {}, manaUsed: { player1: 7 },
    maxWaveReached: 50, maxEnrageStack: 1, maxDungenonTime: 40, minDungenonTime: 30,
    playerRanOutOfMana: { player1: false, player2: true },
    playerRanOutOfManaTime: { player1: { isOutOfMana: true, startTimeForOutOfMana: 90, totalTimeForOutOfMana: 5 } },
    timeSpentAlive: [
      { name: '#1', timeSpentAlive: 20, spawnedAt: 60, alive: false, count: 2 },
      { name: 'boss', timeSpentAlive: 8, spawnedAt: 50, alive: true, count: 1 },
    ],
    lastDungeonFinishTime: 80, lastEncounterFinishTime: 95, firstEncounterFinishTime: 4,
    wipeEvents: [{ simulationTime: 70, logs: [], wave: 3, timestamp: 'x' }],
    labRoomOutcomes: [],
    zoneName: '/actions/combat/chimerical_den', difficultyTier: 0, isDungeon: true, numberOfPlayers: 1,
    bossSpawns: ['#50,boss'], isGuildTrial: false, trialHrid: null,
  };
}

function shardB() {
  return {
    simulatedTime: 50, encounters: 4, dungeonsCompleted: 1, dungeonsFailed: 0, dungeonsTimedOut: 0,
    labyAttemptCount: 0,
    deaths: { boss: 1, adds: 3 },
    experienceGained: { player1: { melee: 4, attack: 1 } },
    attacks: { player1: { boss: { '/abilities/a': { hit: 2 }, '/abilities/b': { crit: 1 } } } },
    consumablesUsed: {},
    hitpointsGained: {}, healingDone: {}, manapointsGained: {}, hitpointsSpent: {}, manaUsed: { player1: 3 },
    maxWaveReached: 50, maxEnrageStack: 3, maxDungenonTime: 35, minDungenonTime: 0,
    playerRanOutOfMana: { player1: true, player2: false },
    playerRanOutOfManaTime: { player1: { isOutOfMana: false, startTimeForOutOfMana: 0, totalTimeForOutOfMana: 2 } },
    timeSpentAlive: [
      { name: 'boss', timeSpentAlive: 6, spawnedAt: 30, alive: false, count: 1 },
      { name: '#1', timeSpentAlive: 10, spawnedAt: 5, alive: true, count: 1 },
      { name: 'adds', timeSpentAlive: 3, spawnedAt: 10, alive: false, count: 3 },
    ],
    lastDungeonFinishTime: 0, lastEncounterFinishTime: 45, firstEncounterFinishTime: 2,
    wipeEvents: [{ simulationTime: 20, logs: [], wave: 7, timestamp: 'y' }],
    labRoomOutcomes: [],
    zoneName: '/actions/combat/chimerical_den', difficultyTier: 0, isDungeon: true, numberOfPlayers: 1,
    bossSpawns: ['#50,boss'], isGuildTrial: false, trialHrid: null,
  };
}

test('mergeSimResults adds counts and trees, and takes extremes', () => {
  const m = mergeSimResults([shardA(), shardB()]);
  assert.equal(m.simulatedTime, 150);
  assert.equal(m.encounters, 14);
  assert.equal(m.dungeonsCompleted, 3);
  assert.equal(m.dungeonsFailed, 1);
  assert.equal(m.dungeonsTimedOut, 1);
  assert.deepEqual(m.deaths, { player1: 1, boss: 3, adds: 3 });
  assert.deepEqual(m.experienceGained, { player1: { melee: 14, stamina: 5, attack: 1 } });
  assert.deepEqual(m.attacks, { player1: { boss: { '/abilities/a': { hit: 5, miss: 1 }, '/abilities/b': { crit: 1 } } } });
  assert.deepEqual(m.consumablesUsed, { player1: { food: 2 } });
  assert.deepEqual(m.manaUsed, { player1: 10 });
  assert.equal(m.maxWaveReached, 50);
  assert.equal(m.maxEnrageStack, 3);
  assert.equal(m.maxDungenonTime, 40);
  assert.equal(m.minDungenonTime, 30);
  assert.deepEqual(m.playerRanOutOfMana, { player1: true, player2: true });
});

test('mergeSimResults closes an open out-of-mana spell at its shard end', () => {
  const m = mergeSimResults([shardA(), shardB()]);
  // A: 5 closed + (100 - 90) still open at its end; B: 2
  assert.deepEqual(m.playerRanOutOfManaTime.player1, { isOutOfMana: false, startTimeForOutOfMana: 0, totalTimeForOutOfMana: 17 });
});

test('mergeSimResults sums time alive by name and puts later shards on one clock', () => {
  const m = mergeSimResults([shardA(), shardB()]);
  assert.deepEqual(m.timeSpentAlive, [
    { name: '#1', timeSpentAlive: 30, spawnedAt: 105, alive: true, count: 3 },
    { name: 'boss', timeSpentAlive: 14, spawnedAt: 130, alive: false, count: 2 },
    { name: 'adds', timeSpentAlive: 3, spawnedAt: 110, alive: false, count: 3 },
  ]);
  assert.equal(m.lastDungeonFinishTime, 80); // B never finished one
  assert.equal(m.lastEncounterFinishTime, 145);
  assert.equal(m.firstEncounterFinishTime, 4);
  assert.deepEqual(m.wipeEvents.map((w) => [w.simulationTime, w.wave]), [[70, 3], [120, 7]]);
  assert.equal(m.zoneName, '/actions/combat/chimerical_den');
  assert.deepEqual(m.bossSpawns, ['#50,boss']);
});

test('mergeSimResults offsets labyrinth outcomes onto the clock', () => {
  const a = { simulatedTime: 10, labRoomOutcomes: [{ outcome: 'win', monsterHpPct: 0, time: 5, startTime: 1 }] };
  const b = { simulatedTime: 10, labRoomOutcomes: [{ outcome: 'timeout', monsterHpPct: 40, time: 8, startTime: 2 }] };
  const m = mergeSimResults([a, b]);
  assert.deepEqual(m.labRoomOutcomes.map((o) => [o.time, o.startTime]), [[5, 1], [18, 12]]);
});

test('mergeSimResults omits dungeonsTimedOut when no input has it', () => {
  const a = shardA(); const b = shardB();
  delete a.dungeonsTimedOut; delete b.dungeonsTimedOut;
  assert.equal('dungeonsTimedOut' in mergeSimResults([a, b]), false);
});

test('mergeSimResults hands a single result back unchanged and refuses none', () => {
  const a = shardA();
  assert.equal(mergeSimResults([a]), a);
  assert.throws(() => mergeSimResults([]));
});

test('mergeSimResults leaves the inputs untouched', () => {
  const a = shardA(); const b = shardB();
  const before = JSON.stringify([a, b]);
  mergeSimResults([a, b]);
  assert.equal(JSON.stringify([a, b]), before);
});

test('merged per-hour rates equal the rates of the concatenated totals', () => {
  const a = shardA(); const b = shardB();
  const m = mergeSimResults([a, b]);
  const t = a.simulatedTime + b.simulatedTime;
  assert.equal(m.dungeonsCompleted / m.simulatedTime, (a.dungeonsCompleted + b.dungeonsCompleted) / t);
  assert.equal(m.experienceGained.player1.melee / m.simulatedTime, (10 + 4) / t);
  assert.equal(m.deaths.boss / m.simulatedTime, (2 + 1) / t);
  const runs = (r) => r.dungeonsCompleted + r.dungeonsFailed;
  assert.equal(m.simulatedTime / runs(m), t / (runs(a) + runs(b)));
});

test('every merge rule names a known strategy', () => {
  const known = new Set(['sum', 'sumTree', 'max', 'minNonZero', 'or', 'outOfManaClosed', 'timeSpentAlive',
    'lastOnClock', 'firstOnClock', 'concatOnClock', 'first']);
  for (const [key, rule] of Object.entries(MERGE_RULES)) assert.ok(known.has(rule), `${key}: ${rule}`);
});

// -- running batches -------------------------------------------------------------

test('runDungeonRunsSerial runs the planned batches, reports progress, and merges', async () => {
  const sizes = [];
  const progress = [];
  const result = await runDungeonRunsSerial({
    totalRuns: 5,
    maxRunDurationNs: 40 * H,
    runBatch: async (n, i, onBatchProgress) => {
      sizes.push(n);
      onBatchProgress(0.5);
      onBatchProgress(1);
      return { simulatedTime: 10 * n, dungeonsCompleted: n, dungeonsFailed: 0, dungeonsTimedOut: 0, batch: i };
    },
    onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(sizes, planBatches(5, 40 * H));
  assert.equal(result.dungeonsCompleted, 5);
  assert.equal(result.simulatedTime, 50);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  assert.equal(progress.at(-1), 1);
});

test('workerBatchRunner drives a worker.js one start_simulation per batch', async () => {
  const posted = [];
  const worker = {
    postMessage(msg) {
      posted.push(msg);
      queueMicrotask(() => {
        this.onmessage({ data: { type: 'simulation_progress', progress: 0.5 } });
        this.onmessage({ data: { type: 'simulation_result', simResult: { simulatedTime: msg.maxRuns, dungeonsCompleted: msg.maxRuns, dungeonsFailed: 0 } } });
      });
    },
  };
  const seen = [];
  const run = workerBatchRunner(worker, { players: [1], zone: { zoneHrid: 'z' }, maxRunDurationNs: 3 * H });
  const r = await run(7, 0, (p) => seen.push(p));
  assert.deepEqual(posted, [{ type: 'start_simulation', players: [1], zone: { zoneHrid: 'z' }, maxRunDurationNs: 3 * H, maxRuns: 7 }]);
  assert.deepEqual(seen, [0.5]);
  assert.equal(r.dungeonsCompleted, 7);

  worker.postMessage = function () { queueMicrotask(() => this.onmessage({ data: { type: 'simulation_error', error: 'boom' } })); };
  await assert.rejects(run(1, 1, () => {}), /boom/);
});

// -- the idle between runs -------------------------------------------------------

const GAP = { completed: 3e9, failed: 3e9 };

/** One engine-shaped result per run, as a shard of one run would return it. */
function perRunResults() {
  const outcome = [true, true, false, true, false, false, true];
  return outcome.map((ok, i) => ({
    simulatedTime: 1000e9 + i * 17e9,
    dungeonsCompleted: ok ? 1 : 0,
    dungeonsFailed: ok ? 0 : 1,
    dungeonsTimedOut: ok ? 0 : 1,
    deaths: { boss: ok ? 1 : 0 },
    dungeonRunGapNs: GAP,
  }));
}

test('addRunIdleTime adds one gap per run, by outcome, and records it', () => {
  const r = addRunIdleTime({ simulatedTime: 100e9, dungeonsCompleted: 3, dungeonsFailed: 2, dungeonRunGapNs: { completed: 3e9, failed: 5e9 } });
  assert.equal(r.dungeonIdleTime, 3 * 3e9 + 2 * 5e9);
  assert.equal(r.simulatedTime, 100e9 + 3 * 3e9 + 2 * 5e9);
});

test('addRunIdleTime refuses to be applied twice, or to a result without the gap', () => {
  const r = addRunIdleTime({ simulatedTime: 10, dungeonsCompleted: 1, dungeonsFailed: 0, dungeonRunGapNs: GAP });
  assert.throws(() => addRunIdleTime(r), /already/);
  assert.throws(() => addRunIdleTime({ simulatedTime: 10, dungeonsCompleted: 1, dungeonsFailed: 0 }), TypeError);
});

test('mergeSimResults refuses a result that already carries the idle', () => {
  const [a, b] = perRunResults();
  assert.throws(() => mergeSimResults([addRunIdleTime(a), b]), /idle/);
});

test('the idle total does not depend on how the runs were split', () => {
  const runs = perRunResults();
  const split = (k) => {
    const shards = Array.from({ length: k }, () => []);
    runs.forEach((r, i) => shards[i % k].push(r));
    return addRunIdleTime(mergeSimResults(shards.map((s) => mergeSimResults(s))));
  };
  const one = split(1);
  assert.equal(one.dungeonIdleTime, runs.length * 3e9);
  assert.equal(one.simulatedTime, sum(runs.map((r) => r.simulatedTime)) + runs.length * 3e9);
  for (const k of [2, 4, 7]) {
    const m = split(k);
    assert.equal(m.simulatedTime, one.simulatedTime, `${k} shards`);
    assert.equal(m.dungeonIdleTime, one.dungeonIdleTime, `${k} shards`);
  }
});

test('runDungeonRunsSerial returns the raw merge: the idle is for the caller to add once', async () => {
  const r = await runDungeonRunsSerial({
    totalRuns: 5,
    maxRunDurationNs: 10 * H,
    runBatch: async (n) => ({ simulatedTime: n, dungeonsCompleted: n, dungeonsFailed: 0, dungeonRunGapNs: GAP }),
  });
  assert.equal('dungeonIdleTime' in r, false);
  assert.equal(r.simulatedTime, 5);
});
