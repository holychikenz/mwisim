// =============================================================================
// labyrinth-target tests
//
// Run from api/:  npm test
//
// The optimisers gained a second kind of fight. Most of the machinery did not
// need to know — the pool, the funnel, the paired statistics and the ranking are
// all indifferent to what is being simulated — so these tests concentrate on the
// four places where the two kinds genuinely differ, and on the one place where
// getting it wrong would be invisible:
//
//   * target      — what a valid target is, and what is done to the DTOs
//   * scoring     — clears, timeouts and the completion chance, including which
//                   attempts count toward the denominator
//   * saturation  — clear rate is bounded at BOTH ends, and a run pinned against
//                   either can only report ties. This is the invisible one: a
//                   saturated table looks exactly like a measured table of
//                   indistinguishable slots, and the two want opposite advice.
//   * bounds      — one room-scaled monster, not a spawn enumeration
//
// No worker threads and no simulations here: everything below is either a pure
// function or driven by a synthetic evaluator, as the sibling suites are.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LAB_UPGRADE_LEVEL,
  MAX_ROOM_LEVEL,
  buildCrateBuffs,
  buildLabUpgradeBuffs,
  knownCrates,
  normaliseTarget,
  stripConsumables,
  targetExtraBuffs,
  targetPlayerDTOs,
} from '../lib/target.js';

import {
  LABYRINTH_REPORTED_METRICS,
  REPORTED_METRICS,
  computeDeltas,
  defaultObjective,
  objectiveSaturation,
  reportedMetricsFor,
  scoreSimResult,
} from '../lib/triggerSearch/score.js';

import { breakEvenHours, enhancingHoursPerUnit } from '../../shared/enhancementRoi.js';
import { deriveBounds, deriveLabyrinthEnemyBounds } from '../lib/triggerSearch/bounds.js';
import {
  LABYRINTH_CONSUMABLE_REASON,
  collectSearchParams,
  enumerateTriggers,
} from '../lib/triggerSearch/params.js';
import { scanEquipment } from '../lib/equipmentScan/scan.js';

const ONE_HOUR_NS = 60 * 60 * 1e9;
const CYCLOPS = '/monsters/cyclops';

// -- target ------------------------------------------------------------------

test('normaliseTarget accepts a zone and a labyrinth, but never both', () => {
  const zone = normaliseTarget({ zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 2 } });
  assert.equal(zone.error, null);
  assert.equal(zone.kind, 'zone');
  assert.equal(zone.labyrinth, null);
  assert.equal(zone.zone.difficultyTier, 2);

  const lab = normaliseTarget({ labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 140 } });
  assert.equal(lab.error, null);
  assert.equal(lab.kind, 'labyrinth');
  assert.equal(lab.zone, null);
  assert.equal(lab.labyrinth.roomLevel, 140);

  // Both, and neither, are errors rather than a silent preference. The two
  // produce different objectives and different bounds; guessing which was meant
  // is exactly the quiet decision that makes a number untrustworthy.
  assert.match(
    normaliseTarget({ zone: { zoneHrid: '/actions/combat/fly' }, labyrinth: { labyrinthHrid: CYCLOPS } }).error,
    /not both/
  );
  assert.match(normaliseTarget({}).error, /required/);
});

test('normaliseTarget rejects a monster that is not a labyrinth monster', () => {
  // Not pedantry: Monster's roomLevel scaling is only meaningful for the ten
  // labyrinth monsters, and a zone monster pushed through it is a creature that
  // exists nowhere in the game.
  assert.match(normaliseTarget({ labyrinth: { labyrinthHrid: '/monsters/fly' } }).error, /not a labyrinth monster/);
  assert.match(normaliseTarget({ labyrinth: { labyrinthHrid: '/monsters/nope' } }).error, /Unknown/);
});

test('normaliseTarget clamps the room level and drops unknown crates', () => {
  const target = normaliseTarget({
    labyrinth: {
      labyrinthHrid: CYCLOPS,
      roomLevel: 99999,
      crates: ['/items/expert_tea_crate', '/items/not_a_crate', 17],
      upgrades: { combatDamage: 900, attackSpeed: -3 },
    },
  });
  assert.equal(target.labyrinth.roomLevel, MAX_ROOM_LEVEL);
  assert.deepEqual(target.labyrinth.crates, ['/items/expert_tea_crate']);
  assert.equal(target.labyrinth.upgrades.combatDamage, MAX_LAB_UPGRADE_LEVEL);
  assert.equal(target.labyrinth.upgrades.attackSpeed, 0);

  // A room level of zero is a missing value, not a request for level zero.
  assert.equal(normaliseTarget({ labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 0 } }).labyrinth.roomLevel, 1);
});

