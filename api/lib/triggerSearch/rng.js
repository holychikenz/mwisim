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
//
// The generator itself (and the main-thread `withSeed`) live in
// api/lib/determinism.mjs; this file only installs it inside a worker.
// =============================================================================

import { mulberry32 } from '../determinism.mjs';

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
