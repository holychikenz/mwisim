// =============================================================================
// pool — a worker_threads pool for candidate simulations
//
// The peer fork calibrates its browser worker count by benchmarking 1/2/4/8/12/16
// and keeping the largest that still buys 8% throughput, cached in localStorage
// for 72 hours (TRIGGER-OPTIMIZER.md §7). That elaborate dance exists because a
// browser cannot see the machine's core count reliably and cannot measure it
// cheaply. Node can just ask os.availableParallelism(), so it does.
//
// One worker is left free. The Express event loop has to stay responsive enough
// to keep flushing SSE frames while the pool saturates the rest of the machine;
// a pool that takes every core makes progress reporting stutter, which reads to
// the user as a hang.
// =============================================================================

import { Worker } from 'worker_threads';
import { availableParallelism, cpus } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'poolWorker.js');

/** Never spawn more than this, whatever the machine claims. */
export const MAX_WORKERS = 16;

/**
 * Default pool size: cores minus one, clamped to [1, MAX_WORKERS].
 *
 * @returns {number}
 */
export function defaultPoolSize() {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length || 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

class SimulationPool {
  constructor(size) {
    this.size = Math.max(1, Math.min(MAX_WORKERS, Math.floor(size) || 1));
    this.workers = [];
    this.idle = [];
    this.destroyed = false;
    this.queue = [];
    // id -> { resolve, worker }. One entry per in-flight job.
    this.pending = new Map();
  }

  /** Spawn the workers and wait for each to report ready. */
  async start() {
    const spawns = [];
    for (let i = 0; i < this.size; i += 1) spawns.push(this.#spawn());
    await Promise.all(spawns);
  }

  #spawn() {
    return new Promise((resolve, reject) => {
      // execArgv is inherited, so the worker gets --import ./register-loader.js
      // and can resolve the engine's extensionless and JSON imports. cwd is
      // inherited too, which register-loader.js depends on.
      //
      // stdout/stderr: true means "expose as a stream on the Worker" rather than
      // "pipe into the parent's". The engine console.logs on notable events —
      // wipes, dungeon failures — and a single optimisation run is hundreds of
      // simulations, so leaving the default would bury the API server's own log
      // under thousands of lines. We never read these streams; the point is that
      // nothing is forwarded. Worker errors still arrive via the 'error' event.
      const worker = new Worker(WORKER_PATH, { stdout: true, stderr: true });
      let ready = false;

      worker.on('message', (message) => {
        if (message?.type === 'ready') {
          ready = true;
          this.workers.push(worker);
          this.idle.push(worker);
          resolve(worker);
          return;
        }
        if (message?.type === 'result') {
          const entry = this.pending.get(message.id);
          this.pending.delete(message.id);
          this.idle.push(worker);
          entry?.resolve(
            message.error
              ? { id: message.id, error: message.error }
              : { id: message.id, metrics: message.metrics }
          );
          this.#drain();
        }
      });

      worker.on('error', (error) => {
        if (!ready) {
          reject(error);
          return;
        }
        // A worker that dies takes its in-flight job with it. Fail that one job
        // rather than the whole run, drop the worker, and carry on shorthanded.
        this.workers = this.workers.filter((w) => w !== worker);
        this.idle = this.idle.filter((w) => w !== worker);
        for (const [id, entry] of this.pending.entries()) {
          if (entry.worker !== worker) continue;
          this.pending.delete(id);
          entry.resolve({ id, error: error?.message || 'worker died' });
        }
        this.#drain();
      });

      worker.on('exit', () => {
        this.workers = this.workers.filter((w) => w !== worker);
        this.idle = this.idle.filter((w) => w !== worker);
      });
    });
  }

  #drain() {
    while (this.queue.length && this.idle.length) {
      const worker = this.idle.pop();
      const task = this.queue.shift();
      this.pending.set(task.job.id, { resolve: task.resolve, worker });
      worker.postMessage({ type: 'run', job: task.job });
    }
  }

  /**
   * Run a batch of jobs, resolving when every one has finished.
   *
   * @param {object[]} jobs  `{ id, playersData, zoneConfig, extraBuffs, simulationTimeLimit, seed }`
   * @param {object} [opts]
   * @param {(done: number, total: number) => void} [opts.onJobDone]
   * @returns {Promise<object[]>} `{ id, metrics }` or `{ id, error }` per job
   */
  async run(jobs, { onJobDone = null } = {}) {
    if (this.destroyed) throw new Error('pool has been destroyed');
    if (!jobs.length) return [];

    let done = 0;

    const results = jobs.map(
      (job) =>
        new Promise((resolve) => {
          this.queue.push({
            job,
            resolve: (value) => {
              done += 1;
              onJobDone?.(done, jobs.length);
              resolve(value);
            },
          });
        })
    );

    this.#drain();
    return Promise.all(results);
  }

  /** Terminate every worker. Safe to call twice. */
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue = [];
    // Resolve anything still outstanding so callers awaiting run() do not hang.
    for (const [id, entry] of this.pending.entries()) {
      entry.resolve({ id, error: 'pool destroyed' });
    }
    this.pending.clear();
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
    this.idle = [];
  }
}

/**
 * Create and start a pool.
 *
 * @param {object} [opts]
 * @param {number} [opts.size]
 * @returns {Promise<SimulationPool>}
 */
export async function createSimulationPool({ size = defaultPoolSize() } = {}) {
  const pool = new SimulationPool(size);
  await pool.start();
  return pool;
}

/**
 * Build the `evaluate` function search.js expects, backed by a pool.
 *
 * search.js hands us `{ id, playerDTOs, simulationTimeLimit, seed }`; the worker
 * wants `playersData` plus the run-wide zone and buffs. Bridging here keeps
 * search.js free of any worker vocabulary, so it can be unit-tested against a
 * synthetic evaluator.
 *
 * @param {object} args
 * @param {SimulationPool} args.pool
 * @param {{zoneHrid: string, difficultyTier?: number}} args.zoneConfig
 * @param {object[]} [args.extraBuffs]
 * @param {(info: object) => void} [args.onJobDone]
 * @param {AbortSignal} [args.signal]
 * @returns {(jobs: object[], meta: object) => Promise<object[]>}
 */
export function makePoolEvaluator({
  pool,
  zoneConfig,
  extraBuffs = [],
  consumableCosts = null,
  onJobDone = null,
  signal = null,
}) {
  return async function evaluate(jobs, meta) {
    if (signal?.aborted) {
      const error = new Error('Trigger optimisation cancelled');
      error.name = 'AbortError';
      throw error;
    }

    const poolJobs = jobs.map((job) => ({
      id: job.id,
      playersData: job.playerDTOs,
      zoneConfig,
      extraBuffs,
      consumableCosts,
      simulationTimeLimit: job.simulationTimeLimit,
      seed: job.seed,
    }));

    return pool.run(poolJobs, {
      onJobDone: onJobDone ? (done, total) => onJobDone({ done, total, ...meta }) : null,
    });
  };
}
