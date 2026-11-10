// =============================================================================
// shared/twinEngine.js and the mulberry32 state hand-over — pure JS, no Rust
// toolchain needed.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';

import { mulberry32, withSeed } from '../lib/determinism.mjs';
import { reviveTwinResult, runTwin, getTwinBackend, wantsWasmTwin, twinZoneRequest, twinLabRequest, twinTrialRequest, twinRunRequest } from '../../shared/twinEngine.js';

test('the JS engine is the default backend', () => {
  assert.equal(getTwinBackend(), null);
});

test('reviveTwinResult turns the canonical sentinels back into values, in place', () => {
  const v = reviveTwinResult({ a: '@undefined', b: ['@NaN', '@Infinity', '@-Infinity', 'miss'], c: { d: 1, e: '@nan' } });
  assert.ok('a' in v && v.a === undefined);
  assert.ok(Number.isNaN(v.b[0]));
  assert.equal(v.b[1], Infinity);
  assert.equal(v.b[2], -Infinity);
  assert.equal(v.b[3], 'miss');
  assert.equal(v.c.e, '@nan');
});

test('mulberry32 state() reads and continues the exact stream, and changes no output', () => {
  const ref = mulberry32(12345);
  const r = mulberry32(12345);
  const head = [r(), r(), r()];
  assert.deepEqual(head, [ref(), ref(), ref()]);
  const s = r.state();
  const next = [r(), r()];
  const other = mulberry32(0);
  other.state(s);
  assert.deepEqual([other(), other()], next);
  assert.deepEqual(next, [ref(), ref()]);
});

test('runTwin hands the seeded state over and writes the end state back', async () => {
  const fake = {
    run: async (json) => {
      const req = JSON.parse(json);
      // Pretend the twin drew three numbers and produced a result with a sentinel.
      const g = mulberry32(0);
      g.state(req.rngState);
      g(); g(); g();
      return JSON.stringify({ ok: true, rngState: g.state(), simResult: { seen: req.rngState, x: '@undefined', kind: req.kind } });
    },
  };
  const out = await withSeed(7, async () => {
    const before = Math.random.state();
    const res = await runTwin(fake, { kind: 'zone' });
    return { before, res, after: Math.random() };
  });
  assert.equal(out.res.seen, out.before);
  assert.ok('x' in out.res && out.res.x === undefined);
  const g = mulberry32(7);
  g(); g(); g();
  assert.equal(out.after, g());
});

test('runTwin rethrows the twin error with its JS class', async () => {
  for (const [errorKind, cls] of [['RangeError', RangeError], ['TypeError', TypeError], ['Error', Error]]) {
    const fake = { run: async () => JSON.stringify({ ok: false, error: 'bad', errorKind, rngState: 5 }) };
    const err = await runTwin(fake, { kind: 'zone' }).catch((e) => e);
    assert.equal(err.constructor, cls);
    assert.equal(err.message, 'bad');
  }
});

test('runTwin writes an error\'s rngState back, and poisons the stream when there is none', async () => {
  const at = (rngState) => ({ run: async () => JSON.stringify({ ok: false, error: 'boom', errorKind: 'Error', ...(rngState === undefined ? {} : { rngState }) }) });
  await withSeed(7, async () => {
    await assert.rejects(runTwin(at(42), { kind: 'zone' }), /boom/);
    assert.equal(Math.random.state(), 42);
    await assert.rejects(runTwin(at(undefined), { kind: 'zone' }), /boom/);
    assert.throws(() => Math.random.state(), /unusable by the twin.*boom/);
    assert.equal(typeof Math.random(), 'number'); // the JS engine can still draw
    await assert.rejects(runTwin(at(1), { kind: 'zone' }), /unusable by the twin/);
  });
});

test('runTwin resolves a batch to its array of results', async () => {
  const fake = { run: async () => JSON.stringify({ ok: true, rngState: 1, simResults: [{ a: '@NaN' }, { a: 2 }] }) };
  const out = await withSeed(1, () => runTwin(fake, { kind: 'trial', iterations: 2 }));
  assert.ok(Number.isNaN(out[0].a));
  assert.equal(out[1].a, 2);
});

test('wantsWasmTwin: the toggle picks wasm, labyrinths included', () => {
  const job = { extra: { experimental: { engine: 'wasm' } } };
  assert.equal(wantsWasmTwin(job), true);
  assert.equal(wantsWasmTwin({ ...job, labyrinth: {} }), true);
  assert.equal(wantsWasmTwin({}), false);
});

