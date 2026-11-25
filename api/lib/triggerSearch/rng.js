// =============================================================================
// rng — seeded randomness for reproducible candidate comparison
//
// The engine (the Rust twin) takes over the Math.random stream rather than a
// seed parameter: shared/twinEngine.js runTwin reads the seeded state, runs
// on it, and writes the end state back (mulberry32 below exposes .state()).
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
//
// The generator lives here, free of node:crypto, so the in-browser optimiser
// (ui/src/workers/optimizerSim.js) imports it too; api/lib/determinism.mjs re-exports it.
// =============================================================================

// mulberry32 — small, fast, and good enough that a seed change visibly
// reshuffles the run. The engine only ever needs a uniform in [0, 1).
//
// `.state()` reads the whole generator state (one u32) and `.state(v)` sets it.
// The Rust twin (shared/twinEngine.js) uses it to continue this exact stream
// and hand the advanced state back. It changes no output.
export function mulberry32(seed) {
  let a = seed >>> 0;
  const next = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.state = (v) => (v === undefined ? a : (a = v >>> 0));
  return next;
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
