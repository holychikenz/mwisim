// =============================================================================
// selectTwinFromEnv — CSIM_ENGINE picks the Node combat engine:
//   unset | js   the JS engine (default); nothing is imported
//   native       the Rust twin as a child process (./build.sh rust)
//   wasm         the Rust twin as wasm (./build.sh wasm)
// Registers the backend in shared/twinEngine.js and returns it (null for JS).
//
// preferNative (local runners: api/cli.js; or CSIM_PREFER_NATIVE=1, which is
// how SCLIRoster asks) makes an UNSET CSIM_ENGINE mean native when it works:
// built, spawns, and passes the pow guard. Otherwise one stderr line and JS.
// An explicit CSIM_ENGINE always wins. The outcome is written back to
// CSIM_ENGINE, so worker threads and children started later inherit it.
// =============================================================================

import { setTwinBackend, getTwinBackend } from '../../../shared/twinEngine.js';

let selected = false;

async function preferredNative() {
  let b = null;
  try {
    b = (await import('./native.mjs')).nativeBackend();
    await b.check();
    process.env.CSIM_ENGINE = 'native';
    return b;
  } catch (err) {
    b?.close();
    process.env.CSIM_ENGINE = 'js';
    console.error(`csim: native engine unavailable (${err?.message ?? err}); using JS (fix: ./build.sh rust in csim; CSIM_ENGINE=js silences this)`);
    return null;
  }
}

export async function selectTwinFromEnv({ preferNative = process.env.CSIM_PREFER_NATIVE === '1' } = {}) {
  if (selected) return getTwinBackend();
  const name = process.env.CSIM_ENGINE || (preferNative ? 'prefer-native' : 'js');
  let b = null;
  if (name === 'prefer-native') b = await preferredNative();
  else if (name === 'native') b = (await import('./native.mjs')).nativeBackend();
  else if (name === 'wasm') b = await (await import('./wasm.mjs')).wasmBackend();
  else if (name !== 'js') throw new Error(`CSIM_ENGINE must be js, native or wasm (got "${name}")`);
  setTwinBackend(b);
  selected = true;
  return b;
}
