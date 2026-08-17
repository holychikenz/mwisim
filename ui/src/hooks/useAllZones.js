import { useState, useCallback, useRef, useEffect } from 'react';

// =============================================================================
// useAllZones — drives the zone sweep (workers/allZonesWorker.js)
//
// Same shape and the same watchdog discipline as useSimulation, with one
// difference that matters: rows STREAM. The pool posts each combination's
// summary as it lands, so the table fills over the minutes a sweep takes rather
// than appearing all at once at the end, and a cancelled sweep keeps whatever it
// had already measured.
//
//   →  { type: 'start_all_zones', players, combos, simulationTimeLimit,
//        extra, guildBuffs, workers }
//   ←  { type: 'all_zones_progress' | 'all_zones_row' | 'all_zones_done'
//        | 'all_zones_error' }
// =============================================================================

// Longer than useSimulation's 30s: the pool is silent for as long as its slowest
// shard takes to reach its first 1000-tick progress tick, and a sweep's shards
// start staggered. A minute of true silence still means something is wrong.
const STALL_TIMEOUT_MS = 60_000;

// Rows are buffered and flushed on this interval rather than committed one by
// one. A thirteen-worker pool on a short sweep lands rows in bursts, and every
// commit re-derives the whole table (metrics, sort, best-per-column) — seventy
// eight of those is quadratic work for frames nobody sees. A quarter second
// still reads as "filling in as it goes".
const ROW_FLUSH_MS = 250;

export function useAllZones() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  // { hours, workers, total, completed, startedAt, finishedAt, cancelled }
  const [meta, setMeta] = useState(null);

  const workerRef = useRef(null);
  const watchdogRef = useRef(null);
  const pendingRowsRef = useRef([]);
  const flushTimerRef = useRef(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // Commit whatever has arrived since the last flush. Called on the timer, and
  // synchronously whenever the sweep ends — a cancelled or finished sweep must
  // not leave its last few rows sitting in the buffer.
  const flushRows = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingRowsRef.current.length === 0) return;
    const batch = pendingRowsRef.current;
    pendingRowsRef.current = [];
    setRows(prev => [...prev, ...batch]);
  }, []);

  const stopWorker = useCallback(() => {
    clearWatchdog();
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (workerRef.current) {
      // Terminating the pool also terminates the shards it owns.
      workerRef.current.terminate();
      workerRef.current = null;
    }
  }, [clearWatchdog]);

  useEffect(() => stopWorker, [stopWorker]);

  const failAndReset = useCallback((message) => {
    // Commit before terminating: a stall or a crash should still leave behind
    // every combination that had already been measured.
    flushRows();
    setError(new Error(message));
    setRunning(false);
    stopWorker();
    setMeta(prev => (prev ? { ...prev, finishedAt: Date.now() } : prev));
  }, [stopWorker, flushRows]);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      failAndReset(
        `Zone sweep stalled — the worker pool went silent for ${STALL_TIMEOUT_MS / 1000}s and was reset. ` +
          `Rows already collected are kept; try fewer hours per zone and run again.`
      );
    }, STALL_TIMEOUT_MS);
  }, [clearWatchdog, failAndReset]);

  const run = useCallback((params) => {
    stopWorker();
    const combos = params?.combos || [];
    pendingRowsRef.current = [];
    setRunning(true);
    setProgress(0);
    setRows([]);
    setError(null);
    setMeta({
      hours: params.hours,
      workers: params.workers || null,
      total: combos.length,
      completed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      cancelled: false,
    });

    let worker;
    try {
      worker = new Worker(new URL('../workers/allZonesWorker.js', import.meta.url), {
        type: 'module',
      });
    } catch (e) {
      failAndReset('Could not start the zone-sweep worker: ' + (e?.message || e));
      return;
    }
    workerRef.current = worker;

    worker.onmessage = (event) => {
      armWatchdog();
      const data = event.data || {};
      switch (data.type) {
        case 'all_zones_progress':
          setProgress(data.progress * 100);
          // Only a CHANGED count is a new object. The pool posts progress on
          // every shard's every 1000-event tick — hundreds a second across a
          // full pool — and a fresh `{...prev}` each time would deny React its
          // bail-out and re-render the whole app (and re-derive the table) for a
          // number that had not moved.
          setMeta(prev =>
            prev && prev.completed !== data.completed ? { ...prev, completed: data.completed } : prev
          );
          break;
        case 'all_zones_row':
          pendingRowsRef.current.push(data.row);
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              flushTimerRef.current = null;
              flushRows();
            }, ROW_FLUSH_MS);
          }
          break;
        case 'all_zones_done':
          flushRows();
          setProgress(100);
          setRunning(false);
          setMeta(prev =>
            prev ? { ...prev, completed: data.completed, failed: data.failed, finishedAt: Date.now() } : prev
          );
          stopWorker();
          break;
        case 'all_zones_error':
          failAndReset(String(data.error || 'Zone sweep failed'));
          break;
        default:
          break;
      }
    };

    worker.onerror = (e) => {
      failAndReset(e.message || 'Zone-sweep worker crashed');
    };

    worker.postMessage({
      type: 'start_all_zones',
      players: params.players,
      combos,
      simulationTimeLimit: params.simulationTimeLimit,
      extra: params.extra || {},
      guildBuffs: params.guildBuffs || [],
      workers: params.workers || null,
    });
    armWatchdog();
  }, [stopWorker, armWatchdog, failAndReset, flushRows]);

  // Stop, but KEEP the rows already measured — a half-swept table is still an
  // answer, and re-running is expensive. Buffered rows are committed first, so
  // stopping never discards a combination that had in fact finished.
  const cancel = useCallback(() => {
    flushRows();
    stopWorker();
    setRunning(false);
    setMeta(prev => (prev ? { ...prev, finishedAt: Date.now(), cancelled: true } : prev));
  }, [stopWorker, flushRows]);

  const clear = useCallback(() => {
    stopWorker();
    pendingRowsRef.current = [];
    setRunning(false);
    setProgress(0);
    setRows([]);
    setError(null);
    setMeta(null);
  }, [stopWorker]);

  return { running, progress, rows, error, meta, run, cancel, clear };
}
