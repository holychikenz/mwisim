// =============================================================================
// The Progress zone finder's pure helpers (ui/src/utils/zoneProgress.js) and the
// per-skill split summariseZoneRun now carries across the worker boundary.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const { summariseZoneRun } = await import('../../ui/src/utils/allZones.js');
const { finderVariants, scoreZoneRow, topZones, rankZones, rankFinalists, countRuns, QUICK_HOURS, VERIFY_HOURS, FINALISTS, TOP_N } =
  await import('../../ui/src/utils/zoneProgress.js');
const { itemDetailMap: items } = await import('../../src/combatsimulator/dataProvider.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≈ ${b}`);

test('summariseZoneRun: per-skill experience and the combo variant', () => {
  const experienceGained = { player1: { ranged: 300, attack: 700, stamina: 0 }, player2: { magic: 50 } };
  const row = summariseZoneRun({ simulatedTime: 2 * 3600e9, experienceGained },
    { zoneHrid: 'z', difficultyTier: 2, variant: 'a|b' });
  assert.deepEqual(row.experienceBySkill, experienceGained);
  assert.equal(row.variant, 'a|b');
  assert.equal(row.hours, 2);
  assert.equal(summariseZoneRun({ simulatedTime: 3600e9 }, { zoneHrid: 'z', difficultyTier: 0 }).variant, undefined);
});

// ---------------------------------------------------------------------------
// scoreZoneRow
// ---------------------------------------------------------------------------

const monsters = { '/monsters/m': { dropTable: [{ itemHrid: '/items/book_a', dropRate: 0.01, minCount: 1, maxCount: 1 }] } };
const zoneRow = (over = {}) => ({
  zoneHrid: '/actions/combat/z', difficultyTier: 0, hours: 2, numberOfPlayers: 1,
  experienceBySkill: { player1: { ranged: 600000, attack: 1400000, defense: 999 } },
  deaths: { '/monsters/m': 1000, player1: 3 }, dropRateMultiplier: { player1: 1.15 }, ...over });
const progressRows = (attack = 0.001) => [
  { id: 'stat:ranged', label: 'Ranged', kind: 'stat', skill: 'ranged', pctPerMillionXp: 0.002 },
  { id: 'stat:attack', label: 'Attack', kind: 'stat', skill: 'attack', pctPerMillionXp: attack },
  { id: 'ability:a', label: 'A', kind: 'ability', bookHrid: '/items/book_a', pctPerBook: 0.0004 },
  { id: 'ability:b', label: 'B', kind: 'ability', bookHrid: null, pctPerBook: null },
];

test('scoreZoneRow: XP and books per hour, in Progress currency', () => {
  const s = scoreZoneRow(zoneRow(), progressRows(), 'player1', monsters, items);
  near(s.progressPerHour, 0.0036, 'progress/h');
  near(s.booksPerHour, 5.75, 'books/h');
  assert.equal(s.xpPerHour, 1000499.5);
  assert.deepEqual(s.parts.map((p) => p.id), ['stat:ranged', 'stat:attack', 'ability:a', 'ability:b']);
  assert.equal(s.zoneHrid, '/actions/combat/z', 'the row survives');
  near(scoreZoneRow(zoneRow({ dropRateMultiplier: { player1: 1 } }), progressRows(), 'player1', monsters, items).booksPerHour, 5);
  near(scoreZoneRow(zoneRow(), progressRows(-0.001), 'player1', monsters, items).progressPerHour, 0.0029, 'negative clamped');
  const withP2 = zoneRow({ experienceBySkill: { ...zoneRow().experienceBySkill, player2: { ranged: 9e9 } } });
  near(scoreZoneRow(withP2, progressRows(), 'player1', monsters, items).progressPerHour, 0.0036, 'player2 ignored');
  assert.equal(scoreZoneRow(zoneRow({ error: 'boom' }), progressRows(), 'player1', monsters, items), null);
  assert.equal(scoreZoneRow(zoneRow({ hours: 0 }), progressRows(), 'player1', monsters, items), null);
  assert.equal(scoreZoneRow(null, progressRows(), 'player1', monsters, items), null);
  const dungeon = scoreZoneRow(zoneRow({ isDungeon: true }), progressRows(), 'player1', monsters, items);
  assert.equal(dungeon.booksPerHour, 0);
  near(dungeon.progressPerHour, 0.0013, 'dungeon: XP only');
  assert.equal(dungeon.xpPerHour, 1000499.5);
  assert.equal(dungeon.parts.find((p) => p.id === 'ability:a').perHour, 0);
});

test('rankZones / countRuns: a stopped pass ranks what it has; failed runs are counted, not ranked', () => {
  const job = { progressRows: progressRows(), subjectHrid: 'player1', monsters, items };
  const rows = [zoneRow({ variant: 'v1' }),
    zoneRow({ variant: 'v2', experienceBySkill: { player1: { ranged: 1200000 } } }),
    zoneRow({ zoneHrid: '/actions/combat/y', variant: 'v1', error: 'boom' })];
  const top = rankZones(rows, job, TOP_N);
  assert.equal(top.length, 1);
  assert.equal(top[0].variant, 'v1');
  assert.deepEqual(rankZones([rows[2]], job, TOP_N), []);
  assert.deepEqual(countRuns(rows), { runs: 3, failed: 1 });
  assert.deepEqual(countRuns(rows, { runs: 10, failed: 2 }), { runs: 13, failed: 3 });
  assert.deepEqual(countRuns([]), { runs: 0, failed: 0 });
});

test('rankFinalists: long rows re-rank the finalists; one without a long row keeps its quick score', () => {
  const job = { progressRows: progressRows(), subjectHrid: 'player1', monsters, items };
  const quickTop = rankZones([zoneRow({ variant: 'v1' }), zoneRow({ zoneHrid: '/actions/combat/y', variant: 'v1',
    experienceBySkill: { player1: { ranged: 300000 } } })], job, FINALISTS);
  assert.equal(quickTop.length, 2);
  // z's long run did better, y's failed: y keeps its quick score, marked.
  const long = [zoneRow({ variant: 'v1', hours: 24, experienceBySkill: { player1: { ranged: 240e6 } } }),
    zoneRow({ zoneHrid: '/actions/combat/y', variant: 'v1', error: 'boom' })];
  const top = rankFinalists(quickTop, long, job, TOP_N);
  assert.deepEqual(top.map((r) => [r.zoneHrid, r.hours, !!r.quickOnly]), [['/actions/combat/z', 24, false], ['/actions/combat/y', 2, true]]);
  // Stopped before any long row landed: the quick ranking stands.
  assert.deepEqual(rankFinalists(quickTop, [], job, TOP_N).map((r) => r.zoneHrid), quickTop.map((r) => r.zoneHrid));
  // A long row that earns nothing drops the zone rather than falling back.
  assert.equal(rankFinalists(quickTop, [zoneRow({ variant: 'v1', experienceBySkill: {}, deaths: {} })], job, TOP_N).length, 1);
  assert.deepEqual(rankFinalists([], [], job, TOP_N), []);
});

// ---------------------------------------------------------------------------
// topZones
// ---------------------------------------------------------------------------

test('topZones: best variant per (zone, tier), best first, zero-earners dropped', () => {
  const r = (zoneHrid, difficultyTier, variant, progressPerHour) => ({ zoneHrid, difficultyTier, variant, progressPerHour });
  const rows = [r('a', 0, 'v1', 1), r('a', 0, 'v2', 3), r('a', 1, 'v1', 2), r('b', 0, 'v1', 5), r('c', 0, 'v1', 0), null];
  assert.deepEqual(topZones(rows, 2), [rows[3], rows[1]]);
  assert.equal(topZones(rows, 15).length, 3);
  const many = Array.from({ length: 20 }, (_, i) => r(`z${i}`, 0, 'v', i + 1));
  assert.equal(topZones(many, FINALISTS).length, 15);
  const top = topZones(many, TOP_N);
  assert.equal(top.length, 10);
  assert.equal(top[0].zoneHrid, 'z19');
  assert.deepEqual([QUICK_HOURS, VERIFY_HOURS, FINALISTS, TOP_N], [3, 24, 15, 10]);
});

// ---------------------------------------------------------------------------
// finderVariants
// ---------------------------------------------------------------------------

const CHARM = '/equipment_types/charm';
const stat = (skill, pct = 0.001) => ({ id: `stat:${skill}`, kind: 'stat', skill, pctPerMillionXp: pct });
const customTriggers = [{ dependencyHrid: '/combat_trigger_dependencies/self', conditionHrid: 'x', comparatorHrid: 'y', value: 1 }];
const subject = (over = {}) => ({
  hrid: 'player1', rangedLevel: 110, attackLevel: 105, staminaLevel: 90, defenseLevel: 100,
  equipment: { [CHARM]: { hrid: '/items/master_ranged_charm', enhancementLevel: 5 }, '/equipment_types/body': { hrid: '/items/b', enhancementLevel: 0 } },
  drinks: [{ hrid: '/items/ranged_coffee', triggers: [] }, { hrid: '/items/wisdom_coffee', triggers: customTriggers }, null],
  ...over });

test('finderVariants: a charm per measured stat whose requirement is met, times wisdom/lucky', () => {
  const s = subject();
  const before = structuredClone(s);
  const vs = finderVariants(s, [stat('ranged'), stat('attack'), stat('stamina')], items);
  assert.deepEqual([...new Set(vs.map((v) => v.charm))], ['/items/master_ranged_charm', '/items/master_attack_charm']);
  assert.equal(vs.length, 4);
  assert.equal(new Set(vs.map((v) => v.key)).size, 4);
  for (const v of vs) {
    assert.equal(v.player.equipment[CHARM].enhancementLevel, 5);
    assert.equal(v.player.equipment[CHARM].hrid, v.charm);
    assert.equal(v.player.equipment['/equipment_types/body'], s.equipment['/equipment_types/body']);
  }
  const wisdom = vs.find((v) => v.coffee === '/items/wisdom_coffee');
  assert.equal(wisdom.player.drinks[1], s.drinks[1], 'the slotted coffee is kept as is');
  const lucky = vs.find((v) => v.coffee === '/items/lucky_coffee');
  assert.equal(lucky.player.drinks[1].hrid, '/items/lucky_coffee');
  const defaults = items['/items/lucky_coffee'].consumableDetail.defaultCombatTriggers;
  assert.deepEqual(lucky.player.drinks[1].triggers, defaults);
  assert.notEqual(lucky.player.drinks[1].triggers[0], defaults[0], 'a copy, not the game data');
  assert.equal(lucky.player.drinks[0], s.drinks[0]);
  assert.equal(lucky.player.drinks[2], null);
  assert.deepEqual(s, before, 'the subject is not mutated');

  const def = subject({ equipment: { ...s.equipment, [CHARM]: { hrid: '/items/master_defense_charm', enhancementLevel: 5 } } });
  const worn = finderVariants(def, [stat('ranged'), stat('attack')], items);
  assert.deepEqual([...new Set(worn.map((v) => v.charm))],
    ['/items/master_defense_charm', '/items/master_ranged_charm', '/items/master_attack_charm'], 'the worn charm goes first');
  assert.equal(worn.length, 6);
  assert.equal(worn[0].player.equipment[CHARM].hrid, '/items/master_defense_charm');
});

test('finderVariants: unmeasured stats, no charm, no coffee, both coffees', () => {
  const nullStat = finderVariants(subject(), [stat('ranged'), stat('attack', null)], items);
  assert.deepEqual([...new Set(nullStat.map((v) => v.charm))], ['/items/master_ranged_charm']);

  const bare = subject({ equipment: { '/equipment_types/body': { hrid: '/items/b', enhancementLevel: 0 } } });
  const noCharm = finderVariants(bare, [stat('ranged')], items);
  assert.ok(noCharm.every((v) => v.charm === null && v.player.equipment === bare.equipment));

  const plain = subject({ equipment: bare.equipment, drinks: [{ hrid: '/items/ranged_coffee', triggers: [] }] });
  const one = finderVariants(plain, [stat('ranged')], items);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].player, plain);

  const both = subject({ drinks: [{ hrid: '/items/wisdom_coffee', triggers: [] }, { hrid: '/items/lucky_coffee', triggers: [] }] });
  assert.ok(finderVariants(both, [stat('ranged')], items).every((v) => v.coffee === null));
});

test('real data: every tier of every combat charm exists and focuses its skill', () => {
  for (const tier of ['trainee', 'basic', 'advanced', 'expert', 'master', 'grandmaster']) {
    for (const skill of ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic']) {
      const hrid = `/items/${tier}_${skill}_charm`;
      assert.equal(items[hrid]?.equipmentDetail?.combatStats?.focusTraining, `/skills/${skill}`, hrid);
    }
  }
});
