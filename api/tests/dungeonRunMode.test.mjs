// =============================================================================
// dungeon run mode — the engine can stop a dungeon after N runs, and a run that
// outlasts its time limit fails.
//
// Run from api/:  npm test
//
// E1–E7 drive the engine (the twin) directly: one request with
// `runLimits: { maxRuns, maxRunDurationNs }`. E8–E11 go through
// api/lib/simulator.js, which splits runs into batches and merges them back with
// shared/dungeonRuns.js.
//
// F4–F6 check that nothing of run N+1 is simulated, and that the idle between
// runs is added once, outside the engine.
//
// All runs are seeded (lib/determinism.mjs), so every number asserted here is
// a fixed outcome, not a statistical one.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { withSeed } from '../lib/determinism.mjs';
import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';

import { getTwinBackend, runTwin, twinZoneRequest } from '../../shared/twinEngine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

const DEN = '/actions/combat/chimerical_den';
const ONE_HOUR = 3600e9;
const ONE_SECOND = 1e9;

function dtos(builds, level) {
  return builds.map((name, i) => toCsimPlayer(BUILDS[name], { level, index: i + 1, items, abilityData }));
}

/** One engine run's inputs; `onProgress` may be set before runSeeded. */
function makeSim(builds, level, zoneHrid = DEN) {
  return { players: dtos(builds, level), zone: { zoneHrid, difficultyTier: 0 }, onProgress: null };
}

const runSeeded = (seed, sim, limit, runLimits) =>
  withSeed(seed, () => runTwin(getTwinBackend(), twinZoneRequest({ players: sim.players, zone: sim.zone, simulationTimeLimit: limit, runLimits }), sim.onProgress));

// -- E1–E4: whole runs --------------------------------------------------------

test('E1 a strong solo stops after exactly N runs, none timed out', async () => {
  const r = await runSeeded(1, makeSim(['melee'], 600), undefined, { maxRuns: 3, maxRunDurationNs: 3 * ONE_HOUR });
  assert.equal(r.dungeonsCompleted + r.dungeonsFailed, 3);
  assert.equal(r.dungeonsTimedOut, 0);
  assert.ok(r.simulatedTime < 9 * ONE_HOUR, `simulatedTime ${r.simulatedTime}`);
});

test('E2 a run still going when its time runs out fails and is counted as timed out', async () => {
  const r = await runSeeded(1, makeSim(['melee'], 600), undefined, { maxRuns: 3, maxRunDurationNs: 60 * ONE_SECOND });
  assert.equal(r.dungeonsCompleted, 0);
  assert.equal(r.dungeonsFailed, 3);
  assert.equal(r.dungeonsTimedOut, 3);
  // each run: 60 s on the clock; the idle between runs is not simulated (F6)
  assert.equal(r.simulatedTime, 3 * 60 * ONE_SECOND);
});

test('E3 a party that wipes fails its runs without timing out', async () => {
  const r = await runSeeded(1, makeSim(['bare'], 10), undefined, { maxRuns: 4, maxRunDurationNs: 3 * ONE_HOUR });
  assert.equal(r.dungeonsFailed, 4);
  assert.equal(r.dungeonsCompleted, 0);
  assert.equal(r.dungeonsTimedOut, 0);
});

test('E4 the default hour-based path assigns no run-mode key', async () => {
  const r = await runSeeded(1, makeSim(['melee'], 600), 0.5 * ONE_HOUR);
  assert.equal('dungeonsTimedOut' in r, false);
});

// -- E6: bad limits are refused -----------------------------------------------

test('E6 run limits are refused outside a dungeon or when malformed', async () => {
  const good = { maxRuns: 2, maxRunDurationNs: ONE_HOUR };
  await assert.rejects(runSeeded(1, makeSim(['melee'], 600, '/actions/combat/aqua_planet'), undefined, good), RangeError);
  for (const bad of [
    { maxRuns: 0, maxRunDurationNs: ONE_HOUR },
    { maxRuns: 1.5, maxRunDurationNs: ONE_HOUR },
    { maxRuns: 2, maxRunDurationNs: 0 },
    { maxRuns: 2, maxRunDurationNs: NaN },
  ]) {
    await assert.rejects(runSeeded(1, makeSim(['melee'], 600), undefined, bad), RangeError, JSON.stringify(bad));
  }
});

// -- E7: progress --------------------------------------------------------------

