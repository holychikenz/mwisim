// =============================================================================
// Guards for the data refresh (tools/refreshData.mjs).
//
// The two things that can silently go wrong here are formatting and scope:
// a refresh that reserialises every file buries a two-key change in a 17-file
// diff nobody reads, and a refresh that rewrites content-equal files does the
// same. Both are asserted below on a throwaway directory.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../tools/refreshData.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csim-refresh-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  // Same content, deliberately NOT the house serialisation.
  fs.writeFileSync(path.join(dataDir, 'sameMap.json'), '{"a":{"n":1}}');
  fs.writeFileSync(path.join(dataDir, 'staleMap.json'), JSON.stringify({ a: 1 }, null, 4));
  fs.writeFileSync(path.join(dataDir, 'goneMap.json'), '{}');

  const dumpPath = path.join(dir, 'dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify({
    type: 'init_client_data',
    gameVersion: 'v1.20261113.0',
    sameMap: { a: { n: 1 } },
    staleMap: { a: 2, crit: 0.00008 },
  }));
  return { dumpPath, dataDir };
}

test('content-equal files are left byte-for-byte alone', () => {
  const { dumpPath, dataDir } = fixture();
  const before = fs.readFileSync(path.join(dataDir, 'sameMap.json'), 'utf8');
  const r = refresh({ dumpPath, dataDir });
  assert.deepEqual(r.unchanged, ['sameMap.json']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'sameMap.json'), 'utf8'), before);
});

test('a changed file is rewritten in the house format', () => {
  const { dumpPath, dataDir } = fixture();
  const r = refresh({ dumpPath, dataDir });
  assert.deepEqual(r.updated, ['staleMap.json']);
  const out = fs.readFileSync(path.join(dataDir, 'staleMap.json'), 'utf8');
  assert.equal(out, JSON.stringify({ a: 2, crit: 0.00008 }, null, 4));
  // The float keeps the game's own notation, not an exponent form.
  assert.ok(out.includes('0.00008'), out);
});

test('a key absent from the dump is reported, not silently emptied', () => {
  const { dumpPath, dataDir } = fixture();
  const r = refresh({ dumpPath, dataDir });
  assert.deepEqual(r.missing, ['goneMap']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'goneMap.json'), 'utf8'), '{}');
});

test('--check writes nothing', () => {
  const { dumpPath, dataDir } = fixture();
  const before = fs.readFileSync(path.join(dataDir, 'staleMap.json'), 'utf8');
  const r = refresh({ dumpPath, dataDir, check: true });
  assert.deepEqual(r.updated, ['staleMap.json']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'staleMap.json'), 'utf8'), before);
});

test('a non-client dump is refused', () => {
  const { dataDir } = fixture();
  const bad = path.join(path.dirname(dataDir), 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ type: 'init_character_data' }));
  assert.throws(() => refresh({ dumpPath: bad, dataDir }), /not an init_client_data dump/);
});
