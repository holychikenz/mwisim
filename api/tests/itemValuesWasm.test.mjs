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

test('wasm enhance_*: the fixture character costs an item as the server golden does', { skip }, async () => {
  const b = await wasmBackend();
  const maps = ['actionDetailMap', 'itemDetailMap', 'enhancementLevelTotalBonusMultiplierTable'];
  const client = '{' + maps.map((m) => `"${m}":${read(`src/combatsimulator/data/${m}.json`)}`).join(',') + '}';
  const character = read('fixtures/econ/character.json');
  const config = JSON.parse(await b.enhanceConfig(client, character));
  assert.equal(config.enhancing_level, JSON.parse(read('fixtures/econ/enhance__character.json')).enhancing_level);
  const body = JSON.stringify({ config: {}, item_hrid: '/items/holy_brush', target: 10, iron_cow: true });
  const out = JSON.parse(await b.enhanceCalculate(client, character, body));
  const golden = JSON.parse(read('fixtures/econ/enhance_iron__calc.json'));
  assert.equal(out.optimal_prot, golden.optimal_prot);
  assert.ok(Math.abs(out.rows[0].total_cost - golden.rows[0].total_cost) <= 1e-6 * golden.rows[0].total_cost);
  assert.equal(JSON.parse(await b.enhanceCalculate(client, character, '[]')).ok, false);
});

test('wasm enhance_calculate cache follows the character and the overrides', { skip }, async () => {
  const b = await wasmBackend();
  const maps = ['actionDetailMap', 'itemDetailMap', 'enhancementLevelTotalBonusMultiplierTable'];
  const client = '{' + maps.map((m) => `"${m}":${read(`src/combatsimulator/data/${m}.json`)}`).join(',') + '}';
  const character = read('fixtures/econ/character.json');
  const ch = JSON.parse(character);
  for (const s of ch.characterSkills) s.level -= 10; // slower crafting: dearer materials
  const lower = JSON.stringify(ch);
  const body = (ov) => JSON.stringify({ config: {}, item_hrid: '/items/holy_brush', target: 10, iron_cow: true, ...(ov && { essence_overrides: ov }) });
  const call = async (c, bd) => {
    const t0 = performance.now();
    const out = await b.enhanceCalculate(client, c, bd);
    return [out, performance.now() - t0];
  };
  const [first, ms1] = await call(character, body());
  const [second, ms2] = await call(character, body());
  assert.equal(second, first);
  assert.ok(Math.abs(JSON.parse(first).rows[0].total_cost - JSON.parse(read('fixtures/econ/enhance_iron__calc.json')).rows[0].total_cost) < 1e-6);
  assert.notEqual((await call(lower, body()))[0], first, 'a changed character is not served from the cache');
  assert.equal((await call(character, body()))[0], first);
  const [ov] = await call(character, body({ '/items/enhancing_essence': 99 }));
  assert.notEqual(ov, first, 'changed overrides are not served from the cache');
  assert.equal((await call(character, body()))[0], first);
  console.log(`# enhance_calculate (wasm): first ${ms1.toFixed(0)} ms, repeat ${ms2.toFixed(0)} ms`);
});
