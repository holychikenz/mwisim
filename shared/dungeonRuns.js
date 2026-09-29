// =============================================================================
// dungeonRuns — simulate a dungeon as a number of runs, split across workers
// and batches, and merge the pieces back into one SimResult
//
// Shared by csim's two products:
//
//   src/multiWorker.js       — the browser: one shard per core, each a nested worker
//   api/lib/simulator.js     — Node, the API and tests: batches on the main thread
//
// The engine side is simulate(limit, { maxRuns, maxRunDurationNs }) — see
// CombatSimulator._beginRunMode. The engine never imports this file: MWIX
// vendors only src/combatsimulator/ (MWIX-RELATIONSHIP.md), and batching is not
// the engine's business. A batch is just one more simulate() on a fresh Zone.
//
// SHARDS AND BATCHES. A shard is the runs one worker owns (planShards). Within
// a shard, runs go in batches (planBatches) so no single simulate() is asked
// for more than BATCH_BUDGET_HOURS of worst-case simulated time; long run
// limits therefore mean smaller batches, not bigger simulations.
//
// RNG. Each browser worker is its own realm with its own Math.random. In Node,
// sequential batches share the main thread's one stream, so a seeded caller
// (lib/determinism.mjs withSeed) gets a reproducible whole. Tests that compare
// a sharded result against an unsharded one seed each shard distinctly.
//
// MERGE RULE. Shards are laid end to end on one clock: shard i starts where
// shard i-1's simulatedTime ended. Counts add, so every per-hour rate a reader
// computes by dividing by simulatedTime is the rate of the concatenated whole.
// Timestamps are offset onto that clock. Per-key rules are in MERGE_RULES.
//
// IDLE BETWEEN RUNS. The engine does not simulate the few seconds between one
// run and the next: every run starts from a full reset, so the gap changes
// nothing but the clock. A run-mode result carries the engine's gap constants
// (dungeonRunGapNs), and addRunIdleTime() adds the idle ONCE, to the final
// merged total, at each top-level entry point: api/lib/simulator.js
// runSimulation, src/multiWorker.js's final merge, and useSimulation's serial
// fallback. Shards and batches stay raw; mergeSimResults refuses an input that
// already has it.
// =============================================================================

export const ONE_HOUR_NS = 3600e9;
export const DEFAULT_MAX_RUN_HOURS = 3;
export const DEFAULT_DUNGEON_RUNS = 100;
export const MAX_DUNGEON_RUNS = 10000;
export const MIN_RUN_HOURS = 1;
export const MAX_RUN_HOURS = 10;
export const MIN_RUNS_PER_SHARD = 10;
export const MAX_SHARDS = 16;
export const DEFAULT_CONCURRENCY = 4;
export const BATCH_BUDGET_HOURS = 100;

function assertRunCount(totalRuns) {
  if (!Number.isInteger(totalRuns) || totalRuns < 1) {
    throw new RangeError(`dungeon runs must be a positive integer (got ${totalRuns})`);
  }
}

/** `total` split into `count` near-equal integers, larger first. */
function evenSplit(total, count) {
  const base = Math.floor(total / count);
  const extra = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Runs per worker: at most one shard per core, MAX_SHARDS, or one per MIN_RUNS_PER_SHARD runs. */
export function planShards(totalRuns, concurrency) {
  assertRunCount(totalRuns);
  const count = Math.max(
    1,
    Math.min(concurrency || DEFAULT_CONCURRENCY, MAX_SHARDS, Math.ceil(totalRuns / MIN_RUNS_PER_SHARD), totalRuns)
  );
  return evenSplit(totalRuns, count);
}

/** Runs per simulate() call within one shard, keeping each within BATCH_BUDGET_HOURS. */
export function planBatches(totalRuns, maxRunDurationNs) {
  assertRunCount(totalRuns);
  const perBatch = Math.max(1, Math.floor(BATCH_BUDGET_HOURS / (maxRunDurationNs / ONE_HOUR_NS)));
  return evenSplit(totalRuns, Math.ceil(totalRuns / perBatch));
}

/**
 * A request body's { maxRuns, maxRunHours } as engine run limits, or null when
 * the request is hour-based (no maxRuns). Throws RangeError on bad input.
 */
export function normaliseRunLimits({ maxRuns, maxRunHours } = {}) {
  if (maxRuns == null) return null;
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_DUNGEON_RUNS) {
    throw new RangeError(`maxRuns must be an integer from 1 to ${MAX_DUNGEON_RUNS} (got ${maxRuns})`);
  }
  const hours = maxRunHours ?? DEFAULT_MAX_RUN_HOURS;
  if (typeof hours !== 'number' || !(hours >= MIN_RUN_HOURS && hours <= MAX_RUN_HOURS)) {
    throw new RangeError(`maxRunHours must be from ${MIN_RUN_HOURS} to ${MAX_RUN_HOURS} (got ${maxRunHours})`);
  }
  return { maxRuns, maxRunDurationNs: hours * ONE_HOUR_NS };
}

