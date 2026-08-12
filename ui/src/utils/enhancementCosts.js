// =============================================================================
// enhancementCosts — what the NEXT enhancement level costs, in seconds
//
// The other half of the Gear tab. The scan measures what a level is worth; this
// asks the cow webapp's enhancement simulator what it costs, and because that
// simulator has an iron-cow mode which denominates everything in production
// SECONDS, both halves of the trade end up in the same currency. No exchange rate
// between coins and combat time has to be invented, which is the thing that makes
// the whole comparison honest. The arithmetic lives in shared/enhancementRoi.js,
// where the api test runner can reach it.
//
// WHY CLIENT-SIDE. Exactly where the consumable production times already come
// from, and for the same reasons. The cow webapp is a personal, local Flask
// server holding one player's character; the csim API is a stateless simulator
// that should not acquire a dependency on it. And the enhancement configuration —
// enhancing level, tool, teas, observatory — is a fact about the player, which is
// the UI's business.
//
// Endpoints used (both documented in EQUIPMENT-OPTIMIZER.md):
//   GET  /api/enhance/character  -> an EnhancementConfig from the live character
//   POST /api/enhance/calculate  -> Markov solution over protection levels
// =============================================================================

import { IRON_API_BASE } from '../hooks/usePrices';
import { marginalCostFromTargets } from '../../../shared/enhancementRoi.js';

/** Same host as the production-time source; its CORS is open. */
export const ENHANCE_API_BASE = IRON_API_BASE;

/** The cap, matching the engine's multiplier table. */
export const MAX_ENHANCEMENT_LEVEL = 20;

/** Requests are ~80ms each; this is a guard against a wedged server, not a budget. */
const REQUEST_TIMEOUT_MS = 20_000;

function withTimeout(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * The player's enhancing setup, auto-filled from their live character.
 *
 * @param {object} [opts]
 * @returns {Promise<object>} an EnhancementConfig
 */
export async function fetchEnhancementConfig({ signal } = {}) {
  const guard = withTimeout(signal);
  try {
    const response = await fetch(`${ENHANCE_API_BASE}/api/enhance/character`, {
      signal: guard.signal,
    });
    if (!response.ok) throw new Error(`Enhancement config unavailable (HTTP ${response.status})`);
    return await response.json();
  } finally {
    guard.done();
  }
}

/**
 * Cheapest expected cost, in seconds, of taking a fresh item from +0 to `target`.
 *
 * The response carries one row per protection level; the cheapest is the relevant
 * one, since a player free to choose where to start protecting will choose well.
 * `optimal_prot` says the same thing, but minimising here keeps this honest if
 * the server's tie-breaking ever changes.
 *
 * Returns null when the API cannot answer — notably at `target = 1`, where its
 * protection loop (`range(2, target + 1)`) is empty and no rows come back.
 *
 * @returns {Promise<{seconds: number, protectAt: number, basePrice: number}|null>}
 */
export async function fetchTargetCost({ itemHrid, target, config, signal }) {
  const guard = withTimeout(signal);
  try {
    const response = await fetch(`${ENHANCE_API_BASE}/api/enhance/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iron_cow: true, config, item_hrid: itemHrid, target }),
      signal: guard.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return null;

    let best = null;
    for (const row of rows) {
      const total = Number(row?.total_cost);
      if (!Number.isFinite(total)) continue;
      if (!best || total < best.seconds) best = { seconds: total, protectAt: row.protect_at };
    }
    if (!best) return null;
    return { ...best, basePrice: Number(body.base_price) || 0 };
  } catch {
    return null;
  } finally {
    guard.done();
  }
}

/**
 * Seconds to take THIS item from its current level to one level higher.
 *
 * For an item at +N (N >= 1) this is the difference of two whole-programme costs,
 * which cancels the item's own acquisition price — see marginalCostFromTargets.
 *
 * For an item at +0 the lower side would be `target = 0`, which costs nothing
 * because you already hold the item, so the marginal cost is the cost of reaching
 * +1 less the base price. That needs `target = 1`, which the server's protection
 * loop cannot produce: `for prot in range(2, target + 1)` is empty there. Rather
 * than reimplement the success-rate table on this side — game data that lives in
 * the cow repo and would silently rot here — the case is reported as unknown with
 * a reason the panel can show. A one-line change on the server
 * (`range(min(2, target), target + 1)`) fixes it, and this function picks that up
 * automatically the moment it lands.
 *
 * @returns {Promise<{seconds: number|null, reason?: string, protectAt?: number}>}
 */
export async function fetchMarginalCost({ itemHrid, currentLevel, config, signal }) {
  const level = Math.max(0, Math.floor(Number(currentLevel) || 0));
  if (level >= MAX_ENHANCEMENT_LEVEL) {
    return { seconds: null, reason: `already at +${MAX_ENHANCEMENT_LEVEL}` };
  }

  const target = await fetchTargetCost({ itemHrid, target: level + 1, config, signal });
  if (!target) {
    return {
      seconds: null,
      reason:
        level === 0
          ? 'the enhancement API cannot cost the very first level (its protection loop starts at 2)'
          : 'the enhancement API returned no costing for this item',
    };
  }

  if (level === 0) {
    // Nothing is sunk yet only in the sense that the item is already owned: strip
    // the acquisition price, keep the attempts and materials.
    const seconds = target.seconds - (target.basePrice || 0);
    return seconds > 0
      ? { seconds, protectAt: target.protectAt }
      : { seconds: null, reason: 'no usable production time for this item' };
  }

  const current = await fetchTargetCost({ itemHrid, target: level, config, signal });
  if (!current) {
    return { seconds: null, reason: 'the enhancement API returned no costing for this item' };
  }

  const seconds = marginalCostFromTargets(target.seconds, current.seconds);
  return seconds == null
    ? { seconds: null, reason: 'no usable production time for this item' }
    : { seconds, protectAt: target.protectAt };
}

/**
 * Cost every row of a scan result, sequentially.
 *
 * Sequential on purpose. Each request is ~80ms and a full party is under thirty
 * of them, so parallelism would save a second at most — and the server is a
 * single-threaded Flask development server holding one user's character, which
 * a fan-out would simply queue anyway.
 *
 * @param {object[]} rows       scan result rows
 * @param {object} config       EnhancementConfig
 * @param {object} [opts]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<Record<string, {seconds: number|null, reason?: string}>>} keyed by row id
 */
export async function costScanRows(rows, config, { signal, onProgress } = {}) {
  const out = {};
  const list = Array.isArray(rows) ? rows : [];
  // Two items of the same kind at the same level cost the same, and a party of
  // five can easily wear duplicates.
  const memo = new Map();

  for (let i = 0; i < list.length; i += 1) {
    if (signal?.aborted) break;
    const row = list[i];
    const key = `${row.itemHrid}@${row.currentLevel}`;
    if (!memo.has(key)) {
      memo.set(
        key,
        await fetchMarginalCost({
          itemHrid: row.itemHrid,
          currentLevel: row.currentLevel,
          config,
          signal,
        })
      );
    }
    out[row.id] = memo.get(key);
    onProgress?.(i + 1, list.length);
  }
  return out;
}
