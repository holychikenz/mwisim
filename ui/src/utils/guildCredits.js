// =============================================================================
// guildCredits — re-express a loot table as guild credits.
// -----------------------------------------------------------------------------
// Items you donate to a guild convert into guild credits. The exchange rates
// live on each item record in itemDetailMap as `guildCreditConversions`:
//
//   "guildCreditConversions": [
//     { "creditItemHrid": "/items/red_guild_credit",  "itemCount": 1, "creditCount": 4000 },
//     { "creditItemHrid": "/items/gold_guild_credit", "itemCount": 1, "creditCount": 80 }
//   ]
//
// 837 items convert; 700 offer one option, 136 offer two, and the Guild Token
// itself offers all eight. When an item offers MORE THAN ONE option we take the
// HIGHEST-TIER credit — the conversion the game treats as the premium payout.
//
// Tier ladder (ascending), taken from the items' own sortIndex in
// itemDetailMap: guild_token < green < brown < white < blue < purple < red <
// silver < gold.
//
// NOTE ON ORDERING: in the shipped data every multi-option array happens to be
// stored in ascending tier order, so "last element" would give the same answer.
// We rank explicitly anyway — relying on array order would be an unstated
// assumption that a future patch could quietly break.
// =============================================================================

export const GUILD_CREDIT_TIERS = [
  '/items/guild_token',
  '/items/green_guild_credit',
  '/items/brown_guild_credit',
  '/items/white_guild_credit',
  '/items/blue_guild_credit',
  '/items/purple_guild_credit',
  '/items/red_guild_credit',
  '/items/silver_guild_credit',
  '/items/gold_guild_credit',
];

const TIER_RANK = new Map(GUILD_CREDIT_TIERS.map((hrid, i) => [hrid, i]));

/** Rank of a credit hrid on the tier ladder; -1 for anything unrecognised. */
export function creditTierRank(creditItemHrid) {
  return TIER_RANK.has(creditItemHrid) ? TIER_RANK.get(creditItemHrid) : -1;
}

/**
 * Choose the highest-tier conversion from an item's `guildCreditConversions`.
 * Unrecognised credit hrids rank below every known tier but are still eligible,
 * so a newly-added credit type degrades to "usable" rather than "invisible".
 * @param {Array<{creditItemHrid: string, itemCount: number, creditCount: number}>} conversions
 * @returns {object|null} the winning conversion, or null if there is none
 */
export function pickHighestTierConversion(conversions) {
  if (!Array.isArray(conversions) || conversions.length === 0) return null;

  let best = null;
  let bestRank = -Infinity;
  for (const c of conversions) {
    if (!c || !c.creditItemHrid) continue;
    const rank = creditTierRank(c.creditItemHrid);
    if (rank > bestRank) {
      bestRank = rank;
      best = c;
    }
  }
  return best;
}

/**
 * Credits produced per single unit of an item, for the winning conversion.
 * Guards itemCount: the data always uses whole positive counts, but a 0 would
 * otherwise yield Infinity and poison every downstream total.
 */
function creditsPerItem(conversion) {
  const itemCount = Number(conversion.itemCount);
  const creditCount = Number(conversion.creditCount);
  if (!Number.isFinite(itemCount) || itemCount <= 0) return 0;
  if (!Number.isFinite(creditCount) || creditCount <= 0) return 0;
  return creditCount / itemCount;
}

/**
 * Re-express a drops list in guild credits.
 *
 * @param {Array<{itemHrid, name, amount, perHour}>} drops  rows from
 *        calculateExpectedDrops / calculateDropsPerHour
 * @param {Record<string, object>} items  itemDetailMap
 * @returns {{
 *   rows: Array<object>,            // one per input drop, in the same order
 *   totals: Array<object>,          // per credit tier, highest tier first
 *   convertedCount: number,         // drops that had a conversion
 *   unconvertedCount: number        // drops that did not
 * }}
 */
export function convertDropsToCredits(drops, items) {
  const rows = [];
  const totalsMap = new Map();
  let convertedCount = 0;
  let unconvertedCount = 0;

  for (const drop of drops || []) {
    const item = items?.[drop.itemHrid];
    const conversion = pickHighestTierConversion(item?.guildCreditConversions);

    if (!conversion) {
      unconvertedCount += 1;
      rows.push({ ...drop, convertible: false });
      continue;
    }

    const perItem = creditsPerItem(conversion);
    if (perItem <= 0) {
      unconvertedCount += 1;
      rows.push({ ...drop, convertible: false });
      continue;
    }

    const creditItemHrid = conversion.creditItemHrid;
    const creditAmount = drop.amount * perItem;
    const creditPerHour = (drop.perHour ?? 0) * perItem;

    convertedCount += 1;
    rows.push({
      ...drop,
      convertible: true,
      creditItemHrid,
      creditName: items?.[creditItemHrid]?.name || creditItemHrid.split('/').pop(),
      creditsPerItem: perItem,
      creditAmount,
      creditPerHour,
      // How many options the item offered, so the UI can flag where a
      // higher-tier choice was actually made rather than merely available.
      conversionOptionCount: item.guildCreditConversions.length,
    });

    const running = totalsMap.get(creditItemHrid) || { amount: 0, perHour: 0 };
    running.amount += creditAmount;
    running.perHour += creditPerHour;
    totalsMap.set(creditItemHrid, running);
  }

  const totals = [...totalsMap.entries()]
    .map(([creditItemHrid, v]) => ({
      creditItemHrid,
      name: items?.[creditItemHrid]?.name || creditItemHrid.split('/').pop(),
      amount: v.amount,
      perHour: v.perHour,
      rank: creditTierRank(creditItemHrid),
    }))
    .sort((a, b) => b.rank - a.rank);

  return { rows, totals, convertedCount, unconvertedCount };
}
