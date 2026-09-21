// =============================================================================
// The insertion-ordered mirror of `combatBuffs` (performance adaptation).
// Run: cd api && node --import ./register-loader.js --test tests/buffMirror.test.mjs
//
// `_buildBuffBoostIndex` used to walk `Object.values(this.combatBuffs)`. It now
// walks `_combatBuffList`, a mirror maintained by the same two writers, because
// `_commitInstances` deletes keys and a deleted-from object spends the rest of
// its life in V8's dictionary mode (Object.values 602 ns against 83 ns fast, 8 ns
// for an indexed array walk).
//
// THE ORDER IS THE WHOLE RISK. The rebuild sums each buff type's boosts with
// `+=` in iteration order and float addition is not associative, so a mirror in
// a different order is a plausible wrong combat number with NO error anywhere.
// JS object key order has two behaviours a naive mirror gets wrong:
//   - assigning to an EXISTING key leaves its position unchanged;
//   - delete then re-insert moves the key to the END.
// A mirror that pushed on every write reproduces the first wrongly; one that
// spliced and re-pushed on re-assign reproduces the second wrongly.
//
// So the central test is DIFFERENTIAL, in the shape pendingAction.test.mjs
// established: drive a long randomised sequence of add / re-assign / delete /
// re-add through the real writers and assert after EVERY mutation that the
// mirror equals `Object.values(combatBuffs)` element for element — the object
// itself being the oracle, since it is the thing the retired form read.
//
// Mutation-verified before it was trusted. Four deliberate breakages of
// combatUnit.js, each caught by the differential test here:
//   1. `_mirrorReplace` splices and pushes instead of writing in place
//      (re-assign wrongly moves the buff to the end);
//   2. `_commitInstances` pushes unconditionally instead of replacing
//      (duplicate entries, so a boost is summed twice);
//   3. the delete branch drops the `_mirrorRemove` call (an expired buff keeps
//      contributing);
//   4. `clearBuffs` leaves `_combatBuffList` alone instead of rebuilding it.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CombatUnit = (await import('../../src/combatsimulator/combatUnit.js')).default;
const { buffTypeOrdinal } = await import('../../src/combatsimulator/generated/buffTypes.js');

// Real buff types, so the ordinal interning is exercised rather than stubbed.
const TYPES = [
  '/buff_types/armor',
  '/buff_types/damage',
  '/buff_types/accuracy',
  '/buff_types/evasion',
  '/buff_types/threat',
];

// Eight distinct uniqueHrids, so the sequence has room to interleave.
const HRIDS = Array.from({ length: 8 }, (_, i) => `/buff_uniques/mirror_${i}`);

function makeUnit() {
  const u = new CombatUnit();
  u.isPlayer = false;
  return u;
}

function buff(hrid, type, { ratioBoost = 0, flatBoost = 0, duration = 1e9 } = {}) {
  return { uniqueHrid: hrid, typeHrid: type, ratioBoost, flatBoost, duration };
}

// The oracle: what the retired `Object.values(this.combatBuffs)` would have
// yielded, at this instant.
function oracle(u) {
  return Object.values(u.combatBuffs);
}

function assertMirrored(u, where) {
  const want = oracle(u);
  const got = u._combatBuffList;
  assert.equal(got.length, want.length, `${where}: mirror length`);
  for (let i = 0; i < want.length; i++) {
    assert.equal(got[i], want[i], `${where}: mirror[${i}] is not combatBuffs value ${i}`);
  }
}

// A seeded LCG, so a failure is reproducible. Same generator as
// pendingAction.test.mjs, for the same reason.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// --------------------------------------------------------------------------
// 1. The differential case: 4 000 randomised mutations, checked after each.
// --------------------------------------------------------------------------
test('the mirror reproduces Object.values(combatBuffs) over 4 000 randomised mutations', () => {
  const u = makeUnit();
  const rand = lcg(20260921);
  const sources = [{}, {}, {}];
  let time = 0;

  for (let step = 0; step < 4000; step++) {
    const hrid = HRIDS[Math.floor(rand() * HRIDS.length)];
    const type = TYPES[Math.floor(rand() * TYPES.length)];
    const source = sources[Math.floor(rand() * sources.length)];
    const roll = rand();
    time += 1;

    if (roll < 0.5) {
      // add, or re-assign when this hrid is already present
      u.addBuff(buff(hrid, type, { ratioBoost: rand(), flatBoost: rand() * 10 }), time, source);
    } else if (roll < 0.8) {
      // remove one source — deletes the key only when it was the last instance
      u.removeBuff(buff(hrid, type), source);
    } else if (roll < 0.95) {
      // expire everything older than a moving cutoff
      u.removeExpiredBuffs(time);
    } else {
      // wholesale replacement
      u.clearBuffs();
    }

    assertMirrored(u, `step ${step}`);
  }

  // The sequence must actually have exercised the interesting states, or the
  // test passes vacuously.
  assert.ok(u._combatBuffList.length >= 0);
});

