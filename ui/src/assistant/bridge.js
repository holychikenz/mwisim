import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';

// The assistant's handle on App: this render's state and setters, read only from async agent code.
// flushSync commits a tool's write before the next call, so `run` (App's handleStartSimulation,
// refreshed in the layout effect of that commit) sees it — "set zone, then run" in one reply.
// shortcut: a tool write replaces the slices it read; an update queued elsewhere in the same tick could be lost — rebase in a functional updater if it ever bites.
export function useAssistantBridge(state, setters, run) {
  const live = useRef(null);
  useLayoutEffect(() => { live.current = { state, setters, run }; });
  const getState = useCallback(() => live.current.state, []);
  const commit = useCallback((next) => flushSync(() => {
    for (const [key, value] of Object.entries(next)) live.current.setters[key](value);
  }), []);
  const runNow = useCallback(() => live.current.run(), []);
  return useMemo(() => ({ getState, commit, run: runNow }), [getState, commit, runNow]);
}
