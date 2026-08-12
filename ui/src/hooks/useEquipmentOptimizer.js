// =============================================================================
// useEquipmentOptimizer — drives the backend equipment enhancement scan
//
// Same transport as useTriggerOptimizer, and for the same reasons: SSE over
// POST, because EventSource is GET-only and the payload is a full set of player
// DTOs. Frames are split on the blank line by hand.
//
// Deliberately NOT sharing an implementation with useTriggerOptimizer. The two
// look alike but differ in what they carry — that hook tracks a resumable
// checkpoint across a four-stage funnel, this one has a single stage and nothing
// to resume — and folding them together would mean parameterising a working hook
// for the sake of forty saved lines. The transport is the boring part; the
// interesting differences are in the frames.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, pingApi } from '../utils/apiBase';

/** The server heartbeats every 10s, so silence this long means a dead socket. */
const STALL_TIMEOUT_MS = 60_000;

/** Frames arrive fast; repainting on each one costs more than it buys. */
const PROGRESS_THROTTLE_MS = 100;

const API_DOWN_MESSAGE =
  'Cannot reach the csim API. Start it with `npm start` in csim/api ' +
  '(it listens on port 3001), then try again.';

export function useEquipmentOptimizer() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0); // 0..100, matching ProgressBar
  const [stage, setStage] = useState('');
  const [label, setLabel] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
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

  // Kill any in-flight run on unmount, so navigating away does not leave a worker
  // pool saturating the server for a result nobody will read.
  useEffect(() => stop, [stop]);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      setError(new Error('The equipment scan stopped responding. The run was cancelled.'));
      setLoading(false);
      stop();
    }, STALL_TIMEOUT_MS);
  }, [clearWatchdog, stop]);

  /** Which slots can be probed, which cannot and why, and what it will cost. */
  const fetchPreview = useCallback(async (payload) => {
    setPreviewing(true);
    setError(null);
    try {
      const response = await fetch(apiUrl('/api/optimize-equipment/preview'), {
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
      // "The API is not running" is by far the likelier mistake: every other panel
      // in this UI works without it, so a user has no reason to expect it is needed.
      const reachable = await pingApi();
      setApiReachable(reachable);
      setPreview(null);
      setError(reachable ? caught : new Error(API_DOWN_MESSAGE));
      return null;
    } finally {
      setPreviewing(false);
    }
  }, []);

  /**
   * Run the scan, streaming progress.
   *
   * @param {object} payload  { players, zone, extra, guildBuffs, selection, scan, … }
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

      const controller = new AbortController();
      abortRef.current = controller;
      armWatchdog();

      try {
        const response = await fetch(apiUrl('/api/optimize-equipment'), {
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
          if (raw.startsWith(':')) return; // keepalive comment
          if (!raw.startsWith('data: ')) return;

          let frame;
          try {
            frame = JSON.parse(raw.slice(6));
          } catch {
            return; // A truncated frame is not worth failing the run over.
          }

          switch (frame.type) {
            case 'start':
              setStage('start');
              setLabel(
                `Pool of ${frame.poolSize} · ${frame.workload?.total ?? '?'} simulations planned`
              );
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

            case 'result':
              // Tagged so App can route it, exactly as the trigger optimiser does.
              setResults({ __kind: 'equipOpt', ...frame.result, meta: payload.meta || {} });
              setProgress(100);
              setStage('done');
              setLabel('');
              finished = true;
              break;

            case 'cancelled':
              finished = true;
              break;

            case 'error':
              setError(new Error(frame.error || 'The equipment scan failed.'));
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
          setError(
            (current) => current || new Error('The equipment scan connection closed unexpectedly.')
          );
        }
      } catch (caught) {
        if (caught?.name !== 'AbortError') {
          const reachable = await pingApi();
          setApiReachable(reachable);
          setError(reachable ? caught : new Error(API_DOWN_MESSAGE));
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
  }, [stop]);

  return {
    loading,
    progress,
    stage,
    label,
    results,
    error,
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
