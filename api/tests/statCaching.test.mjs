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
const { eventTypeId } = await import(SRC + 'events/eventTypeIds.js');
const { default: Monster, MONSTER_ZEROED_COMBAT_STATS } = await import(SRC + 'monster.js');
const dataProvider = await import(SRC + 'dataProvider.js');

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

// The last entry is a REAL buff type that nothing in these tests grants — the
// index must answer "no boosts" for it. It used to be a made-up hrid; since the
// boost index is keyed by a generated ordinal, an hrid outside that table now
// throws by design (see the test below), which is the whole point.
const TYPES = ['/buff_types/armor', '/buff_types/damage', '/buff_types/evasion',
  '/buff_types/attack_speed', '/buff_types/wisdom'];

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
  const boosts = unit.getBuffBoosts('/buff_types/wisdom');
  assert.deepStrictEqual(boosts, []);
  // Shared and frozen: a caller pushing onto it would corrupt every unit.
  assert.throws(() => boosts.push({ ratioBoost: 1, flatBoost: 1 }));
});

test('a buff type outside the ordinal table throws rather than vanishing', () => {
  // The one real hazard of keying the index by ordinal: an hrid the generated
  // table never saw would index the dense arrays at `undefined`, contribute
  // nothing, and leave the simulation reporting a plausible but WRONG number
  // with no error. It must be loud.
  const unit = new CombatUnit();
  assert.throws(() => unit.getBuffBoosts('/buff_types/nothing_grants_this'), /Unknown buff type/);
  assert.throws(() => unit.getBuffBoost('/buff_types/nothing_grants_this'), /Unknown buff type/);
  unit.addPermanentBuff({
    uniqueHrid: '/u/bogus', typeHrid: '/buff_types/nothing_grants_this',
    ratioBoost: 1, flatBoost: 1, duration: 0,
  });
  assert.throws(() => unit.clearBuffs(), /Unknown buff type/,
    'a buff carrying an unknown type must fail the rebuild, not be dropped from it');
});

test('the boost index is reused between rebuilds without leaking stale entries', () => {
  // The arrays and records handed out by the index are pooled and overwritten
  // in place. That is only safe if a rebuild cannot leave a previous build's
  // entry visible under a type that no longer has one.
  const unit = new CombatUnit();
  const src = {};
  unit.addBuff(buff('/u/a', '/buff_types/armor', 0.1, 5), 0, src);
  unit.addBuff(buff('/u/b', '/buff_types/evasion', 0.2, 6), 0, src);
  assert.equal(unit.getBuffBoosts('/buff_types/armor').length, 1);

  unit.removeBuff(buff('/u/a', '/buff_types/armor', 0.1, 5), src);
  assert.deepStrictEqual(unit.getBuffBoosts('/buff_types/armor'), [],
    'a type that lost its last buff still reports the old entry');
  assert.deepStrictEqual(unit.getBuffBoost('/buff_types/armor'), { ratioBoost: 0, flatBoost: 0 },
    'the memoised sum survived a rebuild that should have invalidated it');
  // The surviving type is untouched by the pool reshuffle.
  assert.deepStrictEqual(unit.getBuffBoost('/buff_types/evasion'), { ratioBoost: 0.2, flatBoost: 6 });

  // And a re-add refills correctly from the same pool.
  unit.addBuff(buff('/u/c', '/buff_types/armor', 0.5, 9), 0, src);
  assert.deepStrictEqual(unit.getBuffBoost('/buff_types/armor'), { ratioBoost: 0.5, flatBoost: 9 });
});

// ---- the buff-apply path ----------------------------------------------------
// removeExpiredBuffs() used to end with an UNCONDITIONAL updateCombatDetails()
// — "for behavior parity with the old code" — and it is called once per combat
// event, so almost every one of those recomputes was thrown away. Making it
// conditional on something having actually expired is only safe if the
// recompute is a pure function of (equipment, levels, buff set), i.e. if
// running it twice is the same as running it once. These two tests pin that
// down; sim:check pins down the whole-engine consequence.

test('removeExpiredBuffs does not recompute when nothing has expired', () => {
  const unit = new CombatUnit();
  const a = {};
  unit.addBuff(buff('/u/1', '/buff_types/armor', 0.1, 5), 0, a);

  let recomputes = 0;
  const real = unit.updateCombatDetails.bind(unit);
  unit.updateCombatDetails = () => { recomputes++; return real(); };

  // Long before the buff expires: no write to combatBuffs, so no recompute.
  unit.removeExpiredBuffs(1e9);
  assert.equal(recomputes, 0, 'recomputed although nothing expired');

  // Past the expiry: the commit changes the effective view, so it must.
  unit.removeExpiredBuffs(100e9);
  assert.equal(recomputes, 1, 'failed to recompute when a buff expired');

  // And, having already been dropped, a second sweep must not recompute again.
  unit.removeExpiredBuffs(200e9);
  assert.equal(recomputes, 1, 'recomputed a second time for the same expiry');
});

