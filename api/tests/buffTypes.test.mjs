// =============================================================================
// Guards for the generated buff-type ordinal table.
//
// The table is what the buff-boost index is keyed on, so a name missing from it
// is not a crash — it is a buff that throws at runtime, or, if the throw were
// ever weakened, a buff that silently contributes nothing and a plausible but
// WRONG combat number. This codebase has been bitten by exactly that shape of
// bug once already: a scrape whose character class excluded digits dropped
// "hpRegenPer10"/"mpRegenPer10" from a stat list and moved kills/hr by 2%.
//
// The central assertion is the byte-for-byte one: re-run the generator and
// demand the committed file matches. That is what makes generating the table
// safe — the committed artefact can never drift from its source of truth.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const gen = await import('../../tools/genBuffTypes.mjs');
const table = await import('../../src/combatsimulator/generated/buffTypes.js');

test('the committed table is byte-for-byte what the generator produces', () => {
  const committed = fs.readFileSync(gen.OUT_PATH, 'utf8');
  assert.equal(
    gen.generate(),
    committed,
    'src/combatsimulator/generated/buffTypes.js is stale — run `node tools/genBuffTypes.mjs`'
  );
});

test('the hrid scanner accepts digit-bearing names', () => {
  // THE trap, asserted rather than eyeballed. A character class of [a-z_]
  // passes every other test in this file and drops precisely the names that
  // carry digits.
  const found = gen.scanHrids('x "/buff_types/foo_10" y /buff_types/bar2 z');
  assert.ok(found.includes('/buff_types/foo_10'), 'a digit-bearing hrid was dropped by the scanner');
  assert.ok(found.includes('/buff_types/bar2'), 'a trailing-digit hrid was dropped by the scanner');
});

test('the structural JSON walk finds buff types at any depth, in keys or values', () => {
  const out = gen.walkJson({
    a: [{ typeHrid: '/buff_types/deep_value' }],
    permanentBuffs: { '/buff_types/deep_key': { flatBoost: 1 } },
    noise: ['/items/not_a_buff', '/buff_types/'],
  }, new Set());
  assert.deepStrictEqual([...out].sort(), ['/buff_types/deep_key', '/buff_types/deep_value']);
});

test('the table is complete, duplicate-free and consistently indexed', () => {
  const { BUFF_TYPE, BUFF_TYPE_NAMES, BUFF_TYPE_COUNT } = table;
  assert.equal(BUFF_TYPE_NAMES.length, BUFF_TYPE_COUNT);
  assert.equal(new Set(BUFF_TYPE_NAMES).size, BUFF_TYPE_COUNT, 'duplicate hrid in the table');
  BUFF_TYPE_NAMES.forEach((name, i) => {
    assert.equal(BUFF_TYPE[name], i, `${name} does not round-trip through the ordinal map`);
  });
  assert.equal(Object.keys(BUFF_TYPE).length, BUFF_TYPE_COUNT);
});

test('ordinals are sorted, not insertion-ordered', () => {
  // Stability matters: a game-data update must not renumber the world just
  // because a monster moved in the file.
  const sorted = [...table.BUFF_TYPE_NAMES].sort();
  assert.deepStrictEqual([...table.BUFF_TYPE_NAMES], sorted);
});

test('every buff type the engine names as a literal has an ordinal', () => {
  // A second, independent derivation of the same set: scan the engine sources
  // directly. If the generator's own collection logic were to lose a source,
  // this fails.
  const literals = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'data') walk(`${dir}/${e.name}`); }
      else if (e.name.endsWith('.js')) {
        for (const h of gen.scanHrids(fs.readFileSync(`${dir}/${e.name}`, 'utf8'))) literals.add(h);
      }
    }
  };
  walk(new URL('../../src/combatsimulator', import.meta.url).pathname);
  assert.ok(literals.size > 0, 'the engine scan found nothing — the walk is broken');
  for (const hrid of literals) {
    assert.ok(hrid in table.BUFF_TYPE, `${hrid} is used by the engine but has no ordinal`);
  }
});

test('every buff type the bundled game data declares has an ordinal', () => {
  const dir = new URL('../../src/combatsimulator/data', import.meta.url).pathname;
  const found = new Set();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    gen.walkJson(JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')), found);
  }
  assert.ok(found.size > 0, 'the data scan found nothing — the walk is broken');
  for (const hrid of found) {
    assert.ok(hrid in table.BUFF_TYPE, `${hrid} is declared by game data but has no ordinal`);
  }
});

test('an unseen buff type throws rather than reading undefined', () => {
  assert.throws(
    () => table.buffTypeOrdinal('/buff_types/definitely_not_a_real_buff'),
    /Unknown buff type/,
    'an unknown hrid must throw; returning undefined would silently drop the buff'
  );
  assert.equal(table.buffTypeOrdinal(table.BUFF_TYPE_NAMES[0]), 0);
});

test('the ordinal map cannot be shadowed by Object.prototype', () => {
  // BUFF_TYPE is null-prototype on purpose: "constructor" or "toString" as an
  // hrid would otherwise resolve to an inherited function, not undefined, and
  // the throw above would never fire.
  assert.equal(Object.getPrototypeOf(table.BUFF_TYPE), null);
  assert.throws(() => table.buffTypeOrdinal('constructor'), /Unknown buff type/);
});
