// =============================================================================
// apiBase — where the csim Express API (csim/api) lives, as seen from the UI
//
// This is the FIRST part of the UI to talk to that API. Everything else runs the
// engine in a browser Web Worker (useSimulation) or imports the JSON data
// directly (useGameData), so there was previously no base URL to resolve.
//
// The trigger optimiser cannot follow suit: it runs hundreds of candidate
// simulations across a worker pool, which belongs on a machine with real threads
// and no tab to freeze.
//
// Two deployments, and they need different answers:
//
//   npm run dev            Vite proxies /api → http://localhost:3001
//                          (ui/vite.config.js), so a RELATIVE path works and
//                          keeps requests same-origin.
//
//   packaged ui/dist       served statically at /sim/ by
//                          tampermonkey/start-server.py, where NO proxy exists.
//                          A relative /api would 404, so an ABSOLUTE base is
//                          required.
//
// Resolution order, most specific first:
//   1. localStorage override — lets a user point at another host without a rebuild
//   2. VITE_CSIM_API_BASE   — build-time configuration
//   3. dev server           — relative, so the Vite proxy handles it
//   4. DEFAULT_API_BASE     — the absolute fallback
//
// Mirrors the IRON_API_BASE convention already established in usePrices.js.
// =============================================================================

/** Where `npm start` in csim/api listens by default (api/server.js:11). */
export const DEFAULT_API_BASE = 'http://localhost:3001';

/** localStorage key, following the UI's `csim_*` convention. */
export const API_BASE_KEY = 'csim_api_base';

/**
 * @returns {string} base URL with no trailing slash; '' means "same origin,
 *   let the dev proxy handle it"
 */
export function getApiBase() {
  try {
    const override = localStorage.getItem(API_BASE_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    // Private browsing or a blocked storage partition — fall through.
  }

  const configured = import.meta.env?.VITE_CSIM_API_BASE;
  if (configured) return String(configured).replace(/\/+$/, '');

  if (import.meta.env?.DEV) return '';

  return DEFAULT_API_BASE;
}

/** Persist a base URL override, or clear it when given a falsy value. */
export function setApiBase(base) {
  try {
    if (base) localStorage.setItem(API_BASE_KEY, String(base).replace(/\/+$/, ''));
    else localStorage.removeItem(API_BASE_KEY);
  } catch {
    // Nothing sensible to do; the in-memory default still applies.
  }
}

/**
 * Build a full URL for an API path.
 *
 * @param {string} path e.g. '/api/optimize-triggers'
 * @returns {string}
 */
export function apiUrl(path) {
  const base = getApiBase();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Is the API reachable? Used to show a helpful message rather than a bare
 * network error, since a user running only `npm run dev` in ui/ will not have
 * started the API at all — and for this panel, unlike every other, that matters.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function pingApi(timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl('/health'), { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
