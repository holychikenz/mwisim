// =============================================================================
// audit-7 — the optimiser tools refuse or correct bad input instead of
// running on it: an unknown zone, an out-of-range tier, an unknown objective,
// a selection naming one trigger twice.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { normaliseTarget } from '../lib/target.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;
const triggers = (await import('../lib/tools/triggers.js')).default;
const equipment = (await import('../lib/tools/equipment.js')).default;
const { previewTool } = await import('../lib/optimizerTool.js');

async function post(tool, body) {
  const { status, json } = previewTool(tool, body, 1);
  return { statusCode: status, body: json };
}

const players = [toCsimPlayer(BUILDS.magic, { level: 100, index: 1, items, abilityData })];
const fly = { zoneHrid: '/actions/combat/fly', difficultyTier: 0 };

test('audit-7b: an unknown zone is refused, and the tier is clamped to the game range', () => {
  assert.match(normaliseTarget({ zone: { zoneHrid: '/actions/combat/no_such_zone' } }).error, /Unknown combat zone/);
  assert.match(normaliseTarget({ zone: { zoneHrid: '/actions/brewing/tea' } }).error, /Unknown combat zone/);
  assert.equal(normaliseTarget({ zone: { ...fly, difficultyTier: 9 } }).zone.difficultyTier, 5);
  assert.equal(normaliseTarget({ zone: { ...fly, difficultyTier: -2 } }).zone.difficultyTier, 0);
  assert.equal(normaliseTarget({ zone: { ...fly, difficultyTier: 5 } }).zone.difficultyTier, 5);
  assert.equal(normaliseTarget({ zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 4 } }).zone.difficultyTier, 2);
});

test('audit-7c: both routes answer 400 to an unknown objective and accept a known one', async () => {
  for (const [tool, path] of [[triggers, 'optimize-triggers'], [equipment, 'optimize-equipment']]) {
    const bad = await post(tool, { players, zone: fly, objective: 'profitPerHour' });
    assert.equal(bad.statusCode, 400, path);
    assert.match(bad.body.error, /objective/);
    const good = await post(tool, { players, zone: fly, objective: 'experiencePerHour' });
    assert.equal(good.statusCode, 200, path);
    assert.equal(good.body.objective, 'experiencePerHour');
  }
});

test('audit2-7: an objective must be higher-is-better and reported by the target', async () => {
  const { objectiveError } = await import('../lib/optimizerTool.js');
  const zone = { kind: 'zone', dungeon: false };
  const dungeon = { kind: 'zone', dungeon: true };
  const lab = { kind: 'labyrinth' };
  for (const objective of ['deathsPerHour', 'consumableSecondsPerHour', 'consumablesPerHour', 'outOfManaSecondsPerHour']) {
    assert.ok(objectiveError({ objective }, zone), objective);
  }
  assert.ok(objectiveError({ objective: 'dungeonFailuresPerHour' }, dungeon));
  for (const objective of ['timeoutsPerHour', 'roomDeathsPerHour', 'attemptsPerHour']) assert.ok(objectiveError({ objective }, lab), objective);
  assert.ok(objectiveError({ objective: 'clearRatePercent' }, zone), 'a zone reports no clear rate');
  assert.ok(objectiveError({ objective: 'encountersPerHour' }, dungeon), 'a dungeon ranks on completions');
  assert.equal(objectiveError({ objective: 'experiencePerHour' }, zone), null);
  assert.equal(objectiveError({ objective: 'completionsPerHour' }, dungeon), null);
  assert.equal(objectiveError({ objective: 'clearRatePercent' }, lab), null);
  assert.equal(objectiveError({}, zone), null);
  const res = await post(triggers, { players, zone: fly, objective: 'deathsPerHour' });
  assert.equal(res.statusCode, 400);
});

test('audit-7d: a trigger named twice in the selection is swept once', async () => {
  const all = await post(triggers, { players, zone: fly });
  const row = all.body.selection[0];
  assert.ok(row, 'the build must offer at least one searchable trigger');
  const once = await post(triggers, { players, zone: fly, selection: [row] });
  const twice = await post(triggers, { players, zone: fly, selection: [row, { ...row }] });
  assert.equal(twice.body.selection.length, 1);
  assert.equal(twice.body.params.length, once.body.params.length);
});

test('a null stages body is the default stages, not a 500', async () => {
  const res = await post(triggers, { players, zone: fly, stages: null });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
});
