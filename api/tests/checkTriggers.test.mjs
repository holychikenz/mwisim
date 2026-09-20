// =============================================================================
// Guards for checkTriggers()'s allocation-free fixpoint loop.
//
// Two properties are load-bearing and neither is visible from reading the
// method in isolation.
//
// 1. SNAPSHOT SEMANTICS. Upstream decides membership with `filter`, which runs
//    its predicate over EVERY element before `forEach` invokes the first
//    callback. The rewrite keeps that — it builds a liveness mask up front —
//    where a plain indexed loop with the test in the body would decide lazily.
//    The two differ the moment a unit's hitpoints cross zero mid-pass, and the
//    difference is not a wrong number but a THROWN ERROR (checkTriggersForUnit
//    rejects a dead unit) or a silently skipped trigger.
//
// 2. THE WIDE-ROSTER FALLBACK. The mask is 32 bits. Nothing in the game fields
//    a roster that wide, which means the fallback path is never exercised by
//    any simulation — and an unexercised correctness path is exactly the kind
//    that rots. `1 << 32` is `1`, not an overflow, so getting the guard wrong
//    would corrupt the mask silently rather than fail loudly.
//
// The tests drive checkTriggers() directly against a stub, because the
// behaviour under test is the ITERATION, not the combat.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';

const { default: CombatSimulator } = await import('../../src/combatsimulator/combatSimulator.js');

// A unit that is just a hitpoint pool with a name.
const unit = (name, hp = 100) => ({ name, combatDetails: { currentHitpoints: hp } });

// Drive checkTriggers() with checkTriggersForUnit() replaced by a recorder.
// `onVisit` may mutate the roster, which is how the snapshot corner case is
// reached without needing a real fight.
function visitsOf(players, enemies, onVisit = () => false) {
  const sim = Object.create(CombatSimulator.prototype);
  sim.players = players;
  sim.enemies = enemies;
  const visits = [];
  sim.checkTriggersForUnit = (u) => {
    if (u.combatDetails.currentHitpoints <= 0) {
      throw new Error('Checking triggers for a dead unit');
    }
    visits.push(u.name);
    return onVisit(u, visits.length);
  };
  sim.checkTriggers();
  return visits;
}

test('every living unit is visited once per pass, players before enemies', () => {
  const players = [unit('p0'), unit('p1'), unit('p2')];
  const enemies = [unit('e0'), unit('e1')];
  assert.deepEqual(visitsOf(players, enemies), ['p0', 'p1', 'p2', 'e0', 'e1']);
});

test('the dead are skipped, and a hole in the middle does not shift the rest', () => {
  const players = [unit('p0'), unit('p1', 0), unit('p2')];
  assert.deepEqual(visitsOf(players, null), ['p0', 'p2']);
});

test('a null enemy list is tolerated', () => {
  assert.deepEqual(visitsOf([unit('p0')], null), ['p0']);
});

test('the fixpoint repeats while a unit reports that something triggered', () => {
  let firings = 2;
  const visits = visitsOf([unit('p0')], null, () => firings-- > 0);
  // Two productive passes plus the one that settles it.
  assert.deepEqual(visits, ['p0', 'p0', 'p0']);
});

test('membership is decided UP FRONT: a unit that dies mid-pass is still visited', () => {
  // This is the whole reason the mask exists. p2 dies while p0 is being
  // checked; `filter` would already have admitted it, so it must still be
  // visited — and checkTriggersForUnit's dead-unit guard must therefore NOT
  // fire, because the caller is upstream-faithful.
  const players = [unit('p0'), unit('p1'), unit('p2')];
  const visits = [];
  const sim = Object.create(CombatSimulator.prototype);
  sim.players = players;
  sim.enemies = null;
  sim.checkTriggersForUnit = (u) => {
    visits.push(`${u.name}@${u.combatDetails.currentHitpoints}`);
    if (u.name === 'p0') players[2].combatDetails.currentHitpoints = 0;
    return false;
  };
  sim.checkTriggers();
  assert.deepEqual(visits, ['p0@100', 'p1@100', 'p2@0']);
});

test('a roster wider than the 32-bit mask agrees with the narrow path', () => {
  // 33 players: one past the mask. `1 << 32` is `1`, NOT an overflow, so a
  // guard that lets 33 units through the mask path aliases player 32 onto
  // player 0 and fails silently.
  //
  // The roster is chosen to make that aliasing observable rather than lucky:
  // player 0 is DEAD and player 32 is ALIVE. Under an aliased mask bit 0 is
  // clear, so p32 would be skipped. A roster with p0 alive would pass whether
  // the guard is right or wrong, which is no test at all.
  const wide = Array.from({ length: 33 }, (_, i) => unit(`p${i}`, i === 0 ? 0 : 100));
  const expected = wide.filter((u) => u.combatDetails.currentHitpoints > 0).map((u) => u.name);

  assert.equal(expected.length, 32);
  assert.ok(!expected.includes('p0'));
  assert.deepEqual(visitsOf(wide, null), expected);
  assert.equal(visitsOf(wide, null).at(-1), 'p32');
});

test('a wide ENEMY roster also takes the fallback', () => {
  const enemies = Array.from({ length: 40 }, (_, i) => unit(`e${i}`));
  const visits = visitsOf([unit('p0')], enemies);
  assert.equal(visits.length, 41);
  assert.equal(visits[0], 'p0');
  assert.equal(visits.at(-1), 'e39');
});
