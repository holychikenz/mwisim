// =============================================================================
// prices — price-map construction and lookup, ported from the old webpack
// UI (src/main.js fetchPrices / fetchIronPrices / getDropProfit).
//
// A price map is { [itemHrid]: { ask, bid, vendor } } where -1 means
// "no listing". Two sources:
//
//   market — https://www.milkywayidle.com/game_data/marketplace.json
//            (CN mirror fallback). Unit: coins. vendor = itemDetailMap
//            sellPrice fallback.
//   iron   — cow/webapp /api/value/market?character=… time values.
//            Unit: SECONDS-to-acquire. Vendor trades pay coins, which are
//            worth no time in iron mode, so vendor = 0 and coin = 0.
//
// Treasure chests have no market listing; their value is the expected value
// of their contents (openableLootDropMap).
// =============================================================================

import openableLootDropMap from '../../../src/combatsimulator/data/openableLootDropMap.json';

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

/** Build a seconds price map from cow/webapp /api/value/market values. */
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
