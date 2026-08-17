// =============================================================================
// useEnhancementCosts — fetches what each scanned slot's next level costs
//
// Post-hoc enrichment of an equipment scan, not application state: it belongs to
// one rendered result and dies with it. That is why it is owned by
// EquipmentOptimizerResults rather than lifted into App like the panel state —
// there is nothing here another view could want, and nothing worth persisting,
// since a cost is only meaningful against the scan that produced the gain.
//
// Explicitly user-initiated. The scan is useful on its own, the cow webapp may
// not be running, and firing thirty requests at a personal Flask server the
// moment a result renders would be presumptuous.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { costScanRows, fetchEnhancementConfig } from '../utils/enhancementCosts';

export function useEnhancementCosts() {
  const [config, setConfig] = useState(null);
  const [costs, setCosts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [error, setError] = useState(null);

  const abortRef = useRef(null);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
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

      try {
        const resolved = await fetchEnhancementConfig({ signal: controller.signal });
        setConfig(resolved);

        const table = await costScanRows(rows, resolved, {
          // Passed through so every material and protection item is priced
          // through the user's own overrides rather than the server's walker,
          // which returns 0 for anything it cannot resolve.
          gameItems,
          pricing,
          protectionPricing,
          protectAt,
          signal: controller.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        if (!controller.signal.aborted) setCosts(table);
      } catch (caught) {
        if (caught?.name !== 'AbortError') {
          // Overwhelmingly the likeliest cause, and the one the user can fix.
          setError(
            new Error(
              'Cannot reach the enhancement API. Start the cow webapp (it listens on ' +
                'port 12345), then try again.'
            )
          );
        }
      } finally {
        abortRef.current = null;
        setLoading(false);
      }
    },
    [stop]
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