test('updateCombatDetails is idempotent, so a skipped recompute is a no-op', () => {
  // The licence for skipping redundant recomputes. Every `+=` target in the
  // method must be reset from equipment/game data at the top of the call,
  // otherwise repeated calls would compound and the number of calls would be
  // observable.
  const player = gearedPlayer();
  player.updateCombatDetails();
  const once = JSON.parse(JSON.stringify(player.combatDetails));

  player.updateCombatDetails();
  player.updateCombatDetails();
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(player.combatDetails)), once,
    'recomputing compounds — the call COUNT is observable, so skipping one is not safe'
  );

  // Same again with buffs applied, since the buff terms are the ones that
  // accumulate onto combatStats.
  player.addBuff(buff('/u/1', '/buff_types/armor', 0.1, 5), 0, {});
  const withBuffOnce = JSON.parse(JSON.stringify(player.combatDetails));
  player.updateCombatDetails();
  player.updateCombatDetails();
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(player.combatDetails)), withBuffOnce,
    'buff boosts compound across recomputes'
  );
});

// ---- hoisted stat lists -----------------------------------------------------

test('the monster zero-fill stat list is complete and has no duplicates', () => {
  // The twin of 'the equipment stat list is complete and has no duplicates'.
  // This list was moved verbatim out of Monster.updateCombatDetails; the
  // failure it guards against is the same one that once silently dropped the
  // two DIGIT-carrying names from EQUIPMENT_COMBAT_STATS, which would leave
  // every monster whose game-data entry omits them with undefined regen.
  assert.equal(new Set(MONSTER_ZEROED_COMBAT_STATS).size, MONSTER_ZEROED_COMBAT_STATS.length);
  assert.equal(MONSTER_ZEROED_COMBAT_STATS.length, 63);
  for (const digitName of ['hpRegenPer10', 'mpRegenPer10']) {
    assert.ok(
      MONSTER_ZEROED_COMBAT_STATS.includes(digitName),
      `${digitName} is missing — the list was scraped with a pattern that drops digits`
    );
  }
  // Every name the list zero-fills must be a declared combatStats field, or the
  // zero-fill is creating a property nothing ever reads.
  //
  // This assertion used to PIN two exceptions, `abilityHaste` and `tenacity`,
  // as an upstream quirk we tolerated: both are live stats — `tenacity` is read
  // in updateCombatDetails and `abilityHaste` by the ability cooldown path —
  // that merely arrived by assignment rather than by declaration. Tolerating
  // them was not free. A field that arrives by assignment is a HIDDEN CLASS
  // TRANSITION on every unit's first recompute, and because monsters also
  // acquire `combatStyleHrids` from their game-data block, players and monsters
  // ended up with different shapes and every `combatStats.x` read in the engine
  // was polymorphic across the roster. Both are now declared in CombatUnit's
  // initializer, so the exception list is empty and stays empty.
  const fields = new CombatUnit().combatDetails.combatStats;
  const missing = MONSTER_ZEROED_COMBAT_STATS.filter((stat) => !(stat in fields));
  assert.deepStrictEqual(missing, []);
});

test('the monster base stat copy reproduces the game-data block exactly', () => {
  // Guards the flat key/value walk that replaced Object.entries() in
  // Monster.updateCombatDetails. The failure mode is a stat silently missing
  // from the copy, which leaves the monster with whatever CombatUnit's
  // initializer happened to hold — a wrong combat number with no error.
  const hrid = Object.keys(dataProvider.combatMonsterDetailMap)[0];
  const base = dataProvider.combatMonsterDetailMap[hrid].combatDetails.combatStats;

  const monster = new Monster(hrid);
  monster.updateCombatDetails();

  // Stats the recompute deliberately scales or derives are compared for
  // presence only; the rest must match value for value.
  const SCALED = new Set(['armor', 'waterResistance', 'natureResistance', 'fireResistance',
                          'attackInterval', 'combatStyleHrid']);
  for (const key of Object.keys(base)) {
    assert.ok(key in monster.combatDetails.combatStats,
      `${key} was dropped from the monster stat copy`);
    if (!SCALED.has(key)) {
      assert.deepStrictEqual(monster.combatDetails.combatStats[key], base[key],
        `${key} does not match the game-data block`);
    }
  }
  // Two copies of the same monster must agree — the cache is shared.
  const twin = new Monster(hrid);
  twin.updateCombatDetails();
  assert.deepStrictEqual(twin.combatDetails.combatStats, monster.combatDetails.combatStats);
});