test('buildCrateBuffs drops unknown crates instead of concatenating undefined', () => {
  // The engine's Labyrinth constructor concatenates blindly, so an unrecognised
  // crate hrid puts `undefined` in the buff list and the first buff walk throws.
  // A request handler must not be crashable by a typo in a POST body.
  const known = knownCrates();
  assert.ok(known.length > 0);
  const buffs = buildCrateBuffs([known[0], '/items/not_a_crate']);
  assert.ok(buffs.length > 0);
  assert.ok(buffs.every((buff) => buff && typeof buff === 'object'));
  assert.deepEqual(buildCrateBuffs(['/items/not_a_crate']), []);
  assert.deepEqual(buildCrateBuffs(), []);
});

test('lab-shop upgrades become ratio or flat boosts, and only when purchased', () => {
  assert.deepEqual(buildLabUpgradeBuffs({}), []);
  assert.deepEqual(buildLabUpgradeBuffs({ combatDamage: 0 }), []);

  const buffs = buildLabUpgradeBuffs({ combatDamage: 5, castSpeed: 3 });
  const damage = buffs.find((b) => b.typeHrid === '/buff_types/damage');
  const cast = buffs.find((b) => b.typeHrid === '/buff_types/cast_speed');
  // Mirrors src/worker.js: damage and attack speed are RATIO boosts, cast speed
  // and critical rate are FLAT. Swapping the two would be a silent mis-buff.
  assert.equal(damage.ratioBoost, 0.05);
  assert.equal(damage.flatBoost, 0);
  assert.equal(cast.flatBoost, 0.03);
  assert.equal(cast.ratioBoost, 0);
});

test('a labyrinth target strips consumables and adds its upgrades; a zone does neither', () => {
  const players = [
    {
      hrid: 'player1',
      food: [{ hrid: '/items/donut', triggers: [] }, null, null],
      drinks: [{ hrid: '/items/swiftness_coffee', triggers: [] }, null, null],
    },
  ];

  const lab = normaliseTarget({
    labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 100, upgrades: { attackSpeed: 2 } },
  });
  const stripped = targetPlayerDTOs(players, lab);
  assert.deepEqual(stripped[0].food, [null, null, null]);
  assert.deepEqual(stripped[0].drinks, [null, null, null]);
  assert.equal(targetExtraBuffs(lab).length, 1);

  // The caller's DTOs are NOT mutated: the same baseline set is reused for the
  // trigger enumeration, which must still see the consumables in order to
  // explain why it is not offering them.
  assert.equal(players[0].food[0].hrid, '/items/donut');

  const zone = normaliseTarget({ zone: { zoneHrid: '/actions/combat/fly' } });
  assert.equal(targetPlayerDTOs(players, zone), players);
  assert.deepEqual(targetExtraBuffs(zone), []);
});

test('stripConsumables leaves equipment and abilities alone', () => {
  const [dto] = stripConsumables([
    {
      hrid: 'player1',
      equipment: { '/equipment_types/head': { hrid: '/items/acrobatic_hood', enhancementLevel: 3 } },
      abilities: [{ hrid: '/abilities/fireball', level: 10, triggers: [] }],
      food: [{ hrid: '/items/donut' }],
      drinks: [{ hrid: '/items/swiftness_coffee' }],
    },
  ]);
  assert.equal(dto.equipment['/equipment_types/head'].enhancementLevel, 3);
  assert.equal(dto.abilities[0].hrid, '/abilities/fireball');
  assert.deepEqual(dto.food, [null, null, null]);
});

// -- scoring -----------------------------------------------------------------

