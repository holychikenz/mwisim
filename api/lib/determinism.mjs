// =============================================================================
// determinism — the seeded-replay kit: one copy, shared by every harness that
// needs a simulation run to be a pure function of (inputs, seed).
//
// Extracted verbatim from api/sim-parity.mjs, which grew all of this first and
// now imports it. api/eval/ needs the identical primitives, and two copies of a
// hash function is two hashes that will eventually disagree for a reason nobody
// can reconstruct.
//
// WALL-CLOCK REDACTION — WHY canonical() SCRUBS wipeEvents[*].timestamp
// ---------------------------------------------------------------------
// src/combatsimulator/simResult.js:197 — addWipeEvent() stamps each wipe with
// `new Date().toISOString()`. That is wall-clock time: it is not a function of
// the inputs or the seed, so it changes between two runs that are otherwise
// bit-identical, and a hash taken over it is noise rather than evidence.
//
// This never fired before, only because it had never been exercised: all three
// fixtures/sim scenarios record `wipeEvents: []`. A wipe-heavy case (five bare
// L10 players in chimerical_den — 62 wipe events) hashes differently on two
// runs at the SAME seed; scrubbing the timestamp restores bit-identity.
//
// THE GENERAL RULE, of which this is one instance: any field carrying
// WALL-CLOCK TIME, a UUID, a process identity, an absolute path or a memory
// address must be redacted before hashing, or the hash stops being a statement
// about behaviour. Redact narrowly — key the redaction on the containing field,
// never on the leaf name — so that a real field that happens to be called
// `timestamp` somewhere else still participates in the hash.
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

// Fields whose value is non-deterministic and must not reach the hash. Keyed by
// the CONTAINING array/object field, so the redaction cannot spread to an
// unrelated leaf of the same name.
const REDACTIONS = {
  // simResult.js:197 — new Date().toISOString() per wipe.
  wipeEvents: ['timestamp'],
};

export const REDACTED = '@wallclock';

// Key-sorted, with the JSON-hostile values the engine can produce spelled out
// rather than silently coerced (JSON.stringify turns NaN/Infinity into null,
// which would hide exactly the kind of drift we are looking for).
export function canonical(value, seen = new Set(), redactKeys = null) {
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
    // An array inherits its parent's redaction list, so `wipeEvents` reaches
    // each element of the array rather than stopping at the array itself.
    if (Array.isArray(value)) return value.map((v) => canonical(v, seen, redactKeys));
    if (value instanceof Map) {
      return { '@map': [...value.entries()].map(([k, v]) => [canonical(k, seen), canonical(v, seen)]).sort() };
    }
    if (value instanceof Set) {
      return { '@set': [...value].map((v) => canonical(v, seen)).sort() };
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (redactKeys && redactKeys.includes(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = canonical(value[key], seen, REDACTIONS[key] || null);
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
