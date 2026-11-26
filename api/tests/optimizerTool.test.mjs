// The transport-free optimiser layer the browser host (ui/src/workers/optimizerHost.js)
// drives: previewTool/planTool answers, runPlanned's
// frames and pool teardown, and poolCore's queue over a non-worker_threads worker.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Refusal, planTool, previewTool, runPlanned } from '../lib/optimizerTool.js';
import { AbortError, startPool } from '../lib/triggerSearch/poolCore.js';

const tool = {
  path: 'x',
  preview: (body) => {
    if (body.refuse) throw new Refusal('no', { extra: 1 });
    if (body.crash) throw new Error('boom');
    return { ok: true };
  },
  plan: (body) => {
    if (body.crash) throw new Error('hostile');
    return { start: { s: 1 }, evaluator: {}, run: body.run };
  },
};

test('previewTool and planTool answer as the routes did', () => {
  assert.deepEqual(previewTool(tool, {}, 3), { status: 200, json: { success: true, ok: true, poolSize: 3 } });
  assert.deepEqual(previewTool(tool, { refuse: true }, 3), { status: 400, json: { success: false, error: 'no', extra: 1 } });
  assert.deepEqual(previewTool(tool, { crash: true }, 3), { status: 500, json: { success: false, error: 'boom' } });
  assert.deepEqual(planTool(tool, { crash: true }), { status: 400, json: { success: false, error: 'hostile' } });
  assert.ok(planTool(tool, {}).planned);
});

async function frames(run, createPool) {
  const sent = [];
  let destroyed = 0;
  const pool = { run: async () => [], destroy: async () => { destroyed += 1; } };
  await runPlanned({ start: { s: 1 }, evaluator: {}, run }, {
    poolSize: 2, send: (f) => sent.push(f), signal: new AbortController().signal, createPool: createPool || (async () => pool),
  });
  return { sent, destroyed };
}

test('runPlanned: start then result, cancelled or error; the pool always destroyed', async () => {
  let r = await frames(async ({ onProgress }) => { onProgress({ progress: 0.5 }); return { done: 1 }; });
  assert.deepEqual(r.sent, [{ type: 'start', poolSize: 2, s: 1 }, { type: 'progress', progress: 0.5 }, { type: 'result', result: { done: 1 } }]);
  assert.equal(r.destroyed, 1);
  r = await frames(async () => { throw new AbortError('stopped'); });
  assert.deepEqual(r.sent.at(-1), { type: 'cancelled', error: 'stopped' });
  assert.equal(r.destroyed, 1);
  r = await frames(async () => { throw new Error('bad'); });
  assert.deepEqual(r.sent.at(-1), { type: 'error', error: 'bad' });
  r = await frames(async () => ({}), async () => { throw new Error('no engine'); });
  assert.deepEqual(r.sent, [{ type: 'error', error: 'no engine' }]);
});

/** A fake worker with worker_threads' surface, as ui/src/workers/browserPool.js adapts a Web Worker. */
function fakeWorker({ failStart = false } = {}) {
  const on = { message: [], error: [], exit: [] };
  const emit = (event, value) => on[event].forEach((fn) => fn(value));
  queueMicrotask(() => (failStart ? emit('error', new Error('init failed')) : emit('message', { type: 'ready' })));
  return {
    on: (event, fn) => on[event].push(fn),
    postMessage: ({ job }) => queueMicrotask(() => emit('message', { type: 'result', id: job.id, metrics: { v: job.id } })),
    terminate: async () => emit('exit'),
  };
}

test('startPool queues jobs over any worker with the worker_threads surface, and rejects a failed start', async () => {
  const pool = await startPool(2, () => fakeWorker());
  assert.deepEqual(await pool.run([{ id: 1 }, { id: 2 }, { id: 3 }]), [1, 2, 3].map((id) => ({ id, metrics: { v: id } })));
  await pool.destroy();
  await assert.rejects(startPool(2, () => fakeWorker({ failStart: true })), /init failed/);
});
