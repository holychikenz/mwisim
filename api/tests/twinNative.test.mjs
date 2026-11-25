// =============================================================================
// The native twin on DTO shapes the corpus never sends (digests and seeded
// draws recorded on the retired JS engine, which native matched bit for bit
// before it was deleted), plus the native backend's stall watchdog, pow guard, error kinds and the
// random stream an error leaves. Skipped without a built
// rust/target/release/csim-native, so a machine with no Rust stays green.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { withSeed, canonical, digest } from '../lib/determinism.mjs';
import { runSimulation, runGuildTrialSimulation, loadGameData } from '../lib/simulator.js';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { setTwinBackend, getTwinBackend, runTwin, twinRunRequest } from '../../shared/twinEngine.js';
import { nativeBackend, NATIVE_BIN, lineSplitter } from '../lib/twin/native.mjs';

const skip = !existsSync(NATIVE_BIN) && 'native engine not built';

test('the native line reader is linear: an 8 MB line in 64-byte chunks splits fast and exactly', () => {
  const big = `7 ${'x'.repeat(8 << 20)}`;
  const stream = `1 ~progress 0.5\n${big}\n2 {}\n3 tail`;
  const lines = [];
  const split = lineSplitter((l) => lines.push(l));
  const t0 = performance.now();
  for (let i = 0; i < stream.length; i += 64) split(stream.slice(i, i + 64));
  const ms = performance.now() - t0;
  assert.deepEqual(lines.map((l) => l.length), [15, big.length, 4]); // "3 tail" has no newline yet
  assert.equal(lines[1], big);
  assert.ok(ms < 5000, `took ${ms} ms`); // the old rescan-the-buffer reader took hours here
  split('\n');
  assert.equal(lines.at(-1), '3 tail');
});

const basePlayer = () =>
  toCsimPlayer(BUILDS.melee, { level: 200, index: 1, items: loadGameData('itemDetailMap'), abilityData: loadGameData('abilityDetailMap') });
const ZONE = { zoneHrid: '/actions/combat/gobo_planet', difficultyTier: 0 };

/** The request on the native twin, under seed 1. */
async function runOn(req) {
  const b = nativeBackend();
  setTwinBackend(b);
  try {
    return await withSeed(1, () => runSimulation(structuredClone(req)));
  } finally {
    setTwinBackend(null);
    b.close();
  }
}

/** `jsDigest`: the result's digest as the JS engine produced it under seed 1. */
async function assertSame(req, jsDigest) {
  assert.equal(digest(canonical(await runOn(req))), jsDigest);
}

test('a loose DTO (locked/unused slots without triggers, array achievements, null ability level) matches JS bit for bit', { skip }, async () => {
  const p = basePlayer();
  p.achievements = [];
  p.intelligenceLevel = 10; // slots [0,1,1,20,50,90]: abilities 0 and 1 unlocked, 2-4 locked
  delete p.abilities[4].triggers;
  p.abilities[1].level = null;
  p.equipment['/equipment_types/pouch'] = null; // one food slot
  p.food[2] = { hrid: p.food[0].hrid };
  await assertSame({ players: [p], zone: ZONE, simulationTimeLimit: 3600e9 }, 'd73eee5a4749742bcf503a841a7cd17be942610adbded3b14c9527d67e461f4a');
});

const dojo = (over) => ({ uniqueHrid: '/buff_uniques/guild_building_dojo', typeHrid: '/buff_types/attack_level', ratioBoost: null, ratioBoostLevelBonus: null, flatBoost: 4, flatBoostLevelBonus: 0, duration: null, ...over });

test('a null buff number is 0, as in JS; a string one is refused', { skip }, async () => {
  await assertSame({ players: [basePlayer()], zone: ZONE, simulationTimeLimit: 3600e9, guildBuffs: [dojo()] }, '5d9af50f097949e5898fdb6a17d0abc78085d6b21322d7d0363212365866adb8');
  await assert.rejects(runOn({ players: [basePlayer()], zone: ZONE, simulationTimeLimit: 3600e9, guildBuffs: [dojo({ flatBoost: '4' })] }), /number or null/);
});

test('a missing or non-numeric zone.difficultyTier is an error on the twin', { skip }, async () => {
  for (const zone of [{ zoneHrid: ZONE.zoneHrid }, { ...ZONE, difficultyTier: '1' }]) {
    await assert.rejects(runOn({ players: [basePlayer()], zone, simulationTimeLimit: 3600e9 }), /difficultyTier/);
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
    await assert.rejects(p, /no output for 60 s/);
    t.mock.timers.reset();
    assert.equal(JSON.parse(await b.selftest(TINY)).ok, true);
  } finally {
    b.close();
  }
});

