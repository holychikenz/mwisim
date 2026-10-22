// =============================================================================
// audit-7 — the optimiser routes refuse or correct bad input instead of
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
const triggers = (await import('../routes/optimizeTriggers.js')).default;
const equipment = (await import('../routes/optimizeEquipment.js')).default;

function handler(router, path) {
  return router.stack.find((l) => l.route?.path === path && l.route.methods.post).route.stack[0].handle;
}
async function post(router, path, body) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler(router, path)({ body }, res);
  return res;
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
  for (const [router, path] of [[triggers, '/optimize-triggers/preview'], [equipment, '/optimize-equipment/preview']]) {
    const bad = await post(router, path, { players, zone: fly, objective: 'profitPerHour' });
    assert.equal(bad.statusCode, 400, path);
    assert.match(bad.body.error, /objective/);
    const good = await post(router, path, { players, zone: fly, objective: 'experiencePerHour' });
    assert.equal(good.statusCode, 200, path);
    assert.equal(good.body.objective, 'experiencePerHour');
  }
});

test('audit-7d: a trigger named twice in the selection is swept once', async () => {
  const all = await post(triggers, '/optimize-triggers/preview', { players, zone: fly });
  const row = all.body.selection[0];
  assert.ok(row, 'the build must offer at least one searchable trigger');
  const once = await post(triggers, '/optimize-triggers/preview', { players, zone: fly, selection: [row] });
  const twice = await post(triggers, '/optimize-triggers/preview', { players, zone: fly, selection: [row, { ...row }] });
  assert.equal(twice.body.selection.length, 1);
  assert.equal(twice.body.params.length, once.body.params.length);
});
