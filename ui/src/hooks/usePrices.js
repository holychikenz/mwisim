import { useState, useCallback, useEffect } from 'react';
import { buildMarketPrices, buildIronPrices } from '../utils/prices';

// =============================================================================
// usePrices — price-source state + fetchers.
//
//   source = 'vendor' — no fetch; DropsTable falls back to itemDetailMap
//                       sellPrice (the pre-pricing behaviour).
//   source = 'market' — live marketplace.json (coins).
//   source = 'iron'   — cow/webapp time values (seconds), per character.
//
// The cow webapp is addressed absolutely (CORS is open on its side) so this
// works both under the Vite dev server and the static /sim/ mount on
// start-server.py.
// =============================================================================

export const IRON_API_BASE = 'http://127.0.0.1:12345';

const MARKET_URLS = [
  'https://www.milkywayidle.com/game_data/marketplace.json',
  'https://www.milkywayidlecn.com/game_data/marketplace.json'
];

export function usePrices(gameData) {
  const [source, setSource] = useState('vendor');
  const [prices, setPrices] = useState(null);
  const [unit, setUnit] = useState('coins');
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [fetchedLabel, setFetchedLabel] = useState(null);
  const [revenueMode, setRevenueMode] = useState('bid');
  const [expenseMode, setExpenseMode] = useState('ask');
  const [ironCharacter, setIronCharacter] = useState(null);
  const [characters, setCharacters] = useState([]);

  // Populate the iron character list (best effort — webapp may be down).
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

  const fetchPrices = useCallback(async () => {
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
        setPrices(buildMarketPrices(payload.marketData || {}, gameData.items));
        setUnit('coins');
        setFetchedLabel('market');
      } else if (source === 'iron') {
        const url = `${IRON_API_BASE}/api/value/market` +
          (ironCharacter ? `?character=${encodeURIComponent(ironCharacter)}` : '');
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        setPrices(buildIronPrices(payload.values || {}, gameData.items));
        setUnit('seconds');
        setFetchedLabel(`iron · ${payload.character || ironCharacter || 'default'}`);
      } else {
        // vendor — clear any fetched map
        setPrices(null);
        setUnit('coins');
        setFetchedLabel(null);
      }
    } catch (e) {
      setError(e);
      setPrices(null);
      setFetchedLabel(null);
    } finally {
      setFetching(false);
    }
  }, [source, ironCharacter, gameData]);

  // Selecting "vendor" needs no fetch — reset immediately.
  useEffect(() => {
    if (source === 'vendor') {
      setPrices(null);
      setUnit('coins');
      setFetchedLabel(null);
      setError(null);
    }
  }, [source]);

  return {
    source, setSource,
    prices, unit, fetching, error, fetchedLabel, fetchPrices,
    revenueMode, setRevenueMode,
    expenseMode, setExpenseMode,
    ironCharacter, setIronCharacter, characters
  };
}
