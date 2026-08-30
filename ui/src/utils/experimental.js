// =============================================================================
// experimental — the UI side of the engine's EXPERIMENTAL knobs
// (src/combatsimulator/simSettings.js).
//
// These are deliberately kept out of the session blob and in their own
// localStorage key: they are a bench setting, not part of a build, and must not
// travel with an exported/imported loadout. A shared build that silently
// carried someone else's experiment would be a trap.
//
// Every default here MUST equal the engine's default, so a fresh browser and a
// fresh worker agree on what "off" means.
// =============================================================================

const KEY = 'csim_experimental';

export const EXPERIMENTAL_DEFAULTS = Object.freeze({
  // "auto"   = labyrinth gets "half", everything else "random" — each context
  //            gets the model measured for it (see simSettings.js)
  // "random" = force upstream everywhere (U[0.5, 1.0)*CD, mean 0.75)
  // "half"   = force a flat 0.5*CD everywhere
  monsterStartCooldown: 'auto'
});

export function loadExperimental() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw && typeof raw === 'object'
      ? { ...EXPERIMENTAL_DEFAULTS, ...raw }
      : { ...EXPERIMENTAL_DEFAULTS };
  } catch {
    return { ...EXPERIMENTAL_DEFAULTS };
  }
}

export function saveExperimental(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Quota or private browsing — the setting still applies this session.
  }
}

// How many knobs are away from their default — drives the cog's indicator, so
// an experiment left on overnight cannot quietly poison tomorrow's numbers.
export function countExperimentsOn(settings) {
  if (!settings) return 0;
  return Object.keys(EXPERIMENTAL_DEFAULTS).filter(
    k => settings[k] !== EXPERIMENTAL_DEFAULTS[k]
  ).length;
}