test('the request builders add only the defaults the seams applied', () => {
  const z = twinZoneRequest({ players: [1], zone: { zoneHrid: 'z', difficultyTier: 0 }, simulationTimeLimit: 5 });
  assert.ok(!('runLimits' in z));
  assert.deepEqual(z.partyBuffs, []);
  assert.deepEqual(twinZoneRequest({ players: [], zone: {}, simulationTimeLimit: 1, runLimits: { maxRuns: 2 } }).runLimits, { maxRuns: 2 });
  const t = twinTrialRequest({ players: [1, 2, 3], trialHrid: 'x', startTier: 100, trialOptions: {} });
  assert.equal(t.guildTrial.participantCount, 3);
  assert.equal(t.kind, 'trial');
  assert.ok(!('iterations' in t));
  assert.equal(twinTrialRequest({ players: [], trialHrid: 'x', iterations: 4 }).iterations, 4);
  const l = twinLabRequest({ players: [1], labyrinth: { labyrinthHrid: '/monsters/m', roomLevel: 60, crates: [] }, simulationTimeLimit: 5 });
  assert.equal(l.kind, 'labyrinth');
  assert.deepEqual(l.partyBuffs, []);
  assert.ok(!('runLimits' in l));
  const lab = { labyrinthHrid: '/monsters/m', roomLevel: 60 };
  assert.deepEqual(twinRunRequest({ players: [], labyrinth: lab, simulationTimeLimit: 1, runLimits: { maxRuns: 2 } }), { kind: 'labyrinth', players: [], partyBuffs: [], labyrinth: lab, simulationTimeLimit: 1, runLimits: { maxRuns: 2 } });
  assert.equal(twinRunRequest({ players: [], zone: { zoneHrid: 'z' }, labyrinth: lab, simulationTimeLimit: 1 }).kind, 'zone'); // zone wins, as in the JS seams
  assert.ok(!('labyrinth' in twinRunRequest({ players: [], zone: { zoneHrid: 'z' }, simulationTimeLimit: 1 })));
});

test('a twin trial batch goes in chunks of TWIN_TRIAL_CHUNK, with progress offset per chunk', async () => {
  const { runTrialIterations, TWIN_TRIAL_CHUNK } = await import('../../shared/guildTrialRuns.js');
  const { setTwinBackend } = await import('../../shared/twinEngine.js');
  const sizes = [];
  const fake = { run: async (json, onProgress) => {
    const n = JSON.parse(json).iterations;
    sizes.push(n);
    for (let k = 1; k <= n; k++) onProgress(k);
    return JSON.stringify({ ok: true, rngState: 1, simResults: Array.from({ length: n }, () => ({})) });
  } };
  setTwinBackend(fake);
  try {
    const seen = [];
    const out = await withSeed(1, () => runTrialIterations({ players: [], partyBuffs: [], trialHrid: 'x', iterations: TWIN_TRIAL_CHUNK + 5, onIteration: (d) => seen.push(d) }));
    assert.deepEqual(sizes, [TWIN_TRIAL_CHUNK, 5]);
    assert.equal(out.length, TWIN_TRIAL_CHUNK + 5);
    assert.deepEqual(seen, Array.from({ length: TWIN_TRIAL_CHUNK + 5 }, (_, i) => i + 1));
    // Fractional iterations: the JS loop runs ceil(n); the twin must get whole chunks summing to that.
    sizes.length = 0;
    const frac = await withSeed(1, () => runTrialIterations({ players: [], partyBuffs: [], trialHrid: 'x', iterations: TWIN_TRIAL_CHUNK + 4.5 }));
    assert.deepEqual(sizes, [TWIN_TRIAL_CHUNK, 5]);
    assert.equal(frac.length, TWIN_TRIAL_CHUNK + 5);
  } finally {
    setTwinBackend(null);
  }
});

test('a twin trial batch with progress but no onIteration returns (regression: `?.(++done)` never counted)', async () => {
  const { runTrialIterations } = await import('../../shared/guildTrialRuns.js');
  const { setTwinBackend } = await import('../../shared/twinEngine.js');
  const fake = { run: async (json, onProgress) => { onProgress(1); onProgress(2); return JSON.stringify({ ok: true, rngState: 1, simResults: [{}, {}] }); } };
  setTwinBackend(fake);
  try {
    const out = await withSeed(1, () => runTrialIterations({ players: [], partyBuffs: [], trialHrid: 'x', iterations: 2 }));
    assert.equal(out.length, 2);
    const seen = [];
    await withSeed(1, () => runTrialIterations({ players: [], partyBuffs: [], trialHrid: 'x', iterations: 2, onIteration: (d) => seen.push(d) }));
    assert.deepEqual(seen, [1, 2]);
  } finally {
    setTwinBackend(null);
  }
});
