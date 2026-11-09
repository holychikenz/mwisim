// =============================================================================
// consumableCosts — resolving what the party's food and drink cost, in seconds
//
// The layer between a price map and the arithmetic in shared/consumableCost.js:
// it knows about `usePrices` (sources, expense mode, hand-entered overrides), and
// the shared module knows about none of that. Two consumers, which is why this is
// not inside triggerOptimizer.js any more:
//
//   the trigger optimiser  — prices the party's SLOTTED consumables up front, to
//                            send as a cost table with the search
//   the zone results       — prices what was ACTUALLY consumed, after the fact,
//                            to restate encounters/hour on the real clock
//
// Only the `iron` price source yields seconds (usePrices sets unit: 'seconds'
// from buildIronPrices, sourced from the cow webapp). Vendor and market report
// COINS, which are not commensurable with combat time — an hour of fighting
// cannot be added to eleven thousand coins — so those sources are treated as no
// cost data at all and both consumers say so rather than quietly guessing.
// =============================================================================

import {
  partyConsumableSeconds,
  partyNetConsumableSeconds,
  consumableClassHrids,
  consumableTimeShare,
  dropCreditSeconds,
  effectiveNetRatePerHour,
  effectiveRatePerHour,
  sumConsumablesUsed,
} from '../../../shared/consumableCost.js';
import { calculateDropsPerHour, calculateExpectedDrops } from '../../../shared/drops.js';
import { priceOf } from './prices';
// The bundled snapshot useGameData reads too: what drop credit counts, and what drops it.
import ITEMS from '../../../src/combatsimulator/data/itemDetailMap.json';
import ACTIONS from '../../../src/combatsimulator/data/actionDetailMap.json';
import MONSTERS from '../../../src/combatsimulator/data/combatMonsterDetailMap.json';

const CONSUMABLE_CLASS = consumableClassHrids(ITEMS, ACTIONS);

/**
 * The price map, but only when it is denominated in something we can use.
 *
 * Reads `fetchedPrices` in preference to `prices`. Since the overrides are now
 * laid over the price map inside usePrices, `prices` already reflects them — so
 * resolving `fetched` from it would report the user's own number back as though
 * the server had said it, and the editor would show "fetched 25000, overridden to
 * 25000" with nothing struck through. `fetchedPrices` is the untouched original.
 * The fallback keeps this working for any caller still passing only `prices`.
 */
function secondsPrices(pricing) {
  if (pricing?.unit !== 'seconds') return null;
  return pricing.fetchedPrices || pricing.prices || null;
}

/**
 * One item's cost: what was fetched, what the user said instead, and which of
 * those will be used.
 *
 * `fetched` is null when the source cannot answer — either it is not
 * seconds-denominated, or the cow webapp has no value for the item (which
 * buildIronPrices stores as -1 and priceOf flattens to 0; by the time we see it
 * the two are indistinguishable, so both read as "unknown").
 *
 * `override` is null only when there is NO override. Zero is a real override and
 * survives, which is the whole point: an item that arrives free costs nothing at
 * the margin, and that is a fact about the player's circumstances which no
 * production time can know.
 *
 * Named for items generally rather than consumables specifically because it was
 * never consumable-specific — only its CALLERS were. The enhancement costing now
 * uses it for materials and protection items too.
 *
 * @param {string} hrid
 * @param {object} pricing  { fetchedPrices, prices, unit, expenseMode, itemCostOverrides }
 * @returns {{hrid: string, fetched: number|null, override: number|null, effective: number|null}}
 */
export function resolveItemCost(hrid, pricing) {
  const prices = secondsPrices(pricing);
  // expenseMode, because a consumable is a cost, not a receipt.
  const raw = prices ? priceOf(prices, hrid, pricing.expenseMode || 'ask') : null;
  const fetched = Number.isFinite(raw) && raw > 0 ? raw : null;

  const stored = pricing?.itemCostOverrides?.[hrid];
  const overrideValue = Number(stored);
  const override =
    stored != null && Number.isFinite(overrideValue) && overrideValue >= 0 ? overrideValue : null;

  return { hrid, fetched, override, effective: override ?? fetched };
}

/**
 * Every consumable the party has SLOTTED, with its fetched cost, its override and
 * the one that will be used. Deduplicated by item, in slot order, so it doubles
 * as the row list for the optimiser panel's override editor.
 *
 * @param {object[]} playerDTOs  engine DTOs (consumables keyed `hrid`)
 * @param {object} pricing
 * @returns {Array<{hrid: string, fetched: number|null, override: number|null, effective: number|null}>}
 */
