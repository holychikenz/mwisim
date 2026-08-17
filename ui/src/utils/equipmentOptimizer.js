// =============================================================================
// equipmentOptimizer — config defaults, persistence and pure helpers for the
// Equipment Optimizer panel.
//
// Kept out of the components because ui/eslint.config.js enables
// react-refresh/only-export-components: a .jsx file that exports a component may
// not also export constants or helpers.
// =============================================================================

import { PROTECTION_PRICING } from '../../../shared/enhancementRoi.js';

/** localStorage key, following the UI's `csim_*` convention. */
export const EQUIPMENT_OPT_KEY = 'csim_equipment_optimizer';

/**
 * Defaults, mirroring api/lib/equipmentScan/scan.js.
 *
 * `step` is the one worth understanding. A single +1 on one piece moves
 * encounters/hour by far less than the Monte-Carlo noise on any zone worth
 * optimising for, so probing +1 directly measures nothing. Six levels lifts the
 * signal clear of the floor and the result is divided back down. Lower it and
 * the run will mostly report "within noise"; raise it and the linearity
 * assumption stretches further than the multiplier table supports.
 *
 * `replicates` is what buys the error bar. Two is the floor for having one at
 * all; six gives five degrees of freedom, which is where Student-t stops being
 * punitive, and costs six times a single pass — which on measured throughput is
 * still seconds.
 */
export const DEFAULT_EQUIPMENT_OPT_CONFIG = {
  hours: 24,
  replicates: 6,
  step: 6,
  alpha: 0.05,
  workers: null, // null = let the server size the pool from its core count

  /**
   * How a protect is priced when costing an enhancement: `cheapest`, `mirror` or
   * `free` (see PROTECTION_PRICING in shared/enhancementRoi.js).
   *
   * `mirror` by default, and the default is a judgement about DATA rather than
   * about play. An item's own protection is drop-only — a Chaotic Chain, an
   * Acrobat's Ribbon — so it is absent from the production-time map and
   * unpriceable until the player types a number for every one of them. A mirror
   * is craftable, works on any piece, and needs pricing exactly once. Defaulting
   * to `cheapest` would mean the return-on-investment column reads zero for most
   * protections until a dozen drop-only items have been costed by hand, which is
   * a poor first impression of a number that is supposed to be trustworthy.
   */
  protectionPricing: PROTECTION_PRICING.MIRROR,

  /**
   * Where protecting starts, when protections are free.
   *
   * Read only in `free` mode — `forcedProtectLevel` owns that rule and explains
   * it. +7 because that is where a protect stops being a luxury: the failure
   * chance is high enough by then that an unprotected attempt can cost several
   * levels, and it is the answer most players give when asked where they begin.
   */
  protectAt: 7,
};

/** The bounds the "protect from" control offers. Below +2 nothing can protect. */
export const MIN_PROTECT_AT = 2;
export const MAX_PROTECT_AT = 20;

/** Turn the flat UI config into the `scan` object the API takes. */
export function toScan(config) {
  const cfg = { ...DEFAULT_EQUIPMENT_OPT_CONFIG, ...(config || {}) };
  return {
    hours: cfg.hours,
    replicates: cfg.replicates,
    step: cfg.step,
    alpha: cfg.alpha,
  };
}

/**
 * Very rough wall-clock estimate, in seconds.
 *
 * Deliberately crude — it exists so a user can tell "a few seconds" from "a few
 * minutes" before committing. The constant is the same pessimistic one the
 * trigger optimiser uses and is documented there: measured throughput is 4-5
 * simulated hours per second per worker, rounded down to 3 so the estimate errs
 * slow. A user told two minutes who waits ninety seconds is content; the reverse
 * is not true.
 */
export function estimateSeconds(workload, workerCount = 4) {
  if (!workload?.simulatedHours) return null;
  const HOURS_PER_SECOND_PER_WORKER = 3;
  return workload.simulatedHours / (HOURS_PER_SECOND_PER_WORKER * Math.max(1, workerCount));
}

/** Human-readable duration from seconds. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

/**
 * A signed percentage with a fixed number of decimals, or an em dash.
 *
 * Signed on purpose: an enhancement that makes a build WORSE is a real and
 * useful finding (an off-hand that slows a two-hander's rotation, say), and an
 * unsigned "0.12%" would read as a gain.
 */
export function formatSignedPct(fraction, decimals = 3) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  const pct = fraction * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

/** Unsigned percentage, for margins and shares. */
export function formatPct(fraction, decimals = 2) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** `/items/kraken_tunic` → `kraken tunic`. */
export function lastSegment(hrid) {
  return String(hrid || '').split('/').pop().replace(/_/g, ' ');
}

/**
 * The verdict for a row, as a small vocabulary the results table renders.
 *
 * Three levels rather than two, because "this beat the noise" and "this beat the
 * noise even after allowing for having asked the same question of fourteen
 * slots" are genuinely different claims, and the top of a ranked table is
 * precisely where the difference matters.
 */
export function verdictOf(row) {
  if (!row) return 'unknown';
  if (row.significantFamilywise) return row.perLevel >= 0 ? 'strong-gain' : 'strong-loss';
  if (row.significant) return row.perLevel >= 0 ? 'gain' : 'loss';
  return 'noise';
}

export const VERDICT_LABELS = {
  'strong-gain': 'Clear gain',
  gain: 'Likely gain',
  'strong-loss': 'Clear loss',
  loss: 'Likely loss',
  noise: 'Within noise',
  unknown: '—',
};

/**
 * The old boolean, carried forward.
 *
 * `alwaysUseMirror` became one value of a three-way mode. Merging over defaults
 * is not enough on its own: a user who deliberately turned the switch OFF has
 * `alwaysUseMirror: false` saved, and would silently get the mirror back. The old
 * key is read once, translated, and dropped.
 */
export function migrateEquipmentOptConfig(stored) {
  const config = { ...DEFAULT_EQUIPMENT_OPT_CONFIG, ...(stored || {}) };
  if (!stored || 'protectionPricing' in stored || !('alwaysUseMirror' in stored)) {
    delete config.alwaysUseMirror;
    return config;
  }
  config.protectionPricing = stored.alwaysUseMirror
    ? PROTECTION_PRICING.MIRROR
    : PROTECTION_PRICING.CHEAPEST;
  delete config.alwaysUseMirror;
  return config;
}

export function loadEquipmentOptState() {
  try {
    const raw = JSON.parse(localStorage.getItem(EQUIPMENT_OPT_KEY) || 'null');
    if (!raw || typeof raw !== 'object') {
      return { config: { ...DEFAULT_EQUIPMENT_OPT_CONFIG }, selection: null };
    }
    return {
      // Merge over defaults so a config saved by an older build gains new keys
      // rather than arriving with them undefined.
      config: migrateEquipmentOptConfig(raw.config),
      selection: Array.isArray(raw.selection) ? raw.selection : null,
    };
  } catch {
    return { config: { ...DEFAULT_EQUIPMENT_OPT_CONFIG }, selection: null };
  }
}

export function saveEquipmentOptState(state) {
  try {
    localStorage.setItem(EQUIPMENT_OPT_KEY, JSON.stringify(state));
  } catch {
    // Quota or private browsing — the session works, it just will not persist.
  }
}