/** A minimal labyrinth SimResult: `n` of each outcome over `hours`. */
function labSimResult({ wins = 0, deaths = 0, timeouts = 0, hours = 1, attemptCount = null } = {}) {
  const outcomes = [
    ...Array.from({ length: wins }, () => ({ outcome: 'win' })),
    ...Array.from({ length: deaths }, () => ({ outcome: 'death' })),
    ...Array.from({ length: timeouts }, () => ({ outcome: 'timeout' })),
  ];
  return {
    isLabyrinth: true,
    simulatedTime: hours * ONE_HOUR_NS,
    encounters: wins,
    labyAttemptCount: attemptCount ?? outcomes.length,
    labRoomOutcomes: outcomes,
    manaUsed: { player1: 0 },
    deaths: { player1: deaths },
  };
}

test('scoreSimResult reports clears, timeouts and the completion chance', () => {
  const metrics = scoreSimResult(labSimResult({ wins: 30, deaths: 5, timeouts: 5, hours: 2 }));
  assert.equal(metrics.labyrinthAttempts, 40);
  assert.equal(metrics.clearRatePercent, 75);
  assert.equal(metrics.clearsPerHour, 15);
  assert.equal(metrics.roomDeathsPerHour, 2.5);
  assert.equal(metrics.timeoutsPerHour, 2.5);
  assert.equal(metrics.attemptsPerHour, 20);
});

test('the clear rate counts RESOLVED rooms, not every room the engine spawned', () => {
  // labyAttemptCount includes the room still in progress when the window closed,
  // which is unfinished rather than failed. Counting it would bias the clear rate
  // downward — and the whole point of the figure is that a player can read it as
  // the game's own completion chance.
  const metrics = scoreSimResult(labSimResult({ wins: 9, deaths: 1, attemptCount: 11 }));
  assert.equal(metrics.labyrinthAttempts, 10);
  assert.equal(metrics.clearRatePercent, 90);
});

test('scoring falls back to the coarse pair when no room resolved', () => {
  // An engine build without the outcome log, or a window shorter than one
  // attempt. Reporting a clear rate of zero would read as total failure rather
  // than as an absence of measurement, so fall back rather than invent.
  const metrics = scoreSimResult({
    isLabyrinth: true,
    simulatedTime: ONE_HOUR_NS,
    encounters: 3,
    labyAttemptCount: 4,
    labRoomOutcomes: [],
    manaUsed: { player1: 0 },
  });
  assert.equal(metrics.labyrinthAttempts, 4);
  assert.equal(metrics.clearRatePercent, 75);
  assert.equal(metrics.timeoutsPerHour, 1);
});

test('a zone result carries no labyrinth metrics at all', () => {
  // Absent rather than zero: four zeroes look exactly like a measurement of
  // something, and this table is read by people deciding where to spend levels.
  const metrics = scoreSimResult({
    simulatedTime: ONE_HOUR_NS,
    encounters: 100,
    manaUsed: { player1: 0 },
  });
  assert.equal(metrics.clearRatePercent, undefined);
  assert.equal(metrics.labyrinthAttempts, undefined);
  assert.equal(metrics.encountersPerHour, 100);
});

test('the objective and the reported metrics follow the target', () => {
  assert.equal(defaultObjective({ labyrinth: true }), 'clearRatePercent');
  assert.equal(defaultObjective({ labyrinth: true, consumableCostsKnown: true }), 'clearRatePercent');
  assert.equal(defaultObjective({ consumableCostsKnown: true }), 'effectiveEncountersPerHour');
  assert.equal(defaultObjective({}), 'encountersPerHour');

  assert.equal(reportedMetricsFor({ kind: 'labyrinth' }), LABYRINTH_REPORTED_METRICS);
  assert.equal(reportedMetricsFor({ kind: 'zone' }), REPORTED_METRICS);
  // Not a superset: encounters and the consumable bill mean nothing in a
  // labyrinth, and printing them beside a clear rate invites a comparison with
  // zone figures they have no relation to.
  assert.ok(!LABYRINTH_REPORTED_METRICS.includes('encountersPerHour'));
  assert.ok(!LABYRINTH_REPORTED_METRICS.includes('consumableSecondsPerHour'));
  assert.ok(LABYRINTH_REPORTED_METRICS.includes('clearRatePercent'));
});

