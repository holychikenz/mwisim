// =============================================================================
// Guards for the three caches added to the engine for performance
// (equipment stat totals, the Equipment.getCombatStat memo, and the buff-boost
// index). Each one replaces a recomputation with a stored value, so each one
// can go stale — and a stale value here is a WRONG COMBAT NUMBER with no error
// anywhere, which is precisely the failure the fixtures in fixtures/sim/ and
// these assertions exist to catch.
//
// fixtures/sim/ proves the whole engine replays bit-identically; this file
// proves the individual invariants, including ones a fight happens not to
// exercise (an earlier attempt dropped "hpRegenPer10" from the stat list and
// the dungeon scenario did not notice, because that loadout grants none).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';

const SRC = '../../src/combatsimulator/';
const { default: Player, EQUIPMENT_COMBAT_STATS } = await import(SRC + 'player.js');
const { default: Equipment } = await import(SRC + 'equipment.js');
const { default: CombatUnit } = await import(SRC + 'combatUnit.js');
const { default: EventQueue } = await import(SRC + 'events/eventQueue.js');

// A kit spanning every slot shape the cache has to handle: two-hand, off-hand,
// charm (a slot the Player class does NOT predeclare), and a pouch.
const KIT = {
  '/equipment_types/head': { hrid: '/items/acrobatic_hood', enhancementLevel: 5 },
  '/equipment_types/body': { hrid: '/items/anchorbound_plate_body', enhancementLevel: 3 },
  '/equipment_types/legs': { hrid: '/items/anchorbound_plate_legs', enhancementLevel: 0 },
  '/equipment_types/feet': { hrid: '/items/pathbreaker_boots', enhancementLevel: 7 },
  '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets', enhancementLevel: 5 },
  '/equipment_types/two_hand': { hrid: '/items/cursed_bow', enhancementLevel: 5 },
  '/equipment_types/off_hand': { hrid: '/items/chimerical_quiver_refined', enhancementLevel: 5 },
  '/equipment_types/pouch': { hrid: '/items/small_pouch', enhancementLevel: 2 },
  '/equipment_types/charm': { hrid: '/items/master_attack_charm', enhancementLevel: 5 },
  '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 1 },
};

function gearedPlayer() {
  return Player.createFromDTO({
    hrid: 'p', staminaLevel: 100, intelligenceLevel: 100, attackLevel: 100,
    meleeLevel: 100, defenseLevel: 100, rangedLevel: 100, magicLevel: 100,
    equipment: KIT, food: [], drinks: [], abilities: [],
    houseRooms: {}, achievements: {}, debuffOnLevelGap: 0,
  });
}

// The pre-cache expression, kept here verbatim as the reference implementation
// — except that it calls `_computeCombatStat`, NOT the memoised
// `getCombatStat`. Going through the memo would make this a test that the two
// caches agree with each other, which they would even if both were stale.
function referenceTotal(player, stat) {
  return Object.values(player.equipment)
    .filter((equipment) => equipment != null)
    .map((equipment) => equipment._computeCombatStat(stat))
    .reduce((prev, cur) => prev + cur, 0);
}

// ---- the stat list itself ---------------------------------------------------

test('the equipment stat list is complete and has no duplicates', () => {
  assert.equal(EQUIPMENT_COMBAT_STATS.length, 70,
    'the list lost or gained a stat — equipment now contributes something different');
  assert.equal(new Set(EQUIPMENT_COMBAT_STATS).size, 70, 'duplicate stat name');
  // The two names carrying digits. A /"([a-zA-Z]+)"/ scrape drops exactly
  // these, silently, and moves kills/hr by ~2%.
  assert.ok(EQUIPMENT_COMBAT_STATS.includes('hpRegenPer10'));
  assert.ok(EQUIPMENT_COMBAT_STATS.includes('mpRegenPer10'));
});

// ---- equipment stat totals --------------------------------------------------

test('cached equipment totals equal the reference sum for every stat', () => {
  const player = gearedPlayer();
  player.updateCombatDetails();
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    assert.equal(player._equipmentStatTotals[stat], referenceTotal(player, stat),
      `cached total for ${stat} disagrees with the reference sum`);
  }
});

test('repeated recomputes are idempotent', () => {
  const player = gearedPlayer();
  player.updateCombatDetails();
  const first = { ...player.combatDetails.combatStats };
  for (let i = 0; i < 5; i++) player.updateCombatDetails();
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    assert.equal(player.combatDetails.combatStats[stat], first[stat],
      `${stat} drifted across repeated updateCombatDetails() calls`);
  }
});

