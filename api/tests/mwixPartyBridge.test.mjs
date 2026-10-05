// =============================================================================
// mwixBridge.partyFromBridgePayload — MWIX's "Sim Party" button lands every
// party member in its own slot, in the game's order, with ITS OWN shrines.
// A single-loadout payload (no `party`) must still take the old P1 path.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const { partyFromBridgePayload } = await import('../../ui/src/utils/mwixBridge.js');

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