export function describeConsumableCosts(playerDTOs, pricing) {
  const rows = [];
  const seen = new Set();

  for (const player of playerDTOs || []) {
    for (const slotKind of ['food', 'drinks']) {
      for (const slot of player?.[slotKind] || []) {
        const hrid = slot?.hrid;
        if (!hrid || seen.has(hrid)) continue;
        seen.add(hrid);
        rows.push(resolveItemCost(hrid, pricing));
      }
    }
  }
  return rows;
}

/**
 * Production time, in seconds per unit, for every consumable the party has
 * slotted — the cost table posted with an optimiser run.
 *
 * This is what makes a consumable threshold optimisable honestly. Under a raw
 * encounters-per-hour objective, eating more often is nearly free — measured, a
 * food threshold driven from 400 to 1 bought +0.37% throughput for 44 donuts an
 * hour from a standing start of zero. Denominating the cost in TIME puts both
 * sides of that trade in the same unit, and the recommendation inverts: the
 * search then prefers the setting that eats nothing.
 *
 * Returns null when there is nothing usable, which the server reads as "rank on
 * raw throughput" and the UI reports as a caveat. Overrides are an adjustment to
 * a seconds-denominated table, not a substitute for one: a half-priced table
 * would silently treat every un-overridden item as free, which is exactly the
 * bias this function exists to remove.
 *
 * @param {object[]} playerDTOs
 * @param {object} pricing
 * @returns {Record<string, number>|null} itemHrid → seconds each
 */
