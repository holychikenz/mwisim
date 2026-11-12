// audit-13 (market income nets the 4% tax) and audit-18 (formatValue never
// prints "1m 60s") — both in ui/src/utils/prices.js.
import test from 'node:test';
import assert from 'node:assert/strict';

const { saleValue, matchWebappCharacter, autoIronDecision } = await import('../../ui/src/utils/prices.js');

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

// Following the main character with the iron source (hooks/usePrices.js).
const WEBAPP = { characters: ['alt', 'HolyChikenz'], details: [{ name: 'alt' }, { name: 'HolyChikenz' }] };

test('matchWebappCharacter: by game id, then in-game name, then (no game identity) the record name', () => {
  assert.equal(matchWebappCharacter({ name: 'holychikenz' }, WEBAPP), 'HolyChikenz');
  assert.equal(matchWebappCharacter({ name: 'Holy (main)', game: { id: 7, name: 'holychikenz' } }, WEBAPP), 'HolyChikenz');
  assert.equal(matchWebappCharacter({ name: 'nobody' }, WEBAPP), null);
  const byId = { characters: ['renamed'], details: [{ name: 'renamed', characterId: 7 }] };
  assert.equal(matchWebappCharacter({ name: 'x', game: { id: 7 } }, byId), 'renamed');
  assert.equal(matchWebappCharacter({ name: 'x', game: { id: '7' } }, { details: [{ name: 'r', id: 7 }] }), 'r');
  for (const bad of [null, {}, { characters: 'x' }]) assert.equal(matchWebappCharacter({ name: 'x' }, bad), null);
  assert.equal(matchWebappCharacter(null, WEBAPP), null);
  const both = { characters: ['alt', 'main'], details: [{ name: 'alt' }, { name: 'main', characterId: 7 }] };
  assert.equal(matchWebappCharacter({ name: 'alt', game: { id: 7, name: 'alt' } }, both), 'main', 'id beats a name');
  assert.equal(matchWebappCharacter({ name: 'alt', game: { id: 9, name: 'gone' } }, WEBAPP), null, 'editable name unused when game is known');
});

test('autoIronDecision: fetch once, never over the cached times, follow back', () => {
  const main = { name: 'holychikenz' };
  assert.deepEqual(autoIronDecision({ main, webapp: WEBAPP, cache: {} }), { name: 'HolyChikenz', needsFetch: true });
  assert.deepEqual(
    autoIronDecision({ main, webapp: WEBAPP, cache: { iron: { character: 'holychikenz' } } }),
    { name: 'HolyChikenz', needsFetch: false }
  );
  assert.deepEqual(
    autoIronDecision({ main, webapp: WEBAPP, cache: { iron: { character: 'alt' } } }),
    { name: 'HolyChikenz', needsFetch: true }
  );
  assert.equal(autoIronDecision({ main, webapp: WEBAPP, cache: {}, followed: 'HolyChikenz' }), null);
  assert.equal(autoIronDecision({ main, webapp: null, cache: {} }), null);
  assert.equal(autoIronDecision({ main: null, webapp: WEBAPP, cache: {} }), null);
  // Main moved to someone the webapp does not know: name null, so moving back follows again.
  assert.deepEqual(
    autoIronDecision({ main: { name: 'nobody' }, webapp: WEBAPP, cache: {}, followed: 'HolyChikenz' }),
    { name: null, needsFetch: false }
  );
});

test('snapshot roster: main follows by game id to the snapshot name', async () => {
  const { snapshotRoster, snapshotByName } = await import('../../ui/src/utils/characterSnapshots.js');
  const snaps = { 42: { character: { id: 42, name: 'NewName' } }, 7: { character: { id: 7, name: 'Alt' } }, 9: {} };
  const roster = snapshotRoster(snaps);
  assert.deepEqual(roster.characters, ['Alt', 'NewName']);
  // Renamed in game since the store record was made: the id still finds it.
  const main = { name: 'OldName', game: { id: 42, name: 'OldName' } };
  assert.deepEqual(autoIronDecision({ main, webapp: roster, cache: {} }), { name: 'NewName', needsFetch: true });
  assert.equal(snapshotByName(snaps, 'NewName'), snaps[42]);
  assert.equal(snapshotByName(snaps, 'Nobody'), null);
});
