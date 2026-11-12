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

test('autoIronDecision: fetch once, never over the cached times, follow back — by id', () => {
  const main = { name: 'Holy', game: { id: 42 } };
  const s0 = valuationStamp(SNAPS[42]);
  const want = (needsFetch) => ({ id: '42', key: `42@${s0}`, needsFetch });
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: {} }), want(true));
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: { iron: { characterId: '42', snapshotStamp: s0 } } }), want(false));
  // Same name, other id (or a name-keyed entry with no id): not theirs.
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: { iron: { characterId: '7', character: 'HolyChikenz' } } }), want(true));
  assert.deepEqual(autoIronDecision({ main, snapshots: SNAPS, cache: { iron: { character: 'HolyChikenz' } } }), want(true));
  assert.equal(autoIronDecision({ main, snapshots: SNAPS, cache: {}, followed: `42@${s0}` }), null);
  // A refreshed snapshot that the valuation reads differently follows again and recomputes.
  const fresh = { ...SNAPS, 42: { ...SNAPS[42], characterSkills: [{ skillHrid: '/skills/cooking', level: 90 }] } };
  const s1 = valuationStamp(fresh[42]);
  assert.notEqual(s1, s0);
  assert.deepEqual(autoIronDecision({ main, snapshots: fresh, cache: { iron: { characterId: '42', snapshotStamp: s0 } }, followed: `42@${s0}`, ironCharacter: '42' }),
    { id: '42', key: `42@${s1}`, needsFetch: true });
  assert.deepEqual(autoIronDecision({ main, snapshots: fresh, cache: { iron: { characterId: '42', snapshotStamp: s1 } } }),
    { id: '42', key: `42@${s1}`, needsFetch: false });
  assert.equal(autoIronDecision({ main, snapshots: null, cache: {} }), null);
  assert.equal(autoIronDecision({ main: null, snapshots: SNAPS, cache: {} }), null);
  // Main moved to someone with no snapshot: id null, so moving back follows again.
  assert.deepEqual(autoIronDecision({ main: { name: 'x', game: { id: 9 } }, snapshots: SNAPS, cache: {}, followed: `42@${s0}` }), { id: null, key: null, needsFetch: false });
});

test('autoIronDecision: a hand-picked iron character survives main refreshes, not a main change', () => {
  const main = { name: 'Holy', game: { id: 42 } };
  const s0 = valuationStamp(SNAPS[42]);
  const fresh = { ...SNAPS, 42: { ...SNAPS[42], characterSkills: [{ skillHrid: '/skills/cooking', level: 90 }] } };
  const s1 = valuationStamp(fresh[42]);
  // Picked '7' by hand; main's snapshot refreshes: record the key, follow nothing, fetch nothing.
  assert.deepEqual(autoIronDecision({ main, snapshots: fresh, cache: {}, followed: `42@${s0}`, ironCharacter: '7' }),
    { id: null, key: `42@${s1}`, needsFetch: false });
  // The header main changes (here: to '7' from someone else): it is followed.
  assert.deepEqual(autoIronDecision({ main: { name: 'alt', game: { id: 7 } }, snapshots: SNAPS, cache: {}, followed: `42@${s0}`, ironCharacter: '42' }),
    { id: '7', key: `7@${valuationStamp(SNAPS[7])}`, needsFetch: true });
  // An id prefix is not the same main ('4' vs '42').
  assert.equal(autoIronDecision({ main, snapshots: SNAPS, cache: {}, followed: '4@x', ironCharacter: '7' }).id, '42');
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

test('initialIronCharacter: remembered id if it has a snapshot, else the first; names are dropped', () => {
  assert.equal(initialIronCharacter('42', SNAPS), '42');
  assert.equal(initialIronCharacter(42, SNAPS), '42');
  assert.equal(initialIronCharacter('alt', SNAPS), '7');
  assert.equal(initialIronCharacter(null, SNAPS), '7');
  // No named snapshot at all (none yet, or unreadable): the remembered id stands.
  assert.equal(initialIronCharacter('42', {}), '42');
  assert.equal(initialIronCharacter(null, {}), null);
  assert.equal(initialIronCharacter(null, { 1: {}, ...SNAPS }), '7', 'a nameless snapshot is not an option');
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
