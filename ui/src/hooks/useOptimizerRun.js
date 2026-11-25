// =============================================================================
// useOptimizerRun — drives one of the optimiser tools (trigger search, equipment
// scan, loadout, abilities, progress, swaps) in the browser. useTriggerOptimizer
// and its siblings are this hook with their tool path, result kind and name.
//
// Mirrors useSimulation's contract ({ loading, progress, results, error, run…,
// clearResults }) so App can treat it the same way. The tools are the csim API's
// own (api/lib/tools/*.js), run by a Web Worker host (workers/optimizerHost.js)
// over a pool of engine workers, so no API needs to be running: previews go to
// one long-lived host, and each run gets a fresh host, terminated when it ends
// or is cancelled. The frames are the API's SSE frames, unchanged.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRunResults } from './useRunResults.js';
import { createLatestGate } from '../utils/latestRequest';
import { createPreviewClient } from '../workers/previewClient.js';

/**
 * Abandon a run that has gone quiet. The host heartbeats every 10s
 * (workers/optimizerHost.js), so silence for this long means it is wedged
 * rather than merely busy with a long candidate.
 */
const STALL_TIMEOUT_MS = 60_000;

/** Frames arrive fast; repainting on every one wastes far more time than it costs. */
const PROGRESS_THROTTLE_MS = 100;

const newHost = () => new Worker(new URL('../workers/optimizerHost.js', import.meta.url), { type: 'module' });

/** A host that died answers with this, not silence: before any frame it never started, after one it stopped. */
const hostCrash = (name, event, started = false) => {
  event?.preventDefault?.();
  const what = started ? 'stopped unexpectedly' : 'could not start in this browser';
  return new Error(`${name} ${what}${event?.message ? `: ${event.message}` : ''}.`);
};

// One preview host for every optimiser hook (workers/previewClient.js).
const requestPreview = createPreviewClient(newHost, (event) => hostCrash('The optimiser', event));

/**
 * @param {object} options
 * @param {string} options.endpoint  the tool's path, e.g. '/api/optimize-triggers' (api/lib/tools/*.js `path`)
 * @param {string} options.kind      the `__kind` its results are tagged with, for App's routing
 * @param {string} options.name      how errors name it, e.g. 'The optimiser'
 */