test('computeDeltas covers the objective whichever target produced it', () => {
  // search.js reads deltas[objective] directly, so a labyrinth objective missing
  // from the map would silently become an undefined margin — a row reporting no
  // improvement because nobody computed one.
  const deltas = computeDeltas(
    scoreSimResult(labSimResult({ wins: 8, deaths: 2 })),
    scoreSimResult(labSimResult({ wins: 6, deaths: 4 }))
  );
  assert.equal(deltas.clearRatePercent.value, 20);
  assert.ok(Math.abs(deltas.clearRatePercent.pct - 20 / 60) < 1e-9);

  // The reverse direction is the one that keeps zone payloads honest: a key
  // NEITHER side carries is skipped rather than reported as a zero delta, so a
  // zone run does not acquire four labyrinth rows that look like measurements.
  // (A labyrinth run does still carry the zone rates — encounters ARE clears in
  // there, and the consumable bill is a truthful zero — so the skip only ever
  // fires in this direction.)
  const zoneDeltas = computeDeltas(
    scoreSimResult({ simulatedTime: ONE_HOUR_NS, encounters: 110, manaUsed: { player1: 0 } }),
    scoreSimResult({ simulatedTime: ONE_HOUR_NS, encounters: 100, manaUsed: { player1: 0 } })
  );
  assert.equal(zoneDeltas.encountersPerHour.value, 10);
  assert.equal(zoneDeltas.clearRatePercent, undefined);
  assert.equal(zoneDeltas.timeoutsPerHour, undefined);
});

// -- saturation --------------------------------------------------------------

test('clear rate saturates at BOTH ends, and the two are named', () => {
  // Measured on a real level-146 magic build against the cyclops: clear rate is
  // 100% at room levels 60-140 and 0% at 300, and only the band between them
  // measures anything. Both ends produce a table of ties; they want opposite
  // advice, so a boolean would have been the wrong shape.
  assert.equal(objectiveSaturation('clearRatePercent', 100), 'ceiling');
  assert.equal(objectiveSaturation('clearRatePercent', 0), 'floor');
  assert.equal(objectiveSaturation('clearRatePercent', 97.3), null);
  // Only a bounded objective can saturate.
  assert.equal(objectiveSaturation('encountersPerHour', 0), null);
  assert.equal(objectiveSaturation('clearRatePercent', NaN), null);
});

test('a scan that clears every attempt reports saturation, not inconclusiveness', async () => {
  // The distinction is the point. Both tables are ties, but "we could not tell"
  // asks for more replicates, while "everything already clears" asks for a
  // harder room — and the second advice is useless if the first is given.
  const candidates = [
    { id: '0:/equipment_types/head', scannable: true, step: 6, requestedStep: 6 },
    { id: '0:/equipment_types/body', scannable: true, step: 6, requestedStep: 6 },
  ];
  const evaluate = async (jobs) =>
    jobs.map((job) => ({
      id: job.id,
      metrics: { clearRatePercent: 100, clearsPerHour: 420, labyrinthAttempts: 100 },
    }));

  const result = await scanEquipment({
    playerDTOs: [{ hrid: 'player1' }],
    candidates,
    evaluate,
    applyCandidate: (dtos) => dtos,
    objective: 'clearRatePercent',
    hours: 1,
    replicates: 3,
  });

  assert.equal(result.saturated, 'ceiling');
  assert.equal(result.inconclusive, true);
  assert.ok(result.rows.every((row) => row.perLevel === 0));
});

test('a scan in the measurable band is neither saturated nor inconclusive', async () => {
  const candidates = [
    { id: '0:/equipment_types/head', scannable: true, step: 6, requestedStep: 6 },
    { id: '0:/equipment_types/body', scannable: true, step: 6, requestedStep: 6 },
  ];
  // Deterministic and separable: head is worth six points over the probe, body
  // nothing. With no variance the paired test's degenerate branch calls a
  // non-zero mean significant, which is the honest reading of "every replicate
  // agreed exactly".
  const evaluate = async (jobs) =>
    jobs.map((job) => {
      const [id] = String(job.id).split('#');
      const clearRatePercent = id === '0:/equipment_types/head' ? 76 : 70;
      return { id: job.id, metrics: { clearRatePercent, clearsPerHour: clearRatePercent } };
    });

  const result = await scanEquipment({
    playerDTOs: [{ hrid: 'player1' }],
    candidates,
    evaluate,
    applyCandidate: (dtos) => dtos,
    objective: 'clearRatePercent',
    hours: 1,
    replicates: 3,
  });

  assert.equal(result.saturated, null);
  assert.equal(result.inconclusive, false);
  assert.equal(result.rows[0].id, '0:/equipment_types/head');
  // Six points over a probe of six levels: one point per level, in percentage
  // points of clear rate.
  assert.equal(result.rows[0].perLevel, 1);
  assert.equal(result.rows[1].perLevel, 0);
});

