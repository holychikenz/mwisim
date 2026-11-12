import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { buildMarketPrices, buildIronPrices, autoIronDecision, initialIronCharacter, staleIronCharacter } from '../utils/prices';
import { createLatestGate } from '../utils/latestRequest';
import { loadSnapshots, snapshotOptions } from '../utils/characterSnapshots';

// =============================================================================
// usePrices — price-source state + fetchers, with a persistent per-source cache.
//
//   source = 'vendor' — no fetch; DropsTable falls back to itemDetailMap
//                       sellPrice (the pre-pricing behaviour).
//   source = 'market' — live marketplace.json (coins).
//   source = 'iron'   — time values (seconds), per character, computed here
//                       from the character's raw snapshot (utils/characterSnapshots.js)
//                       by the Rust valuation in wasm (src/worker.js "item_values").
//                       THE DEFAULT: this is an ironcow tool, and seconds are the
//                       only unit commensurable with combat time, which the
//                       trigger optimiser needs to cost food and drink honestly.
//
// CACHING. Fetched values are kept per source in localStorage and reused
// indefinitely — nothing refetches on mount, on a source switch, or on reload.
// Prices only change when the user asks, by pressing fetch. That is deliberate:
// production times are stable, the market fetch depends on an external service
// that may be offline, a character's iron times outlive its snapshot (none exist
// until the csim-import userscript lands), and silently recomputing would make two
// optimiser runs an hour apart incomparable for no reason the user asked for.
//
// ONE EXCEPTION: FOLLOWING THE MAIN CHARACTER. On load, and whenever the header's
// main character changes, a main with a snapshot becomes the iron character and
// their times are computed — at most once per character per session, and never
// when the cached iron times are already theirs, so a reload with main's times
// cached computes nothing. The computation is quiet: a failure (e.g. a build
// without the wasm engine) sets no error and the cached entry stands. The SOURCE
// is never switched ('iron' is the default; anything else was picked by hand),
// and hand-entered overrides are untouched.
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
// =============================================================================

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
  itemCostOverrides: {},
  // Drop credit (Costs page): a run's consumable drops offset its consumable bill
  // in every effective rate. On by default; only a seconds source can credit.
  dropCredit: true,
  // What the Costs page's preset replaced, hrid → seconds or null (no override),
  // so Revert restores exactly that. Null when there is nothing to revert.
  dropCreditUndo: null
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
      itemCostOverrides: pickOverrides(raw.itemCostOverrides, raw.consumableCostOverrides),
      dropCredit: raw.dropCredit !== false,
      dropCreditUndo: raw.dropCreditUndo && typeof raw.dropCreditUndo === 'object' ? raw.dropCreditUndo : null
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

/** cowstuff's /api/value/market payload for one raw character, from a fresh sim worker (~150 ms of wasm). */
function itemValuesInWorker(characterData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../../src/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.type !== 'item_values_result') return reject(new Error(String(data.error)));
      try {
        const payload = JSON.parse(data.json);
        if (payload.ok === false) throw new Error(payload.error);
        resolve(payload);
      } catch (e) {
        reject(e);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'item-values worker failed'));
    };
    worker.postMessage({ type: 'item_values', character: JSON.stringify(characterData) });
  });
}

/** The iron times for game character `id`, from their snapshot; throws when there is none or the valuation fails. */
async function computeIronEntry(id, snapshots, items) {
  const snapshot = id != null ? snapshots[id] ?? null : null;
  if (!snapshot) throw new Error(`no game snapshot for character ${id}`);
  const payload = await itemValuesInWorker(snapshot);
  const name = snapshot.character?.name ?? String(id);
  return {
    prices: pruneEmptyPrices(buildIronPrices(payload.values || {}, items)),
    unit: 'seconds',
    label: `iron · ${name}`,
    character: name,
    characterId: String(id),
    fetchedAt: Date.now()
  };
}

const NO_CHARACTERS = [];

