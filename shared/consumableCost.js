// =============================================================================
// consumableCost — what food and drink cost, and what that does to a rate
//
// Shared by csim's two products:
//
//   api/lib/triggerSearch/score.js        — scores optimiser candidates
//   ui/src/utils/consumableCosts.js       — the zone and All Zones effective rates
//
// WHY THIS DIRECTORY. It is emphatically NOT in src/combatsimulator/, though
// that is the other place both products can reach. That directory is
// upstream-tracked and vendored wholesale into the MWIX Tampermonkey bundle
// (MWIX-RELATIONSHIP.md), so every file we add there surfaces in the upstream
// diff forever and ships to a consumer that has no use for it. Production-time
// economics are csim's own concern, not the engine's: the engine counts what was
// eaten, and what eating is *worth* is a question about the player's situation.
//
// WHY SHARED AT ALL. The arithmetic is trivial; the CONVENTIONS are not, and
// they have already been got wrong once. A cost of -1 means "unknown" and must
// contribute nothing, while a cost of 0 means "free" and must be honoured as
// data — the difference decides whether an all-free build is ranked on an
// honest objective or told its costs are unknown and optimised toward eating
// constantly. Three call sites had to agree on that rule; a fourth writing it
// out again by hand is how the rule quietly stops being the rule.
// =============================================================================

/**
 * Is this a cost we can use?
 *
 * Zero passes, negatives do not. `buildIronPrices` stores -1 for "no value
 * known", and treating that as a cost of minus one second would make eating look
 * profitable. A deliberate 0 — a daily, a guild handout, a stockpile already
 * paid for — is a real cost of nothing and is kept.
 *
 * The type check ahead of the numeric one is not ceremony. `Number(null)`,
 * `Number('')`, `Number([])` and `Number(false)` are all 0, so a bare `>= 0` test
 * reads every one of those as "free" — the one wrong answer that costs nothing to
 * produce and quietly understates the bill. Only a number, or a string that is
 * one, counts as a stated cost.
 *
 * @param {unknown} value  seconds per unit
 * @returns {boolean}
 */
export function isKnownCost(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value !== 'string' || value.trim() === '') return false;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0;
}

/**
 * Flatten the engine's per-player consumable tally into one per-item total.
 *
 * `simResult.consumablesUsed` is `{ [playerHrid]: { [itemHrid]: count } }`. This
 * merged tally is for COUNTING units; it is not a production bill, because each
 * character makes their own consumables — see partyConsumableSeconds.
 *
 * @param {Record<string, Record<string, number>>} consumablesUsed
 * @returns {{byItem: Record<string, number>, total: number}}
 */
export function sumConsumablesUsed(consumablesUsed) {
  const byItem = {};
  let total = 0;
  for (const perItem of Object.values(consumablesUsed || {})) {
    for (const [itemHrid, count] of Object.entries(perItem || {})) {
      const used = Number(count) || 0;
      byItem[itemHrid] = (byItem[itemHrid] || 0) + used;
      total += used;
    }
  }
  return { byItem, total };
}

/**
 * Production time owed for everything consumed, in seconds.
 *
 * An item with no usable cost is skipped rather than guessed at, so the total is
 * always an UNDER-statement of the true bill when prices are patchy. That is the
 * safe direction: it can make a configuration look better than it is, never
 * worse, so it cannot invent a reason to change a threshold.
 *
 * @param {Record<string, number>} byItem  itemHrid → units consumed
 * @param {Record<string, number>} costs   itemHrid → seconds each
 * @returns {{seconds: number, priced: string[], unpriced: string[]}}
 */
export function consumableSecondsUsed(byItem, costs) {
  let seconds = 0;
  const priced = [];
  const unpriced = [];

  for (const [itemHrid, count] of Object.entries(byItem || {})) {
    const secondsEach = costs?.[itemHrid];
    if (isKnownCost(secondsEach)) {
      seconds += Number(secondsEach) * (Number(count) || 0);
      priced.push(itemHrid);
    } else {
      unpriced.push(itemHrid);
    }
  }

  return { seconds, priced, unpriced };
}

/**
 * Production time owed by the party, in seconds over `hours` of combat, on the
 * per-player rule: each character makes their own consumables, so each has
 * their own real clock, E / (1 + s_i/3600). The party figure is the seconds
 * whose effective rate is the MEAN of the members' — so every member's eating
 * moves it (a max would hide all but the slowest kitchen from the optimiser),
 * and for one player it is exactly their own bill.
 *
 * `players` is the roster: a member who ate nothing is absent from the tally
 * but still counts, at no cost. Defaults to the tally's keys.
 *
 * The one rule for every effective rate (zone results, All Zones, optimiser).
 *
 * @param {Record<string, Record<string, number>>} consumablesUsed  per-player tally
 * @param {Record<string, number>} costs  itemHrid → seconds each
 * @param {{players?: string[], hours?: number}} [opts]
 * @returns {{seconds: number, priced: string[], unpriced: string[]}}
 */
export function partyConsumableSeconds(consumablesUsed, costs, { players, hours = 1 } = {}) {
  const roster = players?.length ? players : Object.keys(consumablesUsed || {});
  const span = hours > 0 ? hours : 1;
  let clockShare = 0;
  let solo = 0; // a party of one returns its own bill exactly, free of float drift
  const priced = new Set();
  const unpriced = new Set();
  for (const hrid of roster) {
    const own = consumableSecondsUsed(consumablesUsed?.[hrid], costs);
    solo = own.seconds;
    clockShare += 1 / (1 + own.seconds / span / 3600);
    own.priced.forEach((item) => priced.add(item));
    own.unpriced.forEach((item) => unpriced.add(item));
  }
  const mean = roster.length ? clockShare / roster.length : 1;
  const seconds = roster.length === 1 ? solo : 3600 * (1 / mean - 1) * span;
  return { seconds, priced: [...priced], unpriced: [...unpriced] };
}

/**
 * A rate per hour of COMBAT time, restated per hour of TOTAL time — combat plus
 * the production owed for what the combat consumed.
 *
 * Over H hours yielding E events and owing T seconds of production:
 * E / ((3600H + T) / 3600), which reduces to the divisor below. The same shape
 * works for any per-hour figure, so encounters, kills and experience can all be
 * restated on the real clock.
 *
 * With no cost this returns the input unchanged, so it is always safe to rank or
 * report on — it simply stops discriminating.
 *
 * @param {number} ratePerHour
 * @param {number} consumableSecondsPerHour
 * @returns {number}
 */
export function effectiveRatePerHour(ratePerHour, consumableSecondsPerHour) {
  const rate = Number(ratePerHour) || 0;
  const seconds = Number(consumableSecondsPerHour) || 0;
  if (!(seconds > 0)) return rate;
  return rate / (1 + seconds / 3600);
}

/**
 * Fraction of a player's real time that goes on producing consumables rather
 * than fighting. The headline number for an ironcow: 44% means nearly half the
 * session is spent cooking for the other half.
 *
 * @param {number} consumableSecondsPerHour
 * @returns {number} 0..1
 */
export function consumableTimeShare(consumableSecondsPerHour) {
  const seconds = Number(consumableSecondsPerHour) || 0;
  if (!(seconds > 0)) return 0;
  return seconds / (3600 + seconds);
}
