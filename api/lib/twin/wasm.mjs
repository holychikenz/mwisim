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

export async function wasmBackend() {
  if (!wasm) {
    if (!existsSync(join(PKG, 'csim_twin_bg.wasm'))) throw new Error('csim wasm engine not built: run ./build.sh wasm');
    const mod = await import(pathToFileURL(join(PKG, 'csim_twin.js')).href);
    const t0 = performance.now();
    mod.initSync({ module: readFileSync(join(PKG, 'csim_twin_bg.wasm')) });
    const t1 = performance.now();
    const text = '{' + TWIN_DATA_NAMES.map((n) => `"${n}":${readFileSync(join(DATA_DIR, `${n}.json`), 'utf8')}`).join(',') + '}';
    mod.load_data(text);
    wasmLoadMs.init = t1 - t0;
    wasmLoadMs.loadData = performance.now() - t1;
    wasm = mod;
  }
  return {
    run: async (json, onProgress) => wasm.run(json, onProgress ?? null),
    selftest: async (json) => wasm.selftest(json),
  };
}
