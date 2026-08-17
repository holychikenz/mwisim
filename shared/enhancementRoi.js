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
 * The universal protection item. Works on any piece, and is craftable — 200
 * shards — which is what makes it the one protection a player can reliably put a
 * time to.
 */
export const MIRROR_OF_PROTECTION = '/items/mirror_of_protection';

/**
 * How a protect is priced. Three modes, mutually exclusive.
 *
 * `cheapest` — the cheapest priced candidate the item admits.
 * `mirror`   — always a Philosopher's Mirror, at whatever it costs.
 * `free`     — a mirror at zero, because the player already holds a stack.
 *
 * The third is not the same as an unpriced mirror, though the arithmetic is
 * identical. An unpriced input is a hole in the data and makes every figure a
 * lower bound; a free one is a CLAIM the player has made about their own
 * situation, and is as trustworthy as anything else they typed. Hence
 * `assumedFree` on the chosen row: the caller must not flag it as missing.
 */
export const PROTECTION_PRICING = Object.freeze({
  CHEAPEST: 'cheapest',
  MIRROR: 'mirror',
  FREE: 'free',
});

/**
 * Which protection item to cost an enhancement against, and at what price.
 *
 * The choice between the first two modes is a question about DATA as much as
 * about play. An item's own protection — a Chaotic Chain, an Acrobat's Ribbon —
 * is drop-only, absent from the production-time map, and therefore unpriceable
 * without the player typing a number for every single one. A mirror is craftable,
 * universal, and needs pricing exactly once. So `mirror` collapses a dozen
 * unanswerable questions into one answerable one.
 *
 * `mirror` is honoured even when the mirror itself has no price. The alternative
 * — silently falling back to the cheapest of the others — would mean a mode
 * labelled *always a mirror* sometimes did something else, which is worse than a
 * cost of zero that the caller is told about and can flag.
 *
 * `free` returns the mirror at **zero, deliberately**, marked `assumedFree` so
 * the caller can tell an asserted zero from an absent one. It is the honest
 * version of the state a fresh install already lands in — an unpriced mirror
 * costs nothing either — with two differences: the panel stops calling the
 * figure a lower bound, and the player is expected to pin down where protecting
 * starts, because a solver handed free protects will protect from +2 and spend
 * fifty-nine of them on a single hood. See `forcedProtectLevel`.
 *
 * `cheapest` takes the cheapest **priced** candidate. An unpriced one must not
 * win by default, and that is not hypothetical — the server's own selection
 * reads `if pc and pc < cheapest`, where a zero is falsy and so silently
 * skipped, leaving it to fall back to the mirror without saying so.
 *
 * @param {Array<{hrid: string, effective: number|null}>} candidates
 * @param {object} [opts]
 * @param {string} [opts.protectionPricing] one of PROTECTION_PRICING
 * @returns {object|null} the chosen candidate, or null when there are none
 */
export function chooseProtection(
  candidates,
  { protectionPricing = PROTECTION_PRICING.CHEAPEST } = {}
) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return null;

  if (protectionPricing === PROTECTION_PRICING.FREE) {
    const mirror = list.find((row) => row.hrid === MIRROR_OF_PROTECTION);
    // No mirror offered is null rather than a substitution, exactly as in
    // `mirror` mode: a caller that meant "free mirrors" should not be handed a
    // free Chaotic Chain without being told.
    return mirror ? { ...mirror, effective: 0, assumedFree: true } : null;
  }

  if (protectionPricing === PROTECTION_PRICING.MIRROR) {
    return list.find((row) => row.hrid === MIRROR_OF_PROTECTION) || null;
  }

  const priced = list.filter((row) => Number.isFinite(row.effective));
  if (!priced.length) return list[0];
  return priced.reduce((best, row) => (row.effective < best.effective ? row : best));
}

/**
 * The protect level to force, or null to let the solver minimise.
 *
 * The coupling rule lives here, in one function, because it is a judgement and
 * not a detail: **only free protections force a level.** When a protect has a
 * price, minimising over where protecting starts answers a real question — the
 * cost and the count trade off against each other and the solver balances them.
 * When a protect is free that trade vanishes, the minimum is always "protect
 * from the earliest level the chain allows", and the answer it gives is a
 * fantasy: 59.3 mirrors for an Acrobatic Hood's +8, 1,472 for its +13. Free but
 * FINITE is the real situation, and a forced level is how a finite stack is
 * expressed.
 *
 * @param {object} [args]
 * @param {string} [args.protectionPricing]
 * @param {number} [args.protectAt]
 * @returns {number|null}
 */
export function forcedProtectLevel({ protectionPricing, protectAt } = {}) {
  if (protectionPricing !== PROTECTION_PRICING.FREE) return null;
  const level = Math.round(Number(protectAt));
  if (!Number.isFinite(level) || level < 1) return null;
  return level;
}

