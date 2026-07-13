import { useState, useCallback, useRef, useEffect } from 'react';

// =============================================================================
// useSimulation — runs the combat simulator in a browser Web Worker.
//
// The worker entry is upstream's own `src/worker.js`, consumed verbatim via
// Vite's `new Worker(new URL(...))` support. The message protocol is therefore
// identical to the webpack UI's:
//
//   →  { type: "start_simulation", players, zone, labyrinth,
//        simulationTimeLimit, extra }
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

export function useSimulation() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const workerRef = useRef(null);

  const stopWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, []);

  // Terminate any in-flight worker on unmount
  useEffect(() => stopWorker, [stopWorker]);

  const runSimulation = useCallback((params) => {
    // One worker per run: cheap to spawn, and guarantees no stale engine
    // state bleeds between simulations.
    stopWorker();
    setLoading(true);
    setProgress(0);
    setError(null);
    setResults(null);

    const worker = createSimWorker();
    workerRef.current = worker;

    worker.onmessage = (event) => {
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
      setError(new Error(e.message || 'Simulation worker crashed'));
      setLoading(false);
      stopWorker();
    };

    worker.postMessage({
      type: 'start_simulation',
      players: params.players,
      zone: params.zone ?? null,
      labyrinth: params.labyrinth ?? null,
      simulationTimeLimit: params.simulationTimeLimit,
      extra: params.extra ?? {}
    });
  }, [stopWorker]);

  const runGuildTrial = useCallback((params) => {
    stopWorker();
    setLoading(true);
    setProgress(0);
    setError(null);
    setResults(null);

    const worker = createTrialWorker();
    workerRef.current = worker;

    worker.onmessage = (event) => {
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
      setError(new Error(e.message || 'Simulation worker crashed'));
      setLoading(false);
      stopWorker();
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
  }, [stopWorker]);

  const clearResults = useCallback(() => {
    stopWorker();
    setResults(null);
    setError(null);
    setProgress(0);
    setLoading(false);
  }, [stopWorker]);

  return { loading, progress, results, error, runSimulation, runGuildTrial, clearResults };
}
