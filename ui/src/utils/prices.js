// =============================================================================
// prices — price-map construction and lookup (originally ported from
// upstream's fetchPrices / fetchIronPrices / getDropProfit).
//
// A price map is { [itemHrid]: { ask, bid, vendor } } where -1 means
// "no listing". Two sources:
//
//   market — https://www.milkywayidle.com/game_data/marketplace.json
//            (CN mirror fallback). Unit: coins. vendor = itemDetailMap
//            sellPrice fallback.
//   iron   — time values from the Rust valuation (hooks/usePrices.js).
//            Unit: SECONDS-to-acquire. Vendor trades pay coins, which are
//            worth no time in iron mode, so vendor = 0 and coin = 0.
//
// Treasure chests have no market listing; their value is the expected value
// of their contents (openableLootDropMap).
// =============================================================================

import openableLootDropMap from '../../../src/combatsimulator/data/openableLootDropMap.json';
import { valuationStamp } from './characterSnapshots';

const MARKET_CHESTS = [
  '/items/small_treasure_chest',
  '/items/medium_treasure_chest',
  '/items/large_treasure_chest'
];

function chestExpectedValue(prices, chestHrid, field) {
  const drops = openableLootDropMap[chestHrid];
  if (!drops) return 0;
  return drops
    .map((item) => {
      const p = prices[item.itemHrid];
      if (!p) return 0;
      const v = p[field];
      return v > 0 ? v * item.dropRate * (item.maxCount + item.minCount) / 2 : 0;
    })
    .reduce((a, b) => a + b, 0);
}

/** Build a coins price map from marketplace.json's marketData. */
export function buildMarketPrices(marketData, items) {
  const prices = {};
  for (const item of Object.values(items)) {
    const hrid = item.hrid;
    if (hrid in marketData) {
      prices[hrid] = { ask: -1, bid: -1, vendor: item.sellPrice };
      if (marketData[hrid]['0']) {
        prices[hrid].ask = marketData[hrid]['0'].a;
        prices[hrid].bid = marketData[hrid]['0'].b;
      }
    }
  }
  prices['/items/coin'] = { ask: 1, bid: 1, vendor: 1 };
  for (const chest of MARKET_CHESTS) {
    prices[chest] = {
      ask: chestExpectedValue(prices, chest, 'ask'),
      bid: chestExpectedValue(prices, chest, 'bid'),
      vendor: chestExpectedValue(prices, chest, 'vendor')
    };
  }
  return prices;
}

/** Build a seconds price map from item_values' (cowstuff /api/value/market's) values. */
export function buildIronPrices(values, items) {
  const prices = {};
  for (const item of Object.values(items)) {
    const hrid = item.hrid;
    const v = hrid in values ? values[hrid] : -1;
    prices[hrid] = { ask: v, bid: v, vendor: 0 };
  }
  prices['/items/coin'] = { ask: 0, bid: 0, vendor: 0 };
  for (const chest of MARKET_CHESTS) {
    const expected = chestExpectedValue(prices, chest, 'ask');
    prices[chest] = { ask: expected, bid: expected, vendor: 0 };
  }
  return prices;
}

/**
 * Resolve an item's unit price. `mode` is 'bid' (bid-first) or 'ask'
 * (ask-first); -1 listings fall through to the other side, then vendor.
 * Mirrors the old UI's getDropProfit chain exactly.
 */
export function priceOf(prices, hrid, mode = 'bid') {
  if (!prices) return 0;
  const item = prices[hrid];
  if (!item) return 0;
  let price = -1;
  if (mode === 'bid') {
    if (item.bid !== -1) price = item.bid;
    else if (item.ask !== -1) price = item.ask;
  } else {
    if (item.ask !== -1) price = item.ask;
    else if (item.bid !== -1) price = item.bid;
  }
  if (price === -1) price = item.vendor;
  return price > 0 ? price : 0;
}

/** The marketplace keeps 4% of every sale. */
export const MARKET_TAX = 0.04;

/**
 * What selling a drop nets on `source`: the market price less the 4% tax. Coin is
 * not sold, a chest is opened rather than listed, and an item with no listing
 * falls back to its (untaxed) vendor price.
 */
export function saleValue(prices, hrid, mode, source) {
  const price = priceOf(prices, hrid, mode);
  const item = prices?.[hrid];
  const listed = item && (item.bid !== -1 || item.ask !== -1);
  const taxed = source === 'market' && listed && hrid !== '/items/coin' && !MARKET_CHESTS.includes(hrid);
  return taxed ? price * (1 - MARKET_TAX) : price;
}

