// G4 (docs/engine-retirement/PLAN.md): a twin-only caller of api/lib/simulator.js and
// shared/guildTrialRuns.js loads no JS engine code. A child process records every module it
// loads, imports both, runs a zone and a trial on the native twin, and lists what it loaded
// from src/combatsimulator/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_BIN } from '../lib/twin/native.mjs';

const API = fileURLToPath(new URL('..', import.meta.url));
// Pure modules a twin caller may load: no Player, Monster, CombatSimulator or other engine class.
const ALLOWED = new Set(['guildTrialStats.js', 'simSettings.js', 'trialLadder.js']);

function engineFilesLoaded(env, body) {
  const script = `
    import { registerHooks } from 'node:module';
    const seen = new Set();
    registerHooks({ load(url, context, next) { seen.add(url); return next(url, context); } });
    const sim = await import('./lib/simulator.js');
    const runs = await import('../shared/guildTrialRuns.js');
    ${body}
    const dir = '/src/combatsimulator/';
    console.log(JSON.stringify([...seen].filter((u) => u.includes(dir) && !u.includes(dir + 'data/')).map((u) => u.slice(u.indexOf(dir) + dir.length))));
  `;
  const r = spawnSync(process.execPath, ['--import', './register-loader.js', '--input-type=module', '-e', script], {
    cwd: API, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('importing the simulator and trial runner loads no JS engine code', () => {
  const loaded = engineFilesLoaded({ CSIM_ENGINE: 'js' }, '');
  assert.deepEqual(loaded.filter((f) => !ALLOWED.has(f)), []);
});

test('a zone and a trial on the native twin load no JS engine code', { skip: !existsSync(NATIVE_BIN) && 'native engine not built' }, () => {
  const loaded = engineFilesLoaded({ CSIM_ENGINE: 'native' }, `
    const { BUILDS, toCsimPlayer } = await import('./bench/builds.mjs');
    const items = sim.loadGameData('itemDetailMap'), abilityData = sim.loadGameData('abilityDetailMap');
    const players = [toCsimPlayer(BUILDS.melee, { level: 200, index: 1, items, abilityData })];
    await sim.runSimulation({ players, zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 }, simulationTimeLimit: 60e9 });
    await sim.runGuildTrialSimulation({ players, trialHrid: '/guild_combat/badger', iterations: 1 });
    (await import('../shared/twinEngine.js')).getTwinBackend()?.close?.();
  `);
  assert.deepEqual(loaded.filter((f) => !ALLOWED.has(f)), []);
});

test('the JS path still loads the engine on first use', () => {
  const loaded = engineFilesLoaded({ CSIM_ENGINE: 'js' }, `
    const { BUILDS, toCsimPlayer } = await import('./bench/builds.mjs');
    const items = sim.loadGameData('itemDetailMap'), abilityData = sim.loadGameData('abilityDetailMap');
    const players = [toCsimPlayer(BUILDS.melee, { level: 200, index: 1, items, abilityData })];
    await sim.runSimulation({ players, zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 }, simulationTimeLimit: 60e9 });
  `);
  assert.ok(loaded.includes('combatSimulator.js') && loaded.includes('player.js'), JSON.stringify(loaded));
});
