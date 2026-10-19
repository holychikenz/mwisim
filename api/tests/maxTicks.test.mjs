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

// The reported run shape, end to end: ~5.2k events/h for 1500 h is ~7.7 M events,
// half again past the old fixed 5 M, so a slightly quieter build still exercises it.
test('a 1500 h three-player planet run completes', async () => {
  const r = await withSeed(1, () => engine.runZone(caseById('floor-party'), 1500));
  assert.ok(r.simulatedTime >= 1500 * ONE_HOUR);
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

// A clock that freezes late must not spend the budget it earned before freezing.
test('a clock that freezes at 100 h throws within 5 M stalled events', async () => {
  const original = CombatSimulator.prototype.processEvent;
  let swallowed = 0;
  CombatSimulator.prototype.processEvent = function (event) {
    if (this.simulationTime < 100 * ONE_HOUR) return original.call(this, event);
    swallowed++; // budget at 100 h is 15 M; only the stall check stops this at 5 M
  };
  try {
    await assert.rejects(
      withSeed(1, () => engine.runZone(caseById('floor-solo'), 1000)),
      /exceeded MAX_TICKS=\d+ at simTime=36\d{4}\.\d{2}s/
    );
    assert.ok(swallowed <= 5_000_000, `swallowed ${swallowed}`);
  } finally {
    CombatSimulator.prototype.processEvent = original;
  }
});
