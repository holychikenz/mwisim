// =============================================================================
// rng — seeded randomness for reproducible candidate comparison
//
// The engine calls Math.random() directly (zone.js:34,90 for spawn selection,
// and throughout combatSimulator for hit/crit rolls). It has no seed parameter
// and we deliberately do NOT add one: src/combatsimulator/ is upstream-tracked
// (see MWIX-RELATIONSHIP.md) and every local adaptation costs us at each sync.
//
// Instead we replace Math.random inside each worker_thread. A worker has its
// own global scope, so the substitution cannot leak into the main thread or
// into a concurrent worker. api/tests/guildTrial.test.mjs already establishes
// this idiom with its `withRandom` helper.
//
// WHY IT MATTERS: without a pinned seed, two candidates differ by the spawn
// sequence they happened to draw as much as by their triggers. The peer fork
// ranks candidates within a 0.1% epsilon, which is far below the run-to-run
// noise of an unseeded 6-hour simulation — so their stage-one screening is
// partly luck. Pinning the seed makes a comparison fair: every candidate in a
// sweep faces the *same* sequence of encounters.
//
// The seed is varied BETWEEN stages, never within one, so a threshold that
// only wins against one particular spawn sequence gets found out later.
// =============================================================================

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over an LCG because the low bits of an LCG are notoriously weak, and
 * the engine takes many small independent rolls per tick where that would
 * show. Period is 2^32, comfortably beyond a single simulation's draw count.
 *
 * @param {number} seed  any integer; coerced to uint32
 * @returns {() => number} generator yielding [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Swap Math.random for a seeded generator.
 *
 * @param {number} seed
 * @returns {() => void} restore function; call it to put Math.random back
 */
export function installSeededRandom(seed) {
  const original = Math.random;
  Math.random = mulberry32(seed);
  return function restore() {
    Math.random = original;
  };
}

/**
 * Run `fn` with Math.random pinned, restoring it even if `fn` throws.
 * Mirrors the `withRandom` helper in api/tests/guildTrial.test.mjs, but seeded
 * rather than constant — a constant Math.random makes every spawn identical
 * and every roll degenerate, which is fine for a unit test and useless here.
 *
 * @template T
 * @param {number} seed
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSeed(seed, fn) {
  const restore = installSeededRandom(seed);
  try {
    return await fn();
  } finally {
    restore();
  }
}
