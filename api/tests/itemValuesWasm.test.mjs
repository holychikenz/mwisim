// =============================================================================
// The wasm item_values export (rust/src/lib.rs) on the scrubbed cowstuff fixture
// character, against one item of cowstuff's /api/value/market golden
// (rust/tests/item_values.rs checks every item natively). Skipped without a built rust/pkg/.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { wasmBackend } from '../lib/twin/wasm.mjs';

const skip = !existsSync(fileURLToPath(new URL('../../rust/pkg/csim_twin_bg.wasm', import.meta.url))) && 'wasm engine not built';
const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('wasm item_values: the fixture character prices an item as the server golden does', { skip }, async () => {
  const b = await wasmBackend();
  const maps = ['actionDetailMap', 'itemDetailMap', 'enhancementLevelTotalBonusMultiplierTable'];
  const client = '{' + maps.map((m) => `"${m}":${read(`src/combatsimulator/data/${m}.json`)}`).join(',') + '}';
  const t0 = performance.now();
  const out = JSON.parse(await b.itemValues(client, read('fixtures/econ/character.json')));
  const ms = performance.now() - t0;
  const golden = JSON.parse(read('fixtures/econ/value__market.json'));
  assert.equal(out.character, 'TwinTester');
  assert.equal(out.values['/items/acrobatic_hood'], golden.values['/items/acrobatic_hood']);
  assert.equal(out.values['/items/coin'], 0);
  console.log(`# item_values (wasm, incl. parse): ${ms.toFixed(0)} ms`);
});
