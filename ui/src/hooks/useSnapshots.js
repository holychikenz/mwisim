import { useEffect, useState } from 'react';
import { loadSnapshots, SNAPSHOTS_EVENT } from '../utils/characterSnapshots';

/** The stored game snapshots, re-read whenever the userscript bridge writes new ones. */
export function useSnapshots() {
  const [snapshots, setSnapshots] = useState(loadSnapshots);
  useEffect(() => {
    const reload = () => setSnapshots(loadSnapshots());
    window.addEventListener(SNAPSHOTS_EVENT, reload);
    return () => window.removeEventListener(SNAPSHOTS_EVENT, reload);
  }, []);
  return snapshots;
}
