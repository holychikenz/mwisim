import { useState, useCallback, useRef, useEffect } from 'react';
import { useRunResults } from './useRunResults.js';
import { runDungeonRunsSerial, workerBatchRunner, addRunIdleTime } from '../../../shared/dungeonRuns.js';

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
// A dungeon given `maxRuns` is simulated as that many runs instead, spread
// across cores by multiWorker.js (see createMultiWorker below):
//
//   →  { type: "start_simulation_dungeon_runs", players, zone,
//        simulationTimeLimit, extra, guildBuffs, maxRuns, maxRunDurationNs }
//   ←  simulation_progress / simulation_result / simulation_error, as above
//   ←  { type: "dungeon_runs_unsupported" }   no nested workers in this browser:
//        the same batches then run here over a single worker.js
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

// Guild trials and dungeon runs shard their work across a worker pool, so they
// run through upstream's `src/multiWorker.js` (which itself spawns nested
// `worker.js` shards). Guild-trial protocol (consumed verbatim from Phase 2
// plumbing; dungeon runs are in the header above):
//
//   →  { type: "start_simulation_guild_trial", players, guildTrial, guildBuffs,
//        extra, iterations, aggregateOptions }
//   ←  { type: "simulation_progress", progress /* 0-1 */ }
//   ←  { type: "simulation_result_guildTrial", aggregate, summaries }
//   ←  { type: "simulation_error", error }
function createMultiWorker() {
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
  const [error, setError] = useState(null);
  // `stale`: true while `results` belong to an earlier run of the same kind
  // (zone, labyrinth or guild trial) — see useRunResults. Results stay mounted
  // so the open tab and scroll survive a re-run.
  const { results, stale, publish, begin, clear } = useRunResults();
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

  // Dungeon runs without multiWorker (it could not start, or this browser has
  // no nested workers): the same batches, one after another, over one
  // worker.js. Slower, since it uses a single core, but it gives the same answer.
  const runDungeonRunsHere = useCallback((message) => {
    stopWorker();
    let worker;
    try {
      worker = createSimWorker();
    } catch (e) {
      failAndReset('Could not start the simulation worker: ' + (e?.message || e));
      return;
    }
    workerRef.current = worker;
    const current = () => workerRef.current === worker;
    // This path is a top level: the idle between runs is added once, here.
    runDungeonRunsSerial({
      totalRuns: message.maxRuns,
      maxRunDurationNs: message.maxRunDurationNs,
      runBatch: workerBatchRunner(worker, message),
      onProgress: (p) => {
        if (!current()) return;
        armWatchdog();
        setProgress(p * 100);
      }
    }).then(addRunIdleTime).then((simResult) => {
      if (!current()) return;
      setProgress(100);
      publish(simResult, 'zone');
      setLoading(false);
      stopWorker();
    }, (e) => {
      if (!current()) return;
      setError(e instanceof Error ? e : new Error(String(e?.message || e || 'Simulation failed')));
      setLoading(false);
      stopWorker();
    });
    armWatchdog();
  }, [stopWorker, armWatchdog, failAndReset, publish]);

  const runSimulation = useCallback((params) => {
    // One worker per run: cheap to spawn, and guarantees no stale engine
    // state bleeds between simulations.
    stopWorker();
    setLoading(true);
    setProgress(0);
    setError(null);
    const kind = params.labyrinth ? 'labyrinth' : 'zone';
    begin(kind);

    const message = {
      players: params.players,
      zone: params.zone ?? null,
      labyrinth: params.labyrinth ?? null,
      simulationTimeLimit: params.simulationTimeLimit,
      extra: params.extra ?? {},
      // Guild shrine buffs apply to all combat, not just trials — see the
      // adaptation note in worker.js. Pre-resolved by resolveGuildBuffs().
      guildBuffs: params.guildBuffs ?? []
    };
    const dungeonRuns = params.maxRuns != null;
    if (dungeonRuns) {
      message.maxRuns = params.maxRuns;
      message.maxRunDurationNs = params.maxRunDurationNs;
    }

    let worker;
    try {
      worker = dungeonRuns ? createMultiWorker() : createSimWorker();
    } catch (e) {
      if (dungeonRuns) {
        runDungeonRunsHere(message);
        return;
      }
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
          publish(event.data.simResult, kind);
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
        case 'dungeon_runs_unsupported':
          runDungeonRunsHere(message);
          break;
        default:
          break;
      }
    };

    worker.onerror = (e) => {
      failAndReset(e.message || 'Simulation worker crashed');
    };

    worker.postMessage({
      ...message,
      type: dungeonRuns ? 'start_simulation_dungeon_runs' : 'start_simulation'
    });
    // Guard the gap between dispatch and the first progress tick, too.
    armWatchdog();
  }, [stopWorker, armWatchdog, failAndReset, runDungeonRunsHere, publish, begin]);

  const runGuildTrial = useCallback((params) => {
    stopWorker();
    setLoading(true);
    setProgress(0);
    setError(null);
    begin('guildTrial');

    let worker;
    try {
      worker = createMultiWorker();
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
          publish({
            __kind: 'guildTrial',
            aggregate: event.data.aggregate,
            summaries: event.data.summaries,
            meta: params.meta || {}
          }, 'guildTrial');
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
  }, [stopWorker, armWatchdog, failAndReset, publish, begin]);

  // Stop: kill any in-flight worker/watchdog but keep the last results on
  // screen. `stale` is left as it is, so results from before the abandoned run
  // stay badged ("the last run did not finish"). Bound to the run strip's Stop.
  const cancelRun = useCallback(() => {
    stopWorker();
    setLoading(false);
    setProgress(0);
  }, [stopWorker]);

  // Hard reset: kill any in-flight worker/watchdog and wipe results back to a
  // clean slate. Bound to the results header's Clear.
  const clearResults = useCallback(() => {
    stopWorker();
    clear();
    setError(null);
    setProgress(0);
    setLoading(false);
  }, [stopWorker, clear]);

  return { loading, progress, results, stale, error, runSimulation, runGuildTrial, cancelRun, clearResults, reset: clearResults };
}
