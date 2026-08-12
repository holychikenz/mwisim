// =============================================================================
// enhancementRoi — when does an enhancement level pay for itself?
//
// Shared by csim's two products:
//
//   ui/src/utils/enhancementCosts.js   — the Gear tab's return-on-investment column
//   api/tests/equipmentScan.test.mjs   — which is the only test runner csim has
//
// WHY THIS DIRECTORY. Same reasoning as consumableCost.js, its neighbour: not in
// src/combatsimulator/, which is upstream-tracked and vendored into the MWIX
// bundle, because what an enhancement is WORTH to a particular player is not a
// question the engine should hold an opinion on. And not in ui/, because ui/ has
// no test runner, and arithmetic that decides "grind this zone for nine hours
// before that necklace pays you back" should not be the one part of the feature
// nothing tests.
//
// THE IDEA. The equipment scan measures a gain in EFFECTIVE encounters per hour —
// encounters per hour of total time, combat plus the production owed for every
// consumable burned. The cow webapp's enhancement simulator, in iron-cow mode,
// reports what a level COSTS in seconds. Both sides are therefore denominated in
// the same currency, and the honest comparison falls out without needing to
// invent an exchange rate between coins and time.
//
// It is not, however, a ratio. Spending C seconds enhancing and then grinding for
// T hours gives an overall rate of
//
//     E_new * T / (T + C/3600)
//
// because the enhancing time is real time too, and it is paid once while the gain
// accrues for as long as you keep fighting. Setting that equal to E_old and
// solving gives the break-even:
//
//     T  =  (C / 3600) * E_old / (E_new - E_old)
//
// — the number of COMBAT HOURS before the enhancement has repaid the time it
// cost. That is the figure to rank on, and it can invert the ranking by raw gain
// completely: a 0.18% gain costing four minutes beats a 1.3% gain costing a week.
// =============================================================================

/** Seconds in an hour. Both sides of the trade are denominated in seconds. */
const SECONDS_PER_HOUR = 3600;

/**
 * Is this a usable cost in seconds?
 *
 * Deliberately STRICTER than consumableCost's isKnownCost, which admits 0.
 * There, a zero is a real claim a user can make about their own situation ("this
 * food reaches me free"). Here the number comes from a recursive production-time
 * walker that returns 0.0 for anything it cannot resolve — a drop-only item, a
 * material with no acquisition route — so a zero is very nearly always "unknown"
 * wearing the costume of "free", and treating it as free would report an
 * instant, infinite return on the items we understand least.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUsableEnhancementCost(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

/**
 * Combat hours before an enhancement repays the time it cost.
 *
 * @param {object} args
 * @param {number} args.costSeconds   seconds to buy the level (materials + attempts)
 * @param {number} args.baselineRate  effective encounters/hour before
 * @param {number} args.gainPerHour   ABSOLUTE gain in that rate, per level
 * @returns {number|null} hours, or null when it never repays or cannot be computed
 */
export function breakEvenHours({ costSeconds, baselineRate, gainPerHour }) {
  if (!isUsableEnhancementCost(costSeconds)) return null;
  const base = Number(baselineRate);
  const gain = Number(gainPerHour);
  if (!Number.isFinite(base) || !Number.isFinite(gain)) return null;
  // A level that costs time and buys nothing — or costs throughput, as an
  // enhanced Guzzling Pouch does — never repays. null, not Infinity: the caller
  // must render "never", and Infinity invites arithmetic that quietly produces
  // NaN somewhere downstream.
  if (!(gain > 0) || !(base > 0)) return null;
  return (Number(costSeconds) / SECONDS_PER_HOUR) * (base / gain);
}

/**
 * Effective rate actually achieved over a finite grinding horizon, counting the
 * enhancing time as part of it.
 *
 * The figure that makes break-even concrete: at exactly the break-even horizon
 * this equals the baseline, below it you are behind, above it ahead.
 *
 * @param {object} args
 * @param {number} args.costSeconds
 * @param {number} args.improvedRate  effective encounters/hour after the level
 * @param {number} args.horizonHours  how long you intend to keep fighting
 * @returns {number|null}
 */
export function amortisedRate({ costSeconds, improvedRate, horizonHours }) {
  const rate = Number(improvedRate);
  const hours = Number(horizonHours);
  const cost = Number(costSeconds);
  if (!Number.isFinite(rate) || !Number.isFinite(hours) || !(hours > 0)) return null;
  if (!Number.isFinite(cost) || cost < 0) return null;
  return (rate * hours) / (hours + cost / SECONDS_PER_HOUR);
}

/**
 * Marginal cost of one level, from two whole-programme costs.
 *
 * The cow webapp's Markov solver always starts a fresh item at +0 and reports the
 * expected cost of reaching a target, minimised over where you start protecting.
 * The cost of the NEXT level is therefore the difference between the cheapest
 * programme that reaches N+1 and the cheapest that reaches N.
 *
 * Two things make this cleaner than it looks. The item's own acquisition cost
 * appears once on each side and cancels, so a sunk base price does not pollute a
 * marginal figure. And minimising each side independently is the right economic
 * question — "what does an extra level cost me if I play optimally at each
 * target" — rather than holding the protection point fixed at a level that was
 * only optimal for the shorter programme.
 *
 * @param {number|null} costToTarget      cheapest total to reach N+1, in seconds
 * @param {number|null} costToCurrent     cheapest total to reach N, in seconds
 * @returns {number|null} seconds, or null when either side is unavailable
 */
export function marginalCostFromTargets(costToTarget, costToCurrent) {
  const to = Number(costToTarget);
  const from = Number(costToCurrent);
  if (!Number.isFinite(to) || !Number.isFinite(from)) return null;
  const marginal = to - from;
  // A negative marginal cost is not a bargain, it is a broken input: reaching a
  // higher level cannot be cheaper than reaching a lower one under the same
  // configuration. Refuse it rather than reporting a level that pays instantly.
  return marginal > 0 ? marginal : null;
}
