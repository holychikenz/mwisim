// =============================================================================
// Per-source buff instance tracking (game 7/15/2026 party-aura parity).
// Run: cd api && node --import ./register-loader.js --test tests/buffStacking.test.mjs
//
// Patch semantics under test: "In a party, a weaker player's aura or debuff no
// longer replaces a stronger one. The strongest active source of a buff takes
// effect, and when it expires the next strongest takes over."
//
// CombatUnit has no imports and ships default combatDetails, so we instantiate
// it directly. isPlayer=false skips the player-only regen branch in
// updateCombatDetails. Distinct sourceRef objects act as opaque identity keys.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CombatUnit = (await import('../../src/combatsimulator/combatUnit.js')).default;

const TYPE = '/buff_types/armor';
const HRID = '/buff_uniques/test_aura';

function makeUnit() {
  const u = new CombatUnit();
  u.isPlayer = false;
  return u;
}

// A temporary buff (uniqueHrid keyed). ratioBoost carries the "strength".
function buff({ ratioBoost = 0, flatBoost = 0, duration = 100 } = {}) {
  return {
    uniqueHrid: HRID,
    typeHrid: TYPE,
    ratioBoost,
    flatBoost,
    duration,
  };
}

// --------------------------------------------------------------------------
// 1. Weaker source added while a stronger one is active → effective stays the
//    stronger one. Uses NEGATIVE boosts (a debuff) to also exercise the
//    magnitude comparison: "stronger" == larger |boost|.
// --------------------------------------------------------------------------
test('weaker source does not replace a stronger active one (headline; magnitude for debuffs)', () => {
  const u = makeUnit();
  const strong = {};
  const weak = {};

  u.addBuff(buff({ ratioBoost: -0.5 }), 0, strong);
  u.addBuff(buff({ ratioBoost: -0.2 }), 10, weak); // weaker |0.2| < |0.5|, still active

  assert.equal(u.getBuffBoost(TYPE).ratioBoost, -0.5, 'strongest magnitude wins');
  assert.equal(u.combatBuffs[HRID].sourceKey, strong);
  assert.equal(u.buffInstances[HRID].length, 2, 'both instances tracked');
});

// --------------------------------------------------------------------------
// 2. Stronger source added over a weaker one → effective becomes the stronger.
// --------------------------------------------------------------------------
test('stronger source added over a weaker one takes effect', () => {
  const u = makeUnit();
  const weak = {};
  const strong = {};

  u.addBuff(buff({ ratioBoost: 0.2 }), 0, weak);
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.2);

  u.addBuff(buff({ ratioBoost: 0.5 }), 0, strong);
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.5);
  assert.equal(u.combatBuffs[HRID].sourceKey, strong);
});

// --------------------------------------------------------------------------
// 3. The strongest expires → the still-active weaker source takes over (the
//    entry is NOT deleted).
// --------------------------------------------------------------------------
test('when the strongest expires, the next strongest takes over', () => {
  const u = makeUnit();
  const strong = {};
  const weak = {};

  u.addBuff(buff({ ratioBoost: 0.5, duration: 50 }), 0, strong);  // expires at 50
  u.addBuff(buff({ ratioBoost: 0.2, duration: 200 }), 0, weak);   // expires at 200
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.5);

  u.removeExpiredBuffs(60); // past strong's expiry, before weak's
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.2, 'weaker source promoted');
  assert.equal(u.combatBuffs[HRID].sourceKey, weak);
  assert.ok(u.combatBuffs[HRID] !== undefined, 'entry survives — not deleted');
  assert.equal(u.buffInstances[HRID].length, 1);
});

// --------------------------------------------------------------------------
// 4. The same source re-applying with weaker values (fury decay-on-miss)
//    replaces its own instance → the effective drops immediately.
// --------------------------------------------------------------------------
test('same source re-applying weaker replaces its own instance (fury decay)', () => {
  const u = makeUnit();
  const self = {};

  u.addBuff(buff({ ratioBoost: 0.5 }), 0, self);
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.5);

  u.addBuff(buff({ ratioBoost: 0.2 }), 10, self); // same source, weaker
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.2, 'own instance replaced, not stacked');
  assert.equal(u.buffInstances[HRID].length, 1, 'still a single instance for this source');
});