// -- the cost of a percentage point -------------------------------------------

test('enhancingHoursPerUnit prices one unit of a bounded objective', () => {
  // 7200 s of enhancing for +0.5 percentage points per level: two hours buys
  // half a point, so a whole point costs four.
  assert.equal(enhancingHoursPerUnit({ costSeconds: 7200, gainPerLevel: 0.5 }), 4);
  assert.equal(enhancingHoursPerUnit({ costSeconds: 3600, gainPerLevel: 2 }), 0.5);
});

test('enhancingHoursPerUnit and breakEvenHours agree when the gain is relative', () => {
  // A pay-back time IS this function with the RELATIVE gain as its denominator:
  // (C/3600) x base/gain === (C/3600) / (gain/base). Pinning the identity keeps
  // the two from drifting into different conventions, since a caller swaps one
  // for the other on nothing but the target kind.
  const costSeconds = 12_345;
  const baselineRate = 610.44;
  const gainPerHour = 1.117;
  const relativeGain = gainPerHour / baselineRate;

  const payback = breakEvenHours({ costSeconds, baselineRate, gainPerHour });
  const perUnit = enhancingHoursPerUnit({ costSeconds, gainPerLevel: relativeGain });
  assert.ok(Math.abs(payback - perUnit) < 1e-9);
});

test('a level that buys nothing has no price per unit, and says so with null', () => {
  // null rather than Infinity, matching breakEvenHours: the caller renders
  // "never", and an infinity would propagate into arithmetic that quietly
  // becomes NaN somewhere downstream.
  assert.equal(enhancingHoursPerUnit({ costSeconds: 3600, gainPerLevel: 0 }), null);
  assert.equal(enhancingHoursPerUnit({ costSeconds: 3600, gainPerLevel: -0.4 }), null);
  assert.equal(enhancingHoursPerUnit({ costSeconds: 3600, gainPerLevel: NaN }), null);
});

test('an unusable cost yields no figure rather than a free one', () => {
  // isUsableEnhancementCost REJECTS zero, unlike its consumable sibling: a zero
  // from the production-time walker is nearly always "unknown" wearing the
  // costume of "free", and honouring it would report an instant, unbeatable
  // return on precisely the items we understand least.
  assert.equal(enhancingHoursPerUnit({ costSeconds: 0, gainPerLevel: 1 }), null);
  assert.equal(enhancingHoursPerUnit({ costSeconds: null, gainPerLevel: 1 }), null);
  assert.equal(enhancingHoursPerUnit({ costSeconds: -50, gainPerLevel: 1 }), null);
});

test('cheaper-per-point beats bigger-per-level, which is the entire point', () => {
  // The finding §9 records for zones, restated in the labyrinth's currency: a
  // slot can buy twice as much per level and still be the worse investment,
  // because the next level on it sits far enough up the enhancement curve to
  // cost fifty times as much. Ranking on the gain alone sends the player to the
  // worst available purchase.
  const hood = enhancingHoursPerUnit({ costSeconds: 3540, gainPerLevel: 0.084 });
  const boots = enhancingHoursPerUnit({ costSeconds: 62, gainPerLevel: 0.043 });
  assert.ok(hood > boots);
});

// -- bounds ------------------------------------------------------------------

test('labyrinth enemy bounds come from one room-scaled monster', () => {
  const low = deriveLabyrinthEnemyBounds(CYCLOPS, 50);
  const high = deriveLabyrinthEnemyBounds(CYCLOPS, 200);

  assert.equal(low.resolved, true);
  // A room spawns exactly one monster, so the total and the single-target
  // ceilings are the same number — and every "2+ units" threshold is dead.
  assert.equal(low.maxSpawnCount, 1);
  assert.equal(low.totalHitpoints, low.targetHitpoints);
  // Every stat scales by roomLevel / 100, so the same hrid at two room levels is
  // two different creatures. If the monster cache ignored the room level, these
  // would be equal — which is the bug this test exists to catch.
  assert.ok(high.targetHitpoints > low.targetHitpoints);

  const unresolved = deriveLabyrinthEnemyBounds(null, 100);
  assert.equal(unresolved.resolved, false);
});

