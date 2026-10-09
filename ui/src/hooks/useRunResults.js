import { useState, useCallback } from 'react';

const EMPTY = { results: null, kind: null, stale: false };

// The results slot shared by the run hooks (browser sim, both optimisers).
//
// A new run does not clear the old results (that unmounted the results tree
// and reset its tabs): `begin(kind)` keeps them mounted and marks them
// `stale` until `publish` replaces them, and a failed or stopped run leaves
// them stale. That only holds for results of the SAME kind as the run being
// started; results of another kind (a zone run's figures while a guild trial
// runs) are not "the previous run" of anything on screen, so `begin` clears
// them and the pane shows its progress/empty state instead.
//
// `kind` is any value compared with ===; hooks with a single kind of run can
// leave it out.
export function useRunResults() {
  const [state, setState] = useState(EMPTY);

  // The one way a finished run's results are shown: new results are never stale.
  const publish = useCallback((results, kind = null) => {
    setState({ results, kind, stale: false });
  }, []);

  const begin = useCallback((kind = null) => {
    setState((prev) => (prev.results != null && prev.kind === kind
      ? { ...prev, stale: true }
      : EMPTY));
  }, []);

  const clear = useCallback(() => setState(EMPTY), []);

  return { results: state.results, stale: state.stale, publish, begin, clear };
}
