// The test build (/mwisim/test/, VITE_SERVER=test) shares live's origin: its storage is namespaced test::.
import test from 'node:test';
import assert from 'node:assert/strict';
const { isTestBuild, TEST_BUILD, namespaceStorage } = await import('../../ui/src/utils/serverStorage.js');
const { snapshotsKeyFor } = await import('../../ui/src/utils/characterSnapshots.js');

const fakeStorage = (entries) => {
  const store = new Map(entries);
  const proto = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
  return { store, proto };
};

test('a build is a test build only when VITE_SERVER is exactly "test"', () => {
  assert.equal(TEST_BUILD, false);
  for (const env of [undefined, {}, { VITE_SERVER: '' }, { VITE_SERVER: 'live' }, { VITE_SERVER: 'TEST' }]) {
    assert.equal(isTestBuild(env), false, JSON.stringify(env));
  }
  assert.equal(isTestBuild({ VITE_SERVER: 'test' }), true);
});

test('namespaced storage never touches an unprefixed key', () => {
  const { store, proto } = fakeStorage([['csim_prices', 'live'], ['csim_characters', 'live']]);
  namespaceStorage(proto, 'test::');
  assert.equal(proto.getItem('csim_prices'), null);
  proto.setItem('csim_prices', 'test');
  proto.setItem('csim_characters', 'test');
  assert.equal(store.get('csim_prices'), 'live');
  assert.equal(store.get('csim_characters'), 'live');
  assert.equal(store.get('test::csim_prices'), 'test');
  proto.removeItem('csim_prices');
  assert.equal(store.get('csim_prices'), 'live');
  assert.equal(store.has('test::csim_prices'), false);
});

test('snapshots: the test build uses test::csim_character_snapshots, prefixed once', () => {
  const { store, proto } = fakeStorage([['csim_character_snapshots', 'live']]);
  namespaceStorage(proto, 'test::');
  proto.setItem(snapshotsKeyFor('/mwisim/test/', true), 'test');
  assert.deepEqual([...store.keys()].sort(), ['csim_character_snapshots', 'test::csim_character_snapshots']);
  assert.equal(store.get('csim_character_snapshots'), 'live');
  // A live build keeps 6b79412's path rule.
  assert.equal(snapshotsKeyFor('/mwisim/test/', false), 'csim_character_snapshots:test');
  assert.equal(snapshotsKeyFor('/mwisim/', false), 'csim_character_snapshots');
});