test('E7 run-mode progress counts runs, stays in [0, 1] and never goes back', async () => {
  const sim = makeSim(['melee'], 600);
  const seen = [];
  sim.onProgress = (p) => seen.push(p);
  await runSeeded(2, sim, undefined, { maxRuns: 4, maxRunDurationNs: 3 * ONE_HOUR });
  assert.ok(seen.length > 0);
  for (let i = 0; i < seen.length; i++) {
    assert.ok(seen[i] >= 0 && seen[i] <= 1, `progress ${seen[i]}`);
    if (i > 0) assert.ok(seen[i] >= seen[i - 1], `progress went back at ${i}`);
  }
});

// -- E8–E11: through api/lib/simulator.js, batched and merged ------------------

const { runSimulation } = await import('../lib/simulator.js');
const { MERGE_RULES, mergeSimResults, addRunIdleTime } = await import('../../shared/dungeonRuns.js');
const { canonical, digest } = await import('../lib/determinism.mjs');
const { MIXED_PARTY } = await import('../bench/builds.mjs');

const apiRun = (seed, builds, level, runLimits, onProgress) =>
  withSeed(seed, () =>
    runSimulation(
      { players: dtos(builds, level), zone: { zoneHrid: DEN, difficultyTier: 0 }, extra: {}, ...runLimits },
      onProgress
    )
  );

test('audit3-j: runSimulation refuses a non-positive time limit or run duration', async () => {
  const players = dtos(MIXED_PARTY.slice(0, 1), 100);
  const zone = { zoneHrid: DEN, difficultyTier: 0 };
  for (const simulationTimeLimit of [0, -1, undefined, NaN]) {
    await assert.rejects(runSimulation({ players, zone, simulationTimeLimit }), RangeError, String(simulationTimeLimit));
  }
  for (const maxRunDurationNs of [0, -5]) {
    await assert.rejects(runSimulation({ players, zone, maxRuns: 1, maxRunDurationNs }), RangeError, String(maxRunDurationNs));
  }
  await assert.rejects(runSimulation({ players, zone, maxRuns: 0 }), RangeError);
});

test('E8 runSimulation runs long-limit runs in batches and reports progress to 1', async () => {
  const progress = [];
  const r = await apiRun(3, ['melee'], 600, { maxRuns: 5, maxRunDurationNs: 40 * ONE_HOUR }, (m) => {
    assert.equal(m.type, 'progress');
    progress.push(m.progress);
  });
  assert.equal(r.dungeonsCompleted + r.dungeonsFailed, 5);
  assert.equal(r.dungeonsTimedOut, 0);
  assert.ok(progress.length > 0);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  assert.equal(progress.at(-1), 1);
});

test('E9 a single batch through runSimulation is the engine run, bit for bit', async () => {
  const limits = { maxRuns: 3, maxRunDurationNs: 3 * ONE_HOUR };
  const direct = await runSeeded(4, makeSim(['melee'], 600), undefined, limits);
  const viaApi = await apiRun(4, ['melee'], 600, limits);
  // runSimulation adds the idle between runs once, on top of the engine's result
  assert.equal(digest(canonical(viaApi)), digest(canonical(addRunIdleTime(direct))));
});

test('E10 twenty runs in one call and as four merged shards agree on the rates', async () => {
  const limits = { maxRunDurationNs: 3 * ONE_HOUR };
  const whole = await apiRun(10, MIXED_PARTY, 600, { ...limits, maxRuns: 20 });
  // Shards are raw engine results, as multiWorker's are: the idle between runs
  // is added once, to the merged total.
  const shards = [];
  for (let i = 0; i < 4; i++) shards.push(await runSeeded(100 + i, makeSim(MIXED_PARTY, 600), undefined, { ...limits, maxRuns: 5 }));
  const merged = addRunIdleTime(mergeSimResults(shards));

  const runs = (r) => r.dungeonsCompleted + r.dungeonsFailed;
  assert.equal(runs(whole), 20);
  assert.equal(runs(merged), 20);
  const perHour = (r, v) => v / (r.simulatedTime / ONE_HOUR);
  const xp = (r) => Object.values(r.experienceGained).reduce((a, p) => a + Object.values(p).reduce((b, x) => b + x, 0), 0);
  const bossDeaths = (r) => Object.entries(r.deaths).filter(([k]) => !k.startsWith('player')).reduce((a, [, v]) => a + v, 0);
  // Measured under three seed sets: every ratio within 0.7%. 3% leaves room
  // for RNG without letting a per-batch cost (the old 10%) back in.
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.03 * Math.max(a, b), `${what}: ${a} vs ${b}`);
  near(whole.simulatedTime / runs(whole), merged.simulatedTime / runs(merged), 'average run time');
  near(perHour(whole, xp(whole)), perHour(merged, xp(merged)), 'XP/h');
  near(perHour(whole, bossDeaths(whole)), perHour(merged, bossDeaths(merged)), 'monster deaths/h');
  // Every run starts fresh, so a batch no longer pays for opening consumables
  // the whole would have carried over: per run, the two agree.
  const used = (r) => Object.values(r.consumablesUsed).reduce((a, p) => a + Object.values(p).reduce((b, x) => b + x, 0), 0);
  near(used(whole) / runs(whole), used(merged) / runs(merged), 'consumables per run');
});

