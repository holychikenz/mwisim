// =============================================================================
// MAX_TICKS guard — scales with simulated duration, still catches a stuck loop.
//
// Regression: a ~1000 h, 3-player planet run threw "exceeded MAX_TICKS=5000000
// at simTime=3469545.91s" at a perfectly normal ~5.2k events per simulated hour.
//
// Run from api/:  npm test
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { withSeed } from '../lib/determinism.mjs';
import { loadEngine } from '../eval/engine.mjs';
import { CASES } from '../bench/builds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CombatSimulator = (await import(join(ROOT, 'src', 'combatsimulator', 'combatSimulator.js'))).default;
const engine = await loadEngine(ROOT);

const ONE_HOUR = 3600e9;

test('the tick budget scales with the simulated duration', () => {
  assert.equal(CombatSimulator.maxTicksFor(ONE_HOUR), 5_000_000);
  assert.equal(CombatSimulator.maxTicksFor(undefined), 5_000_000);
  assert.equal(CombatSimulator.maxTicksFor(Infinity), 5_000_000);
  // The reported run: 5 M ticks consumed by 963.76 h of a 1000 h limit.
  assert.ok(CombatSimulator.maxTicksFor(1000 * ONE_HOUR) > (5_000_000 / 963.76) * 1000 * 2);
});

test('a run longer than the floor budget completes when its rate is normal', async () => {
  const saved = CombatSimulator.MIN_MAX_TICKS;
  CombatSimulator.MIN_MAX_TICKS = 1000; // shrink the floor so 1 h stands in for 1000 h
  try {
    const kase = CASES.find((c) => c.id === 'floor-party');
    const r = await withSeed(1, () => engine.runZone(kase, 1));
    assert.equal(r.simulatedTime >= ONE_HOUR, true);
  } finally {
    CombatSimulator.MIN_MAX_TICKS = saved;
  }
});

test('a loop whose clock never advances still throws', async () => {
  const kase = CASES.find((c) => c.id === 'floor-solo');
  const original = CombatSimulator.prototype.processEvent;
  CombatSimulator.prototype.processEvent = function () {}; // swallow events: simulationTime stays 0
  try {
    await assert.rejects(withSeed(1, () => engine.runZone(kase, 1)), /exceeded MAX_TICKS=5000000/);
  } finally {
    CombatSimulator.prototype.processEvent = original;
  }
});
