// =============================================================================
// MAX_TICKS guard — grows with elapsed simulated time, still catches a stuck loop.
//
// Regression: a ~1000 h, 3-player planet run threw "exceeded MAX_TICKS=5000000
// at simTime=3469545.91s" at a perfectly normal ~5.2k events per simulated hour.
//
// Run from api/:  npm test
// =============================================================================

import test from 'node:test';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

import { withSeed } from '../lib/determinism.mjs';
import { loadEngine } from '../eval/engine.mjs';
import { CASES } from '../bench/builds.mjs';
import CombatSimulator from '../../src/combatsimulator/combatSimulator.js';

const engine = await loadEngine(fileURLToPath(new URL('../..', import.meta.url)));
const ONE_HOUR = 3600e9;
const caseById = (id) => CASES.find((c) => c.id === id);

test('the tick budget grows with elapsed simulated time', () => {
  assert.equal(CombatSimulator.maxTicksAt(0), 5_000_000);
  assert.equal(CombatSimulator.maxTicksAt(1000 * ONE_HOUR), 105_000_000);
});

// The reported run, end to end: ~5.17 M events in 1000 h, past the old fixed 5 M.
test('a 1000 h three-player planet run completes', async () => {
  const r = await withSeed(1, () => engine.runZone(caseById('floor-party'), 1000));
  assert.ok(r.simulatedTime >= 1000 * ONE_HOUR);
});

// A long limit must not buy a frozen clock a bigger budget.
test('a loop whose clock never advances throws at 5 M even under a 1000 h limit', async () => {
  const original = CombatSimulator.prototype.processEvent;
  CombatSimulator.prototype.processEvent = function () {}; // swallow events: simulationTime stays 0
  try {
    await assert.rejects(
      withSeed(1, () => engine.runZone(caseById('floor-solo'), 1000)),
      /exceeded MAX_TICKS=5000000 at simTime=0\.00s/
    );
  } finally {
    CombatSimulator.prototype.processEvent = original;
  }
});