test('E11 every key of a run-mode SimResult has a merge rule', async () => {
  const r = await runSeeded(5, makeSim(['melee'], 600), undefined, { maxRuns: 2, maxRunDurationNs: 3 * ONE_HOUR });
  const missing = Object.keys(r).filter((k) => !(k in MERGE_RULES));
  assert.deepEqual(missing, []);
});

// -- F4–F6: nothing of run N+1, and the idle between runs ----------------------

test('F4 nothing of run N+1 happens: no time after the last run', async () => {
  const r = await runSeeded(1, makeSim(['melee'], 600), undefined, { maxRuns: 3, maxRunDurationNs: 3 * ONE_HOUR });
  assert.equal(r.dungeonsCompleted, 3);
  assert.equal(r.timeSpentAlive.find((e) => e.name === '#1').count, 3);
  // the engine's clock stops at the last boss kill
  assert.equal(r.simulatedTime, r.lastDungeonFinishTime);
});

test('F5 the engine carries the idle-gap constants in run mode only', async () => {
  const r = await runSeeded(1, makeSim(['melee'], 600), undefined, { maxRuns: 1, maxRunDurationNs: 3 * ONE_HOUR });
  assert.ok(r.dungeonRunGapNs.completed > 0 && r.dungeonRunGapNs.failed > 0, JSON.stringify(r.dungeonRunGapNs));
  assert.equal('dungeonIdleTime' in r, false, 'the engine never adds the idle itself');
  const h = await runSeeded(1, makeSim(['melee'], 600), 0.1 * ONE_HOUR);
  assert.equal('dungeonRunGapNs' in h, false);
});

test('F6 timed-out runs: the engine clock is the runs alone, runSimulation adds one gap per run', async () => {
  const limits = { maxRuns: 3, maxRunDurationNs: 60 * ONE_SECOND };
  const engineOnly = await runSeeded(1, makeSim(['melee'], 600), undefined, limits);
  assert.equal(engineOnly.dungeonsTimedOut, 3);
  assert.equal(engineOnly.simulatedTime, 3 * 60 * ONE_SECOND);
  const viaApi = await apiRun(1, ['melee'], 600, limits);
  const gap = viaApi.dungeonRunGapNs.failed;
  assert.equal(viaApi.dungeonIdleTime, 3 * gap);
  assert.equal(viaApi.simulatedTime, 3 * (60 * ONE_SECOND + gap));
});

// -- Z1: planet zone "workers" ----------------------------------------------------

test('Z1 two planet runs merge into one result over their summed time, every key ruled', async () => {
  const PLANET = '/actions/combat/smelly_planet';
  const a = await runSeeded(11, makeSim(['melee'], 100, PLANET), ONE_HOUR);
  const b = await runSeeded(12, makeSim(['melee'], 100, PLANET), ONE_HOUR);
  for (const k of Object.keys(a)) assert.ok(k in MERGE_RULES, `planet result key ${k} has no merge rule`);
  const m = mergeSimResults([a, b]);
  assert.equal(m.simulatedTime, a.simulatedTime + b.simulatedTime);
  assert.equal(m.encounters, a.encounters + b.encounters);
  const xp = (r) => r.experienceGained.player1.melee;
  assert.ok(a.encounters > 0 && xp(a) > 0 && xp(b) > 0, 'both runs fought');
  assert.equal(xp(m) / m.simulatedTime, (xp(a) + xp(b)) / (a.simulatedTime + b.simulatedTime));
  assert.equal(m.dungeonIdleTime, undefined);
});
