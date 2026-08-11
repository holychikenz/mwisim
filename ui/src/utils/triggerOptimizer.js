// =============================================================================
// triggerOptimizer — config defaults, persistence and small pure helpers for the
// Trigger Optimizer panel.
//
// Kept out of the components because ui/eslint.config.js enables
// react-refresh/only-export-components: a .jsx file that exports a component may
// not also export constants or helpers.
// =============================================================================

/** localStorage key, following the UI's `csim_*` convention. */
export const TRIGGER_OPT_KEY = 'csim_trigger_optimizer';

// Consumable pricing lives in ./consumableCosts.js — buildConsumableCosts for the
// table posted with a run, describeConsumableCosts for the override editor's rows.
// It moved out when the zone results began restating their own encounter rate the
// same way: that view has no business importing from the optimiser's own module.

/**
 * "3 min ago" / "2 days ago" for a cached-at timestamp.
 *
 * Prices are cached indefinitely and only refetched when asked, so the age is the
 * only cue a user has that a figure may have drifted from reality.
 */
export function formatAge(timestamp) {
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at <= 0) return null;
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  const days = Math.round(seconds / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Seconds → a compact human duration, for production-time figures. */
export function formatSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0s';
  if (value < 90) return `${Math.round(value)}s`;
  if (value < 5400) return `${Math.round(value / 60)} min`;
  return `${(value / 3600).toFixed(1)} h`;
}

/**
 * Stage hours mirror the backend's defaults (api/lib/triggerSearch/search.js),
 * which in turn mirror the peer fork's 6 / 12 / 24 / 72.
 *
 * `calibration.repeats` is the one setting worth understanding before changing:
 * those runs measure this build-and-zone's Monte-Carlo noise, and every stage's
 * ranking threshold is derived from it. Set it to 0 and the optimiser falls back
 * to a fixed 0.1% epsilon, which measured 57x too small on a hard zone — it will
 * then rank confidently on differences that are pure noise.
 */
export const DEFAULT_TRIGGER_OPT_CONFIG = {
  calibrationRepeats: 5,
  initialHours: 6,
  keepPerParam: 3,
  coarseHours: 12,
  beamWidth: 8,
  fineHours: 24,
  keep: 5,
  verifyHours: 72,
  stableMode: false,
  workers: null, // null = let the server size the pool from its core count
};

/** Stable identity for a trigger address, for selection sets and React keys. */
export function triggerKey(row) {
  return `${row.playerIndex}:${row.slotKind}:${row.slotIndex}:${row.triggerIndex}`;
}

/** The four address fields the API expects, stripped of display extras. */
export function toAddress(row) {
  return {
    playerIndex: row.playerIndex,
    slotKind: row.slotKind,
    slotIndex: row.slotIndex,
    triggerIndex: row.triggerIndex,
  };
}

/** Turn the flat UI config into the nested `stages` object the API takes. */
export function toStages(config) {
  const cfg = { ...DEFAULT_TRIGGER_OPT_CONFIG, ...(config || {}) };
  return {
    calibration: { repeats: cfg.calibrationRepeats },
    initial: { hours: cfg.initialHours, keepPerParam: cfg.keepPerParam },
    coarse: { hours: cfg.coarseHours, beamWidth: cfg.beamWidth },
    fine: { hours: cfg.fineHours, keep: cfg.keep },
    verify: { hours: cfg.verifyHours },
  };
}

/**
 * Very rough wall-clock estimate, in seconds.
 *
 * Deliberately crude — it exists so a user can tell "a minute" from "an hour"
 * before starting a run whose verification stage alone is 72 simulated hours per
 * finalist. Wrong by a factor of two is fine; wrong by a factor of fifty is not,
 * which is roughly what showing no estimate at all amounts to.
 */
export function estimateSeconds(workload, stages, workerCount = 4) {
  if (!workload || !stages) return null;
  const simulatedHours =
    (workload.calibration || 0) * stages.initial.hours +
    (workload.initial || 0) * stages.initial.hours +
    (workload.coarse || 0) * stages.coarse.hours +
    (workload.fine || 0) * stages.fine.hours +
    (workload.verify || 0) * stages.verify.hours;

  // Measured on this machine across three zones: ~4-5 simulated hours per second
  // per worker on a single-spawn zone, ~4.5 on a busy dungeon. Rounded DOWN to 3
  // so the estimate errs pessimistic — a user who is told two minutes and waits
  // ninety seconds is content; the reverse is not true. Throughput scales with
  // how many units are in each encounter, so a crowded zone will be slower.
  const HOURS_PER_SECOND_PER_WORKER = 3;
  return simulatedHours / (HOURS_PER_SECOND_PER_WORKER * Math.max(1, workerCount));
}

/** Human-readable duration from seconds. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

/**
 * Describe an insensitivity band as a range, which is how a user should read it.
 * A single value invites false precision; "40–60 behave identically" does not.
 */
export function formatBand(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.length === 1) return String(values[0]);
  const low = values[0];
  const high = values[values.length - 1];
  return low === high ? String(low) : `${low}–${high}`;
}

export function loadTriggerOptState() {
  try {
    const raw = JSON.parse(localStorage.getItem(TRIGGER_OPT_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { config: { ...DEFAULT_TRIGGER_OPT_CONFIG }, selection: null };
    return {
      // Merge over defaults so a config saved by an older build gains new keys
      // rather than arriving with them undefined.
      config: { ...DEFAULT_TRIGGER_OPT_CONFIG, ...(raw.config || {}) },
      selection: Array.isArray(raw.selection) ? raw.selection : null,
    };
  } catch {
    return { config: { ...DEFAULT_TRIGGER_OPT_CONFIG }, selection: null };
  }
}

export function saveTriggerOptState(state) {
  try {
    localStorage.setItem(TRIGGER_OPT_KEY, JSON.stringify(state));
  } catch {
    // Quota or private browsing — the session still works, it just will not persist.
  }
}
