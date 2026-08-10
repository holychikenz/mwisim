import { useState, useCallback, useRef, useEffect } from 'react';

// =============================================================================
// useSimulation — runs the combat simulator in a browser Web Worker.
//
// The worker entry is upstream's own `src/worker.js`, consumed verbatim via
// Vite's `new Worker(new URL(...))` support. The message protocol is therefore
// identical to the webpack UI's:
//
//   →  { type: "start_simulation", players, zone, labyrinth,
//        simulationTimeLimit, extra, guildBuffs }
//   ←  { type: "simulation_progress", progress /* 0-1 */, ... }
//   ←  { type: "simulation_result", simResult }
//   ←  { type: "simulation_error", error }
//
// Because we never modify worker.js or the engine, upstream rebases pass
// straight through this seam. The Express API (csim/api) remains available
// for headless/automation callers but is no longer needed to use this UI.
// =============================================================================

function createSimWorker() {
  return new Worker(new URL('../../../src/worker.js', import.meta.url), {
    type: 'module'
  });
}

// Guild trials shard their iterations across a worker pool, so they run through
// upstream's `src/multiWorker.js` (which itself spawns nested `worker.js`
// shards). Message protocol (consumed verbatim from Phase 2 plumbing):
//
//   →  { type: "start_simulation_guild_trial", players, guildTrial, guildBuffs,
//        extra, iterations, aggregateOptions }
//   ←  { type: "simulation_progress", progress /* 0-1 */ }
//   ←  { type: "simulation_result_guildTrial", aggregate, summaries }
//   ←  { type: "simulation_error", error }
function createTrialWorker() {
  return new Worker(new URL('../../../src/multiWorker.js', import.meta.url), {
    type: 'module'
  });
}

// Watchdog: the engine emits a progress event every 1000 ticks (see
// combatSimulator.simulate) and caps runaway loops at MAX_TICKS, so in normal
// operation the worker is never silent for long. If NO message (progress or
// result) arrives within this window we treat the worker as hung or silently
// crashed, terminate it, and reset the UI to a usable state instead of leaving
// a spinner (and a wedged tab) forever.
const STALL_TIMEOUT_MS = 30_000;

export function useSimulation() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const workerRef = useRef(null);
  const watchdogRef = useRef(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const stopWorker = useCallback(() => {
    clearWatchdog();
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, [clearWatchdog]);

  // Terminate any in-flight worker (and its watchdog) on unmount.
  useEffect(() => stopWorker, [stopWorker]);

  // Kill the worker and surface a friendly error without wedging the UI.
  const failAndReset = useCallback((message) => {
    setError(new Error(message));
    setLoading(false);
    setProgress(0);
    stopWorker();
  }, [stopWorker]);

  // (Re)arm the inactivity watchdog. Called after posting the job and on every
  // message from the worker, so a healthy, chatty worker never trips it.
  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      failAndReset(
        `Simulation stalled — the worker went silent for ${STALL_TIMEOUT_MS / 1000}s and was reset. ` +
          `Try reducing the duration or iteration count and run again.`
      );
    }, STALL_TIMEOUT_MS);
  }, [clearWatchdog, failAndReset]);

  const runSimulation = useCallback((params) => {
    // One worker per run: cheap to spawn, and guarantees no stale engine
    // state bleeds between simulations.
    stopWorker();
    setLoading(true);
    setProgress(0);
    setError(null);
    setResults(null);

    let worker;
    try {
      worker = createSimWorker();
    } catch (e) {
      failAndReset('Could not start the simulation worker: ' + (e?.message || e));
      return;
    }
    workerRef.current = worker;

    worker.onmessage = (event) => {
      // Any message means the worker is alive — push the watchdog back.
      armWatchdog();
      switch (event.data.type) {
        case 'simulation_progress':
          // Worker reports a 0-1 fraction; UI displays 0-100.
          setProgress(event.data.progress * 100);
          break;
        case 'simulation_result':
          setProgress(100);
          setResults(event.data.simResult);
          setLoading(false);
          stopWorker();
          break;
        case 'simulation_error': {
          const raw = event.data.error;
          setError(raw instanceof Error ? raw : new Error(String(raw?.message || raw || 'Simulation failed')));
          setLoading(false);
          stopWorker();
          break;
        }
        default:
          break;
      }
    };

    worker.onerror = (e) => {
      failAndReset(e.message || 'Simulation worker crashed');
    };

    worker.postMessage({
      type: 'start_simulation',
      players: params.players,
      zone: params.zone ?? null,
      labyrinth: params.labyrinth ?? null,
      simulationTimeLimit: params.simulationTimeLimit,
      extra: params.extra ?? {},
      // Guild shrine buffs apply to all combat, not just trials — see the
      // adaptation note in worker.js. Pre-resolved by resolveGuildBuffs().
      guildBuffs: params.guildBuffs ?? []
    });
    // Guard the gap between dispatch and the first progress tick, too.
    armWatchdog();
  }, [stopWorker, armWatchdog, failAndReset]);

  const runGuildTrial = useCallback((params) => {
    stopWorker();
    setLoading(true);
    setProgress(0);
    setError(null);
    setResults(null);

    let worker;
    try {
      worker = createTrialWorker();
    } catch (e) {
      failAndReset('Could not start the trial worker: ' + (e?.message || e));
      return;
    }
    workerRef.current = worker;

    worker.onmessage = (event) => {
      // Any message means the worker pool is alive — push the watchdog back.
      armWatchdog();
      switch (event.data.type) {
        case 'simulation_progress':
          setProgress(event.data.progress * 100);
          break;
        case 'simulation_result_guildTrial':
          setProgress(100);
          // Tagged so App can route it to <GuildTrialResults> rather than the
          // zone/lab <SimulationResults>.
          setResults({
            __kind: 'guildTrial',
            aggregate: event.data.aggregate,
            summaries: event.data.summaries,
            meta: params.meta || {}
          });
          setLoading(false);
          stopWorker();
          break;
        case 'simulation_error': {
          const raw = event.data.error;
          setError(raw instanceof Error ? raw : new Error(String(raw?.message || raw || 'Simulation failed')));
          setLoading(false);
          stopWorker();
          break;
        }
        default:
          break;
      }
    };

    worker.onerror = (e) => {
      failAndReset(e.message || 'Trial worker crashed');
    };

    worker.postMessage({
      type: 'start_simulation_guild_trial',
      players: params.players,
      guildTrial: params.guildTrial,
      guildBuffs: params.guildBuffs || [],
      extra: params.extra || {},
      iterations: params.iterations || 1000,
      aggregateOptions: params.aggregateOptions || {}
    });
    // Guard the gap before the first shard reports in, too.
    armWatchdog();
  }, [stopWorker, armWatchdog, failAndReset]);

  // Hard reset: kill any in-flight worker/watchdog and wipe results back to a
  // clean slate. Bound to the header's Stop button; also the recovery path a
  // user can invoke if a run ever misbehaves.
  const clearResults = useCallback(() => {
    stopWorker();
    setResults(null);
    setError(null);
    setProgress(0);
    setLoading(false);
  }, [stopWorker]);

  return { loading, progress, results, error, runSimulation, runGuildTrial, clearResults, reset: clearResults };
}
