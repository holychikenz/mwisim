// =============================================================================
// The native twin against the JS engine on DTO shapes the corpus never sends,
// plus the native backend's stall watchdog, pow guard, error kinds and the
// random stream an error leaves. Skipped without a built
// rust/target/release/csim-native, so a machine with no Rust stays green.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { withSeed, canonical, digest } from '../lib/determinism.mjs';
import { runSimulation, runGuildTrialSimulation, loadGameData } from '../lib/simulator.js';
import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { setTwinBackend, runTwin } from '../../shared/twinEngine.js';
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

/** Run `fn` on the twin or JS under seed 1; returns the error's class and message, and the next seeded draw. */
async function throwThenDraw(twin, fn) {
  const b = twin ? nativeBackend() : null;
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
    b?.close();
  }
}

test('a mid-run throw leaves the seeded stream where JS leaves it, with the JS error class', { skip }, async () => {
  const p = basePlayer();
  // Slot 1 is first checked after slot 0's cast, mid-fight; JS then reads a missing dependency.
  p.abilities[1].triggers = [{ dependencyHrid: '/combat_trigger_dependencies/bogus', conditionHrid: '/combat_trigger_conditions/current_hp', comparatorHrid: '/combat_trigger_comparators/greater_than_equal', value: 0 }];
  const run = () => runSimulation(structuredClone({ players: [p], zone: ZONE, simulationTimeLimit: 3600e9 }));
  const js = await throwThenDraw(false, run);
  const tw = await throwThenDraw(true, run);
  assert.ok(js.drew, 'the JS run must draw before it throws, or this proves nothing');
  assert.equal(js.kind, TypeError);
  assert.equal(tw.kind, TypeError);
  assert.equal(tw.next, js.next);
});

test('errors before the first draw keep their JS class and leave the stream untouched', { skip }, async () => {
  const cases = [
    [TypeError, () => runSimulation({ players: [basePlayer()], zone: { ...ZONE, zoneHrid: '/actions/combat/nope' }, simulationTimeLimit: 3600e9 })],
    [RangeError, () => runGuildTrialSimulation({ players: [basePlayer()], trialHrid: '/guild_combat/swarm', startTier: 105, iterations: 2 })],
  ];
  for (const [kind, fn] of cases) {
    const js = await throwThenDraw(false, fn);
    const tw = await throwThenDraw(true, fn);
    assert.equal(js.kind, kind);
    assert.equal(tw.kind, kind);
    assert.equal(tw.next, js.next);
  }
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

test('a batched trial fires onIteration once per iteration, in order, as the JS loop does', { skip }, async () => {
  const players = [basePlayer()];
  const spec = { players, trialHrid: '/guild_combat/jellyfish', startTier: 100, trialOptions: { enemyScale: 0.2, durationSeconds: 120 } };
  const { runTrialIterations } = await import('../../shared/guildTrialRuns.js');
  const go = async (twin) => {
    const b = twin ? nativeBackend() : null;
    setTwinBackend(b);
    try {
      const seen = [];
      const summaries = await withSeed(3, () => runTrialIterations({ ...structuredClone(spec), partyBuffs: [], iterations: 4, onIteration: (d) => seen.push(d) }));
      return { seen, d: digest(canonical(summaries)) };
    } finally {
      setTwinBackend(null);
      b?.close();
    }
  };
  const js = await go(false);
  const tw = await go(true);
  assert.deepEqual(js.seen, [1, 2, 3, 4]);
  assert.deepEqual(tw.seen, js.seen);
  assert.equal(tw.d, js.d);
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
