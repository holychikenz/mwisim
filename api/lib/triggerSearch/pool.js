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
import { AbortError, makePoolEvaluator, MAX_WORKERS, startPool } from './poolCore.js';

// Re-exported: the queue, the evaluator and the cap are portable (poolCore.js, also the browser pool's).
export { AbortError, makePoolEvaluator, MAX_WORKERS };

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'poolWorker.js');

/**
 * Default pool size: cores minus one, clamped to [1, MAX_WORKERS].
 *
 * @returns {number}
 */
export function defaultPoolSize() {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length || 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

/**
 * Create and start a pool.
 *
 * @param {object} [opts]
 * @param {number} [opts.size]
 * @returns {Promise<SimulationPool>}
 */
export function createSimulationPool({ size = defaultPoolSize() } = {}) {
  // execArgv is inherited, so the worker gets --import ./register-loader.js
  // and can resolve the engine's extensionless and JSON imports. Its
  // stdout/stderr go to the server's (the engine no longer logs, audit2-16).
  return startPool(size, () => new Worker(WORKER_PATH));
}
