// =============================================================================
// userscript/csim-import.user.js (allowlist filter) and the csim side of its
// hand-over (ui/src/utils/characterSnapshots.js: message validation, the write).
// The MessageEvent hook itself is tested by hand in the game.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const userscript = require('../../userscript/csim-import.user.js');
const snaps = await import('../../ui/src/utils/characterSnapshots.js');

const FRAME = {
  type: 'init_character_data',
  email: 'me@example.com', guestPassword: 'hunter2', user: { id: 1 }, userInfo: {},
  steamUserId: 's', kongregateUserId: 'k', chatHistoryByChannelMap: { general: ['hi'] },
  whisperChatHistory: [], guildChatHistory: [],
  character: { id: 42, userID: 1, name: 'Holy', previousName: 'Old', gameMode: 'ironcow' },
  characterSkills: [{ skillHrid: '/skills/milking', level: 100 }],
  characterItems: [], noncombatStats: {}, characterActions: [{ ordinal: 0 }],
  houseActionTypeBuffsMap: {}
};

test('userscript filter: only allowlisted keys; character is id + name', () => {
  const out = userscript.filterCharacterData(FRAME);
  assert.deepEqual(Object.keys(out).sort(),
    ['character', 'characterActions', 'characterItems', 'characterSkills', 'houseActionTypeBuffsMap', 'noncombatStats']);
  assert.deepEqual(out.character, { id: 42, name: 'Holy' });
  assert.ok(!JSON.stringify(out).includes('me@example.com') && !JSON.stringify(out).includes('hunter2'));
  assert.equal(userscript.filterCharacterData({ character: {} }), null);
});

test('the userscript and csim agree on the allowlist and message type', () => {
  assert.deepEqual(userscript.SNAPSHOT_KEYS, snaps.SNAPSHOT_KEYS);
  assert.equal(userscript.MESSAGE_TYPE, snaps.SNAPSHOT_MESSAGE);
  assert.equal(userscript.READY_TYPE, snaps.SNAPSHOT_READY);
});

test('snapshotsFromMessage: validates shape, re-filters, drops mismatched ids', () => {
  const msg = { type: snaps.SNAPSHOT_MESSAGE, snapshots: {
    42: FRAME,                                              // unfiltered: csim strips it again
    7: { character: { id: 8, name: 'liar' } },              // key/id mismatch
    x: { character: { id: 'x', name: 'x' } },               // not a numeric id
    9: { character: { id: 9 } },                            // no name
    10: { character: { id: 10, name: 'ok' }, characterSkills: 'nope' } // wrong type: dropped key
  } };
  const out = snaps.snapshotsFromMessage(msg);
  assert.deepEqual(Object.keys(out).sort(), ['10', '42']);
  assert.deepEqual(out[42].character, { id: 42, name: 'Holy' });
  assert.equal(out[42].email, undefined);
  assert.equal(out[42].chatHistoryByChannelMap, undefined);
  assert.deepEqual(out[10], { character: { id: 10, name: 'ok' } });
  for (const bad of [null, 'x', {}, { type: 'other', snapshots: {} }, { type: snaps.SNAPSHOT_MESSAGE, snapshots: [] }]) {
    assert.equal(snaps.snapshotsFromMessage(bad), null);
  }
});

test('saveSnapshots: merges by id into csim_character_snapshots and notifies', () => {
  const store = new Map([[snaps.SNAPSHOTS_KEY, JSON.stringify({ 7: { character: { id: 7, name: 'alt' } } })]]);
  const events = [];
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
  try {
    assert.equal(snaps.saveSnapshots({ 42: { character: { id: 42, name: 'Holy' } } }), true);
    assert.deepEqual(Object.keys(snaps.loadSnapshots()).sort(), ['42', '7']);
    assert.deepEqual(events, [snaps.SNAPSHOTS_EVENT]);
    const at = snaps.loadSnapshots()[42].savedAt;
    assert.equal(typeof at, 'number');
    // Unchanged: no write, no event, the stamp stands.
    assert.equal(snaps.saveSnapshots({ 42: { character: { id: 42, name: 'Holy' } } }), true);
    assert.equal(events.length, 1);
    assert.equal(snaps.loadSnapshots()[42].savedAt, at);
    globalThis.localStorage.setItem = () => { throw new Error('quota'); };
    assert.equal(snaps.saveSnapshots({ 1: { character: { id: 1, name: 'n' } } }), false);
    assert.equal(events.length, 1);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
  }
});
