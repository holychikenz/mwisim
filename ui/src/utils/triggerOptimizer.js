// =============================================================================
// triggerOptimizer — config defaults, persistence and small pure helpers for the
// Trigger Optimizer panel.
//
// Kept out of the components because ui/eslint.config.js enables
// react-refresh/only-export-components: a .jsx file that exports a component may
// not also export constants or helpers.
// =============================================================================

import { priceOf } from './prices';

/** localStorage key, following the UI's `csim_*` convention. */
export const TRIGGER_OPT_KEY = 'csim_trigger_optimizer';

/**
 * Every consumable the party has slotted, with its fetched cost, its hand-entered
 * override and the one that will actually be used. Deduplicated by item, in slot
 * order, so it doubles as the row list for the override editor.
 *
 * `fetched` is null when the price source cannot answer — either it is not
 * seconds-denominated at all, or the cow webapp has no value for that item (which
 * buildIronPrices stores as -1 and priceOf flattens to 0; the two are
 * indistinguishable by the time we see them, so both read as "unknown").
 *
 * `override` is null only when there is NO override. Zero is a real override and
 * survives here, which is the whole point: an item that arrives free costs nothing
 * at the margin, and that is a fact about the player's situation which no fetched
 * production time can know.
 *
 * @param {object[]} playerDTOs  engine DTOs (consumables keyed `hrid`)
 * @param {object} pricing       { prices, unit, expenseMode, consumableCostOverrides }
 * @returns {Array<{hrid: string, fetched: number|null, override: number|null, effective: number|null}>}
 */
export function describeConsumableCosts(playerDTOs, pricing) {
  // expenseMode, because a consumable is a cost, not a receipt.
  const usable = pricing?.unit === 'seconds' && pricing?.prices ? pricing.prices : null;
  const overrides = pricing?.consumableCostOverrides || {};
  const rows = [];
  const seen = new Set();

  for (const player of playerDTOs || []) {
    for (const slotKind of ['food', 'drinks']) {
      for (const slot of player?.[slotKind] || []) {
        const hrid = slot?.hrid;
        if (!hrid || seen.has(hrid)) continue;
        seen.add(hrid);

        const raw = usable ? priceOf(usable, hrid, pricing.expenseMode || 'ask') : null;
        const fetched = Number.isFinite(raw) && raw > 0 ? raw : null;

        const overrideRaw = Number(overrides[hrid]);
        const override =
          overrides[hrid] != null && Number.isFinite(overrideRaw) && overrideRaw >= 0
            ? overrideRaw
            : null;

        rows.push({ hrid, fetched, override, effective: override ?? fetched });
      }
    }
  }
  return rows;
}

/**
 * Production time, in seconds per unit, for every consumable the party has slotted.
 *
 * This is what makes a consumable threshold optimisable honestly. Under a raw
 * encounters-per-hour objective, eating more often is nearly free — measured, a
 * food threshold driven from 400 to 1 bought +0.37% throughput for 44 donuts an
 * hour from a standing start of zero. Denominating the cost in TIME rather than
 * coins puts both sides of that trade in the same unit, and the recommendation
 * inverts: the search then prefers the setting that eats nothing.
 *
 * Only the `iron` price source yields seconds (usePrices sets unit: 'seconds' from
 * buildIronPrices, sourced from the cow webapp). On `vendor` or `market` the values
 * are coins, which are NOT commensurable with combat time, so we return null and
 * let the optimiser fall back to raw throughput — with the UI warning that the food
 * bill is not being counted. Overrides are an adjustment to a seconds-denominated
 * table, not a substitute for one: a half-priced table would silently treat every
 * un-overridden item as free, which is exactly the bias this function exists to
 * remove.
 *
 * @param {object[]} playerDTOs  engine DTOs (consumables keyed `hrid`)
 * @param {object} pricing       the usePrices() return value
 * @returns {Record<string, number>|null} itemHrid → seconds each
 */
export function buildConsumableCosts(playerDTOs, pricing) {
  if (!pricing || pricing.unit !== 'seconds' || !pricing.prices) return null;

  const costs = {};
  for (const row of describeConsumableCosts(playerDTOs, pricing)) {
    // An unknown item is omitted, so it contributes nothing rather than a negative
    // cost. An explicit 0 is KEPT: it contributes nothing either, but it keeps the
    // table non-empty and so keeps the objective time-denominated, which matters
    // when every consumable in the build has been declared free.
    if (row.effective != null) costs[row.hrid] = row.effective;
  }
  return Object.keys(costs).length ? costs : null;
}

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