export function usePrices(gameData, main = null) {
  const persisted = useMemo(loadPersisted, []);

  const [source, setSource] = useState(persisted.source);
  const [cache, setCache] = useState(persisted.cache);
  const [fetching, setFetching] = useState(false);
  // Manual fetches and main-following share one gate: only the newest iron request writes cache.iron.
  const [nextIron] = useState(createLatestGate);
  // The manual fetch's own turn: only the newest one shows its error or stops the spinner (a follow touches neither).
  const [nextFetch] = useState(createLatestGate);
  const [error, setError] = useState(null);
  const [revenueMode, setRevenueMode] = useState(persisted.revenueMode);
  const [expenseMode, setExpenseMode] = useState(persisted.expenseMode);
  // Read once; the csim-import userscript (not yet built) will need to refresh it.
  const snapshots = useMemo(loadSnapshots, []);
  // The iron character is a game characterId (string), never a name: a rename keeps its times.
  const [ironCharacter, setIronCharacter] = useState(() => initialIronCharacter(persisted.ironCharacter, snapshots));
  const options = useMemo(() => snapshotOptions(snapshots), [snapshots]);
  const characters = options.length ? options : NO_CHARACTERS;
  const ironCharacterName = options.find((o) => o.value === ironCharacter)?.label ?? ironCharacter;
  const [itemCostOverrides, setItemCostOverrides] = useState(persisted.itemCostOverrides);
  const [dropCredit, setDropCredit] = useState(persisted.dropCredit);
  const [dropCreditUndo, setDropCreditUndo] = useState(persisted.dropCreditUndo);

  // Persist the choices, the cache and the overrides. Prices are only written by
  // fetchPrices and main-following, so this effect computes and fetches nothing.
  useEffect(() => {
    persist({ source, ironCharacter, revenueMode, expenseMode, cache, itemCostOverrides, dropCredit, dropCreditUndo });
  }, [source, ironCharacter, revenueMode, expenseMode, cache, itemCostOverrides, dropCredit, dropCreditUndo]);

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
  const staleCharacter = source === 'iron' ? staleIronCharacter(active, ironCharacter) : null;

  const fetchPrices = useCallback(async () => {
    if (source === 'vendor') {
      setError(null);
      return;
    }
    const isCurrent = nextFetch();
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
        const isLatest = nextIron();
        const iron = await computeIronEntry(ironCharacter, snapshots, gameData.items);
        if (isLatest()) setCache((prev) => ({ ...prev, iron }));
      }
    } catch (e) {
      // The cached entry is deliberately LEFT IN PLACE. A failed fetch or valuation
      // should not silently strip the production times an optimiser run is about
      // to depend on; the error is surfaced and the old values stand.
      if (isCurrent()) setError(e);
    } finally {
      if (isCurrent()) setFetching(false);
    }
  }, [source, ironCharacter, snapshots, gameData, nextIron, nextFetch]);

  // Switching source clears the error and ends the old source's manual fetch: its late
  // error or finish no longer reaches this one (its reply still fills its own cache).
  // Cached entries survive.
  useEffect(() => {
    nextFetch();
    setError(null);
    setFetching(false);
  }, [source, nextFetch]);

  // Following the main character — the one automatic fetch (see the header).
  // `followed`: the snapshot id last acted on this session (loop guard).
  const followed = useRef(null);
  const followMain = useCallback(async (id, needsFetch) => {
    // A turn is taken even without a fetch: following main to cached times must still void
    // an older iron reply in flight. No `fetching`: that is the manual fetch's spinner.
    const isLatest = nextIron();
    setIronCharacter(id);
    if (!needsFetch) return;
    try {
      const iron = await computeIronEntry(id, snapshots, gameData.items);
      if (isLatest()) setCache((prev) => ({ ...prev, iron }));
    } catch {
      // Quiet by design: e.g. a build without the wasm engine; the cached times stand.
    }
  }, [snapshots, gameData, nextIron]);
  useEffect(() => {
    if (!gameData?.items) return;
    const next = autoIronDecision({ main, snapshots, cache, followed: followed.current });
    if (!next) return;
    followed.current = next.id;
    if (next.id) followMain(next.id, next.needsFetch);
  }, [main, snapshots, cache, gameData, followMain]);

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
    // `prices` carries the overrides; `fetchedPrices` is what the source said.
    // Only the cost editor should ever want the latter.
    prices, fetchedPrices,
    unit, fetching, error, fetchedLabel, fetchPrices,
    fetchedAt, staleCharacter, clearPrices,
    revenueMode, setRevenueMode,
    expenseMode, setExpenseMode,
    // ironCharacter is a game characterId; characters are Select options { value: id, label: name }.
    ironCharacter, setIronCharacter, ironCharacterName, characters,
    itemCostOverrides,
    setItemCostOverride,
    setItemCostOverrides: setItemCostOverrides_,
    clearItemCostOverrides,
    dropCredit, setDropCredit,
    dropCreditUndo, setDropCreditUndo
  };
}