test('a run far longer than the stall limit is kept alive by its heartbeats', { skip }, async () => {
  const b = nativeBackend({ stallMs: 1500 });
  setTwinBackend(b);
  const beats = [];
  try {
    const t0 = Date.now();
    const req = { players: [basePlayer()], zone: ZONE, simulationTimeLimit: 4000 * 3600e9 };
    const json = JSON.stringify({ kind: 'zone', ...req, partyBuffs: [], settings: { monsterStartCooldown: 'auto' }, rngState: 1 });
    const res = JSON.parse(await b.run(json, (x) => beats.push(x)));
    assert.equal(res.ok, true);
    assert.ok(Date.now() - t0 > 3000, `the run must outlast the 1.5 s limit twice to prove anything (took ${Date.now() - t0} ms)`);
    assert.ok(beats.length >= 2 && beats.every((x, i) => x > 0 && x <= 1 && (i === 0 || x >= beats[i - 1])), `beats ${beats}`);
  } finally {
    setTwinBackend(null);
    b.close();
  }
});

test('a malformed selftest line gets an ok:false reply and the child keeps serving', { skip }, async () => {
  const data = fileURLToPath(new URL('../../src/combatsimulator/data', import.meta.url));
  const c = spawn(NATIVE_BIN, ['serve', '--data', data], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: c.stdout })[Symbol.asyncIterator]();
  try {
    c.stdin.write('7 {"selftest"}\n8 {"selftest":}\n9 {"selftest":' + TINY + '}\n');
    for (const id of ['7', '8']) {
      const { value } = await lines.next();
      assert.ok(value.startsWith(`${id} `), value);
      assert.equal(JSON.parse(value.slice(2)).ok, false);
    }
    const { value } = await lines.next();
    assert.equal(JSON.parse(value.slice(2)).ok, true);
  } finally {
    c.stdin.end();
  }
});

// Number() of each, against the twin's js::number (bits, so NaN, Infinity and -0 count).
const TO_NUMBER = [
  null, true, false, 0, 1.5, // (-0 has no JSON spelling: '-0' below)
  -2e-7, 1e300, {}, { a: 1 },
  '', ' ', '\t\n\r\v\f', ' 12 ', '\u00a012\ufeff', '\u2028 7 \u3000', '\u008512', '\u200b1',
  '1.', '.5', '.', '+.5e1', '-1e-2', '1e', '1e+', '1E3', '1_000', '1,000', '00012', '-0', '+0', '--1',
  'Infinity', '-Infinity', '+Infinity', 'infinity', 'inf', 'NaN', '0x1F', '0X1f', '-0x1', '0x', '0xg',
  '0o17', '0O8', '0b101', '0b2', '0x1p3', '1 2', '0x20000000000001', '0x' + 'f'.repeat(40), '0x' + 'f'.repeat(300),
  '9007199254740993', '1e400', '-1e-400', '4.9406564584124654e-324',
  [], [5], ['7'], [null], [[]], [[3]], [-0], [1, 2], [true], [{}], [' 4 '], [[1, 2]], [1e21],
];
const bitsOf = (x) => new BigUint64Array(new Float64Array([x]).buffer)[0].toString();

test('js::number matches Number() on tricky JSON values', { skip }, async () => {
  const b = nativeBackend();
  try {
    const out = JSON.parse(await b.selftest(JSON.stringify({ seed: 0, draws: 0, pow: [], numbers: [], toNumber: TO_NUMBER })));
    assert.equal(out.toNumber.length, TO_NUMBER.length);
    const fromBits = (s) => new Float64Array(new BigUint64Array([BigInt(s)]).buffer)[0];
    TO_NUMBER.forEach((v, i) => assert.ok(Object.is(fromBits(out.toNumber[i]), Number(v)), `Number(${JSON.stringify(v)}): js ${Number(v)} twin ${fromBits(out.toNumber[i])}`));
  } finally {
    b.close();
  }
});

// The first draw of a fresh seed-1 stream: what an error that drew nothing leaves next.
const SEED1_FIRST = 0.6270739405881613;

/** Run `fn` on the native twin under seed 1; returns the error's class and message, and the next seeded draw. */
async function throwThenDraw(fn) {
  const b = nativeBackend();
  setTwinBackend(b);
  try {
    return await withSeed(1, async () => {
      const s0 = Math.random.state();
      const err = await fn().then(() => null, (e) => e);
      assert.ok(err, 'expected a throw');
      return { kind: err.constructor, message: err.message, drew: Math.random.state() !== s0, next: Math.random() };
    });
  } finally {
    setTwinBackend(null);
    b.close();
  }
}

test('a mid-run throw leaves the seeded stream where JS leaves it, with the JS error class', { skip }, async () => {
  const p = basePlayer();
  // Slot 1 is first checked after slot 0's cast, mid-fight; JS then reads a missing dependency.
  p.abilities[1].triggers = [{ dependencyHrid: '/combat_trigger_dependencies/bogus', conditionHrid: '/combat_trigger_conditions/current_hp', comparatorHrid: '/combat_trigger_comparators/greater_than_equal', value: 0 }];
  const tw = await throwThenDraw(() => runSimulation(structuredClone({ players: [p], zone: ZONE, simulationTimeLimit: 3600e9 })));
  assert.ok(tw.drew, 'the run must draw before it throws, or this proves nothing');
  assert.equal(tw.kind, TypeError);
  assert.equal(tw.next, 0.6128388606011868); // the JS engine's next draw after the same throw
});

