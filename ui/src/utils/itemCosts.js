// =============================================================================
// itemCosts — which items actually affect this build's numbers
//
// The Costs tab could just be a search box over all 957 items, and it has one.
// But a search box is only useful to someone who already knows what to type, and
// the whole reason this tab exists is that a user CANNOT know: the items that
// silently cost nothing are the ones absent from the production-time map, and
// nothing in the UI ever names them.
//
// So the tab opens on the items that matter — what the party eats, and every
// material and protection item behind the gear it wears — with the unpriced ones
// first. That turns "why is my pay-back sixteen thousand seconds" into a list of
// three boxes to fill in.
// =============================================================================

import { resolveItemCost } from './consumableCosts';
import { MIRROR_OF_PROTECTION } from '../../../shared/enhancementRoi.js';

/** Where an item enters the calculation. Ordered by how much explaining it needs. */
export const COST_ROLES = Object.freeze({
  consumable: 'Eaten or drunk',
  material: 'Enhancement material',
  protection: 'Protection item',
});

/** `/items/chaotic_chain` → `chaotic chain`. */
export function lastSegment(hrid) {
  return String(hrid || '').split('/').pop().replace(/_/g, ' ');
}

/**
 * Every item this build's costs depend on, priced, deduplicated, and annotated
 * with why it is here.
 *
 * An item can play more than one role — an essence can be both eaten and used in
 * enhancing — so `roles` is a set rather than a single value, and the row is
 * emitted once.
 *
 * @param {object[]} playerDTOs  engine DTOs
 * @param {object} gameItems     useGameData's `items`
 * @param {object} pricing       usePrices' return value
 * @returns {Array<{hrid, name, roles: string[], usedBy: string[], fetched, override, effective}>}
 */
export function describeBuildCosts(playerDTOs, gameItems, pricing, { alwaysUseMirror = false } = {}) {
  const rows = new Map();

  const add = (hrid, role, usedBy) => {
    if (!hrid) return;
    if (!rows.has(hrid)) {
      rows.set(hrid, {
        ...resolveItemCost(hrid, pricing),
        name: gameItems?.[hrid]?.name || lastSegment(hrid),
        roles: [],
        usedBy: [],
      });
    }
    const row = rows.get(hrid);
    if (!row.roles.includes(role)) row.roles.push(role);
    if (usedBy && !row.usedBy.includes(usedBy)) row.usedBy.push(usedBy);
  };

  for (const player of playerDTOs || []) {
    for (const slotKind of ['food', 'drinks']) {
      for (const slot of player?.[slotKind] || []) {
        add(slot?.hrid, 'consumable', null);
      }
    }

    for (const entry of Object.values(player?.equipment || {})) {
      const itemHrid = entry?.hrid;
      if (!itemHrid) continue;
      const detail = gameItems?.[itemHrid];
      if (!detail) continue;
      const wornName = detail.name || lastSegment(itemHrid);

      for (const cost of detail.enhancementCosts || []) {
        // Coin costs an ironcow no time; the server prices it at 0 in iron mode
        // and adds it separately, so it is not a row anyone can usefully edit.
        if (!cost?.itemHrid || cost.itemHrid === '/items/coin') continue;
        add(cost.itemHrid, 'material', wornName);
      }

      // Under "always use mirror" the item's own protections are never costed,
      // so listing them here would be asking the user to price a dozen drop-only
      // items that nothing will read. That omission IS the simplification.
      //
      // Otherwise: everything the chooser might pick. `_refined` variants are
      // excluded to match the server's own search, so we never invite a price for
      // something that can never be chosen.
      if (!alwaysUseMirror) {
        for (const hrid of detail.protectionItemHrids || []) {
          if (String(hrid).includes('_refined')) continue;
          add(hrid, 'protection', wornName);
        }
      }
      // Only worth surfacing when something is actually enhanceable.
      if ((detail.enhancementCosts || []).length) {
        add(MIRROR_OF_PROTECTION, 'protection', wornName);
      }
    }
  }

  // Unpriced first — they are the ones costing zero and quietly flattering every
  // pay-back — then overridden, then by name so the order is stable while typing.
  return [...rows.values()].sort((a, b) => {
    const rank = (row) => (row.effective == null ? 0 : row.override != null ? 1 : 2);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Search the whole catalogue.
 *
 * Matches on name and hrid so both "chaotic chain" and "chaotic_chain" work, and
 * caps the result list — a two-letter query otherwise renders several hundred
 * NumberInputs and the tab visibly stutters.
 *
 * @param {string} query
 * @param {object} gameItems
 * @param {object} pricing
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Array<object>}
 */
export function searchItemCosts(query, gameItems, pricing, { limit = 60 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];

  const matches = [];
  for (const item of Object.values(gameItems || {})) {
    const name = item?.name || '';
    if (!name.toLowerCase().includes(needle) && !String(item?.hrid).includes(needle.replace(/ /g, '_'))) {
      continue;
    }
    matches.push(item);
    // Not an early break: sortIndex ordering below wants the full match set, but
    // a runaway query on a one-character needle is already excluded above.
  }

  matches.sort((a, b) => {
    // Exact-ish matches first, then the game's own ordering.
    const an = (a.name || '').toLowerCase();
    const bn = (b.name || '').toLowerCase();
    const aStarts = an.startsWith(needle) ? 0 : 1;
    const bStarts = bn.startsWith(needle) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return (a.sortIndex || 0) - (b.sortIndex || 0);
  });

  return matches.slice(0, limit).map((item) => ({
    ...resolveItemCost(item.hrid, pricing),
    name: item.name || lastSegment(item.hrid),
    roles: [],
    usedBy: [],
    categoryHrid: item.categoryHrid,
  }));
}
