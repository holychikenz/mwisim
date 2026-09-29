// =============================================================================
// dungeon run mode — the engine can stop a dungeon after N runs, and a run that
// outlasts its time limit fails.
//
// Run from api/:  npm test
//
// E1–E7 drive the engine directly: `simulate(limit, { maxRuns, maxRunDurationNs })`.
// E8–E11 go through api/lib/simulator.js, which splits runs into batches and
// merges them back with shared/dungeonRuns.js.
//
// F1–F6 check that every run starts from the t = 0 state, that nothing of run
// N+1 is simulated, and that the idle between runs is added once, outside the
// engine.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src', 'combatsimulator');

const CombatSimulator = (await import(join(SRC, 'combatSimulator.js'))).default;
const Player = (await import(join(SRC, 'player.js'))).default;
const Zone = (await import(join(SRC, 'zone.js'))).default;
const CombatStartEvent = (await import(join(SRC, 'events', 'combatStartEvent.js'))).default;
const EnemyRespawnEvent = (await import(join(SRC, 'events', 'enemyRespawnEvent.js'))).default;
const DungeonRunTimeoutEvent = (await import(join(SRC, 'events', 'dungeonRunTimeoutEvent.js'))).default;

const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;

const DEN = '/actions/combat/chimerical_den';
const ONE_HOUR = 3600e9;
const ONE_SECOND = 1e9;

function dtos(builds, level) {
  return builds.map((name, i) => toCsimPlayer(BUILDS[name], { level, index: i + 1, items, abilityData }));
}

function makeSim(builds, level, zoneHrid = DEN) {
  const zone = new Zone(zoneHrid, 0);
  const players = dtos(builds, level).map((dto) => {
    const p = Player.createFromDTO(structuredClone(dto));
    p.zoneBuffs = zone.buffs;
    p.extraBuffs = [];
    return p;
  });
  return new CombatSimulator(players, zone, null, {});
}

async function quietly(fn) {
  const real = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = real;
  }
}

const runSeeded = (seed, sim, limit, runLimits) => withSeed(seed, () => quietly(() => sim.simulate(limit, runLimits)));

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

// -- E5: the timeout handler's guards -----------------------------------------

function armed() {
  const sim = makeSim(['melee'], 600);
  sim.reset();
  sim._beginRunMode({ maxRuns: 5, maxRunDurationNs: 60 * ONE_SECOND }, undefined);
  sim.simulationTime = 100 * ONE_SECOND;
  sim.dungeonRunStartTime = 40 * ONE_SECOND;
  sim.allPlayersDead = false;
  sim.enemies = [{}];
  sim.zone.encountersKilled = 2;
  return sim;
}
const timeout = (runStart = 40 * ONE_SECOND) => new DungeonRunTimeoutEvent(100 * ONE_SECOND, runStart);
const queued = (sim, type) => sim.eventQueue.getMatching((e) => e.type === type);

test('E5a a timeout after the boss died, before the next run is booked, is ignored', () => {
  const sim = armed();
  sim.enemies = null;
  sim.zone.encountersKilled = sim.zone.dungeonSpawnInfo.maxWaves + 1;
  sim.processDungeonRunTimeoutEvent(timeout());
  assert.equal(queued(sim, CombatStartEvent.type), null);
  assert.equal(sim.allPlayersDead, false);
  assert.equal(sim.dungeonsTimedOut, 0);
});

test('E5b a timeout left over from an earlier run is ignored', () => {
  const sim = armed();
  sim.processDungeonRunTimeoutEvent(timeout(5 * ONE_SECOND));
  assert.equal(queued(sim, CombatStartEvent.type), null);
  assert.equal(sim.dungeonsTimedOut, 0);
});

test('E5c a timeout after the party already wiped is ignored', () => {
  const sim = armed();
  sim.allPlayersDead = true;
  sim.processDungeonRunTimeoutEvent(timeout());
  assert.equal(queued(sim, CombatStartEvent.type), null);
  assert.equal(sim.dungeonsTimedOut, 0);
});

test('E5d a live run that times out fails, and the next run starts at once', () => {
  const sim = armed();
  sim.eventQueue.addEvent(new EnemyRespawnEvent(sim.simulationTime + 3 * ONE_SECOND));
  sim.processDungeonRunTimeoutEvent(timeout());
  const start = queued(sim, CombatStartEvent.type);
  assert.ok(start, 'a CombatStartEvent is booked');
  assert.equal(start.time, 100 * ONE_SECOND);
  assert.equal(sim.zone.dungeonsFailed, 1);
  assert.equal(sim.zone.encountersKilled, 1);
  assert.equal(sim.allPlayersDead, false);
  assert.equal(sim.enemies, null);
  assert.equal(sim.dungeonsTimedOut, 1);
  assert.equal(queued(sim, EnemyRespawnEvent.type), null);
});