export function useOptimizerRun({ endpoint, kind, name }) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0); // 0..100, matching ProgressBar
  const [stage, setStage] = useState('');
  const [label, setLabel] = useState('');
  // `stale`: true while `results` belong to an earlier run (see useRunResults).
  const { results, stale, publish, begin, clear } = useRunResults();
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  // The payload the shown preview answers: a panel that seeds state from it can tell when it is stale.
  const [previewFor, setPreviewFor] = useState(null);
  const [previewing, setPreviewing] = useState(false);

  const path = endpoint.replace(/^\/?api\//, '');
  // The run in flight: its host, and `end` to settle its promise when stop() ends it from outside.
  const runRef = useRef(null);
  // A late preview or run must not settle state that belongs to a newer one.
  const [nextPreview] = useState(createLatestGate);
  const [nextRun] = useState(createLatestGate);
  const watchdogRef = useRef(null);
  const lastPaintRef = useRef(0);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearWatchdog();
    const run = runRef.current;
    runRef.current = null;
    if (run) {
      // Terminating the host ends its pool's workers with it (nested workers die with their owner).
      run.host.terminate();
      run.end();
    }
  }, [clearWatchdog]);

  // Kill any in-flight run when the component unmounts, so navigating away does
  // not leave a worker pool saturating the machine for a result nobody will read.
  useEffect(() => stop, [stop]);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      setError(new Error(`${name} stopped responding. The run was cancelled.`));
      setLoading(false);
      stop();
    }, STALL_TIMEOUT_MS);
  }, [clearWatchdog, stop, name]);

  /**
   * Ask the tool what can be searched and what it will cost. Cheap; called on
   * every configuration change, so one long-lived host answers every preview.
   */
  const fetchPreview = useCallback(async (payload) => {
    const isLatest = nextPreview();
    setPreviewing(true);
    setError(null);
    try {
      const { status, json } = await requestPreview(path, payload);
      if (!json?.success) throw new Error(json?.error || `Preview failed (${status})`);
      if (!isLatest()) return null;
      setPreview(json);
      setPreviewFor(payload);
      return json;
    } catch (caught) {
      if (!isLatest()) return null;
      setPreview(null);
      setError(caught);
      return null;
    } finally {
      if (isLatest()) setPreviewing(false);
    }
  }, [nextPreview, path]);

  /**
   * Run the search, streaming progress.
   *
   * @param {object} payload  { players, zone, extra, guildBuffs, selection, stages, … }
   */
  const runOptimizer = useCallback(
    async (payload) => {
      stop();
      const isLatest = nextRun();
      setLoading(true);
      setProgress(0);
      setStage('');
      setLabel('Starting…');
      begin();
      setError(null);

      const host = newHost();
      const current = { host, end: () => {} };
      runRef.current = current;
      armWatchdog();

      const handleFrame = (frame) => {
        switch (frame.type) {
          case 'start':
            setStage('start');
            setLabel(`Pool of ${frame.poolSize} · ${frame.workload?.total ?? '?'} simulations planned`);
            return false;

          case 'progress': {
            const now = Date.now();
            if (now - lastPaintRef.current >= PROGRESS_THROTTLE_MS) {
              lastPaintRef.current = now;
              setProgress(Math.min(100, Math.max(0, (frame.progress || 0) * 100)));
              setStage(frame.stage || '');
              setLabel(frame.label || '');
            }
            return false;
          }

          case 'result':
            // Tagged so App can route it, exactly as the guild trial is.
            publish({ __kind: kind, ...frame.result, meta: payload.meta || {} });
            setProgress(100);
            setStage('done');
            setLabel('');
            return true;

          case 'cancelled':
            return true;

          case 'error':
            setError(new Error(frame.error || `${name} failed.`));
            return true;

          default:
            return false;
        }
      };

      try {
        await new Promise((resolve, reject) => {
          let finished = false;
          let started = false;
          current.end = resolve;
          host.onmessage = ({ data }) => {
            if (runRef.current !== current) return; // superseded or cancelled: stop() already ended it
            armWatchdog();
            started = true;
            if (data?.type === 'refused') reject(new Error(data.json?.error || `${name} refused the run (${data.status}).`));
            else if (data?.type === 'frame') finished = handleFrame(data.frame) || finished;
            else if (data?.type === 'done') {
              if (!finished) setError((current) => current || new Error(`${name} ended without a result.`));
              resolve();
            }
          };
          host.onerror = (event) => reject(hostCrash(name, event, started));
          host.postMessage({ type: 'run', path, body: payload });
        });
      } catch (caught) {
        if (isLatest()) setError(caught);
      } finally {
        // A superseded run must not clear its successor's host, watchdog or loading flag.
        if (isLatest()) {
          clearWatchdog();
          if (runRef.current === current) runRef.current = null;
          setLoading(false);
        }
        host.terminate();
      }
    },
    [armWatchdog, clearWatchdog, stop, publish, begin, nextRun, path, kind, name]
  );

  /** Cancel an in-flight run: its host and pool are terminated. */
  const cancel = useCallback(() => {
    stop();
    setLoading(false);
    setLabel('Cancelled');
  }, [stop]);

  const clearResults = useCallback(() => {
    stop();
    setLoading(false);
    setProgress(0);
    setStage('');
    setLabel('');
    clear();
    setError(null);
  }, [stop, clear]);

  return {
    loading,
    progress,
    stage,
    label,
    results,
    stale,
    error,
    preview,
    previewFor,
    previewing,
    fetchPreview,
    runOptimizer,
    cancel,
    clearResults,
    reset: clearResults,
  };
}