test('swapping a worn item invalidates the cache (the browser equip path)', () => {
  const player = gearedPlayer();
  player.updateCombatDetails();
  const before = player.combatDetails.combatStats.armor;

  // src/main.js updateEquipmentState() does exactly this to a live Player and
  // then calls updateCombatDetails() again via updateCombatStatsUI().
  player.equipment['/equipment_types/body'] = null;
  player.updateCombatDetails();
  assert.notEqual(player.combatDetails.combatStats.armor, before,
    'dropping a plate body left the armor total unchanged — the cache went stale');
  // Compare the CACHE, not combatStats: CombatUnit.updateCombatDetails folds
  // buffs and the +0.01 player regen floor into combatStats afterwards, so the
  // two are only equal for stats nothing downstream touches.
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    assert.equal(player._equipmentStatTotals[stat], referenceTotal(player, stat));
  }
});

test('adding and deleting a slot key invalidates the cache', () => {
  const player = gearedPlayer();
  player.updateCombatDetails();

  // Deleting a key shortens the walk, so the signature-length check is what
  // has to catch it — the per-slot comparisons never see the missing slot.
  delete player.equipment['/equipment_types/head'];
  player.updateCombatDetails();
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    assert.equal(player._equipmentStatTotals[stat], referenceTotal(player, stat),
      `${stat} stale after a slot key was deleted`);
  }

  // Adding one lengthens it, so the extra iteration runs off the end of the
  // signature and compares against undefined.
  player.equipment['/equipment_types/ring'] =
    Equipment.createFromDTO({ hrid: '/items/philosophers_ring', enhancementLevel: 4 });
  player.updateCombatDetails();
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    assert.equal(player._equipmentStatTotals[stat], referenceTotal(player, stat),
      `${stat} stale after a slot key was added`);
  }
  assert.notEqual(player._equipmentStatTotals.armor, 0);
});

test('re-enhancing a worn item invalidates the cache', () => {
  const player = gearedPlayer();
  player.updateCombatDetails();
  const before = player.combatDetails.combatStats.armor;

  player.equipment['/equipment_types/body'].enhancementLevel = 12;
  player.updateCombatDetails();
  assert.notEqual(player.combatDetails.combatStats.armor, before,
    'enhancement level change did not reach the totals');
  assert.equal(player._equipmentStatTotals.armor, referenceTotal(player, 'armor'));
});

test('a bare player sums to zero everywhere', () => {
  const player = Player.createFromDTO({
    hrid: 'p', staminaLevel: 1, intelligenceLevel: 1, attackLevel: 1,
    meleeLevel: 1, defenseLevel: 1, rangedLevel: 1, magicLevel: 1,
    equipment: {}, food: [], drinks: [], abilities: [],
    houseRooms: {}, achievements: {}, debuffOnLevelGap: 0,
  });
  player.updateCombatDetails();
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    assert.equal(player._equipmentStatTotals[stat], 0, `${stat} is non-zero on a naked player`);
  }
});

// ---- Equipment.getCombatStat memo -------------------------------------------

test('the getCombatStat memo returns the uncached value', () => {
  const piece = new Equipment('/items/anchorbound_plate_body', 5);
  for (const stat of EQUIPMENT_COMBAT_STATS) {
    const memoised = piece.getCombatStat(stat);
    assert.equal(memoised, piece._computeCombatStat(stat), `memo disagrees for ${stat}`);
    assert.equal(piece.getCombatStat(stat), memoised, `memo not stable for ${stat}`);
  }
});

// ---- buff boost index -------------------------------------------------------

// The pre-index expressions, kept verbatim as the reference implementation.
function referenceBoosts(unit, type) {
  return Object.values(unit.combatBuffs)
    .filter((buff) => buff.typeHrid == type)
    .map((buff) => ({ ratioBoost: buff.ratioBoost, flatBoost: buff.flatBoost }));
}
function referenceBoost(unit, type) {
  return referenceBoosts(unit, type).reduce(
    (acc, b) => ({ ratioBoost: acc.ratioBoost + (b?.ratioBoost ?? 0), flatBoost: acc.flatBoost + (b?.flatBoost ?? 0) }),
    { ratioBoost: 0, flatBoost: 0 });
}

const buff = (unique, type, ratio, flat, duration = 10e9) => ({
  uniqueHrid: unique, typeHrid: type, ratioBoost: ratio, flatBoost: flat, duration,
});

