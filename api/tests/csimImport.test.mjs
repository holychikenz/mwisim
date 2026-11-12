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

test('bridge: any same-origin source is accepted (Firefox sandbox); other origins and READY replies are not', () => {
  const store = new Map();
  const listeners = [];
  const posted = [];
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.window = {
    location: { origin: 'https://csim' },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    postMessage: (m, o) => posted.push([m.type, o]),
    dispatchEvent: () => {}
  };
  try {
    snaps.installSnapshotBridge();
    assert.deepEqual(posted, [[snaps.SNAPSHOT_READY, 'https://csim']]);
    const data = { type: snaps.SNAPSHOT_MESSAGE, snapshots: { 42: FRAME } };
    listeners[0]({ origin: 'https://evil', source: globalThis.window, data });
    assert.deepEqual(snaps.loadSnapshots(), {});
    listeners[0]({ origin: 'https://csim', source: { wrapped: true }, data });
    assert.deepEqual(Object.keys(snaps.loadSnapshots()), ['42']);
    assert.equal(snaps.loadSnapshots()[42].email, undefined, 'still re-filtered');
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
  }
  // The userscript side: READY by origin and type, whatever the source.
  assert.equal(userscript.isReady({ origin: 'https://csim', source: {}, data: { type: userscript.READY_TYPE } }, 'https://csim'), true);
  assert.equal(userscript.isReady({ origin: 'https://evil', data: { type: userscript.READY_TYPE } }, 'https://csim'), false);
  assert.equal(userscript.isReady({ origin: 'https://csim', data: { type: 'other' } }, 'https://csim'), false);
});

test('userscript answers READY with an empty map when nothing is captured yet', () => {
  const listeners = [];
  const posted = [];
  globalThis.unsafeWindow = {
    location: { origin: 'https://csim' },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    postMessage: (m, o) => posted.push([m, o])
  };
  globalThis.GM_getValue = (_key, fallback) => fallback;
  globalThis.GM_addValueChangeListener = () => {};
  try {
    userscript.onCsimPage();
    listeners[0]({ origin: 'https://csim', data: { type: userscript.READY_TYPE } });
    assert.equal(posted.length, 2, 'once on load, once for READY');
    for (const [m, o] of posted) {
      assert.deepEqual(m, { type: userscript.MESSAGE_TYPE, snapshots: {} });
      assert.equal(o, 'https://csim');
    }
    // csim reads that empty answer as "installed".
    assert.deepEqual(snaps.snapshotsFromMessage(posted[0][0]), {});
  } finally {
    delete globalThis.unsafeWindow;
    delete globalThis.GM_getValue;
    delete globalThis.GM_addValueChangeListener;
  }
});

test('userscriptStatus and the bridge: an empty answer means installed; silence past the timeout means missing', async () => {
  const { userscriptStatus } = snaps;
  assert.equal(userscriptStatus({ answered: false, timedOut: false, snapshotCount: 0 }), 'checking');
  assert.equal(userscriptStatus({ answered: false, timedOut: true, snapshotCount: 0 }), 'missing');
  assert.equal(userscriptStatus({ answered: true, timedOut: true, snapshotCount: 0 }), 'empty');
  assert.equal(userscriptStatus({ answered: false, timedOut: true, snapshotCount: 2 }), 'ready');
  const listeners = [];
  const events = [];
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window = {
    location: { origin: 'https://csim' },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); },
    postMessage: () => {},
    dispatchEvent: (e) => events.push(e.type)
  };
  try {
    // A fresh module instance: the earlier bridge test already flipped the shared one.
    const fresh = await import('../../ui/src/utils/characterSnapshots.js?answered');
    fresh.installSnapshotBridge();
    assert.equal(fresh.hasUserscriptAnswered(), false);
    listeners[0]({ origin: 'https://evil', data: { type: snaps.SNAPSHOT_MESSAGE, snapshots: {} } });
    assert.equal(fresh.hasUserscriptAnswered(), false);
    listeners[0]({ origin: 'https://csim', data: { type: snaps.SNAPSHOT_MESSAGE, snapshots: {} } });
    assert.equal(fresh.hasUserscriptAnswered(), true);
    assert.deepEqual(events, [snaps.SNAPSHOTS_EVENT], 'the hooks are told once');
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
  }
});

test('prompt dismissal: persisted when it can be, never throws', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(snaps.loadPromptDismissed(), false);
    snaps.savePromptDismissed(true);
    assert.equal(snaps.loadPromptDismissed(), true);
    snaps.savePromptDismissed(false);
    assert.equal(snaps.loadPromptDismissed(), false);
    globalThis.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    assert.equal(snaps.loadPromptDismissed(), false);
    snaps.savePromptDismissed(true);
  } finally {
    delete globalThis.localStorage;
  }
});