test('overridden game data is not served from the stale stat copy', () => {
  // The stat-block cache is keyed on the combatStats OBJECT, not the monster
  // hrid, precisely so that setOverrides() — which installs fresh nested
  // objects — cannot be answered out of a cache built from the previous game
  // version. An hrid-keyed cache passes every other test in this file and
  // fails only here.
  const hrid = Object.keys(dataProvider.combatMonsterDetailMap)[0];
  const before = new Monster(hrid);
  before.updateCombatDetails();

  const bumped = structuredClone(dataProvider.combatMonsterDetailMap);
  bumped[hrid].combatDetails.combatStats.maxHitpoints =
    (bumped[hrid].combatDetails.combatStats.maxHitpoints ?? 0) + 12345;
  try {
    dataProvider.setOverrides({ combatMonsterDetailMap: bumped });
    const after = new Monster(hrid);
    after.updateCombatDetails();
    assert.equal(
      after.combatDetails.combatStats.maxHitpoints,
      before.combatDetails.combatStats.maxHitpoints + 12345,
      'the stat copy came from a cache built before the override'
    );
  } finally {
    dataProvider.resetOverrides();
  }
});

// ---- event queue ------------------------------------------------------------

test('EventQueue scans the live heap and clears every match', () => {
  const q = new EventQueue();
  assert.ok(Array.isArray(q.minHeap.heapArray),
    'heap-js stopped exposing heapArray — the in-place scans are broken');

  // Events carry an integer typeId alongside `type` so the queue's scans can
  // compare an int; CombatEvent's constructor mints it. Anything pushed onto
  // the queue must have one, which is what these hand-rolled events model.
  const ev = (time, type, hrid, source, target = null) =>
    ({ time, type, typeId: eventTypeId(type), hrid, source, target });

  const unitA = {}, unitB = {};
  for (let i = 0; i < 40; i++) {
    q.addEvent(ev((i * 37) % 40, i % 2 ? 'odd' : 'even', 'e' + i, i % 3 === 0 ? unitA : unitB));
  }

  assert.ok(q.containsEventOfType('odd'));
  assert.ok(q.containsEventOfTypeAndHrid('even', 'e10'));
  assert.ok(!q.containsEventOfType('missing'));
  assert.equal(q.getMatching((e) => e.hrid === 'e7').hrid, 'e7');
  assert.equal(q.getMatching((e) => e.hrid === 'nope'), null);

  // The specialised scans must agree with the generic predicate forms they
  // replaced — that equivalence is the whole claim of the change.
  assert.equal(
    q.getMatchingTypeAndSource('odd', unitA),
    q.getMatching((e) => e.type === 'odd' && e.source === unitA));
  assert.equal(q.getMatchingTypeAndSource('missing', unitA), null);
  assert.equal(
    q.getMatchingEitherTypeAndSource('odd', 'even', unitB),
    q.getMatching((e) => (e.type === 'odd' || e.type === 'even') && e.source === unitB));

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

test('the specialised clears remove exactly what the predicate forms did', () => {
  const ev = (time, type, source, target = null) =>
    ({ time, type, typeId: eventTypeId(type), source, target });
  const unitA = {}, unitB = {};
  const fill = (q) => {
    for (let i = 0; i < 30; i++) {
      q.addEvent(ev((i * 11) % 30, i % 3 ? 'tick' : 'expire', i % 2 ? unitA : unitB,
        i % 5 === 0 ? unitA : null));
    }
  };
  const drain = (q) => {
    const out = [];
    for (let e = q.getNextEvent(); e; e = q.getNextEvent()) out.push(`${e.time}:${e.type}`);
    return out;
  };

  for (const [specialised, generic] of [
    [(q) => q.clearEventsOfType('tick'), (q) => q.clearMatching((e) => e.type == 'tick')],
    [(q) => q.clearEventsForUnit(unitA),
      (q) => q.clearMatching((e) => e.source == unitA || e.target == unitA)],
    [(q) => q.clearMatchingTypeAndSource('expire', unitB),
      (q) => q.clearMatching((e) => e.type == 'expire' && e.source == unitB)],
  ]) {
    const a = new EventQueue(); fill(a);
    const b = new EventQueue(); fill(b);
    assert.equal(specialised(a), generic(b), 'return values disagree');
    assert.deepStrictEqual(drain(a), drain(b), 'the two forms left different queues behind');
  }
});

test('clearEventsForUnit keeps the loose equality its closure had', () => {
  // The closure compared with `==`, and callers pass event.target, which can be
  // null. `null == undefined` is true where `null === undefined` is false, so
  // tightening the comparison would silently stop clearing some events.
  const q = new EventQueue();
  q.addEvent({ time: 1, type: 't', typeId: eventTypeId('t'), source: null, target: null });
  assert.equal(q.clearEventsForUnit(undefined), true,
    'a null source no longer matches an undefined unit — the comparison was tightened');
});