// ---- merging -------------------------------------------------------------------

const TRIAL_KEYS = [
  'isGuildTrial', 'trialHrid', 'trialStartTier', 'trialParticipantCount', 'trialTiersCleared',
  'trialMaxTierCleared', 'trialCurrentTier', 'trialEndReason', 'trialEndTime',
  'trialFinalTierHpRemovedFrac', 'trialTierTimes', 'trialTierStartTimes', 'trialPlayerDeaths',
];

/** How each SimResult key combines across shards. A key not listed takes the first shard's value. */
export const MERGE_RULES = {
  simulatedTime: 'sum', encounters: 'sum', dungeonsCompleted: 'sum', dungeonsFailed: 'sum',
  dungeonsTimedOut: 'sum', labyAttemptCount: 'sum',
  deaths: 'sumTree', experienceGained: 'sumTree', attacks: 'sumTree', consumablesUsed: 'sumTree',
  hitpointsGained: 'sumTree', healingDone: 'sumTree', manapointsGained: 'sumTree',
  hitpointsSpent: 'sumTree', manaUsed: 'sumTree',
  maxWaveReached: 'max', maxEnrageStack: 'max', maxDungenonTime: 'max',
  minDungenonTime: 'minNonZero',
  playerRanOutOfMana: 'or',
  playerRanOutOfManaTime: 'outOfManaClosed',
  timeSpentAlive: 'timeSpentAlive',
  lastDungeonFinishTime: 'lastOnClock', lastEncounterFinishTime: 'lastOnClock',
  firstEncounterFinishTime: 'firstOnClock',
  wipeEvents: 'concatOnClock', labRoomOutcomes: 'concatOnClock',
  dungeonRunGapNs: 'first',
  zoneName: 'first', difficultyTier: 'first', labyrinthName: 'first', roomLevel: 'first',
  isDungeon: 'first', isLabyrinth: 'first', numberOfPlayers: 'first', dropRateMultiplier: 'first',
  rareFindMultiplier: 'first', combatDropQuantity: 'first', debuffOnLevelGap: 'first',
  bossSpawns: 'first', playerStats: 'first', monsterStats: 'first', timeSeriesData: 'first',
  ...Object.fromEntries(TRIAL_KEYS.map((k) => [k, 'first'])),
};

function sumTree(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return (a || 0) + (b || 0);
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = sumTree(out[k], v);
  return out;
}

/** Each timed entry of every shard, moved onto the one clock. */
const ON_CLOCK_FIELDS = { wipeEvents: ['simulationTime'], labRoomOutcomes: ['time', 'startTime'] };

const STRATEGIES = {
  sum: (vals) => vals.reduce((a, v) => a + (v || 0), 0),
  sumTree: (vals) => vals.reduce((a, v) => sumTree(a, v), {}),
  max: (vals) => Math.max(...vals.map((v) => v || 0)),
  minNonZero: (vals) => {
    const nz = vals.filter((v) => v > 0);
    return nz.length ? Math.min(...nz) : 0;
  },
  or: (vals) => {
    const out = {};
    for (const v of vals) for (const [k, flag] of Object.entries(v || {})) out[k] = !!out[k] || !!flag;
    return out;
  },
  // A spell still open at a shard's end is closed there: the next shard is a
  // fresh simulation that starts with full mana.
  outOfManaClosed: (vals, results) => {
    const out = {};
    vals.forEach((v, i) => {
      for (const [hrid, m] of Object.entries(v || {})) {
        const open = m.isOutOfMana ? results[i].simulatedTime - m.startTimeForOutOfMana : 0;
        const prior = out[hrid]?.totalTimeForOutOfMana || 0;
        out[hrid] = { isOutOfMana: false, startTimeForOutOfMana: 0, totalTimeForOutOfMana: prior + m.totalTimeForOutOfMana + open };
      }
    });
    return out;
  },
  timeSpentAlive: (vals, results, offsets) => {
    const byName = new Map();
    vals.forEach((list, i) => {
      for (const e of list || []) {
        const prev = byName.get(e.name);
        byName.set(e.name, {
          name: e.name,
          timeSpentAlive: (prev?.timeSpentAlive || 0) + e.timeSpentAlive,
          spawnedAt: e.spawnedAt + offsets[i],
          alive: e.alive,
          count: (prev?.count || 0) + e.count,
        });
      }
    });
    return [...byName.values()];
  },
  lastOnClock: (vals, results, offsets) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] > 0) return vals[i] + offsets[i];
    return 0;
  },
  firstOnClock: (vals, results, offsets) => {
    for (let i = 0; i < vals.length; i++) if (vals[i] > 0) return vals[i] + offsets[i];
    return 0;
  },
  concatOnClock: (vals, results, offsets, key) =>
    vals.flatMap((list, i) =>
      (list || []).map((e) => {
        const moved = { ...e };
        for (const f of ON_CLOCK_FIELDS[key]) moved[f] = e[f] + offsets[i];
        return moved;
      })
    ),
  first: (vals) => vals[0],
};

