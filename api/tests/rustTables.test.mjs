// =============================================================================
// The Rust twin's generated tables (rust/src/generated.rs) are what the
// generator produces RIGHT NOW, byte for byte — the same guard the four JS
// generated files have. A stat, trigger condition or buff type added on the JS
// side reaches the twin only through this file.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const gen = await import('../../tools/genRustTables.mjs');

test('rust/src/generated.rs is byte-for-byte what the generator produces', () => {
  assert.equal(
    gen.generate(),
    fs.readFileSync(gen.OUT_PATH, 'utf8'),
    'rust/src/generated.rs is stale — run `node tools/genRustTables.mjs`'
  );
});

test('the generated lists are the engine lists, in order', async () => {
  const { EQUIPMENT_COMBAT_STATS } = await import('../../src/combatsimulator/player.js');
  const { MONSTER_ZEROED_COMBAT_STATS } = await import('../../src/combatsimulator/monster.js');
  const { BUFF_TYPE_NAMES } = await import('../../src/combatsimulator/generated/buffTypes.js');
  const c = gen.collect();
  assert.deepEqual(c.equipment, EQUIPMENT_COMBAT_STATS);
  assert.deepEqual(c.monsterZeroed, MONSTER_ZEROED_COMBAT_STATS);
  assert.deepEqual(c.buffTypes, [...BUFF_TYPE_NAMES]);
});