const TYPES = ['/buff_types/armor', '/buff_types/damage', '/buff_types/evasion',
  '/buff_types/attack_speed', '/buff_types/nothing_grants_this'];

function assertIndexAgrees(unit, note) {
  for (const type of TYPES) {
    assert.deepStrictEqual(unit.getBuffBoosts(type), referenceBoosts(unit, type),
      `getBuffBoosts(${type}) disagrees with a fresh scan ${note}`);
    assert.deepStrictEqual(unit.getBuffBoost(type), referenceBoost(unit, type),
      `getBuffBoost(${type}) disagrees with a fresh scan ${note}`);
  }
}

test('the buff index tracks every write path to combatBuffs', () => {
  const unit = new CombatUnit();
  const a = {}, b = {}; // opaque source identities

  assertIndexAgrees(unit, 'on a fresh unit');

  unit.addBuff(buff('/u/1', '/buff_types/armor', 0.1, 5), 0, a);
  assertIndexAgrees(unit, 'after one add');

  unit.addBuff(buff('/u/2', '/buff_types/armor', 0.3, 7), 0, b);
  unit.addBuff(buff('/u/3', '/buff_types/damage', 0.2, 0), 0, a);
  unit.addBuff(buff('/u/4', '/buff_types/evasion', 0, 11), 0, b);
  assertIndexAgrees(unit, 'after several adds across types');

  // Same source re-applying replaces its own instance rather than stacking.
  unit.addBuff(buff('/u/1', '/buff_types/armor', 0.9, 1), 0, a);
  assertIndexAgrees(unit, 'after a same-source re-apply');

  unit.removeBuff(buff('/u/2', '/buff_types/armor', 0.3, 7), b);
  assertIndexAgrees(unit, 'after a remove');

  // Expiry — removeExpiredBuffs commits through the same path.
  unit.removeExpiredBuffs(100e9);
  assertIndexAgrees(unit, 'after everything expired');

  // clearBuffs replaces combatBuffs wholesale from permanentBuffs.
  unit.addPermanentBuff(buff('/u/perm', '/buff_types/armor', 0, 42, 0));
  unit.clearBuffs();
  assertIndexAgrees(unit, 'after clearBuffs restored the permanent buffs');
  assert.equal(unit.getBuffBoost('/buff_types/armor').flatBoost, 42);
});

test('a buff type nothing grants yields an empty, non-writable result', () => {
  const unit = new CombatUnit();
  const boosts = unit.getBuffBoosts('/buff_types/nothing_grants_this');
  assert.deepStrictEqual(boosts, []);
  // Shared and frozen: a caller pushing onto it would corrupt every unit.
  assert.throws(() => boosts.push({ ratioBoost: 1, flatBoost: 1 }));
});

// ---- event queue ------------------------------------------------------------

test('EventQueue scans the live heap and clears every match', () => {
  const q = new EventQueue();
  assert.ok(Array.isArray(q.minHeap.heapArray),
    'heap-js stopped exposing heapArray — the in-place scans are broken');

  const unitA = {}, unitB = {};
  for (let i = 0; i < 40; i++) {
    q.addEvent({ time: (i * 37) % 40, type: i % 2 ? 'odd' : 'even', hrid: 'e' + i,
      source: i % 3 === 0 ? unitA : unitB, target: null });
  }

  assert.ok(q.containsEventOfType('odd'));
  assert.ok(q.containsEventOfTypeAndHrid('even', 'e10'));
  assert.ok(!q.containsEventOfType('missing'));
  assert.equal(q.getMatching((e) => e.hrid === 'e7').hrid, 'e7');
  assert.equal(q.getMatching((e) => e.hrid === 'nope'), null);

  // The removal-during-iteration trap: remove() re-heapifies in place, so a
  // scan that removed as it walked would miss entries.
  assert.equal(q.clearMatching((e) => e.source === unitA), true);
  assert.equal(q.getMatching((e) => e.source === unitA), null,
    'clearMatching left matching events behind');
  assert.equal(q.minHeap.heapArray.length, 40 - 14);
  assert.equal(q.clearMatching((e) => e.source === unitA), false);

  // Still a valid min-heap after all that.
  let last = -Infinity;
  for (let e = q.getNextEvent(); e; e = q.getNextEvent()) {
    assert.ok(e.time >= last, 'heap ordering broken');
    last = e.time;
  }
});
