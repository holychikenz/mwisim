// =============================================================================
// useEnhancementCosts — fetches what each scanned slot's next level costs
//
// Post-hoc enrichment of an equipment scan, not application state: it belongs to
// one rendered result and dies with it. That is why it is owned by
// EquipmentOptimizerResults rather than lifted into App like the panel state —
// there is nothing here another view could want, and nothing worth persisting,
// since a cost is only meaningful against the scan that produced the gain.
//
// Explicitly user-initiated. The scan is useful on its own, and thirty Markov
// solves the moment a result renders would be presumptuous.
//
// The costing runs in the browser: the Rust enhancement simulator (mwi-econ, as
// wasm) in one sim worker per run, on the iron character's game snapshot.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { costScanRows } from '../utils/enhancementCosts';
import { useSnapshots } from './useSnapshots';

/** A guard against a wedged worker, not a budget: one costing takes well under a second. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * The enhancement simulator for one raw character, in a fresh sim worker; callers
 * await one call at a time. Aborting `signal` (Stop, unmount, a new scan) or a
 * call timing out kills the worker, rejects the call in flight, and fails every later one.
 */
function enhanceWorker(character, signal) {
  const worker = new Worker(new URL('../../../src/worker.js', import.meta.url), { type: 'module' });
  const text = JSON.stringify(character);
  let fail = null; // rejects the call in flight
  let dead = null; // why the worker was killed; every later call fails with it at once
  const kill = (error) => {
    dead = error;
    worker.terminate();
    fail?.(error);
  };
  const onAbort = () => kill(new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  const call = (message) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) dead ??= new DOMException('Aborted', 'AbortError');
      if (dead) return reject(dead);
      const timer = setTimeout(() => kill(new Error('the enhancement worker timed out')), CALL_TIMEOUT_MS);
      const settle = (f, v) => {
        clearTimeout(timer);
        fail = null;
        f(v);
      };
      fail = (e) => settle(reject, e);
      worker.onmessage = ({ data }) => {
        if (data.type !== 'enhance_result') return settle(reject, new Error(String(data.error)));
        try {
          const payload = JSON.parse(data.json);
          if (payload?.ok === false) throw new Error(payload.error);
          settle(resolve, payload);
        } catch (e) {
          settle(reject, e);
        }
      };
      worker.onerror = (e) => settle(reject, new Error(e.message || 'enhancement worker failed'));
      worker.postMessage({ ...message, character: text });
    });
  return {
    config: () => call({ type: 'enhance_config' }),
    calculate: (body) => call({ type: 'enhance_calculate', body: JSON.stringify(body) }),
    terminate: () => {
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    },
  };
}

export function useEnhancementCosts() {
  const [config, setConfig] = useState(null);
  const [costs, setCosts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const snapshots = useSnapshots();

  // Abort the fetch in flight, if any. An aborted fetch writes no state of
  // its own (see fetchCosts), so its loading flag is dropped here.
  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setLoading(false);
    }
  }, []);

  useEffect(() => stop, [stop]);

  /**
   * Fetch the player's enhancing setup, then cost every row.
   *
   * @param {object[]} rows  scan result rows
   */
  const fetchCosts = useCallback(
    async (rows, { gameItems, pricing, protectionPricing, protectAt } = {}) => {
      stop();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      setProgress({ done: 0, total: rows?.length || 0 });

      let engine = null;
      try {
        // The character the iron times follow (hooks/usePrices.js), so costs and prices agree.
        const character = snapshots[pricing?.ironCharacter];
        if (!character) {
          throw new Error(
            'No game snapshot for the iron character: import one with the csim-import userscript, then try again.'
          );
        }
        // Material times come from cache.iron; costing against another character's (or an older
        // snapshot's) times would mix two characters silently.
        if (pricing.staleCharacter) {
          throw new Error(
            `Cached item times are for ${pricing.staleCharacter}. Refetch prices for ${pricing.ironCharacterName}, then try again.`
          );
        }
        engine = enhanceWorker(character, controller.signal);
        const resolved = await engine.config();
        setConfig(resolved);

        const table = await costScanRows(rows, resolved, {
          // Passed through so every material and protection item is priced
          // through the user's own overrides rather than the server's walker,
          // which returns 0 for anything it cannot resolve.
          gameItems,
          pricing,
          protectionPricing,
          protectAt,
          engine,
          signal: controller.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        if (!controller.signal.aborted) setCosts(table);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        engine?.terminate();
        // Only the current fetch may settle the shared state: a superseded one
        // must not clear its successor's controller or loading flag.
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [stop, snapshots]
  );

  const clear = useCallback(() => {
    stop();
    setCosts(null);
    setError(null);
    setProgress(null);
    setLoading(false);
  }, [stop]);

  return { config, costs, loading, progress, error, fetchCosts, clear, cancel: stop };
}
