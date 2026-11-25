// =============================================================================
// The Rust twin's generated tables (rust/src/generated.rs) are what the
// generator produces RIGHT NOW, byte for byte, and the collectors behind them
// (tools/genStatSchema.mjs, genTriggerKinds.mjs, genBuffTypes.mjs) find what
// they must. A list wrong by omission is a wrong combat number with no error.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const gen = await import('../../tools/genRustTables.mjs');
const buffs = await import('../../tools/genBuffTypes.mjs');
const DATA = new URL('../../src/combatsimulator/data/', import.meta.url);
const tables = JSON.parse(fs.readFileSync(new URL('../../tools/engineTables.json', import.meta.url), 'utf8'));

test('rust/src/generated.rs is byte-for-byte what the generator produces', () => {
  assert.equal(
    gen.generate(),
    fs.readFileSync(gen.OUT_PATH, 'utf8'),
    'rust/src/generated.rs is stale — run `node tools/genRustTables.mjs`'
  );
});

test('the stat lists are tools/engineTables.json, in order', () => {
  const c = gen.collect();
  assert.deepEqual(c.equipment, tables.EQUIPMENT_COMBAT_STATS);
  assert.deepEqual(c.monsterZeroed, tables.MONSTER_ZEROED_COMBAT_STATS);
  for (const name of ['hpRegenPer10', 'mpRegenPer10']) {
    assert.ok(c.equipment.includes(name) && c.monsterZeroed.includes(name), `${name}: the digit-bearing regen stats survive`);
  }
});

test('zero-fill plus residual covers every key any monster block carries, sorted and disjoint', () => {
  const { monsterZeroed, monsterResidual } = gen.collect();
  const monsters = JSON.parse(fs.readFileSync(new URL('combatMonsterDetailMap.json', DATA), 'utf8'));
  const covered = new Set([...monsterZeroed, ...monsterResidual]);
  const uncovered = new Set();
  for (const m of Object.values(monsters)) {
    for (const stat of Object.keys(m.combatDetails?.combatStats ?? {})) if (!covered.has(stat)) uncovered.add(stat);
  }
  assert.deepStrictEqual([...uncovered], []);
  assert.deepStrictEqual(monsterResidual.filter((s) => monsterZeroed.includes(s)), [], 'a residual name is not also zero-filled');
  assert.deepStrictEqual(monsterResidual, [...monsterResidual].sort());
  assert.ok(monsterResidual.includes('combatStyleHrids') && monsterResidual.includes('attackInterval'));
});

test('trigger conditions: every listed condition once, sorted, with its group', () => {
  const { conditions } = gen.collect();
  const listed = [...tables.EXACT_BUFF_CONDITIONS, ...tables.PREFIX_BUFF_CONDITIONS, ...Object.keys(tables.SCALAR_CONDITION_KINDS)];
  assert.equal(new Set(listed).size, listed.length, 'no hrid is in two groups');
  assert.deepEqual(conditions.map(([h]) => h), [...listed].sort());
  const kind = new Map(conditions);
  for (const h of tables.EXACT_BUFF_CONDITIONS) assert.equal(kind.get(h), 'EXACT_BUFF', h);
  for (const h of tables.PREFIX_BUFF_CONDITIONS) assert.equal(kind.get(h), 'PREFIX_BUFF', h);
  for (const [h, k] of Object.entries(tables.SCALAR_CONDITION_KINDS)) assert.equal(kind.get(h), k, h);
});

test('the buff-type scanner keeps digit-bearing names; the JSON walk finds keys and values at any depth', () => {
  const found = buffs.scanHrids('x "/buff_types/foo_10" y /buff_types/bar2 z');
  assert.ok(found.includes('/buff_types/foo_10') && found.includes('/buff_types/bar2'));
  const out = buffs.walkJson({
    a: [{ typeHrid: '/buff_types/deep_value' }],
    permanentBuffs: { '/buff_types/deep_key': { flatBoost: 1 } },
    noise: ['/items/not_a_buff', '/buff_types/'],
  }, new Set());
  assert.deepStrictEqual([...out].sort(), ['/buff_types/deep_key', '/buff_types/deep_value']);
});

test('buff types: sorted, duplicate-free, and every one the game data or the Rust engine names is there', () => {
  const { buffTypes } = gen.collect();
  assert.deepStrictEqual(buffTypes, [...new Set(buffTypes)].sort());
  const have = new Set(buffTypes);
  const want = new Set();
  for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith('.json'))) buffs.walkJson(JSON.parse(fs.readFileSync(new URL(f, DATA), 'utf8')), want);
  const rust = new URL('../../rust/src/', import.meta.url);
  for (const f of fs.readdirSync(rust).filter((f) => f.endsWith('.rs') && f !== 'generated.rs')) {
    for (const h of buffs.scanHrids(fs.readFileSync(new URL(f, rust), 'utf8'))) want.add(h);
  }
  assert.ok(want.size > 20, 'the scans found almost nothing — a walk is broken');
  for (const h of want) assert.ok(have.has(h), `${h} has no entry in BUFF_TYPE_NAMES`);
});
