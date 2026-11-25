// =============================================================================
// poolWorker — a reusable simulation worker for the trigger optimiser
//
// The optimiser runs hundreds of simulations, and paying the engine's
// module-load cost for each would dominate the run. So this is a message loop:
// it loads the engine once, then answers `run` messages until told to stop.
// Two further points:
//
//   1. Math.random is replaced with a SEEDED generator before every run, so
//      candidates within a sweep face identical spawns. See rng.js for why this
//      lives here rather than in the engine.
//
//   2. It posts back SCORED METRICS, never the SimResult. A 72-hour SimResult
//      carries a large attacks histogram, and structured-cloning hundreds of
//      those across the thread boundary would cost more than the simulations.
//      Scoring in the worker keeps the message a dozen numbers wide.
// =============================================================================

import { parentPort } from 'worker_threads';

const { runJob } = await import('./runJob.js');
// CSIM_ENGINE: each worker registers its own twin backend (env is inherited from the pool's process).
const twin = await (await import('../twin/index.mjs')).selectTwinFromEnv();

parentPort.on('message', async (message) => {
  if (message?.type !== 'run') return;

  try {
    const { metrics } = await runJob(message.job, twin);
    parentPort.postMessage({ type: 'result', id: message.job.id, metrics });
  } catch (error) {
    // A candidate that throws (an invalid trigger shape, a stalled clock)
    // must not take the run down with it — report and let it not compete.
    parentPort.postMessage({ type: 'result', id: message.job.id, error: error?.message || String(error) });
  }
});

parentPort.postMessage({ type: 'ready' });
