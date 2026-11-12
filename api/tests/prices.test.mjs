// audit-13 (market income nets the 4% tax) and audit-18 (formatValue never
// prints "1m 60s") — both in ui/src/utils/prices.js.
import test from 'node:test';
import assert from 'node:assert/strict';

const { saleValue, matchSnapshotId, ironTarget, ironComputeKey, staleIronCharacter } = await import('../../ui/src/utils/prices.js');

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
const { valuationStamp } = await import('../../ui/src/utils/characterSnapshots.js');
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

test('ironTarget: the live hand pick, else main — one id comparison throughout', () => {
  const main = { id: 'rec1', name: 'Holy', game: { id: 42 } };
  assert.equal(ironTarget(null, main, SNAPS), '42');
  // A pick made under this main overrides it.
  assert.equal(ironTarget({ id: '7', main: 'rec1' }, main, SNAPS), '7');
  // The header main changed since the pick: main again (usePrices then clears the pick).
  assert.equal(ironTarget({ id: '7', main: 'rec1' }, { id: 'rec2', name: 'x', game: { id: 42 } }, SNAPS), '42');
  // The picked snapshot vanished: main again.
  const { 7: _gone, ...noAlt } = SNAPS;
  assert.equal(ironTarget({ id: '7', main: 'rec1' }, main, noAlt), '42');
  // A pick made before main had a snapshot survives main's first snapshot arriving.
  const { 42: _none, ...noMain } = SNAPS;
  assert.equal(ironTarget(null, main, noMain), null);
  assert.equal(ironTarget({ id: '7', main: 'rec1' }, main, SNAPS), '7');
  // No main at all: a pick still works; nothing to follow otherwise.
  assert.equal(ironTarget({ id: '7', main: null }, null, SNAPS), '7');
  assert.equal(ironTarget(null, null, SNAPS), null);
  // A main without a game id matches by name ignoring case, as matchSnapshotId does.
  assert.equal(ironTarget(null, { id: 'r', name: 'HOLYCHIKENZ' }, SNAPS), '42');
});

test('ironComputeKey: unchanged stamp none, stamp change or missing cache recompute, one try per session', () => {
  const s0 = valuationStamp(SNAPS[42]);
  const tried = new Set();
  // Cached times are this snapshot's: nothing, ever.
  assert.equal(ironComputeKey('42', s0, { characterId: '42', snapshotStamp: s0 }, tried), null);
  // Cache missing (e.g. dropped by the quota fallback) or another character's: compute.
  assert.equal(ironComputeKey('42', s0, undefined, tried), `42@${s0}`);
  assert.equal(ironComputeKey('42', s0, { characterId: '7', snapshotStamp: s0 }, tried), `42@${s0}`);
  assert.equal(ironComputeKey('42', s0, { character: 'HolyChikenz' }, tried), `42@${s0}`, 'a name-keyed entry is not theirs');
  // Stamp changed (refreshed snapshot the valuation reads differently): compute.
  assert.equal(ironComputeKey('42', 'new', { characterId: '42', snapshotStamp: s0 }, tried), '42@new');
  // A failed attempt is not retried this session for the same id@stamp, but a new stamp tries again.
  tried.add(`42@${s0}`);
  assert.equal(ironComputeKey('42', s0, undefined, tried), null);
  assert.equal(ironComputeKey('42', 'new', undefined, tried), '42@new');
  // No target: nothing.
  assert.equal(ironComputeKey(null, null, undefined, new Set()), null);
});

test('valuationStamp: only what the valuation reads', () => {
  const base = {
    character: { id: 42, name: 'Holy' },
    characterSkills: [{ skillHrid: '/skills/cooking', level: 90, experience: 1 }],
    characterItems: [{ itemHrid: '/items/apple', enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory', count: 5 }],
    characterLoadoutMap: { 1: { actionTypeHrid: '/action_types/cooking', isDefault: true, wearableMap: { a: 'x::y::/items/z::3' } } },
    noncombatStats: { gatheringQuantity: 0.1, cookingSpeed: 0.2 },
    consumableActionTypeBuffsMap: { '/action_types/cooking': [{ typeHrid: '/buff_types/efficiency', uniqueHrid: 'u', flatBoost: 0.1, ratioBoost: 0, startTime: 'a' }] },
    characterActions: [{ ordinal: 0 }]
  };
  const st = valuationStamp(base);
  assert.equal(valuationStamp(null), null);
  const same = (patch) => assert.equal(valuationStamp({ ...base, ...patch }), st, JSON.stringify(patch));
  const diff = (patch) => assert.notEqual(valuationStamp({ ...base, ...patch }), st, JSON.stringify(patch));
  same({ characterSkills: [{ skillHrid: '/skills/cooking', level: 90, experience: 999 }] });
  same({ characterItems: [{ ...base.characterItems[0], count: 1 }] });
  same({ characterActions: [] });
  same({ character: { id: 42, name: 'Renamed' } });
  same({ noncombatStats: { gatheringQuantity: 0.1, cookingSpeed: 0.9 } });
  same({ consumableActionTypeBuffsMap: { '/action_types/cooking': [{ ...base.consumableActionTypeBuffsMap['/action_types/cooking'][0], startTime: 'b' }] } });
  same({ equipmentActionTypeBuffsMap: { x: [{ typeHrid: 't', flatBoost: 1 }] } });
  diff({ characterSkills: [{ skillHrid: '/skills/cooking', level: 91 }] });
  diff({ characterItems: [{ ...base.characterItems[0], enhancementLevel: 2 }] });
  diff({ characterItems: [{ ...base.characterItems[0], itemLocationHrid: '/item_locations/body' }] });
  diff({ characterLoadoutMap: { 1: { ...base.characterLoadoutMap[1], wearableMap: { a: 'x::y::/items/z::4' } } } });
  diff({ noncombatStats: { gatheringQuantity: 0.2 } });
  diff({ houseActionTypeBuffsMap: { '/action_types/cooking': [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.015 }] } });
  diff({ consumableActionTypeBuffsMap: {} });
});

test('staleIronCharacter: compares ids, reports the cached name', () => {
  assert.equal(staleIronCharacter({ character: 'HolyChikenz', characterId: '42' }, '42'), null);
  assert.equal(staleIronCharacter({ character: 'HolyChikenz', characterId: '42' }, '7'), 'HolyChikenz');
  assert.equal(staleIronCharacter({ character: 'alt' }, '7'), 'alt', 'a name-keyed entry is unverified');
  assert.equal(staleIronCharacter(null, '7'), null);
  assert.equal(staleIronCharacter({ character: 'alt', characterId: '7' }, null), null);
  assert.equal(staleIronCharacter({ character: 'alt', characterId: '7', snapshotStamp: 'a' }, '7', 'b'), 'alt (an older snapshot)');
  assert.equal(staleIronCharacter({ character: 'alt', characterId: '7', snapshotStamp: 'b' }, '7', 'b'), null);
});

test('snapshotOptions: id values, in-game name labels, nameless snapshots skipped', async () => {
  const { snapshotOptions } = await import('../../ui/src/utils/characterSnapshots.js');
  assert.deepEqual(snapshotOptions({ ...SNAPS, 9: {} }), [{ value: '7', label: 'alt' }, { value: '42', label: 'HolyChikenz' }]);
  assert.deepEqual(snapshotOptions(null), []);
});
