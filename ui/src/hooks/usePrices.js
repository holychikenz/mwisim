import { useState, useCallback, useEffect, useMemo } from 'react';
import { buildMarketPrices, buildIronPrices } from '../utils/prices';

// =============================================================================
// usePrices — price-source state + fetchers, with a persistent per-source cache.
//
//   source = 'vendor' — no fetch; DropsTable falls back to itemDetailMap
//                       sellPrice (the pre-pricing behaviour).
//   source = 'market' — live marketplace.json (coins).
//   source = 'iron'   — cow/webapp time values (seconds), per character.
//                       THE DEFAULT: this is an ironcow tool, and seconds are the
//                       only unit commensurable with combat time, which the
//                       trigger optimiser needs to cost food and drink honestly.
//
// CACHING. Fetched values are kept per source in localStorage and reused
// indefinitely — nothing refetches on mount, on a source switch, or on reload.
// Prices only change when the user asks, by pressing fetch. That is deliberate:
// production times are stable, the fetch depends on an external service that may
// be offline, and silently refetching would make two optimiser runs an hour apart
// incomparable for no reason the user asked for.
//
// The cache is keyed BY SOURCE rather than being a single slot, so flipping to
// vendor and back does not throw away fetched iron times.
//
// CONSUMABLE COST OVERRIDES. `consumableCostOverrides` is a hand-entered
// itemHrid → seconds map that WINS over whatever was fetched, and it is persisted
// alongside the cache so it survives a refetch, a source switch and a reload. It
// exists because a fetched production time answers "what would it cost me to make
// this?", which is not always the question. An item that arrives free — a daily,
// a guild handout, a stockpile already sunk — costs nothing at the margin, and 0
// is the honest figure. Only the trigger optimiser's cost function reads these;
// drop valuation is a different question and is left alone.
//
// A zero override is DATA, not a missing value: it is kept in the map so the
// objective still counts as priced, which is why the API and score.js accept 0
// while still rejecting the -1 that buildIronPrices uses for "unknown".
//
// The cow webapp is addressed absolutely (CORS is open on its side) so this
// works both under the Vite dev server and the static /sim/ mount on
// start-server.py.
// =============================================================================

export const IRON_API_BASE = 'http://127.0.0.1:12345';

/** localStorage key, following the UI's `csim_*` convention. */
export const PRICES_KEY = 'csim_prices';

const MARKET_URLS = [
  'https://www.milkywayidle.com/game_data/marketplace.json',
  'https://www.milkywayidlecn.com/game_data/marketplace.json'
];

const DEFAULT_STATE = {
  source: 'iron',
  ironCharacter: null,
  revenueMode: 'bid',
  expenseMode: 'ask',
  cache: {},
  // itemHrid → seconds per unit, entered by hand. 0 is a legitimate value.
  //
  // Was `consumableCostOverrides` and covered only food and drink. It now covers
  // ANY item, because the enhancement costing needs times for materials and
  // protection items that no production walker can resolve — a Chaotic Chain is
  // absent from the value map entirely, and the Python side prices an absence at
  // zero, which understated a Chaotic Flail's next level by a factor of 182.
  itemCostOverrides: {}
};

