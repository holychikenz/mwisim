// =============================================================================
// grids — the candidate value sets swept for each searchable threshold
//
// Three unit kinds, because the seven numerically-searchable trigger
// conditions do not share a scale:
//
//   percentage  lowest_hp_percentage                  → 0..100
//   absolute    current_hp / missing_hp /
//               current_mp / missing_mp               → 1..ceiling (points)
//   count       number_of_active_units /
//               number_of_dead_units                  → 0..ceiling (integers)
//
// The peer fork (see TRIGGER-OPTIMIZER.md) special-cases only
// lowest_hp_percentage and treats everything else as "absolute, 1000-point
// steps". For number_of_active_units — an integer count of one to perhaps four
// monsters — a 1000-point grid is meaningless: every point past the first
// collapses to the same behaviour. Hence the third kind.
//
// Absolute steps are DERIVED from the ceiling rather than fixed at the peer's
// 1000/200. Two reasons: a fixed step produces a two-point grid on a low-level
// zone and a two-hundred-point grid on a high-level one, and predictable grid
// sizes are what make the workload estimate in the UI honest.
// =============================================================================

/** Target number of points in a coarse absolute grid. */
export const COARSE_POINTS = 12;
/** Target number of points in a fine absolute or percentage grid. */
export const FINE_POINTS = 11;
/** Coarse percentage step, in percentage points. Matches the peer's 10%. */
export const COARSE_PERCENT_STEP = 10;
/** Fine percentage step. Matches the peer's 5%. */
export const FINE_PERCENT_STEP = 5;
/** Half-width of the fine percentage window, in percentage points. */
export const FINE_PERCENT_WINDOW = 10;

/**
 * Round `raw` up to the nearest "nice" number — 1, 2 or 5 times a power of ten.
 * Keeps grid values human-legible (500, 1000, 2000) instead of arithmetically
 * exact but unreadable (487, 974, 1461), which matters because the winning
 * value is shown to the user and typed back into the game by hand.
 *
 * @param {number} raw
 * @returns {number} at least 1
 */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = Math.pow(10, exponent);
  const normalised = raw / magnitude;
  const multiplier = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return Math.max(1, Math.round(multiplier * magnitude));
}

/** The coarse step an absolute grid of this ceiling will use. */
export function coarseAbsoluteStep(maxValue, targetPoints = COARSE_POINTS) {
  const ceiling = Math.max(1, Math.floor(maxValue));
  return niceStep(ceiling / Math.max(1, targetPoints));
}

/**
 * Coarse absolute grid: 1, then every `step` up to the ceiling, plus the
 * ceiling itself.
 *
 * 1 rather than 0 is the floor because these conditions are compared with
 * >= / <=, and `current_hp >= 0` is trivially always true — a wasted
 * simulation. `current_hp >= 1` means "target is alive", which is the engine's
 * own default trigger for damage abilities (abilityDetailMap: /abilities/smack).
 *
 * @param {number} maxValue
 * @param {number} [targetPoints]
 * @returns {number[]} ascending, deduplicated
 */
export function coarseAbsoluteGrid(maxValue, targetPoints = COARSE_POINTS) {
  const ceiling = Math.max(1, Math.floor(maxValue));
  const step = coarseAbsoluteStep(ceiling, targetPoints);
  const values = new Set([1]);
  for (let value = step; value <= ceiling; value += step) values.add(value);
  values.add(ceiling);
  return [...values].sort((a, b) => a - b);
}

/**
 * Fine absolute grid: `FINE_POINTS` values centred on `current`, at one fifth
 * of the coarse step, clamped to [1, ceiling], and always including `current`
 * itself so a fine pass can never score worse than the coarse pass that fed it.
 *
 * @param {number} current
 * @param {number} maxValue
 * @param {number} [step] coarse step to subdivide; derived when omitted
 * @returns {number[]} ascending, deduplicated
 */
export function fineAbsoluteGrid(current, maxValue, step = coarseAbsoluteStep(maxValue)) {
  const ceiling = Math.max(1, Math.floor(maxValue));
  const centre = Math.max(1, Math.min(ceiling, Math.round(current) || 1));
  const fineStep = Math.max(1, Math.round(step / 5));
  const half = Math.floor(FINE_POINTS / 2);
  const values = new Set([centre]);
  for (let i = -half; i <= half; i += 1) {
    const value = centre + i * fineStep;
    if (value >= 1 && value <= ceiling) values.add(value);
  }
  // Include the clamped window edges. Stepping outward from the centre can march
  // straight past a clamp without landing on it — e.g. centre 2000 with step 40
  // against a ceiling of 2025 gives 2000 then 2040, so the ceiling itself is never
  // tried. The edge is a legitimate and often meaningful value ("only when all
  // hitpoints are missing"), so add it when it falls inside the window's reach.
  values.add(Math.max(1, centre - half * fineStep));
  values.add(Math.min(ceiling, centre + half * fineStep));
  return [...values].sort((a, b) => a - b);
}

