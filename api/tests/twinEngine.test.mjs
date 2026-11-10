// =============================================================================
// shared/twinEngine.js and the mulberry32 state hand-over — pure JS, no Rust
// toolchain needed.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';

import { mulberry32, withSeed } from '../lib/determinism.mjs';
import { reviveTwinResult, runTwin, getTwinBackend, wantsWasmTwin, twinZoneRequest, twinTrialRequest } from '../../shared/twinEngine.js';

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

test('runTwin rethrows the twin error with its kind', async () => {
  const fake = { run: async () => JSON.stringify({ ok: false, error: 'bad', errorKind: 'RangeError' }) };
  await assert.rejects(runTwin(fake, { kind: 'zone' }), RangeError);
});

test('wantsWasmTwin: the toggle picks wasm, except for a labyrinth', () => {
  const job = { extra: { experimental: { engine: 'wasm' } } };
  assert.equal(wantsWasmTwin(job), true);
  assert.equal(wantsWasmTwin({ ...job, labyrinth: {} }), false);
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
});