/** First of the candidates that is a usable object, else an empty map. */
function pickOverrides(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

/**
 * Drop price entries that carry no information.
 *
 * buildIronPrices and buildMarketPrices produce one entry per item in the game —
 * some two thousand of them — and most have no listing. `priceOf` resolves an
 * all-unknown entry to 0 exactly as it resolves a missing one, so pruning them is
 * behaviour-preserving and cuts the stored payload by roughly an order of
 * magnitude. Entries with a vendor fallback are kept, since that fallback is real.
 */
function pruneEmptyPrices(prices) {
  if (!prices) return null;
  const pruned = {};
  for (const [hrid, entry] of Object.entries(prices)) {
    if (!entry) continue;
    const ask = Number(entry.ask);
    const bid = Number(entry.bid);
    const vendor = Number(entry.vendor);
    if (ask === -1 && bid === -1 && !vendor) continue;
    pruned[hrid] = entry;
  }
  return pruned;
}

function loadPersisted() {
  try {
    const raw = JSON.parse(localStorage.getItem(PRICES_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    return {
      // Merge over defaults so state written by an older build gains new keys
      // rather than arriving undefined.
      ...DEFAULT_STATE,
      ...raw,
      cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : {},
      // Migration: `consumableCostOverrides` is the pre-generalisation name for
      // the same map. Read it when the new key is absent so a user who spent time
      // hand-costing their food does not silently lose it. The old key is not
      // written back, so it drains away on the first save.
      itemCostOverrides: pickOverrides(raw.itemCostOverrides, raw.consumableCostOverrides)
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persist(state) {
  try {
    localStorage.setItem(PRICES_KEY, JSON.stringify(state));
  } catch {
    // Almost certainly a quota failure on the price map. Keep the user's SOURCE
    // and character choices, which are tiny and the more annoying thing to lose;
    // the prices themselves stay in memory for this session.
    try {
      localStorage.setItem(PRICES_KEY, JSON.stringify({ ...state, cache: {} }));
    } catch {
      /* storage unavailable entirely — in-memory only */
    }
  }
}

export function usePrices(gameData) {
  const persisted = useMemo(loadPersisted, []);

  const [source, setSource] = useState(persisted.source);
  const [cache, setCache] = useState(persisted.cache);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [revenueMode, setRevenueMode] = useState(persisted.revenueMode);
  const [expenseMode, setExpenseMode] = useState(persisted.expenseMode);
  const [ironCharacter, setIronCharacter] = useState(persisted.ironCharacter);
  const [characters, setCharacters] = useState([]);
  const [itemCostOverrides, setItemCostOverrides] = useState(persisted.itemCostOverrides);

  // Persist the choices, the cache and the overrides. Prices are only written by
  // fetchPrices, so this effect does not itself cause any network activity.
  useEffect(() => {
    persist({ source, ironCharacter, revenueMode, expenseMode, cache, itemCostOverrides });
  }, [source, ironCharacter, revenueMode, expenseMode, cache, itemCostOverrides]);

  // Populate the iron character list (best effort — webapp may be down). Note
  // this does NOT fetch prices; a cached set stays in force until asked.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${IRON_API_BASE}/api/characters`, { mode: 'cors' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          const names = data.characters || [];
          setCharacters(names);
          setIronCharacter((prev) => prev || names[0] || null);
        }
      } catch {
        /* webapp offline — iron source will report on fetch */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The active entry is derived, so switching source is instant and lossless.
  const active = source === 'vendor' ? null : cache[source] || null;
  const fetchedPrices = active?.prices || null;
  // 'coins' whenever there is nothing fetched: with no price map DropsTable falls
  // back to itemDetailMap sellPrice, which is coins whatever the source says.
  const unit = active?.unit || 'coins';

  /**
   * The price map every consumer actually reads: fetched values with the user's
   * hand-entered times laid over the top.
   *
   * Applying the overrides HERE rather than at each call site is what lets one
   * edited number reach the drops table, the consumable objective and the
   * enhancement costing at once, without every reader having to remember the
   * override map exists. `fetchedPrices` stays available, unmodified, for the
   * editor — which has to show what was fetched AND what you said instead.
   *
   * Guarded on the unit, and that guard is load-bearing. An override is a time in
   * SECONDS; the market source is denominated in coins, and laying seconds over
   * coins would silently produce a number that is neither.
   */
  const prices = useMemo(() => {
    if (!fetchedPrices || unit !== 'seconds') return fetchedPrices;
    const entries = Object.entries(itemCostOverrides || {});
    if (!entries.length) return fetchedPrices;
    const merged = { ...fetchedPrices };
    for (const [hrid, seconds] of entries) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 0) continue;
      // vendor 0 because a vendor pays coins, which are worth no time — the same
      // convention buildIronPrices uses.
      merged[hrid] = { ask: value, bid: value, vendor: 0 };
    }
    return merged;
  }, [fetchedPrices, unit, itemCostOverrides]);
  const fetchedLabel = active?.label || null;
  const fetchedAt = active?.fetchedAt || null;

  // The cached iron times belong to one character; say so when the selection has
  // moved on, rather than quietly costing food at another character's rates.
  const staleCharacter =
    source === 'iron' && active?.character && ironCharacter && active.character !== ironCharacter
      ? active.character
      : null;

  const fetchPrices = useCallback(async () => {
    if (source === 'vendor') {
      setError(null);
      return;
    }
    setFetching(true);
    setError(null);
    try {
      if (source === 'market') {
        let payload = null;
        let lastErr = null;
        for (const url of MARKET_URLS) {
          try {
            const res = await fetch(url, { mode: 'cors' });
            if (res.ok) { payload = await res.json(); break; }
            lastErr = new Error(`HTTP ${res.status}`);
          } catch (e) {
            lastErr = e;
          }
        }
        if (!payload) throw lastErr || new Error('market fetch failed');
        setCache((prev) => ({
          ...prev,
          market: {
            prices: pruneEmptyPrices(buildMarketPrices(payload.marketData || {}, gameData.items)),
            unit: 'coins',
            label: 'market',
            fetchedAt: Date.now()
          }
        }));
      } else if (source === 'iron') {
        const url = `${IRON_API_BASE}/api/value/market` +
          (ironCharacter ? `?character=${encodeURIComponent(ironCharacter)}` : '');
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const character = payload.character || ironCharacter || 'default';
        setCache((prev) => ({
          ...prev,
          iron: {
            prices: pruneEmptyPrices(buildIronPrices(payload.values || {}, gameData.items)),
            unit: 'seconds',
            label: `iron · ${character}`,
            character,
            fetchedAt: Date.now()
          }
        }));
      }
    } catch (e) {
      // The cached entry is deliberately LEFT IN PLACE. A webapp that happens to be
      // down should not silently strip the production times an optimiser run is
      // about to depend on; the error is surfaced and the old values stand.
      setError(e);
    } finally {
      setFetching(false);
    }
  }, [source, ironCharacter, gameData]);

  // Switching source clears only the error; cached entries survive.
  useEffect(() => {
    setError(null);
  }, [source]);

  /**
   * Override one item's cost, in seconds per unit. Pass null (or anything not a
   * finite number ≥ 0) to REMOVE the override and fall back to the fetched value.
   *
   * Deleting the key rather than storing a sentinel is what keeps "no opinion"
   * distinguishable from "I say this is free": 0 is a stored, honoured cost.
   */
  const setItemCostOverride = useCallback((hrid, seconds) => {
    if (!hrid) return;
    setItemCostOverrides((prev) => {
      const value = Number(seconds);
      const next = { ...prev };
      if (seconds === null || seconds === '' || !Number.isFinite(value) || value < 0) {
        delete next[hrid];
      } else {
        next[hrid] = value;
      }
      return next;
    });
  }, []);

  /** Set several at once, for a bulk edit. Same per-item rules as above. */
  const setItemCostOverrides_ = useCallback((patch) => {
    setItemCostOverrides((prev) => {
      const next = { ...prev };
      for (const [hrid, seconds] of Object.entries(patch || {})) {
        const value = Number(seconds);
        if (seconds === null || seconds === '' || !Number.isFinite(value) || value < 0) {
          delete next[hrid];
        } else {
          next[hrid] = value;
        }
      }
      return next;
    });
  }, []);

  /** Forget every hand-entered cost and go back to the fetched times throughout. */
  const clearItemCostOverrides = useCallback(() => setItemCostOverrides({}), []);

  /** Discard a cached source (or all of them) and force the next fetch to be fresh. */
  const clearPrices = useCallback((which = source) => {
    setCache((prev) => {
      if (!which) return {};
      const next = { ...prev };
      delete next[which];
      return next;
    });
  }, [source]);

  return {
    source, setSource,
    // `prices` carries the overrides; `fetchedPrices` is what the server said.
    // Only the cost editor should ever want the latter.
    prices, fetchedPrices,
    unit, fetching, error, fetchedLabel, fetchPrices,
    fetchedAt, staleCharacter, clearPrices,
    revenueMode, setRevenueMode,
    expenseMode, setExpenseMode,
    ironCharacter, setIronCharacter, characters,
    itemCostOverrides,
    setItemCostOverride,
    setItemCostOverrides: setItemCostOverrides_,
    clearItemCostOverrides
  };
}