/**
 * Coarse percentage grid: 0, 10, 20 … 100.
 * 0 is kept (unlike the absolute grid) because `lowest_hp_percentage <= 0`
 * is a meaningful "an ally is dead" test rather than a tautology.
 *
 * @param {number} [step]
 * @returns {number[]}
 */
export function coarsePercentGrid(step = COARSE_PERCENT_STEP) {
  const safeStep = Math.max(1, Math.floor(step));
  const values = [];
  for (let value = 0; value <= 100; value += safeStep) values.push(value);
  if (values[values.length - 1] !== 100) values.push(100);
  return values;
}

/**
 * Fine percentage grid: `current` ± window, in 5s, clamped to [0, 100].
 *
 * Both `current` and the clamped window edges are added explicitly. Clamping can
 * otherwise knock a legitimate value off the grid in two different ways: current
 * itself (current = 3 gives a window starting at 0, and 0/5/10 never hits 3), and
 * the upper edge (current = 98 gives 88/93/98 and then steps past 100 without
 * landing on it — yet 100 is the engine's own default for Bloom).
 *
 * @param {number} current
 * @param {number} [window]
 * @param {number} [step]
 * @returns {number[]} ascending, deduplicated
 */
export function finePercentGrid(current, window = FINE_PERCENT_WINDOW, step = FINE_PERCENT_STEP) {
  const centre = Math.max(0, Math.min(100, Math.round(current) || 0));
  const safeStep = Math.max(1, Math.floor(step));
  const low = Math.max(0, centre - window);
  const high = Math.min(100, centre + window);
  const values = new Set([centre, low, high]);
  for (let value = low; value <= high; value += safeStep) values.add(value);
  return [...values].sort((a, b) => a - b);
}

/**
 * Count grid: every integer from 0 to the ceiling, plus the incumbent.
 *
 * Already exhaustive, so there is no coarse/fine distinction — a "fine" pass
 * over a count would re-simulate values it has already measured. `gridFor`
 * relies on that and returns this unchanged for both passes.
 *
 * The incumbent is included even when it EXCEEDS the ceiling. That happens for
 * real: a "when 2+ enemies are active" trigger on a single-spawn zone has a
 * ceiling of 1, and without this the incumbent would never be measured and so
 * could not appear in its own insensitivity band. (Such a trigger can never fire
 * in that zone at all — params.js flags it as unreachable so the UI can say so.)
 *
 * @param {number} maxValue
 * @param {number} [current]
 * @returns {number[]}
 */
export function countGrid(maxValue, current = null) {
  const ceiling = Math.max(1, Math.min(64, Math.floor(maxValue)));
  const values = new Set();
  for (let value = 0; value <= ceiling; value += 1) values.add(value);
  if (Number.isFinite(current) && current >= 0 && current <= 64) values.add(Math.floor(current));
  return [...values].sort((a, b) => a - b);
}

/**
 * Pick the grid for a searchable parameter.
 *
 * @param {{kind: 'percentage'|'absolute'|'count', maxValue: number}} param
 * @param {object} [opts]
 * @param {boolean} [opts.fine]     fine pass rather than coarse
 * @param {number}  [opts.current]  incumbent value; required for a fine pass
 * @returns {number[]}
 */
export function gridFor(param, { fine = false, current = 0 } = {}) {
  switch (param.kind) {
    case 'percentage':
      return fine ? finePercentGrid(current) : coarsePercentGrid();
    case 'count':
      // Exhaustive either way — see countGrid.
      return countGrid(param.maxValue, current);
    case 'absolute':
    default:
      return fine
        ? fineAbsoluteGrid(current, param.maxValue)
        : coarseAbsoluteGrid(param.maxValue);
  }
}

/**
 * How many simulations a coarse sweep of these parameters costs, before any
 * beam widening. Used by the UI's workload preview so a user can see the bill
 * before committing to a 72-hour verification run.
 *
 * @param {Array<{kind: string, maxValue: number}>} params
 * @returns {number}
 */
export function coarseGridSize(params) {
  return params.reduce((total, param) => total + gridFor(param, { fine: false }).length, 0);
}
