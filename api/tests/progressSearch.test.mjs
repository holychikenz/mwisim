// =============================================================================
// progressSearch — the Progress tool's probes: the weapon's damage stat as the
// engine reads it, the game's level table and its 200 cap, ability books, and
// the per-level division (driven by a synthetic objective, no pool).
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import LEVEL_XP from '../../shared/levelExperienceTable.json';
import { MAX_LEVEL, applyProgress, mainStatOf, progressRows, xpBetween } from '../lib/progressSearch.js';
import { prepareProgressRun, runProgress } from '../routes/optimizeProgress.js';

const I = (name) => `/items/${name}`;
const A = (name) => `/abilities/${name}`;
const wield = (slot, name) => ({ equipment: { [`/equipment_types/${slot}`]: { hrid: I(name), enhancementLevel: 0 } } });
const BOW = wield('two_hand', 'cursed_bow');

test('mainStatOf follows the weapon\'s first combat style, read as the engine reads the weapon', () => {
  assert.equal(mainStatOf(BOW), 'ranged');
  assert.equal(mainStatOf(wield('main_hand', 'blazing_trident')), 'magic');
  assert.equal(mainStatOf(wield('main_hand', 'regal_sword')), 'melee');
  assert.equal(mainStatOf(wield('main_hand', 'cheese_spear')), 'melee'); // trains attack, damages with melee
  assert.equal(mainStatOf(wield('two_hand', 'griffin_bulwark')), 'melee'); // trains defense
  const both = { equipment: { ...wield('main_hand', 'regal_sword').equipment, ...BOW.equipment } };
  assert.equal(mainStatOf(both), 'melee');
  assert.equal(mainStatOf({ equipment: {} }), 'melee');
});

test('the level table is the game\'s', () => {
  assert.equal(LEVEL_XP.length, 201);
  assert.equal(MAX_LEVEL, 200);
  assert.deepEqual([1, 2, 100, 199, 200].map((l) => LEVEL_XP[l]), [0, 33, 1e7, 92125192822, 1e11]);
  assert.equal(xpBetween(1, 11), 964);
});

test('stat probes stop at 200 and are divided by the levels actually added', () => {
  const at = (L, opts = { levels: 10 }) => progressRows({ ...BOW, rangedLevel: L, attackLevel: 50, abilities: [] }, opts);
  const ranged = (L) => at(L).find((r) => r.id === 'stat:ranged');
  assert.deepEqual(
    (({ from, to, step, xp, label }) => ({ from, to, step, xp, label }))(ranged(50)),
    { from: 50, to: 60, step: 10, xp: LEVEL_XP[60] - LEVEL_XP[50], label: 'Ranged +10' });
  assert.equal(ranged(195).step, 5);
  assert.equal(ranged(195).xp, 33719405047);
  assert.equal(ranged(195).label, 'Ranged +5');
  assert.equal(ranged(199).step, 1);
  assert.equal(ranged(199).xp, 7874807178);
  assert.equal(ranged(200).scannable, false);
  assert.match(ranged(200).reason, /200/);
  assert.deepEqual(at(50).map((r) => r.id), ['stat:ranged', 'stat:attack']);
  assert.deepEqual(at(50, { levels: 10, stats: ['intelligence', 'junk', 'ranged'] }).map((r) => r.id),
    ['stat:ranged', 'stat:attack', 'stat:intelligence']);
});

test('ability probes: books at 50 or 500 XP, none for Promote, locked slots skipped, one row per ability', () => {
  const subject = { ...BOW, rangedLevel: 50, attackLevel: 50, intelligenceLevel: 20,
    abilities: [{ hrid: A('promote'), level: 3 }, { hrid: A('poke'), level: 1 }, { hrid: A('rain_of_arrows'), level: 10 }, { hrid: A('cleave'), level: 5 }, null] };
  const rows = Object.fromEntries(progressRows(subject, { levels: 10 }).filter((r) => r.kind === 'ability').map((r) => [r.hrid, r]));
  assert.equal(rows[A('poke')].books, Math.ceil(964 / 50));
  assert.equal(rows[A('rain_of_arrows')].books, Math.ceil(2959 / 500));
  assert.equal(rows[A('rain_of_arrows')].label, 'Rain Of Arrows +10 lvls');
  assert.equal(rows[A('rain_of_arrows')].bookHrid, I('rain_of_arrows'));
  assert.equal(rows[A('promote')].books, null);
  assert.equal(rows[A('cleave')], undefined); // slot 3 unlocks at intelligence 50

  const twice = { ...subject, intelligenceLevel: 90, abilities: [null, { hrid: A('poke'), level: 1 }, null, { hrid: A('poke'), level: 1 }, null] };
  const pokes = progressRows(twice, { levels: 10 }).filter((r) => r.kind === 'ability');
  assert.equal(pokes.length, 1);
  const [after] = applyProgress([twice], 0, pokes[0]);
  assert.deepEqual([after.abilities[1].level, after.abilities[3].level], [11, 11]);
});

test('the run ranks stats and abilities by gain per level, with what a level costs', async () => {
  const subject = { ...BOW, rangedLevel: 195, attackLevel: 50, intelligenceLevel: 20,
    abilities: [null, { hrid: A('rain_of_arrows'), level: 10 }, null, null, null] };
  const evaluate = async (jobs) => jobs.map((job) => {
    const dto = job.playerDTOs[0];
    return { id: job.id, metrics: { encountersPerHour: 100 + 2 * dto.rangedLevel + dto.abilities[1].level } };
  });
  const base = { simPlayers: [subject], subjectIndex: 0, scan: { hours: 1, replicates: 2, alpha: 0.05 }, objective: 'encountersPerHour' };
  const p = { ...base, ...prepareProgressRun(base, { levels: 10 }) };
  const result = await runProgress(p, { evaluate, seedBase: 1, onProgress: () => {} });
  assert.deepEqual(result.rows.map((r) => r.id), ['stat:ranged', 'ability:/abilities/rain_of_arrows', 'stat:attack']);
  const [ranged, rain] = result.rows;
  assert.equal(ranged.perLevel, 2);
  assert.equal(ranged.perLevelPct, 2 / 500);
  assert.equal(ranged.xpPerLevel, 33719405047 / 5);
  assert.equal(ranged.pctPerMillionXp, (10 / 500) / (33719405047 / 1e6));
  assert.equal(rain.perLevel, 1);
  assert.equal(rain.booksPerLevel, rain.books / 10);
  assert.equal(rain.pctPerBook, (10 / 500) / rain.books);
});
