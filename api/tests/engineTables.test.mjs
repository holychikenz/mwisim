// G9 (docs/engine-retirement/PLAN.md): tools/engineTables.json is the generators' one source for
// the engine-semantics lists. While the JS engine still declares its own copies, they must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENGINE = ROOT + 'src/combatsimulator/';
const tables = JSON.parse(readFileSync(ROOT + 'tools/engineTables.json', 'utf8'));
const stat = await import('../../tools/genStatSchema.mjs');
const kinds = await import('../../tools/genTriggerKinds.mjs');

test('engineTables.json matches the lists the JS engine declares', { skip: !existsSync(ENGINE + 'trigger.js') && 'JS engine deleted' }, () => {
  const src = (f) => readFileSync(ENGINE + f, 'utf8');
  assert.deepEqual(tables.EQUIPMENT_COMBAT_STATS, stat.extractList(src('player.js'), 'EQUIPMENT_COMBAT_STATS'));
  assert.deepEqual(tables.MONSTER_ZEROED_COMBAT_STATS, stat.extractList(src('monster.js'), 'MONSTER_ZEROED_COMBAT_STATS'));
  assert.deepEqual(tables.EXACT_BUFF_CONDITIONS, kinds.extractList(src('trigger.js'), 'EXACT_BUFF_CONDITIONS'));
  assert.deepEqual(tables.PREFIX_BUFF_CONDITIONS, kinds.extractList(src('trigger.js'), 'PREFIX_BUFF_CONDITIONS'));
  assert.deepEqual(Object.entries(tables.SCALAR_CONDITION_KINDS), kinds.extractScalarKinds(src('trigger.js')));
});
