// =============================================================================
// The wasm twin backend for Node: the same `wasm-pack --target web` package the
// browser worker loads (src/twinWasm.js), instantiated synchronously, with the
// data files handed over as text (no parse/stringify on the JS side).
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TWIN_DATA_NAMES } from '../../../shared/twinEngine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKG = join(ROOT, 'rust', 'pkg');
const DATA_DIR = join(ROOT, 'src', 'combatsimulator', 'data');

let wasm = null;
/** Milliseconds the last first load spent in initSync and load_data (plan risk R3). */
export const wasmLoadMs = { init: null, loadData: null };
/** Instantiations so far, and a test-only trap injector (tests/twinWasm.test.mjs). */
export const wasmTestHooks = { loads: 0, trapNextRun: false };

async function load() {
  if (wasm) return wasm;
  if (!existsSync(join(PKG, 'csim_twin_bg.wasm'))) throw new Error('csim wasm engine not built: run ./build.sh wasm');
  // The glue memoises its instance per module, so a re-instantiation needs a fresh module copy.
  const url = pathToFileURL(join(PKG, 'csim_twin.js')).href + (wasmTestHooks.loads ? `?instance=${wasmTestHooks.loads}` : '');
  const mod = await import(url);
  const t0 = performance.now();
  mod.initSync({ module: readFileSync(join(PKG, 'csim_twin_bg.wasm')) });
  const t1 = performance.now();
  const text = '{' + TWIN_DATA_NAMES.map((n) => `"${n}":${readFileSync(join(DATA_DIR, `${n}.json`), 'utf8')}`).join(',') + '}';
  mod.load_data(text);
  wasmLoadMs.init = t1 - t0;
  wasmLoadMs.loadData = performance.now() - t1;
  wasmTestHooks.loads++;
  wasm = mod;
  return mod;
}

// A trap (a Rust panic or abort) leaves the instance's stack and RefCells unsound: drop it.
function guard(f) {
  try {
    if (wasmTestHooks.trapNextRun) {
      wasmTestHooks.trapNextRun = false;
      throw new WebAssembly.RuntimeError('unreachable (test trap)');
    }
    return f();
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) wasm = null;
    throw e;
  }
}

export async function wasmBackend() {
  await load();
  return {
    run: async (json, onProgress) => { const m = await load(); return guard(() => m.run(json, onProgress ?? null)); },
    selftest: async (json) => { const m = await load(); return guard(() => m.selftest(json)); },
    itemValues: async (client, character, overrides = '') => { const m = await load(); return guard(() => m.item_values(client, character, overrides)); },
  };
}
