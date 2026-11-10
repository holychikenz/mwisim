// =============================================================================
// A small seeded trigger search ranks identically on the JS engine and the
// native twin: the pool workers select their backend from CSIM_ENGINE, so this
// covers poolWorker's seam end to end. Skipped without a built csim-native.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { loadGameData } from '../lib/simulator.js';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { NATIVE_BIN } from '../lib/twin/native.mjs';
import { createSimulationPool, makePoolEvaluator } from '../lib/triggerSearch/pool.js';
import { deriveBounds } from '../lib/triggerSearch/bounds.js';
import { enumerateTriggers, collectSearchParams } from '../lib/triggerSearch/params.js';
import { optimizeTriggers } from '../lib/triggerSearch/search.js';

const skip = !existsSync(NATIVE_BIN) && 'native engine not built';

const player = toCsimPlayer(BUILDS.melee, { level: 200, index: 1, items: loadGameData('itemDetailMap'), abilityData: loadGameData('abilityDetailMap') });
const target = { zone: { zoneHrid: '/actions/combat/gobo_planet', difficultyTier: 0 }, labyrinth: null };
const stages = { calibration: { repeats: 2 }, initial: { hours: 0.5, keepPerParam: 2 }, coarse: { hours: 0.5, beamWidth: 2 }, fine: { hours: 0.5, keep: 2 }, verify: { hours: 1 } };

async function search(engine) {
  const saved = process.env.CSIM_ENGINE;
  process.env.CSIM_ENGINE = engine; // read by each worker as it starts
  const pool = await createSimulationPool({ size: 2 });
  if (saved === undefined) delete process.env.CSIM_ENGINE;
  else process.env.CSIM_ENGINE = saved;
  try {
    const playerDTOs = [player];
    const selection = enumerateTriggers(playerDTOs).filter((t) => t.searchable).slice(0, 2);
    const { params } = collectSearchParams(playerDTOs, selection, deriveBounds({ playerDTOs, target }));
    assert.ok(params.length > 0, 'the melee build has a searchable trigger');
    const evaluate = makePoolEvaluator({ pool, zoneConfig: target.zone });
    return await optimizeTriggers({ playerDTOs, params, evaluate, stages, seedBase: 11 });
  } finally {
    await pool.destroy();
  }
}

test('a seeded trigger search ranks identically under js and native', { skip, timeout: 300_000 }, async () => {
  const js = await search('js');
  const native = await search('native');
  assert.ok(js.rows.length > 0);
  assert.ok(js.simulationsRun > 0);
  assert.deepEqual(native, js);
});