test('E5e the timeout that ends run N stops the loop and books nothing more', () => {
  const sim = armed();
  sim.zone.dungeonsFailed = 4; // maxRuns is 5
  sim.processDungeonRunTimeoutEvent(timeout());
  assert.equal(sim.zone.dungeonsFailed, 5);
  assert.equal(sim.trialEnded, true);
  assert.equal(queued(sim, CombatStartEvent.type), null);
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
  sim.addEventListener('progress', (e) => seen.push(e.detail.progress));
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
    quietly(() =>
      runSimulation(
        { players: dtos(builds, level), zone: { zoneHrid: DEN, difficultyTier: 0 }, extra: {}, ...runLimits },
        onProgress
      )
    )
  );

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

// -- F1–F4: every run starts fresh, and the stop check comes first ------------
//
// A run's start is the moment its first wave spawns (Zone.getNextWave hands
// out wave #1). At that moment — before checkTriggers or any attack — every
// player must look exactly as at t = 0, and the queue must hold only what the
// t = 0 CombatStartEvent leaves behind, at the same offsets.

function unitSnapshot(u) {
  return {
    hp: u.combatDetails.currentHitpoints,
    mp: u.combatDetails.currentManapoints,
    combatDetails: JSON.stringify(u.combatDetails),
    buffInstances: Object.keys(u.buffInstances).sort(),
    combatBuffs: JSON.stringify(Object.entries(u.combatBuffs).sort(([a], [b]) => (a < b ? -1 : 1))),
    permanentBuffs: JSON.stringify(u.permanentBuffs),
    food: u.food.map((f) => f?.lastUsed ?? null),
    drinks: u.drinks.map((d) => d?.lastUsed ?? null),
    abilities: u.abilities.map((a) => a?.lastUsed ?? null),
    cc: [u.isStunned, u.isSilenced, u.isBlinded],
    parked: u.isOutOfMana,
  };
}

/** Record players and queue at each run start, wave-1 spawns, and consumable-use times. */
function instrument(sim) {
  const starts = [];
  const uses = [];
  const zone = sim.zone;
  const nextWave = zone.getNextWave.bind(zone);
  zone.getNextWave = () => {
    const wave = nextWave();
    if (zone.encountersKilled - 1 === 1) {
      const now = sim.simulationTime;
      starts.push({
        time: now,
        players: sim.players.map(unitSnapshot),
        queue: sim.eventQueue.minHeap.heapArray.map((e) => `${e.type}@${e.time - now}`).sort(),
      });
    }
    return wave;
  };
  const reset = sim.reset.bind(sim);
  sim.reset = () => {
    reset();
    const sr = sim.simResult;
    const add = sr.addConsumableUse.bind(sr);
    sr.addConsumableUse = (unit, consumable) => {
      uses.push(sim.simulationTime);
      return add(unit, consumable);
    };
  };
  return { starts, uses };
}

function assertFreshStarts(starts, n) {
  assert.equal(starts.length, n, 'one wave-1 spawn per run, none for run N+1');
  assert.equal(starts[0].time, 0);
  for (let i = 1; i < starts.length; i++) {
    assert.deepEqual(starts[i].players, starts[0].players, `run ${i + 1} players start as at t = 0`);
    assert.deepEqual(starts[i].queue, starts[0].queue, `run ${i + 1} queue starts as at t = 0`);
  }
}

test('F1 runs that complete each start from the t = 0 state', async () => {
  const sim = makeSim(['melee'], 600);
  const { starts, uses } = instrument(sim);
  const r = await runSeeded(1, sim, undefined, { maxRuns: 3, maxRunDurationNs: 3 * ONE_HOUR });
  assert.equal(r.dungeonsCompleted, 3);
  assertFreshStarts(starts, 3);
  assert.ok(uses.length > 0, 'the build does drink its coffees');
});

test('F2 runs that time out each start from the t = 0 state', async () => {
  const sim = makeSim(MIXED_PARTY, 600);
  const { starts } = instrument(sim);
  const r = await runSeeded(2, sim, undefined, { maxRuns: 3, maxRunDurationNs: 90 * ONE_SECOND });
  assert.equal(r.dungeonsTimedOut, 3);
  assertFreshStarts(starts, 3);
});

test('F3 runs that wipe each start from the t = 0 state', async () => {
  const sim = makeSim(['bare'], 10);
  const { starts } = instrument(sim);
  const r = await runSeeded(1, sim, undefined, { maxRuns: 4, maxRunDurationNs: 3 * ONE_HOUR });
  assert.equal(r.dungeonsFailed, 4);
  assertFreshStarts(starts, 4);
});

test('F4 nothing of run N+1 happens: no wave, no consumable, no time', async () => {
  const sim = makeSim(['melee'], 600);
  const { starts, uses } = instrument(sim);
  const r = await runSeeded(1, sim, undefined, { maxRuns: 3, maxRunDurationNs: 3 * ONE_HOUR });
  assert.equal(r.dungeonsCompleted, 3);
  assert.equal(starts.length, 3);
  assert.equal(r.timeSpentAlive.find((e) => e.name === '#1').count, 3);
  // the engine's clock stops at the last boss kill
  assert.equal(r.simulatedTime, r.lastDungeonFinishTime);
  for (const t of uses) assert.ok(t <= r.lastDungeonFinishTime, `consumable used at ${t} after the last run ended`);
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
