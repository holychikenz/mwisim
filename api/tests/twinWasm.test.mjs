// =============================================================================
// api/lib/twin/wasm.mjs: a trap (WebAssembly.RuntimeError) drops the instance,
// and the next call re-instantiates it. Skipped without a built rust/pkg/.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { wasmBackend, wasmTestHooks } from '../lib/twin/wasm.mjs';

const skip = !existsSync(fileURLToPath(new URL('../../rust/pkg/csim_twin_bg.wasm', import.meta.url))) && 'wasm engine not built';
const TINY = '{"seed":1,"draws":1,"pow":[],"numbers":[]}';

test('a trap re-instantiates the wasm twin on the next call', { skip }, async () => {
  const b = await wasmBackend();
  const first = JSON.parse(await b.selftest(TINY));
  const loads = wasmTestHooks.loads;
  assert.equal(JSON.parse(await b.selftest(TINY)).ok, true);
  assert.equal(wasmTestHooks.loads, loads, 'no trap, no reload');
  wasmTestHooks.trapNextRun = true;
  await assert.rejects(b.run('{}'), WebAssembly.RuntimeError);
  assert.deepEqual(JSON.parse(await b.selftest(TINY)), first);
  assert.equal(wasmTestHooks.loads, loads + 1);
  const res = JSON.parse(await b.run('{}'));
  assert.equal(res.ok, false); // the fresh instance answers, and with its data loaded:
  assert.doesNotMatch(res.error, /load_data/);
  assert.equal(wasmTestHooks.loads, loads + 1);
});