/** Format a value in the active unit: coins → 1.2M; seconds → 1h 4m. */
export function formatValue(v, unit) {
  if (!Number.isFinite(v)) return v < 0 ? '-∞' : '∞';
  if (unit === 'seconds') {
    const sign = v < 0 ? '-' : '';
    const s = Math.abs(v);
    if (s < 59.95) return sign + s.toFixed(1) + 's';
    // Round the total to the shown unit first, then split, so 119.6 s is
    // "2m 0s" rather than "1m 60s".
    const secs = Math.round(s);
    if (secs < 3600) return sign + Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    const mins = Math.round(s / 60);
    return sign + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }
  // coins
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return sign + (a / 1e3).toFixed(2) + 'K';
  return sign + Math.floor(a).toLocaleString();
}

const sameName = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The game characterId (a string) of `main`'s snapshot, or null. `snapshots` =
 *  { [gameCharacterId]: characterData } (utils/characterSnapshots.js). Identity
 *  only: a main with a game id is matched by that id and nothing else, so a
 *  missing snapshot never values another character who shares the name. Only a
 *  record with no game id falls back to a name (game.name, else the record's
 *  own), ignoring case. */
export function matchSnapshotId(main, snapshots) {
  if (!main || !snapshots || typeof snapshots !== 'object') return null;
  const gameId = main.game?.id;
  if (gameId != null) return snapshots[gameId] ? String(gameId) : null;
  const want = main.game ? main.game.name : main.name;
  const hit = Object.entries(snapshots).find(([, data]) => sameName(data?.character?.name, want));
  return hit ? hit[0] : null;
}

/** The header main's identity in a following key: game id, else the name matched on. */
const mainRef = (main) => (main.game?.id != null ? `id:${main.game.id}` : `name:${main.game ? main.game.name : main.name}`);
const keyMain = (key) => {
  try { return JSON.parse(key)[0]; } catch { return null; }
};

/** Following main with the iron source (hooks/usePrices.js): null when nothing
 *  changed since `followed` (the `key` last acted on), else { id, key, needsFetch }
 *  — id null when main has no snapshot; key is [main, id, valuationStamp], so a
 *  snapshot that the valuation reads differently follows again. While the same main
 *  stays in the header, a hand-picked iron character (`picked`) stands: id null.
 *  needsFetch false when the cached iron times are already that snapshot's. */
export function autoIronDecision({ main, snapshots, cache, followed = null, picked = false }) {
  if (!snapshots || !main) return null;
  const id = matchSnapshotId(main, snapshots);
  const stamp = id != null ? valuationStamp(snapshots[id]) : null;
  const key = JSON.stringify([mainRef(main), id, stamp]);
  if (key === followed) return null;
  if (picked && keyMain(followed) === mainRef(main)) return { id: null, key, needsFetch: false };
  return { id, key, needsFetch: id != null && (cache?.iron?.characterId !== id || (cache.iron.snapshotStamp ?? null) !== stamp) };
}

/** The iron character (game id): the remembered one when it still has a named
 *  snapshot (a Select option), else the first such, else null. A remembered NAME
 *  (from a build that keyed on names) is dropped rather than matched. With no
 *  named snapshot at all (none yet, or unreadable) the remembered one is kept as is. */
export function initialIronCharacter(remembered, snapshots) {
  const ids = Object.keys(snapshots || {}).filter((id) => typeof snapshots[id]?.character?.name === 'string');
  if (!ids.length) return /^\d+$/.test(String(remembered)) ? String(remembered) : null;
  return remembered != null && ids.includes(String(remembered)) ? String(remembered) : ids[0];
}

/** The cached iron entry's character name when it is not `ironCharacter`'s (by id), else null.
 *  An entry with no characterId (cached by a name-keyed build) counts as stale, and so
 *  does one computed from a snapshot whose valuationStamp differs (`stamp` = the current one's). */
export function staleIronCharacter(entry, ironCharacter, stamp = null) {
  if (!entry?.character || ironCharacter == null) return null;
  if (entry.characterId !== String(ironCharacter)) return entry.character;
  return (entry.snapshotStamp ?? null) !== stamp ? `${entry.character} (an older snapshot)` : null;
}