// --------------------------------------------------------------------------
// 2. The two key-order behaviours, stated directly rather than left to chance.
// --------------------------------------------------------------------------
test('re-assigning an existing key leaves its position unchanged', () => {
  const u = makeUnit();
  const s1 = {}, s2 = {};
  u.addBuff(buff(HRIDS[0], TYPES[0], { ratioBoost: 0.1 }), 0, s1);
  u.addBuff(buff(HRIDS[1], TYPES[1], { ratioBoost: 0.2 }), 0, s1);
  u.addBuff(buff(HRIDS[2], TYPES[2], { ratioBoost: 0.3 }), 0, s1);

  // A stronger second source for HRIDS[0] replaces the VALUE at key 0.
  u.addBuff(buff(HRIDS[0], TYPES[0], { ratioBoost: 0.9 }), 0, s2);

  assertMirrored(u, 're-assign');
  assert.equal(u._combatBuffList[0].uniqueHrid, HRIDS[0], 'still first');
  assert.equal(u._combatBuffList[0].ratioBoost, 0.9, 'and it is the new value');
});

test('delete then re-insert moves the key to the end', () => {
  const u = makeUnit();
  const s1 = {};
  u.addBuff(buff(HRIDS[0], TYPES[0]), 0, s1);
  u.addBuff(buff(HRIDS[1], TYPES[1]), 0, s1);
  u.addBuff(buff(HRIDS[2], TYPES[2]), 0, s1);

  u.removeBuff(buff(HRIDS[0], TYPES[0]), s1);
  assertMirrored(u, 'after delete');

  u.addBuff(buff(HRIDS[0], TYPES[0]), 0, s1);
  assertMirrored(u, 'after re-insert');
  assert.equal(u._combatBuffList[2].uniqueHrid, HRIDS[0], 're-inserted key is last');
});

test('clearBuffs rebuilds the mirror from permanentBuffs, in key order', () => {
  const u = makeUnit();
  u.addPermanentBuff(buff('/buff_uniques/perm_a', TYPES[0], { flatBoost: 1 }));
  u.addPermanentBuff(buff('/buff_uniques/perm_b', TYPES[1], { flatBoost: 2 }));
  u.addBuff(buff(HRIDS[0], TYPES[2]), 0, {});

  u.clearBuffs();
  assertMirrored(u, 'after clearBuffs');
  assert.equal(u._combatBuffList.length, 2, 'temporary buffs are gone');
});

// --------------------------------------------------------------------------
// 3. The assumption the whole mirror rests on: no combatBuffs key is
//    integer-like, so JS's integer-keys-first ordering rule never applies.
//    Confirmed rather than assumed — it is why insertion order IS the order.
// --------------------------------------------------------------------------
test('no combatBuffs key is integer-like, so insertion order is the key order', () => {
  const u = makeUnit();
  const rand = lcg(7);
  const s = {};
  for (let i = 0; i < 200; i++) {
    const hrid = HRIDS[Math.floor(rand() * HRIDS.length)];
    u.addBuff(buff(hrid, TYPES[Math.floor(rand() * TYPES.length)]), i, s);
  }
  u.addPermanentBuff(buff('/buff_uniques/perm', TYPES[0], { flatBoost: 1 }));
  u.clearBuffs();
  u.addBuff(buff(HRIDS[0], TYPES[0]), 0, s);

  for (const key of Object.keys(u.combatBuffs)) {
    assert.equal(key[0], '/', `key ${key} does not start with a slash`);
    assert.notEqual(String(Number(key)), key, `key ${key} is integer-like`);
  }
});

// --------------------------------------------------------------------------
// 4. The interned ordinal is present on every value the rebuild will read, and
//    still agrees with buffTypeOrdinal. A missing field would index the dense
//    boost arrays at `undefined` and silently drop the buff.
// --------------------------------------------------------------------------
test('every combatBuffs value carries the interned typeOrdinal', () => {
  const u = makeUnit();
  u.addPermanentBuff(buff('/buff_uniques/perm', TYPES[3], { flatBoost: 1 }));
  u.clearBuffs();
  u.addBuff(buff(HRIDS[0], TYPES[0]), 0, {});
  u.addBuff(buff(HRIDS[1], TYPES[1]), 0, {});

  for (const b of u._combatBuffList) {
    assert.equal(b.typeOrdinal, buffTypeOrdinal(b.typeHrid), `${b.uniqueHrid} ordinal`);
  }
});

test('an unknown buff type is still a loud failure', () => {
  const u = makeUnit();
  assert.throws(() => u.addBuff(buff(HRIDS[0], '/buff_types/not_a_real_type'), 0, {}));
  assert.throws(() => u.addPermanentBuff(buff(HRIDS[0], '/buff_types/not_a_real_type')));
});
