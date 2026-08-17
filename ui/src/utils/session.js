// =============================================================================
// session — the auto-saved working session (party, zone, tier, duration)
//
// WHY THIS EXISTS AS A MODULE. The session used to be restored by an effect
// inside ImportExport, sitting BELOW that component's auto-save effect. Effects
// run in declaration order, so on every mount the save fired first and wrote the
// app's blank defaults over the stored session; the restore then dutifully read
// back the emptiness it had just been handed. The result was a feature that
// looked implemented and never once worked: party, levels, equipment, zone, tier
// and duration were erased milliseconds before being "restored". Storing
// Twilight Zone T3 / 42 h and reloading gave Smelly Planet T0 / 100 h.
//
// Guarding the save with a ref fixes production but not development, where
// StrictMode mounts twice and the second save runs after the guard has been set
// but before the restore's state updates have landed.
//
// So the session is read during STATE INITIALISATION instead (App.jsx), which is
// how every other persisted slice in this UI already works — the guild-trial
// roster, both optimiser configs, the sweep selection. There is no ordering to
// get wrong: the first render already holds the restored values, and the first
// save writes back exactly what was read.
// =============================================================================

export const SESSION_KEY = 'csim_player_data';

/**
 * The stored session, or null. Every field is validated by the caller's own
 * defaults — a partially-written store should cost you that field, not the app.
 */
export function loadSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

export function saveSession(data) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // Quota or private browsing — the session still works, it just will not persist.
  }
}
