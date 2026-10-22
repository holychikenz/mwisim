// =============================================================================
// audit-6 — the optimiser pool settles promptly on destroy, abort and the loss
// of its last worker, instead of leaving run() pending forever.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadEngine } from '../eval/engine.mjs';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { createSimulationPool, makePoolEvaluator } from '../lib/triggerSearch/pool.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = await loadEngine(ROOT);
const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;
const player = toCsimPlayer(BUILDS.melee, { level: 100, index: 1, items, abilityData });
const zoneConfig = { zoneHrid: '/actions/combat/fly', difficultyTier: 0 };
// Each job is minutes of wall time; nothing here waits for one to finish.
const LONG = 5000 * 3600e9;
const job = (id) => ({ id, playersData: [player], zoneConfig, labyrinthConfig: null, extraBuffs: [], simulationTimeLimit: LONG, seed: id });

const within = (ms, promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms)),
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kill whatever a failing test left running, so a regression fails instead of hanging the suite.
async function pool1(t) {
  const pool = await createSimulationPool({ size: 1 });
  t.after(() => Promise.all(pool.workers.map((w) => w.terminate())));
  return pool;
}

test('audit-6: destroy() settles queued as well as in-flight jobs', async (t) => {
  const pool = await pool1(t);
  const run = pool.run([job(1), job(2), job(3)]);
  await sleep(300);
  await pool.destroy();
  const results = await within(2000, run);
  assert.deepEqual(results.map((r) => r.error), ['pool destroyed', 'pool destroyed', 'pool destroyed']);
  assert.equal(pool.workers.length, 0);
});

test('audit-6: an abort mid-batch rejects the evaluation and frees the workers', async (t) => {
  const pool = await pool1(t);
  const controller = new AbortController();
  const evaluate = makePoolEvaluator({ pool, zoneConfig, signal: controller.signal });
  const jobs = [1, 2, 3].map((id) => ({ id, playerDTOs: [player], simulationTimeLimit: LONG, seed: id }));
  const pending = evaluate(jobs, {});
  await sleep(300);
  controller.abort();
  await assert.rejects(within(2000, pending), { name: 'AbortError' });
  assert.equal(pool.destroyed, true);
  await sleep(200); // terminate() is asynchronous
  assert.equal(pool.workers.length, 0);
});

test('audit-6: losing the last worker fails the queue instead of hanging', async (t) => {
  const pool = await pool1(t);
  const run = pool.run([job(1), job(2)]);
  await sleep(300);
  await pool.workers[0].terminate();
  const results = await within(2000, run);
  assert.ok(results.every((r) => r.error), JSON.stringify(results));
  await pool.destroy();
});
