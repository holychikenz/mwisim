// =============================================================================
// determinism — the seeded-replay kit: one copy, shared by every harness that
// needs a simulation run to be a pure function of (inputs, seed).
//
// Extracted verbatim from api/sim-parity.mjs, which grew all of this first and
// now imports it. api/eval/ needs the identical primitives, and two copies of a
// hash function is two hashes that will eventually disagree for a reason nobody
// can reconstruct.
//
// Any field carrying wall-clock time, a UUID, a process identity, an absolute
// path or a memory address must be redacted before hashing, or the hash stops
// being a statement about behaviour. The current engine emits none.
// =============================================================================

import { createHash } from 'crypto';

// ---- deterministic randomness ----------------------------------------------

// mulberry32 — small, fast, and good enough that a seed change visibly
// reshuffles the run. The engine only ever needs a uniform in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Install over the global Math.random for the duration of `fn`. Every engine
// call site uses the global, so this captures all 26 of them without the
// engine knowing anything about seeding.
//
// It reaches only THIS realm. A harness that delegates to worker_threads gets
// an unseeded run and a fixture that never reproduces — which is why both
// sim-parity and api/eval take the main-thread path deliberately.
export async function withSeed(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return await fn();
  } finally {
    Math.random = real;
  }
}

// ---- canonical serialisation -----------------------------------------------

// Fields older engines emit and the current one no longer does (audit2-5,
// audit2-17). eval/backrun.mjs still loads those engines, so they are dropped
// before hashing; otherwise every pre-audit2 ref mismatches on their presence
// alone (wipeEvents also carried a wall-clock timestamp).
const DROPPED_KEYS = new Set(['wipeEvents', 'timeSeriesData']);

// Key-sorted, with the JSON-hostile values the engine can produce spelled out
// rather than silently coerced (JSON.stringify turns NaN/Infinity into null,
// which would hide exactly the kind of drift we are looking for).
export function canonical(value, seen = new Set()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number') {
    if (Number.isNaN(value)) return '@NaN';
    if (value === Infinity) return '@Infinity';
    if (value === -Infinity) return '@-Infinity';
    return value;
  }
  if (t === 'bigint') return '@bigint:' + value.toString();
  if (t === 'undefined') return '@undefined';
  if (t === 'function') return '@function';
  if (t !== 'object') return value;
  if (seen.has(value)) return '@circular';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => canonical(v, seen));
    if (value instanceof Map) {
      return { '@map': [...value.entries()].map(([k, v]) => [canonical(k, seen), canonical(v, seen)]).sort() };
    }
    if (value instanceof Set) {
      return { '@set': [...value].map((v) => canonical(v, seen)).sort() };
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (!DROPPED_KEYS.has(key)) out[key] = canonical(value[key], seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function digest(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// A handful of headline numbers, so a failing fixture reads as something a
// human can reason about before diffing the full tree.
export function headline(result) {
  return {
    encounters: result?.encounters ?? null,
    elapsedTime: result?.elapsedTime ?? null,
    dungeonsCompleted: result?.dungeonsCompleted ?? null,
    deathCount: result?.deaths ? Object.keys(result.deaths).length : null,
    experienceKeys: result?.experienceGained ? Object.keys(result.experienceGained).length : null,
  };
}
