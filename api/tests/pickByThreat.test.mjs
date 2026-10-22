// audit-20 — one threat-weighted target pick. It draws Math.random() exactly as
// the three inlined copies did, and picks uniformly when total threat is 0
// instead of throwing on `.find(...)` returning undefined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { pickByThreat } = await import(join(ROOT, 'src', 'combatsimulator', 'combatSimulator.js'));

const unit = (name, threat) => ({ name, combatDetails: { combatStats: { threat } } });

function withRandom(values, fn) {
  const real = Math.random;
  let calls = 0;
  Math.random = () => values[calls++];
  try { return { picked: fn(), calls }; } finally { Math.random = real; }
}

test('audit-20: threat-weighted pick, one draw, zero-threat units never chosen', () => {
  const units = [unit('a', 100), unit('b', 0), unit('c', 300)];
  // total 400: a ↔ [0,100), b ↔ [100,100), c ↔ [100,400)
  assert.deepEqual(withRandom([0], () => pickByThreat(units).name), { picked: 'a', calls: 1 });
  assert.deepEqual(withRandom([0.2499], () => pickByThreat(units).name), { picked: 'a', calls: 1 });
  assert.deepEqual(withRandom([0.25], () => pickByThreat(units).name), { picked: 'c', calls: 1 });
  assert.deepEqual(withRandom([0.9999], () => pickByThreat(units).name), { picked: 'c', calls: 1 });
});

test('audit-20: all-zero threat picks uniformly instead of throwing', () => {
  const units = [unit('a', 0), unit('b', 0), unit('c', 0)];
  assert.deepEqual(withRandom([0.5], () => pickByThreat(units).name), { picked: 'b', calls: 1 });
  assert.deepEqual(withRandom([0.99], () => pickByThreat(units).name), { picked: 'c', calls: 1 });
});