/**
 * Which row of an `/api/enhance/calculate` response to believe.
 *
 * The endpoint returns one row per protection level — `protect_at` running from
 * 2 to the target — and the default is to take the cheapest, since a player free
 * to choose where to start protecting will choose well.
 *
 * With `protectAt` set the cheapest is the wrong row: the player is telling us
 * their policy, and a policy costs what it costs. The level is CLAMPED into the
 * range the response offers, which is not a fudge but an identity. Attempts are
 * made from states 0 … target−1, and the Markov step is
 * `dest = i - 1 if i >= protect_at else 0`, so the top row — `protect_at`
 * equal to the target — has no state that protects and therefore IS "never
 * protect". Forcing +7 on a programme that stops at +5 means exactly that: no
 * attempt in it ever reaches the level where you would spend a mirror. Clamping
 * to the top row expresses the policy faithfully rather than approximating it,
 * which is also what keeps a marginal cost positive — both sides of the
 * difference are then the same policy, and reaching a higher level under one
 * policy cannot be cheaper than reaching a lower one.
 *
 * @param {Array<object>} rows  the response's `rows`, server-shaped (snake_case)
 * @param {object} [opts]
 * @param {number|null} [opts.protectAt] forced level, or null to minimise
 * @returns {{protectAt: number, totalCost: number, protects: number|null,
 *           requestedProtectAt: number|null, clamped: boolean}|null}
 */
export function pickProtectionRow(rows, { protectAt = null } = {}) {
  const usable = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((row) => ({
      protectAt: Number(row.protect_at),
      totalCost: Number(row.total_cost),
      protects: Number.isFinite(Number(row.protects)) ? Number(row.protects) : null,
    }))
    .filter((row) => Number.isFinite(row.protectAt) && Number.isFinite(row.totalCost));
  if (!usable.length) return null;

  // `protectAt == null` before `Number()`, because `Number(null)` is 0 and
  // `Number('')` is 0 — either would arrive here as a perfectly finite request to
  // protect from level zero, and quietly clamp "let the solver choose" into "start
  // protecting as early as the chain allows", which is the single most expensive
  // wrong answer this function can give.
  const requested = protectAt == null || protectAt === '' ? NaN : Math.round(Number(protectAt));
  if (!Number.isFinite(requested)) {
    // Minimising here rather than trusting the response's own `optimal_prot`
    // keeps this honest if the server's tie-breaking ever changes.
    const best = usable.reduce((b, row) => (row.totalCost < b.totalCost ? row : b));
    return { ...best, requestedProtectAt: null, clamped: false };
  }

  const levels = usable.map((row) => row.protectAt);
  const wanted = Math.min(Math.max(requested, Math.min(...levels)), Math.max(...levels));
  // Rows are contiguous in every response the endpoint produces, so the exact
  // match is the normal path; nearest-level is a guard against a future gap
  // rather than a case anyone has seen.
  const chosen =
    usable.find((row) => row.protectAt === wanted) ||
    usable.reduce((b, row) =>
      Math.abs(row.protectAt - wanted) < Math.abs(b.protectAt - wanted) ? row : b
    );
  return { ...chosen, requestedProtectAt: requested, clamped: chosen.protectAt !== requested };
}

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
 * Enhancing time that buys ONE UNIT of whatever the scan ranked on.
 *
 * The companion to `breakEvenHours`, for objectives that are not rates. A
 * labyrinth scan ranks on completion chance, a proportion, so there is no hour
 * count for it to "repay itself" in — but "how much enhancing buys a percentage
 * point of clear rate" is a perfectly well-formed question, and it is the one a
 * player allocating a fixed enhancing budget across slots actually asks.
 *
 * The two are closer than they look. Substituting `gain/base` into break-even
 * gives `(cost/3600) / relativeGain` — so a pay-back time IS this function with
 * the RELATIVE gain as its denominator. That is why break-even reads as hours of
 * combat: dividing enhancing hours by a fractional improvement in a rate happens
 * to yield the horizon at which the improvement has repaid the outlay.
 *
 * For a bounded objective, pass the ABSOLUTE gain instead. The result is then
 * hours of enhancing per unit of it — per percentage point of clear rate — which
 * is legible on its own terms and makes no claim about repayment.
 *
 * Same conventions as `breakEvenHours`, deliberately, so a caller can swap one
 * for the other and change nothing else: null for "no answer", smaller is
 * better, and a non-positive gain never qualifies.
 *
 * @param {object} args
 * @param {number} args.costSeconds    seconds to buy the level
 * @param {number} args.gainPerLevel   ABSOLUTE gain in the objective, per level
 * @returns {number|null} hours of enhancing per unit, or null
 */
export function enhancingHoursPerUnit({ costSeconds, gainPerLevel }) {
  if (!isUsableEnhancementCost(costSeconds)) return null;
  const gain = Number(gainPerLevel);
  // A level that buys nothing — or costs clear rate, as an enhanced pouch might
  // by pushing the build past a breakpoint — buys no units at any price. null
  // rather than Infinity, so the caller renders "never" instead of propagating
  // an infinity into arithmetic that quietly becomes NaN.
  if (!Number.isFinite(gain) || !(gain > 0)) return null;
  return Number(costSeconds) / SECONDS_PER_HOUR / gain;
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
 * expected cost of reaching a target, one row per level at which protecting
 * begins; `pickProtectionRow` decides which row to believe. The cost of the NEXT
 * level is therefore the difference between the chosen programme that reaches N+1
 * and the chosen programme that reaches N.
 *
 * Two things make this cleaner than it looks. The item's own acquisition cost
 * appears once on each side and cancels, so a sunk base price does not pollute a
 * marginal figure. And minimising each side independently is the right economic
 * question — "what does an extra level cost me if I play optimally at each
 * target" — rather than holding the protection point fixed at a level that was
 * only optimal for the shorter programme.
 *
 * A FORCED protect level (see `pickProtectionRow`) holds it fixed on purpose,
 * which is not the same mistake: the level is the player's stated policy rather
 * than an artefact of the shorter programme, both sides are held at the same one,
 * and the difference is then the marginal cost of a level under that policy.
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