test('deriveBounds routes on the target kind', () => {
  const playerDTOs = [{ hrid: 'player1', staminaLevel: 50, equipment: {}, abilities: [] }];

  const lab = deriveBounds({
    playerDTOs,
    target: normaliseTarget({ labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 100 } }),
  });
  assert.equal(lab.enemies.maxSpawnCount, 1);
  assert.ok(lab.players[0].maxHitpoints > 0);

  const zone = deriveBounds({
    playerDTOs,
    target: normaliseTarget({ zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 } }),
  });
  assert.equal(zone.enemies.resolved, true);
});

test('crate buffs reach the player bounds', () => {
  // zoneBuffs is the engine's name for "the buffs this location grants", and in
  // a labyrinth that is the supply crates. They lift max HP, so a `self` +
  // current_hp ceiling derived without them would be too low.
  const playerDTOs = [{ hrid: 'player1', staminaLevel: 50, equipment: {}, abilities: [] }];
  const bare = deriveBounds({
    playerDTOs,
    target: normaliseTarget({ labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 100 } }),
  });
  const supplied = deriveBounds({
    playerDTOs,
    target: normaliseTarget({
      labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 100, crates: ['/items/expert_food_crate'] },
    }),
  });
  assert.ok(supplied.players[0].maxHitpoints >= bare.players[0].maxHitpoints);
});

// -- trigger enumeration -----------------------------------------------------

const TRIGGER = {
  dependencyHrid: '/combat_trigger_dependencies/self',
  conditionHrid: '/combat_trigger_conditions/missing_hp',
  comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
  value: 400,
};

function playerWithTriggers() {
  return [
    {
      hrid: 'player1',
      abilities: [{ hrid: '/abilities/fireball', level: 1, triggers: [{ ...TRIGGER }] }],
      food: [{ hrid: '/items/donut', triggers: [{ ...TRIGGER }] }, null, null],
      drinks: [{ hrid: '/items/swiftness_coffee', triggers: [{ ...TRIGGER }] }, null, null],
    },
  ];
}

test('food and drink triggers are listed with a reason, not hidden, in a labyrinth', () => {
  // Hiding a row invites the reader to assume it was searched and found wanting.
  // The user set those thresholds; they are owed the explanation.
  const rows = enumerateTriggers(playerWithTriggers(), { labyrinth: true });
  const bySlot = Object.fromEntries(rows.map((row) => [row.slotKind, row]));

  assert.equal(bySlot.abilities.searchable, true);
  assert.equal(bySlot.food.searchable, false);
  assert.equal(bySlot.food.reason, LABYRINTH_CONSUMABLE_REASON);
  assert.equal(bySlot.drinks.searchable, false);
  assert.equal(rows.length, 3, 'every trigger is still reported');

  // …and are perfectly searchable against a zone.
  const zoneRows = enumerateTriggers(playerWithTriggers());
  assert.ok(zoneRows.every((row) => row.searchable));
});

test('a consumable address is rejected by collectSearchParams in a labyrinth', () => {
  // Belt and braces over the enumeration: a stale selection posted from a
  // previous zone run must not sweep a value the engine will never read.
  const players = playerWithTriggers();
  const bounds = deriveBounds({
    playerDTOs: players,
    target: normaliseTarget({ labyrinth: { labyrinthHrid: CYCLOPS, roomLevel: 100 } }),
  });
  const selection = [
    { playerIndex: 0, slotKind: 'abilities', slotIndex: 0, triggerIndex: 0 },
    { playerIndex: 0, slotKind: 'food', slotIndex: 0, triggerIndex: 0 },
  ];

  const { params, rejected } = collectSearchParams(players, selection, bounds, { labyrinth: true });
  assert.equal(params.length, 1);
  assert.equal(params[0].slotKind, 'abilities');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, LABYRINTH_CONSUMABLE_REASON);

  const zone = collectSearchParams(players, selection, bounds);
  assert.equal(zone.params.length, 2);
});
