// =============================================================================
// A small seeded trigger search on the native twin ranks exactly as recorded:
// the pool workers select their backend from CSIM_ENGINE, so this covers
// poolWorker's seam end to end. Skipped without a built csim-native.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { loadGameData } from '../lib/simulator.js';
import { canonical, digest } from '../lib/determinism.mjs';
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

test('a seeded trigger search ranks exactly as recorded on the twin', { skip, timeout: 300_000 }, async () => {
  const native = await search('native');
  assert.equal(native.rows.length, 2);
  // 31 search simulations + verification: the baseline and one finalist on 6 paired seeds (was 2 on one seed).
  assert.equal(native.simulationsRun, 43);
  // Re-pinned for audit-9 (paired, replicated verification): stages 1-3 are unchanged; the verify rows are
  // now replicate means with paired statistics, and the finalist's -0.9% is no longer called significant.
  assert.equal(digest(canonical(native)), '187df3a7531e50a71e4630b637034801aae591c860c51b36fd700763082eb5e3');
});
