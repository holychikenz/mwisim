// =============================================================================
// poolCore — the portable half of the optimiser pool: the job queue over any
// workers, the cancellation error, the worker cap, and the `evaluate` bridge
// search.js and scan.js are written against. pool.js spawns worker_threads;
// the browser (ui/src/workers/browserPool.js) spawns Web Workers running the
// same jobs (runJob.js).
// =============================================================================

/** A cancelled optimiser run; runPlanned (optimizerTool.js) answers it as 'cancelled'. */
export class AbortError extends Error {
  constructor(message = 'Trigger optimisation cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Never spawn more than this, whatever the machine claims. */
export const MAX_WORKERS = 16;

/** `workers` clamped to [1, MAX_WORKERS]; `fallback` when absent or not a number. */
export function clampPoolSize(workers, fallback) {
  return Math.min(MAX_WORKERS, Math.max(1, Math.floor(Number(workers)) || fallback));
}

class SimulationPool {
  /** `spawn()` returns a worker with worker_threads' surface: on('message'|'error'|'exit'), postMessage, terminate. */
  constructor(size, spawn) {
    this.size = Math.max(1, Math.min(MAX_WORKERS, Math.floor(size) || 1));
    this.spawnWorker = spawn;
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
      const worker = this.spawnWorker();
      let ready = false;

      worker.on('message', (message) => {
        if (message?.type === 'ready') {
          ready = true;
          // A sibling failed to start and the pool was torn down meanwhile.
          if (this.destroyed) {
            worker.terminate();
            resolve(worker);
            return;
          }
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
        // Its own in-flight job dies with it, error event or not.
        for (const [id, entry] of this.pending.entries()) {
          if (entry.worker !== worker) continue;
          this.pending.delete(id);
          entry.resolve({ id, error: 'worker exited' });
        }
        // No worker left to take the queue: fail it rather than hang run().
        if (ready && this.workers.length === 0) this.#failAll('no workers left');
      });
    });
  }

  /** Resolve every queued and in-flight job with `{ id, error }`. */
  #failAll(error) {
    const queued = this.queue;
    this.queue = [];
    for (const task of queued) task.resolve({ id: task.job.id, error });
    for (const [id, entry] of this.pending.entries()) entry.resolve({ id, error });
    this.pending.clear();
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
   * @param {object[]} jobs  `{ id, playersData, zoneConfig, labyrinthConfig, extraBuffs, simulationTimeLimit, seed }`
   * @returns {Promise<object[]>} `{ id, metrics }` or `{ id, error }` per job
   */
  async run(jobs) {
    if (this.destroyed) throw new Error('pool has been destroyed');
    // Nothing would ever drain the queue: the exit handler failed only the batch in flight.
    if (!this.workers.length) throw new Error('no workers left');
    if (!jobs.length) return [];

    const results = jobs.map(
      (job) =>
        new Promise((resolve) => {
          this.queue.push({
            job,
            resolve,
          });
        })
    );

    this.#drain();
    const settled = await Promise.all(results);
    // Every worker died mid-batch: fail the run rather than rank on whichever candidates happened to finish.
    if (!this.destroyed && !this.workers.length) throw new Error('no workers left');
    return settled;
  }

  /** Terminate every worker. Safe to call twice. */
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Resolve anything still outstanding so callers awaiting run() do not hang.
    this.#failAll('pool destroyed');
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
    this.idle = [];
  }
}

/** A worker pool over `spawn` (see SimulationPool), started; never leaks the workers that did start. */
export async function startPool(size, spawn) {
  const pool = new SimulationPool(size, spawn);
  try {
    await pool.start();
  } catch (error) {
    // Do not leak the workers that did start; the caller never gets a pool.
    await pool.destroy();
    throw error;
  }
  return pool;
}

/**
 * Build the `evaluate` function search.js expects, backed by a pool.
 *
 * search.js hands us `{ id, playerDTOs, simulationTimeLimit, seed }`; the worker
 * wants `playersData` plus the run-wide target and buffs. Bridging here keeps
 * search.js free of any worker vocabulary, so it can be unit-tested against a
 * synthetic evaluator.
 *
 * `zoneConfig` and `labyrinthConfig` are mutually exclusive and one is always
 * present — the routes resolve that through target.js before reaching here. Both
 * are passed on every job rather than being resolved into some union type,
 * because the worker builds the engine's own two objects from them and the
 * asymmetry is real: a Zone has a difficulty tier, a Labyrinth has a room level
 * and crates.
 *
 * @param {object} args
 * @param {{run: (jobs: object[]) => Promise<object[]>, destroy: () => unknown}} args.pool
 * @param {{zoneHrid: string, difficultyTier?: number}} [args.zoneConfig]
 * @param {{labyrinthHrid: string, roomLevel: number, crates?: string[]}} [args.labyrinthConfig]
 * @param {object[]} [args.extraBuffs]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.cancelMessage]  surfaced to the user on cancellation
 * @returns {(jobs: object[]) => Promise<object[]>}
 */
export function makePoolEvaluator({
  pool,
  zoneConfig = null,
  labyrinthConfig = null,
  extraBuffs = [],
  consumableCosts = null,
  dropCreditCosts = null,
  signal = null,
  cancelMessage = 'Trigger optimisation cancelled',
}) {
  const aborted = () => new AbortError(cancelMessage);
  // Mid-batch abort: tearing the pool down settles the batch at once, instead
  // of only refusing the next one.
  signal?.addEventListener('abort', () => pool.destroy(), { once: true });

  return async function evaluate(jobs) {
    if (signal?.aborted) throw aborted();

    const poolJobs = jobs.map((job) => ({
      id: job.id,
      playersData: job.playerDTOs,
      zoneConfig,
      labyrinthConfig,
      extraBuffs,
      consumableCosts,
      dropCreditCosts,
      simulationTimeLimit: job.simulationTimeLimit,
      seed: job.seed,
    }));

    const results = await pool.run(poolJobs);
    if (signal?.aborted) throw aborted();
    return results;
  };
}