// --------------------------------------------------------------------------
// 5. Same source, same strength → refreshes duration (single instance, later
//    expiry).
// --------------------------------------------------------------------------
test('same source, same strength re-apply refreshes duration', () => {
  const u = makeUnit();
  const self = {};

  u.addBuff(buff({ ratioBoost: 0.3, duration: 100 }), 0, self);  // expire 100
  assert.equal(u.buffInstances[HRID][0].expireTime, 100);

  u.addBuff(buff({ ratioBoost: 0.3, duration: 100 }), 50, self); // expire 150
  assert.equal(u.buffInstances[HRID].length, 1, 'refresh, not a second instance');
  assert.equal(u.buffInstances[HRID][0].expireTime, 150, 'duration refreshed');
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.3);
});

// --------------------------------------------------------------------------
// 6. removeBuff / removeBuffs with the strongest sourceRef → next strongest
//    promotes; removing the last instance deletes the combatBuffs entry.
// --------------------------------------------------------------------------
test('removeBuff removes only that source; next strongest promotes; last removal deletes entry', () => {
  const u = makeUnit();
  const strong = {};
  const weak = {};

  u.addBuff(buff({ ratioBoost: 0.5 }), 0, strong);
  u.addBuff(buff({ ratioBoost: 0.2 }), 0, weak);

  u.removeBuff(buff(), strong); // removes the strongest source's instance
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.2, 'weaker source promoted');
  assert.equal(u.combatBuffs[HRID].sourceKey, weak);

  u.removeBuff(buff(), weak); // removes the last instance
  assert.equal(u.combatBuffs[HRID], undefined, 'combatBuffs entry deleted');
  assert.equal(u.buffInstances[HRID], undefined, 'instance array deleted');
});

test('removeBuffs (array form) removes a source across multiple buffs', () => {
  const u = makeUnit();
  const self = {};
  const other = {};

  u.addBuffs([buff({ ratioBoost: 0.4 })], undefined, self);
  u.addBuff(buff({ ratioBoost: 0.1 }), 0, other);

  u.removeBuffs([buff()], self);
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.1, 'other source remains effective');
  assert.equal(u.combatBuffs[HRID].sourceKey, other);
});

// --------------------------------------------------------------------------
// 7. Permanent buffs (typeHrid-keyed, no instance array) survive
//    removeExpiredBuffs at a large time.
// --------------------------------------------------------------------------
test('permanent buffs survive removeExpiredBuffs', () => {
  const u = makeUnit();
  u.addPermanentBuff({
    uniqueHrid: '/buff_uniques/perm',
    typeHrid: '/buff_types/armor',
    flatBoost: 5,
    ratioBoost: 0,
    duration: 100,
  });
  u.clearBuffs(); // seeds combatBuffs from permanentBuffs (typeHrid key)

  assert.equal(u.getBuffBoost('/buff_types/armor').flatBoost, 5);

  u.removeExpiredBuffs(1e12); // far past any temporary expiry
  assert.equal(u.getBuffBoost('/buff_types/armor').flatBoost, 5, 'permanent buff untouched');
  assert.ok(u.combatBuffs['/buff_types/armor'] !== undefined);
});

// --------------------------------------------------------------------------
// 8. addBuffs without currentTime (enrage-style) → never expires. expireTime is
//    NaN, and every NaN comparison is false, so removeExpiredBuffs keeps it.
// --------------------------------------------------------------------------
test('buffs added without currentTime (enrage) never expire', () => {
  const u = makeUnit();
  const self = {};

  u.addBuffs([buff({ ratioBoost: 0.1 })], undefined, self);
  assert.ok(Number.isNaN(u.buffInstances[HRID][0].expireTime), 'expireTime is NaN');
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.1);

  u.removeExpiredBuffs(1e12);
  assert.equal(u.getBuffBoost(TYPE).ratioBoost, 0.1, 'never-expiring buff survives');
  assert.equal(u.buffInstances[HRID].length, 1);
});
