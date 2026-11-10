// =============================================================================
// selectTwinFromEnv — CSIM_ENGINE picks the Node combat engine:
//   unset | js   the JS engine (default); nothing is imported
//   native       the Rust twin as a child process (./build.sh rust)
//   wasm         the Rust twin as wasm (./build.sh wasm)
// Registers the backend in shared/twinEngine.js and returns it (null for JS).
// =============================================================================

import { setTwinBackend, getTwinBackend } from '../../../shared/twinEngine.js';

let selected = false;

export async function selectTwinFromEnv() {
  if (selected) return getTwinBackend();
  const name = process.env.CSIM_ENGINE || 'js';
  let b = null;
  if (name === 'native') b = (await import('./native.mjs')).nativeBackend();
  else if (name === 'wasm') b = await (await import('./wasm.mjs')).wasmBackend();
  else if (name !== 'js') throw new Error(`CSIM_ENGINE must be js, native or wasm (got "${name}")`);
  setTwinBackend(b);
  selected = true;
  return b;
}
