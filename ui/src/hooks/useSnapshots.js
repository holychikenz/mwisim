import { useEffect, useState } from 'react';
import {
  loadSnapshots, SNAPSHOTS_EVENT, USERSCRIPT_EVENT, hasUserscriptAnswered, userscriptStatus, USERSCRIPT_TIMEOUT_MS,
  loadPromptDismissed, savePromptDismissed, PROMPT_DISMISSED_EVENT
} from '../utils/characterSnapshots';

/** [dismissed, setDismissed] for the install prompt, shared by every component showing it. */
export function usePromptDismissed() {
  const [dismissed, setDismissed] = useState(loadPromptDismissed);
  useEffect(() => {
    const sync = (e) => setDismissed(Boolean(e.detail));
    window.addEventListener(PROMPT_DISMISSED_EVENT, sync);
    return () => window.removeEventListener(PROMPT_DISMISSED_EVENT, sync);
  }, []);
  return [dismissed, savePromptDismissed];
}

/** The stored game snapshots, re-read whenever the userscript bridge writes new ones. */
export function useSnapshots() {
  const [snapshots, setSnapshots] = useState(loadSnapshots);
  useEffect(() => {
    const reload = () => setSnapshots(loadSnapshots());
    window.addEventListener(SNAPSHOTS_EVENT, reload);
    reload(); // a write between the first render and this effect fired no listener
    return () => window.removeEventListener(SNAPSHOTS_EVENT, reload);
  }, []);
  return snapshots;
}

/** Whether the csim-import userscript is installed (userscriptStatus), given the snapshot count. */
export function useUserscriptStatus(snapshotCount) {
  const [answered, setAnswered] = useState(hasUserscriptAnswered);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const check = () => setAnswered(hasUserscriptAnswered());
    window.addEventListener(USERSCRIPT_EVENT, check);
    check();
    // shortcut: timed from mount, not from READY; both are at startup for CharacterImport.
    const timer = setTimeout(() => setTimedOut(true), USERSCRIPT_TIMEOUT_MS);
    return () => {
      window.removeEventListener(USERSCRIPT_EVENT, check);
      clearTimeout(timer);
    };
  }, []);
  return userscriptStatus({ answered, timedOut, snapshotCount });
}
