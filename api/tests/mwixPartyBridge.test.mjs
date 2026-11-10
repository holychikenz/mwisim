// =============================================================================
// mwixBridge.partyFromBridgePayload — MWIX's "Sim Party" button lands every
// party member in its own slot, in the game's order, with ITS OWN shrines.
// A single-loadout payload (no `party`) must still take the old P1 path.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const { partyFromBridgePayload, mwixStoreId, mergeBridged } = await import('../../ui/src/utils/mwixBridge.js');
const { emptyStore, upsertCharacter, createLoadout } = await import('../../ui/src/utils/characterStore.js');

const member = (name, attack, shrines) => ({
  name,
  loadout: { name: `${name} loadout` },
  importSet: {
    player: { attackLevel: attack, equipment: [] },
    zone: '/actions/combat/twilight_zone',
    difficultyTier: 4
  },
  mwixContext: { guildShrines: shrines }
});

test('a single-loadout payload is not a party', () => {
  assert.equal(partyFromBridgePayload({ importSet: {} }), null);
  assert.equal(partyFromBridgePayload({ party: [] }), null);
});

test('members keep their order, names, loadouts and their own shrines', () => {
  const out = partyFromBridgePayload({
    party: [
      member('Alpha', 110, { '/guild_buffs/force_combat': 5, '/guild_buffs/bogus': 9 }),
      member('Beta', 90, {})
    ]
  });
  assert.deepEqual(out.map(m => [m.slot, m.name, m.loadoutName]), [
    [1, 'Alpha', 'Alpha loadout'],
    [2, 'Beta', 'Beta loadout']
  ]);
  assert.equal(out[0].player.attackLevel, 110);
  assert.equal(out[1].player.hrid, 'player2');
  assert.deepEqual(out[0].player.guildShrines, { '/guild_buffs/force_combat': 5 });
  assert.deepEqual(out[1].player.guildShrines, {});
});

test('more than five members are cut to the five slots', () => {
  const out = partyFromBridgePayload({ party: Array.from({ length: 7 }, (_, i) => member(`M${i}`, 50, {})) });
  assert.equal(out.length, 5);
});

test('audit3-2: MWIX characters are keyed by game characterId, by name only without one', () => {
  const [a, b] = partyFromBridgePayload({ party: [{ ...member('Alpha', 1, {}), characterId: 28337 }, member('Beta', 1, {})] });
  assert.equal(a.characterId, 28337);
  assert.equal(b.characterId, null);
  assert.equal(mwixStoreId(a.characterId, a.name), 'mwix_28337');
  assert.equal(mwixStoreId('28337', 'Renamed'), 'mwix_28337', 'a rename does not move the character');
  assert.equal(mwixStoreId(b.characterId, b.name), 'mwix_beta', 'the old key, so stored characters still match');
  // Two alts with the same loadout name stay two characters.
  assert.notEqual(mwixStoreId(1, 'Combat'), mwixStoreId(2, 'Combat'));
});

test('a bridged loadout patches the full stored character with the same game id', () => {
  const full = upsertCharacter(emptyStore(), {
    id: 'holy', name: 'Holy', game: { id: 28337, name: 'Holy' }, attackLevel: 100,
    personalBuffs: [{ x: 1 }], debuffOnLevelGap: 1, inventory: [{ itemHrid: '/items/a', count: 1 }],
    abilityLevels: { '/abilities/a': 30, '/abilities/b': 20 }, loadouts: { Melee: createLoadout() }
  });
  const player = partyFromBridgePayload({ party: [member('Holy', 110, {})] })[0].player;
  player.abilities = [{ hrid: '/abilities/a', level: 31, triggers: [] }];
  const out = mergeBridged(full, { gameId: '28337', name: 'Holy', legacyName: 'Holy', loadoutName: 'bridge', player, importSet: {} });
  const c = out.store.characters[out.id];
  assert.equal(out.id, 'holy', 'not a separate mwix_28337 record');
  assert.equal(Object.keys(out.store.characters).length, 1);
  assert.equal(c.attackLevel, 110, 'carried fields update');
  assert.deepEqual(Object.keys(c.loadouts).sort(), ['Melee', 'bridge']);
  assert.deepEqual(c.personalBuffs, [{ x: 1 }], 'MWIX sends no personal buffs');
  assert.equal(c.debuffOnLevelGap, 1);
  assert.equal(c.inventory.length, 1);
  assert.deepEqual(c.abilityLevels, { '/abilities/a': 31, '/abilities/b': 20 });
});

test('without a stored match the bridge keeps its old keys', () => {
  const player = partyFromBridgePayload({ party: [member('Beta', 90, {})] })[0].player;
  const base = { gameId: null, name: 'Beta', legacyName: 'Beta', loadoutName: 'bridge', player, importSet: {} };
  assert.equal(mergeBridged(emptyStore(), base).id, 'mwix_beta');
  const legacy = upsertCharacter(emptyStore(), { id: 'mwix_7', name: 'Gamma', loadouts: { Old: createLoadout() } });
  const out = mergeBridged(legacy, { ...base, gameId: 7, name: 'Gamma' });
  assert.equal(out.id, 'mwix_7', 'an earlier bridge record is reused, and now carries the game id');
  assert.equal(out.store.characters.mwix_7.game.id, 7);
});
