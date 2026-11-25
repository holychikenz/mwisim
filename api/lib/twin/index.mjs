// =============================================================================
// selectTwinFromEnv — CSIM_ENGINE picks the Node combat engine:
//   unset        native when it is built and passes the pow guard, else wasm (the default)
//   native       the Rust twin as a child process (./build.sh rust)
//   wasm         the Rust twin as wasm (./build.sh wasm)
// Anything else (including the retired `js`) throws.
// Registers the backend in shared/twinEngine.js and returns it.
//
// An unset CSIM_ENGINE is decided once per realm and written back, so worker
// threads and children started later inherit it. A built native that fails its
// pow guard prints one stderr line and falls back to wasm. A caller with worker
// threads should decide on its main thread and set CSIM_ENGINE before creating
// any (SCLIRoster's optimizer/src/csim.js does), or each worker decides alone.
// =============================================================================

import { existsSync } from 'node:fs';
import { setTwinBackend, getTwinBackend } from '../../../shared/twinEngine.js';

let selected = false;

async function preferredNative() {
  const { nativeBackend, NATIVE_BIN } = await import('./native.mjs');
  if (!existsSync(NATIVE_BIN)) return null;
  let b = null;
  try {
    b = nativeBackend();
    await b.check();
    return b;
  } catch (err) {
    b?.close();
    console.error(`csim: native engine unavailable (${err?.message ?? err}); using wasm (fix: ./build.sh rust in csim; CSIM_ENGINE=wasm silences this)`);
    return null;
  }
}

export async function selectTwinFromEnv() {
  if (selected) return getTwinBackend();
  const name = process.env.CSIM_ENGINE || 'auto';
  let b = null;
  if (name === 'auto') {
    b = await preferredNative();
    process.env.CSIM_ENGINE = b ? 'native' : 'wasm';
    b ??= await (await import('./wasm.mjs')).wasmBackend();
  } else if (name === 'native') b = (await import('./native.mjs')).nativeBackend();
  else if (name === 'wasm') b = await (await import('./wasm.mjs')).wasmBackend();
  else if (name === 'js') throw new Error('CSIM_ENGINE=js: the JS combat engine was removed; use native or wasm (or leave CSIM_ENGINE unset)');
  else throw new Error(`CSIM_ENGINE must be native or wasm (got "${name}")`);
  setTwinBackend(b);
  selected = true;
  return b;
}