/**
 * Merge shard SimResults into one, laid end to end on one clock. A single
 * result is returned as is (by identity). Inputs are not mutated.
 */
export function mergeSimResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('mergeSimResults: nothing to merge');
  }
  if (results.some((r) => r.dungeonIdleTime != null)) {
    throw new Error('mergeSimResults: an input already carries the idle between runs; add it once, after the last merge');
  }
  if (results.length === 1) return results[0];

  const offsets = [];
  let clock = 0;
  for (const r of results) {
    offsets.push(clock);
    clock += r.simulatedTime || 0;
  }

  const keys = [];
  for (const r of results) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);

  const merged = {};
  for (const key of keys) {
    const present = results.filter((r) => key in r);
    const strategy = STRATEGIES[MERGE_RULES[key] || 'first'];
    // A key only some shards carry (dungeonsTimedOut on a mix) merges over the
    // shards that have it; offsets stay those of the full sequence.
    const idx = results.map((r, i) => (key in r ? i : -1)).filter((i) => i >= 0);
    merged[key] = strategy(
      present.map((r) => r[key]),
      present,
      idx.map((i) => offsets[i]),
      key
    );
  }
  return merged;
}

/**
 * Add the idle between runs to a merged run-mode result, once. Sets
 * `dungeonIdleTime` and adds it to `simulatedTime`; returns the same object.
 *
 * Why N gaps, not N - 1: a run is followed by its gap whether or not another
 * run comes after it. The old single-simulation model stopped only at the
 * start of run N + 1, so its simulatedTime already held a gap after every run,
 * the last included; and in hours mode the steady-state cycle is one run plus
 * one gap, so N / (sum of run times + N gaps) is the true long-run throughput.
 * N is completed + failed (= maxRuns); each outcome takes its own gap
 * (dungeonRunGapNs.completed after a boss kill, .failed after a wipe or a
 * timeout), since the engine uses a different delay constant for each.
 *
 * Throws if applied twice, or to a result that is not from run mode.
 */
export function addRunIdleTime(result) {
  if (result.dungeonIdleTime != null) {
    throw new Error('addRunIdleTime: the idle between runs is already added');
  }
  const gap = result.dungeonRunGapNs;
  if (!gap || !Number.isFinite(gap.completed) || !Number.isFinite(gap.failed)) {
    throw new TypeError('addRunIdleTime: not a run-mode result (no dungeonRunGapNs)');
  }
  const idle = (result.dungeonsCompleted || 0) * gap.completed + (result.dungeonsFailed || 0) * gap.failed;
  result.dungeonIdleTime = idle;
  result.simulatedTime += idle;
  return result;
}

/**
 * Run `totalRuns` as planBatches() batches, one after another, and merge.
 * The merge is raw: the caller adds the idle between runs (addRunIdleTime)
 * once, to its final total.
 *
 * runBatch(n, batchIndex, onBatchProgress) => Promise<SimResult> runs n runs on
 * a fresh Zone and calls onBatchProgress(p) with p in [0, 1]. onProgress, if
 * given, receives the overall fraction, never decreasing, ending at 1.
 */
export async function runDungeonRunsSerial({ totalRuns, maxRunDurationNs, runBatch, onProgress }) {
  const batches = planBatches(totalRuns, maxRunDurationNs);
  const results = [];
  let done = 0;
  let last = 0;
  const report = (p) => {
    if (!onProgress) return;
    last = Math.max(last, Math.min(p, 1));
    onProgress(last);
  };
  for (let i = 0; i < batches.length; i++) {
    const n = batches[i];
    results.push(await runBatch(n, i, (p) => report((done + p * n) / totalRuns)));
    done += n;
    report(done / totalRuns);
  }
  return mergeSimResults(results);
}

/**
 * A runBatch for runDungeonRunsSerial that runs each batch on `worker` (a
 * src/worker.js Worker, or anything with postMessage/onmessage) as one
 * `start_simulation` message with `maxRuns: n`. Batches go one at a time, so
 * a single worker serves the whole shard. `message` carries the rest of the
 * start_simulation payload (players, zone, extra, guildBuffs, maxRunDurationNs).
 */
export function workerBatchRunner(worker, message) {
  return (n, batchIndex, onBatchProgress) =>
    new Promise((resolve, reject) => {
      const fail = (raw) => reject(raw instanceof Error ? raw : new Error(String(raw?.message || raw || 'Simulation failed')));
      worker.onmessage = ({ data }) => {
        if (data.type === 'simulation_progress') onBatchProgress(data.progress);
        else if (data.type === 'simulation_result') resolve(data.simResult);
        else if (data.type === 'simulation_error') fail(data.error);
      };
      worker.onerror = (e) => {
        e?.preventDefault?.();
        fail(e?.message || 'Simulation worker crashed');
      };
      worker.postMessage({ ...message, type: 'start_simulation', maxRuns: n });
    });
}
