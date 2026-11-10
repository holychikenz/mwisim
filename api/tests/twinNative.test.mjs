// =============================================================================
// The native twin against the JS engine on DTO shapes the corpus never sends,
// plus the native backend's timeout and pow guard. Skipped without a built
// rust/target/release/csim-native, so a machine with no Rust stays green.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';

import { withSeed, canonical, digest } from '../lib/determinism.mjs';
import { runSimulation, loadGameData } from '../lib/simulator.js';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { setTwinBackend } from '../../shared/twinEngine.js';
import { nativeBackend, NATIVE_BIN } from '../lib/twin/native.mjs';

const skip = !existsSync(NATIVE_BIN) && 'native engine not built';

const basePlayer = () =>
  toCsimPlayer(BUILDS.melee, { level: 200, index: 1, items: loadGameData('itemDetailMap'), abilityData: loadGameData('abilityDetailMap') });
const ZONE = { zoneHrid: '/actions/combat/gobo_planet', difficultyTier: 0 };

/** The request on the twin (native) or the JS engine, under seed 1. */
async function runOn(twin, req) {
  const b = twin ? nativeBackend() : null;
  setTwinBackend(b);
  try {
    return await withSeed(1, () => runSimulation(structuredClone(req)));
  } finally {
    setTwinBackend(null);
    b?.close();
  }
}

async function assertSame(req) {
  const js = digest(canonical(await runOn(false, req)));
  assert.equal(digest(canonical(await runOn(true, req))), js);
}

test('a loose DTO (locked/unused slots without triggers, array achievements, null ability level) matches JS bit for bit', { skip }, async () => {
  const p = basePlayer();
  p.achievements = [];
  p.intelligenceLevel = 10; // slots [0,1,1,20,50,90]: abilities 0 and 1 unlocked, 2-4 locked
  delete p.abilities[4].triggers;
  p.abilities[1].level = null;
  p.equipment['/equipment_types/pouch'] = null; // one food slot
  p.food[2] = { hrid: p.food[0].hrid };
  await assertSame({ players: [p], zone: ZONE, simulationTimeLimit: 3600e9 });
});

const dojo = (over) => ({ uniqueHrid: '/buff_uniques/guild_building_dojo', typeHrid: '/buff_types/attack_level', ratioBoost: null, ratioBoostLevelBonus: null, flatBoost: 4, flatBoostLevelBonus: 0, duration: null, ...over });

test('a null buff number is 0, as in JS; a string one is refused', { skip }, async () => {
  await assertSame({ players: [basePlayer()], zone: ZONE, simulationTimeLimit: 3600e9, guildBuffs: [dojo()] });
  await assert.rejects(runOn(true, { players: [basePlayer()], zone: ZONE, simulationTimeLimit: 3600e9, guildBuffs: [dojo({ flatBoost: '4' })] }), /number or null/);
});

test('a missing or non-numeric zone.difficultyTier is an error on the twin', { skip }, async () => {
  for (const zone of [{ zoneHrid: ZONE.zoneHrid }, { ...ZONE, difficultyTier: '1' }]) {
    await assert.rejects(runOn(true, { players: [basePlayer()], zone, simulationTimeLimit: 3600e9 }), /difficultyTier/);
  }
});

const TINY = '{"seed":1,"draws":1,"pow":[],"numbers":[]}';

test('a stalled native child is killed and the next request respawns it', { skip }, async (t) => {
  const b = nativeBackend();
  try {
    await b.selftest(TINY);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = b.selftest(TINY);
    t.mock.timers.tick(24 * 3600e3);
    await assert.rejects(p, /no reply/);
    t.mock.timers.reset();
    assert.equal(JSON.parse(await b.selftest(TINY)).ok, true);
  } finally {
    b.close();
  }
});

test('the native backend refuses to run when pow differs from Math.pow', { skip }, async (t) => {
  const b = nativeBackend();
  try {
    t.mock.method(Math, 'pow', (x, y) => (x ** y) * 2);
    await assert.rejects(b.run('{}'), /not bit-identical/);
    t.mock.restoreAll();
    assert.equal(JSON.parse(await b.run('{}')).ok, false); // the guard passed; the child answered
  } finally {
    b.close();
  }
});