test('errors before the first draw keep their JS class and leave the stream untouched', { skip }, async () => {
  const cases = [
    [TypeError, () => runSimulation({ players: [basePlayer()], zone: { ...ZONE, zoneHrid: '/actions/combat/nope' }, simulationTimeLimit: 3600e9 })],
    [RangeError, () => runGuildTrialSimulation({ players: [basePlayer()], trialHrid: '/guild_combat/swarm', startTier: 105, iterations: 2 })],
  ];
  for (const [kind, fn] of cases) {
    const tw = await throwThenDraw(fn);
    assert.equal(tw.kind, kind);
    assert.equal(tw.drew, false);
    assert.equal(tw.next, SEED1_FIRST);
  }
});

test('run limits on a labyrinth job throw the JS RangeError, before any draw (src/worker.js seam)', { skip }, async () => {
  const labyrinth = { labyrinthHrid: '/monsters/cyclops', roomLevel: 60 };
  const runLimits = { maxRuns: 2, maxRunDurationNs: 600e9 };
  const tw = await throwThenDraw(() => runTwin(getTwinBackend(), twinRunRequest({ players: [basePlayer()], labyrinth, simulationTimeLimit: 3600e9, runLimits })));
  assert.equal(tw.kind, RangeError);
  assert.equal(tw.message, 'csim simulate(): run limits apply to dungeons only');
  assert.equal(tw.next, SEED1_FIRST);
});

test('a refusal only the twin makes kills the seeded stream for the twin', { skip }, async () => {
  const b = nativeBackend();
  setTwinBackend(b);
  try {
    await withSeed(1, async () => {
      const req = { players: [basePlayer()], zone: ZONE, simulationTimeLimit: 3600e9, guildBuffs: [dojo({ flatBoost: '4' })] };
      await assert.rejects(runSimulation(structuredClone(req)), /number or null/);
      await assert.rejects(runTwin(b, { kind: 'zone' }), /unusable by the twin/);
    });
  } finally {
    setTwinBackend(null);
    b.close();
  }
});

test('a chunked trial batch fires onIteration once per iteration, in order, and matches the JS loop across a chunk boundary', { skip }, async () => {
  const players = [basePlayer()];
  const spec = { players, trialHrid: '/guild_combat/jellyfish', startTier: 100, trialOptions: { enemyScale: 0.2, durationSeconds: 120 } };
  const { runTrialIterations, TWIN_TRIAL_CHUNK } = await import('../../shared/guildTrialRuns.js');
  const iterations = TWIN_TRIAL_CHUNK + 2;
  const go = async () => {
    const b = nativeBackend();
    setTwinBackend(b);
    try {
      const seen = [];
      const summaries = await withSeed(3, () => runTrialIterations({ ...structuredClone(spec), partyBuffs: [], iterations, onIteration: (d) => seen.push(d) }));
      return { seen, d: digest(canonical(summaries)) };
    } finally {
      setTwinBackend(null);
      b.close();
    }
  };
  const tw = await go();
  assert.deepEqual(tw.seen, Array.from({ length: iterations }, (_, i) => i + 1));
  assert.equal(tw.d, 'f281c4f92df342e3d637b8bcb2d50c1c96e4389c117c143004f3a46157707aee'); // the JS loop's summaries
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

// The default engine (CSIM_ENGINE unset), in a fresh process each time.
function select(env, prelude = '') {
  const url = new URL('../lib/twin/index.mjs', import.meta.url).href;
  const src = `${prelude}; const b = await (await import(${JSON.stringify(url)})).selectTwinFromEnv(); console.log('twin', process.env.CSIM_ENGINE); b?.close?.();`;
  const env2 = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env2)) if (v === undefined) delete env2[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { env: env2, encoding: 'utf8' });
  return { out: r.stdout.trim(), err: r.stderr.split('\n').filter((l) => l.startsWith('csim:')) };
}

test('unset CSIM_ENGINE picks native, falls back to wasm on a pow refusal with one line, and CSIM_ENGINE wins', { skip: (skip || !existsSync(new URL('../../rust/pkg/csim_twin_bg.wasm', import.meta.url))) && 'native or wasm not built' }, () => {
  assert.deepEqual(select({ CSIM_ENGINE: undefined }), { out: 'twin native', err: [] });
  const refused = select({ CSIM_ENGINE: undefined }, 'const pow = Math.pow; Math.pow = (x, y) => pow(x, y) * 2');
  assert.equal(refused.out, 'twin wasm');
  assert.equal(refused.err.length, 1);
  assert.match(refused.err[0], /native engine unavailable .*not bit-identical.*using wasm/);
});