export function buildConsumableCosts(playerDTOs, pricing) {
  if (!secondsPrices(pricing)) return null;

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
 * What a finished run's consumption actually cost — the after-the-fact companion
 * to buildConsumableCosts, for the zone results.
 *
 * It prices what was CONSUMED rather than what was slotted, which is both more
 * honest and simpler: the engine has already told us every item and count, so
 * there is no need to reason about which slots were reachable.
 *
 * `known` is false when things WERE consumed and none of them could be priced.
 * The caller should then omit the effective rate rather than print a number equal
 * to the raw one, which would read as "your food is free" when it means "we have
 * no idea".
 *
 * ATE NOTHING IS NOT THE SAME AS CANNOT PRICE IT. A run that consumed nothing at
 * all owes no production time — its effective rate IS its raw rate, and that is a
 * fact, not a guess. Reporting it as unknown was actively misleading in a
 * comparison: in the zone sweep it sank every zone the build never had to eat on
 * to the bottom of the "effective" sort, below zones that eat constantly, and
 * handed the best-value highlight to a costlier zone. `nothingConsumed` is
 * exposed alongside so a caller can phrase the difference rather than print
 * "0 items priced" at someone who ate nothing.
 *
 * DROP CREDIT. Given `drops` (the simResult, or a row carrying its deaths and
 * per-player drop multipliers) and buildDropCreditCosts' table, each member's own
 * consumable drops offset their own bill (partyNetConsumableSeconds), adding
 * creditSecondsPerHour (the members' own credit, their plain mean), netSecondsPerHour
 * (possibly negative) and creditFloored (only when a member hit the clock floor).
 * Without both the result is exactly as before. A caller summarising many runs
 * on one pricing (All Zones) passes `creditCosts`, built once.
 *
 * @param {object} args
 * @param {Record<string, Record<string, number>>} args.consumablesUsed  simResult tally
 * @param {number} args.hours    simulated hours (of combat time)
 * @param {object} args.pricing
 * @param {string[]} [args.players]  the roster; see partyConsumableSeconds
 * @param {object} [args.drops]  what drop credit reads; see above
 * @param {Record<string, number>|null} [args.creditCosts]  buildDropCreditCosts(pricing), when already built
 * @returns {{known: boolean, nothingConsumed: boolean, secondsPerHour: number,
 *           timeShare: number, unitsPerHour: number, priced: string[],
 *           unpriced: string[], overrides: string[],
 *           creditSecondsPerHour?: number, netSecondsPerHour?: number, creditFloored?: true}}
 */
export function summariseConsumableCost({ consumablesUsed, hours, pricing, players, drops = null,
  creditCosts = drops ? buildDropCreditCosts(pricing) : null }) {
  const { byItem, total } = sumConsumablesUsed(consumablesUsed);
  const perHour = (value) => (hours > 0 ? value / hours : 0);
  const nothingConsumed = Object.keys(byItem).length === 0;

  const costs = {};
  const overrides = [];
  for (const hrid of Object.keys(byItem)) {
    const { effective, override } = resolveItemCost(hrid, pricing);
    if (effective != null) costs[hrid] = effective;
    if (override != null) overrides.push(hrid);
  }

  const { seconds, priced, unpriced } = partyConsumableSeconds(consumablesUsed, costs, { players, hours });
  const secondsPerHour = perHour(seconds);
  const roster = players?.length ? players : Object.keys(consumablesUsed || {});
  const net = drops && creditCosts && partyNetConsumableSeconds(consumablesUsed, costs,
    dropCreditSeconds(drops, MONSTERS, creditCosts, roster), { players: roster, hours });

  return {
    known: nothingConsumed || priced.length > 0,
    nothingConsumed,
    secondsPerHour,
    timeShare: consumableTimeShare(secondsPerHour),
    unitsPerHour: perHour(total),
    priced,
    unpriced,
    overrides,
    ...(net && {
      creditSecondsPerHour: perHour(net.credit),
      netSecondsPerHour: perHour(net.seconds),
      ...(net.floored && { creditFloored: true }),
    }),
  };
}

/** A summariseConsumableCost result's rate on the real clock: net of drop credit when it has one, else its bill. */
export function effectiveRateFor(ratePerHour, summary) {
  return summary?.netSecondsPerHour == null
    ? effectiveRatePerHour(ratePerHour, summary?.secondsPerHour)
    : effectiveNetRatePerHour(ratePerHour, summary.netSecondsPerHour);
}

/**
 * Seconds each for every consumable-class item the source can value, overrides
 * included (so a 0 gives an item no credit): the drop-credit table posted with
 * an optimiser run, and what the zone results credit. Null unless the credit is
 * on (pricing.dropCredit) and the source is in seconds — coins are not time.
 *
 * @param {object} pricing
 * @returns {Record<string, number>|null}
 */
export function buildDropCreditCosts(pricing) {
  if (!pricing?.dropCredit || !secondsPrices(pricing)) return null;
  const costs = {};
  for (const hrid of CONSUMABLE_CLASS) {
    const { effective } = resolveItemCost(hrid, pricing);
    if (effective != null) costs[hrid] = effective;
  }
  return Object.keys(costs).length ? costs : null;
}

/**
 * The Costs page's drop-credit rows for one character of a finished zone run:
 * each consumable-class item they are expected to receive, priced like any cost
 * row (overrides apply), with drops and credit per hour, most credit first.
 *
 * @param {object} simResult
 * @param {object} pricing
 * @param {string} playerHrid
 * @returns {Array<object>} resolveItemCost rows plus name, roles, usedBy, perHour, creditPerHour
 */
export function describeDropCredit(simResult, pricing, playerHrid) {
  if (!(Number(simResult?.simulatedTime) > 0)) return [];
  return calculateDropsPerHour(calculateExpectedDrops(simResult, MONSTERS, ITEMS, playerHrid), simResult.simulatedTime)
    .filter((drop) => CONSUMABLE_CLASS.has(drop.itemHrid))
    .map(({ itemHrid, name, perHour }) => {
      const cost = resolveItemCost(itemHrid, pricing);
      return { ...cost, name, roles: [], usedBy: [], perHour, creditPerHour: perHour * (cost.effective ?? 0) };
    })
    .sort((a, b) => b.creditPerHour - a.creditPerHour);
}

/**
 * The Costs page's bear-zone preset. Bear With It drops so much sugar (20-100
 * from every gummy bear) and so many low gummies that they are an infinite pool,
 * worth no time; plum, peach, dragon fruit and star fruit gummies keep theirs.
 */
export const BEAR_ZONE_ZEROED = ['/items/sugar', '/items/gummy', '/items/apple_gummy', '/items/orange_gummy'];

/**
 * What the preset's Revert puts back (hrid → the value it replaced, null: none): only the items whose override is
 * still the 0 the preset set — anything edited since keeps the edit. Empty when nothing is left to revert.
 *
 * @param {Record<string, number|null>|null} undo  usePrices dropCreditUndo
 * @param {Record<string, number>} overrides  usePrices itemCostOverrides
 * @returns {Record<string, number|null>}
 */
export function revertPatch(undo, overrides) {
  return Object.fromEntries(Object.entries(undo || {}).filter(([hrid]) => overrides?.[hrid] === 0));
}

// Re-exported so a consumer needs one import rather than two, and so the divisor
// itself is never rewritten by hand at the call site.
export { effectiveRatePerHour };
