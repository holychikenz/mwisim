// audit-13 (market income nets the 4% tax) and audit-18 (formatValue never
// prints "1m 60s") — both in ui/src/utils/prices.js.
import test from 'node:test';
import assert from 'node:assert/strict';

const { saleValue, matchSnapshotId, autoIronDecision, initialIronCharacter, staleIronCharacter } = await import('../../ui/src/utils/prices.js');

const PRICES = {
  '/items/rainbow_milk': { ask: 100, bid: 80, vendor: 5 },
  '/items/vendor_only': { ask: -1, bid: -1, vendor: 7 },
  '/items/coin': { ask: 1, bid: 1, vendor: 1 },
  '/items/small_treasure_chest': { ask: 1000, bid: 900, vendor: 0 },
};

test('audit-13: a market sale nets 96%, except coin, chests and vendor-only items', () => {
  assert.equal(saleValue(PRICES, '/items/rainbow_milk', 'bid', 'market'), 80 * 0.96);
  assert.equal(saleValue(PRICES, '/items/rainbow_milk', 'ask', 'market'), 100 * 0.96);
  assert.equal(saleValue(PRICES, '/items/coin', 'bid', 'market'), 1);
  assert.equal(saleValue(PRICES, '/items/small_treasure_chest', 'bid', 'market'), 900);
  assert.equal(saleValue(PRICES, '/items/vendor_only', 'bid', 'market'), 7);
  // Other sources are not market sales.
  assert.equal(saleValue(PRICES, '/items/rainbow_milk', 'bid', 'vendor'), 80);
  assert.equal(saleValue(PRICES, '/items/rainbow_milk', 'bid', 'iron'), 80);
});

test('audit-18: formatValue rounds the total before splitting it', async () => {
  const { formatValue } = await import('../../ui/src/utils/prices.js');
  assert.equal(formatValue(119.6, 'seconds'), '2m 0s');
  assert.equal(formatValue(3599.6, 'seconds'), '1h 0m');
  assert.equal(formatValue(7170, 'seconds'), '2h 0m');
  assert.equal(formatValue(59.97, 'seconds'), '1m 0s');
  assert.equal(formatValue(59.9, 'seconds'), '59.9s');
  assert.equal(formatValue(-90, 'seconds'), '-1m 30s');
  assert.equal(formatValue(3661, 'seconds'), '1h 1m');
  assert.equal(formatValue(Infinity, 'seconds'), '∞');
  assert.equal(formatValue(Infinity, 'coins'), '∞');
});

// Following the main character with the iron source (hooks/usePrices.js): keyed on game characterId.
const SNAPS = { 42: { character: { id: 42, name: 'HolyChikenz' } }, 7: { character: { id: 7, name: 'alt' } } };

test('matchSnapshotId: by game id only when main has one; by name only without', () => {
  // Renamed in game since the record was made: the id still finds it.
  assert.equal(matchSnapshotId({ name: 'Old', game: { id: 42, name: 'Old' } }, SNAPS), '42');
  assert.equal(matchSnapshotId({ name: 'x', game: { id: '7' } }, SNAPS), '7');
  // A game id with no snapshot never falls back to a name — that could be another character.
  assert.equal(matchSnapshotId({ name: 'alt', game: { id: 9, name: 'alt' } }, SNAPS), null);
  // No game id: in-game name, then the record's own, ignoring case.
  assert.equal(matchSnapshotId({ name: 'holychikenz' }, SNAPS), '42');
  assert.equal(matchSnapshotId({ name: 'Holy (main)', game: { name: 'ALT' } }, SNAPS), '7');
  assert.equal(matchSnapshotId({ name: 'nobody' }, SNAPS), null);
  for (const bad of [null, undefined, 'x']) assert.equal(matchSnapshotId({ name: 'alt' }, bad), null);
  assert.equal(matchSnapshotId(null, SNAPS), null);
});

test('autoIronDecision: fetch once, never over the cached times, follow back — by id', () => {
  const main = { name: 'Holy', game: { id: 42 } };
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: {} }), { id: '42', needsFetch: true });
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: { iron: { characterId: '42' } } }), { id: '42', needsFetch: false });
  // Same name, other id (or a name-keyed entry with no id): not theirs.
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: { iron: { characterId: '7', character: 'HolyChikenz' } } }), { id: '42', needsFetch: true });
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: { iron: { character: 'HolyChikenz' } } }), { id: '42', needsFetch: true });
  assert.equal(autoIronDecision({ main, snapshots: SNAPS, cache: {}, followed: '42' }), null);
  assert.equal(autoIronDecision({ main, snapshots: null, cache: {} }), null);
  assert.equal(autoIronDecision({ main: null, snapshots: SNAPS, cache: {} }), null);
  // Main moved to someone with no snapshot: id null, so moving back follows again.
  assert.deepEqual(autoIronDecision({ main: { name: 'x', game: { id: 9 } }, snapshots: SNAPS, cache: {}, followed: '42' }), { id: null, needsFetch: false });
});

test('initialIronCharacter: remembered id if it has a snapshot, else the first; names are dropped', () => {
  assert.equal(initialIronCharacter('42', SNAPS), '42');
  assert.equal(initialIronCharacter(42, SNAPS), '42');
  assert.equal(initialIronCharacter('alt', SNAPS), '7');
  assert.equal(initialIronCharacter(null, SNAPS), '7');
  assert.equal(initialIronCharacter('42', {}), null);
});

test('staleIronCharacter: compares ids, reports the cached name', () => {
  assert.equal(staleIronCharacter({ character: 'HolyChikenz', characterId: '42' }, '42'), null);
  assert.equal(staleIronCharacter({ character: 'HolyChikenz', characterId: '42' }, '7'), 'HolyChikenz');
  assert.equal(staleIronCharacter({ character: 'alt' }, '7'), 'alt', 'a name-keyed entry is unverified');
  assert.equal(staleIronCharacter(null, '7'), null);
  assert.equal(staleIronCharacter({ character: 'alt', characterId: '7' }, null), null);
});

test('snapshotOptions: id values, in-game name labels, nameless snapshots skipped', async () => {
  const { snapshotOptions } = await import('../../ui/src/utils/characterSnapshots.js');
  assert.deepEqual(snapshotOptions({ ...SNAPS, 9: {} }), [{ value: '7', label: 'alt' }, { value: '42', label: 'HolyChikenz' }]);
  assert.deepEqual(snapshotOptions(null), []);
});
