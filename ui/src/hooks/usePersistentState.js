import { useEffect, useState } from 'react';

// useState that survives re-runs and reloads, for UI CHOICES ONLY (open tab,
// panel open/closed, sort order). Never use it for data or session state.
//
// - Keys MUST start with 'csim_ui_' (see DESIGN.md, "Persistence").
// - The stored value is read once, synchronously, so there is no flash of the
//   default. A value that fails `validate` (or is corrupt, or storage is
//   blocked) is ignored and the default is used.
// - Callers that compute a fallback (e.g. a remembered tab not offered in this
//   view) should NOT write it back, so the choice returns when it applies again.
export function usePersistentState(key, defaultValue, validate) {
  if (import.meta.env.DEV && !key.startsWith('csim_ui_')) {
    console.warn(`usePersistentState: key "${key}" should start with "csim_ui_"`);
  }
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const v = JSON.parse(raw);
        if (!validate || validate(v)) return v;
      }
    } catch {
      /* storage blocked or corrupt: fall through to the default */
    }
    return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked or full: the choice just won't persist */
    }
  }, [key, value]);
  return [value, setValue];
}

export const oneOf = (list) => (v) => list.includes(v);
export const isBool = (v) => typeof v === 'boolean';
