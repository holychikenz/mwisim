// =============================================================================
// useTriggerOptimizer — drives the backend trigger-threshold search
//
// Mirrors useSimulation's contract ({ loading, progress, results, error, run…,
// clearResults }) so App can treat it the same way, but the transport is
// different: this is the only hook in the UI that talks to csim/api rather than
// spawning a Web Worker.
//
// SSE over POST, not EventSource. EventSource can only issue GET requests, and
// the payload here is a full set of player DTOs plus a stage configuration —
// far too large for a query string, and it would put build data in a URL. So we
// POST and read the response body as a stream, splitting frames on the blank
// line ourselves.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, pingApi } from '../utils/apiBase';

/**
 * Abandon a run that has gone quiet. The server heartbeats every 10s
 * (api/routes/optimizeTriggers.js HEARTBEAT_MS), so silence for this long means
 * the connection is genuinely dead rather than merely busy with a long candidate.
 * useSimulation uses 30s against a worker that reports every 1000 ticks; this is
 * looser because a single 72-hour candidate can legitimately take a while.
 */
const STALL_TIMEOUT_MS = 60_000;

/** Frames arrive fast; repainting on every one wastes far more time than it costs. */
const PROGRESS_THROTTLE_MS = 100;

export function useTriggerOptimizer() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0); // 0..100, matching ProgressBar
  const [stage, setStage] = useState('');
  const [label, setLabel] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [checkpoint, setCheckpoint] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [apiReachable, setApiReachable] = useState(null); // null = not yet checked

  const abortRef = useRef(null);
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
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [clearWatchdog]);

  // Kill any in-flight run when the component unmounts, so navigating away does
  // not leave a worker pool saturating the server for a result nobody will read.
  // (The server also aborts on socket close — belt and braces.)
  useEffect(() => stop, [stop]);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      setError(new Error('The optimiser stopped responding. The run was cancelled.'));
      setLoading(false);
      stop();
    }, STALL_TIMEOUT_MS);
  }, [clearWatchdog, stop]);

  /**
   * Ask the backend what can be searched and what it will cost. Cheap and
   * synchronous server-side; called on every configuration change.
   */
  const fetchPreview = useCallback(async (payload) => {
    setPreviewing(true);
    setError(null);
    try {
      const response = await fetch(apiUrl('/api/optimize-triggers/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body?.error || `Preview failed (HTTP ${response.status})`);
      }
      setPreview(body);
      setApiReachable(true);
      return body;
    } catch (caught) {
      // Distinguish "the API is not running" from "the API said no". The former is
      // by far the likelier mistake, since every other panel in this UI works
      // without the API at all and a user has no reason to expect they need it.
      const reachable = await pingApi();
      setApiReachable(reachable);
      setPreview(null);
      setError(
        reachable
          ? caught
          : new Error(
              'Cannot reach the csim API. Start it with `npm start` in csim/api ' +
                '(it listens on port 3001), then try again.'
            )
      );
      return null;
    } finally {
      setPreviewing(false);
    }
  }, []);

  /**
   * Run the search, streaming progress.
   *
   * @param {object} payload  { players, zone, extra, guildBuffs, selection, stages, … }
   */
  const runOptimizer = useCallback(
    async (payload) => {
      stop();
      setLoading(true);
      setProgress(0);
      setStage('');
      setLabel('Starting…');
      setResults(null);
      setError(null);
      setCheckpoint(null);

      const controller = new AbortController();
      abortRef.current = controller;
      armWatchdog();

      try {
        const response = await fetch(apiUrl('/api/optimize-triggers'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        // Validation failures answer with JSON before the stream opens.
        if (!response.ok) {
          let message = `HTTP ${response.status}`;
          try {
            const body = await response.json();
            if (body?.error) message = body.error;
          } catch {
            // Not JSON — keep the status line.
          }
          throw new Error(message);
        }
        if (!response.body) throw new Error('This browser cannot stream the response body.');

        setApiReachable(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finished = false;

        const handleFrame = (raw) => {
          armWatchdog();
          // SSE comments (the server's keepalive) carry no data.
          if (raw.startsWith(':')) return;
          if (!raw.startsWith('data: ')) return;

          let frame;
          try {
            frame = JSON.parse(raw.slice(6));
          } catch {
            return; // A truncated frame is not worth failing the whole run over.
          }

          switch (frame.type) {
            case 'start':
              setStage('start');
              setLabel(`Pool of ${frame.poolSize} · ${frame.workload?.total ?? '?'} simulations planned`);
              break;

            case 'progress': {
              const now = Date.now();
              if (now - lastPaintRef.current >= PROGRESS_THROTTLE_MS) {
                lastPaintRef.current = now;
                setProgress(Math.min(100, Math.max(0, (frame.progress || 0) * 100)));
                setStage(frame.stage || '');
                setLabel(frame.label || '');
              }
              break;
            }

            case 'checkpoint':
              // Retained so an interrupted run can be resumed by posting this back
              // as `resumeCheckpoint`.
              setCheckpoint(frame.checkpoint);
              break;

            case 'result':
              // Tagged so App can route it, exactly as the guild trial does.
              setResults({ __kind: 'triggerOpt', ...frame.result, meta: payload.meta || {} });
              setProgress(100);
              setStage('done');
              setLabel('');
              finished = true;
              break;

            case 'cancelled':
              finished = true;
              break;

            case 'error':
              setError(new Error(frame.error || 'The optimiser failed.'));
              finished = true;
              break;

            default:
              break;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            handleFrame(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
          }
        }

        if (!finished) {
          // The stream closed without a terminal frame — a dropped connection or a
          // server that died mid-run.
          setError((current) => current || new Error('The optimiser connection closed unexpectedly.'));
        }
      } catch (caught) {
        if (caught?.name !== 'AbortError') {
          const reachable = await pingApi();
          setApiReachable(reachable);
          setError(
            reachable
              ? caught
              : new Error(
                  'Cannot reach the csim API. Start it with `npm start` in csim/api ' +
                    '(it listens on port 3001), then try again.'
                )
          );
        }
      } finally {
        clearWatchdog();
        abortRef.current = null;
        setLoading(false);
      }
    },
    [armWatchdog, clearWatchdog, stop]
  );

  /** Cancel an in-flight run. The server sees the socket close and tears down its pool. */
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
    setResults(null);
    setError(null);
    setCheckpoint(null);
  }, [stop]);

  return {
    loading,
    progress,
    stage,
    label,
    results,
    error,
    checkpoint,
    preview,
    previewing,
    apiReachable,
    fetchPreview,
    runOptimizer,
    cancel,
    clearResults,
    reset: clearResults,
  };
}
