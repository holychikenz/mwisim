// =============================================================================
// Per-player buffs.
// Run: cd api && node --import ./register-loader.js --test tests/perPlayerBuffs.test.mjs
//
// Guild shrines are bought per MEMBER and seals are equipped per CHARACTER, so
// neither is a property of the party. They used to be two party-wide knobs in
// the UI header, which meant a five-person party was always simulated as five
// copies of one person's purchases. They now ride on each player's DTO as
// `extraBuffs`, and every consumer concatenates that tail onto its shared list.
//
// The thing under test is therefore not "a buff applies" — buffStacking.test.mjs
// covers that — but that TWO PLAYERS IN ONE PARTY CAN DIFFER. That is the whole
// feature, and it is the property an accidental `= extraBuffs` overwrite
// anywhere in the chain would silently destroy.
//
// Also pinned here: the seal definitions, which moved out of an inline map in
// src/worker.js into shared/personalBuffs.js so the numbers and the labels could
// stop living in two files that had no way of checking each other.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { derivePlayerBounds } from '../lib/triggerSearch/bounds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  SEAL_DEFS,
  SEAL_OPTIONS,
  resolveSealBuffs,
} = await import('../../shared/personalBuffs.js');

const { resolvePlayerExtraBuffs } = await import('../../ui/src/utils/playerBuffs.js');
const { exportFormatToPlayer, playerToExportFormat } = await import('../../ui/src/utils/importSet.js');

const SPIRIT = '/guild_buffs/spirit_combat';
const DAMAGE_SEAL = '/items/seal_of_damage';
const WISDOM_SEAL = '/items/seal_of_wisdom';

function realDTO(hrid) {
  const fixturePath = join(__dirname, '../../fixtures/lab/cyclops.holychikenz.game.json');
  const dto = JSON.parse(readFileSync(fixturePath, 'utf8')).player.dto;
  dto.hrid = hrid;
  return dto;
}

// -----------------------------------------------------------------------------
// shared/personalBuffs.js
// -----------------------------------------------------------------------------

test('resolveSealBuffs returns the finished buff for a known seal', () => {
  const [buff] = resolveSealBuffs([DAMAGE_SEAL]);
  // The exact numbers, not merely "a buff came back": these were transcribed
  // out of src/worker.js and a transcription error here is invisible everywhere
  // else until someone notices their damage is wrong.
  assert.deepEqual(buff, {
    uniqueHrid: '/buff_uniques/personal_damage',
    typeHrid: '/buff_types/damage',
    ratioBoost: 0.08,
    ratioBoostLevelBonus: 0,
    flatBoost: 0,
    flatBoostLevelBonus: 0,
    startTime: '0001-01-01T00:00:00Z',
    duration: 0,
  });
});

test('resolveSealBuffs skips an unknown hrid rather than throwing', () => {
  // The list arrives from a persisted session, an exported build or an MWIX
  // payload. A seal the game has added since is not a reason to refuse to
  // simulate, and the old inline guard in src/worker.js skipped it too.
  assert.deepEqual(resolveSealBuffs(['/items/seal_of_nothing_in_particular']), []);
  assert.deepEqual(resolveSealBuffs([]), []);
  assert.deepEqual(resolveSealBuffs(), []);
  assert.equal(resolveSealBuffs([DAMAGE_SEAL, '/items/not_a_seal', WISDOM_SEAL]).length, 2);
});

test('every SEAL_OPTIONS entry names a real definition', () => {
  // The options list is the display order and the defs are the data; a value in
  // one with no entry in the other is a checkbox that does nothing.
  assert.equal(SEAL_OPTIONS.length, Object.keys(SEAL_DEFS).length);
  for (const option of SEAL_OPTIONS) {
    assert.ok(SEAL_DEFS[option.value], `${option.value} has no definition`);
    assert.equal(option.label, SEAL_DEFS[option.value].label);
  }
});

// -----------------------------------------------------------------------------
// ui/src/utils/playerBuffs.js — the one resolver every DTO site goes through
// -----------------------------------------------------------------------------

test('resolvePlayerExtraBuffs combines a player\'s own shrines and seals', () => {
  const buffs = resolvePlayerExtraBuffs({
    guildShrines: { [SPIRIT]: 1 },
    personalBuffs: [DAMAGE_SEAL],
  });
  const types = buffs.map((b) => b.typeHrid).sort();
  assert.deepEqual(types, [
    '/buff_types/damage',
    '/buff_types/max_hitpoints',
    '/buff_types/max_manapoints',
  ]);
});

test('resolvePlayerExtraBuffs on a bare player yields nothing', () => {
  assert.deepEqual(resolvePlayerExtraBuffs({}), []);
  assert.deepEqual(resolvePlayerExtraBuffs(undefined), []);
});

test('includeSeals: false drops the seals and keeps the shrines', () => {
  // Guild trials grant neither community buffs nor seals, which is why the UI
  // hides the Buffs control in trial mode.
  const buffs = resolvePlayerExtraBuffs(
    { guildShrines: { [SPIRIT]: 1 }, personalBuffs: [DAMAGE_SEAL] },
    { includeSeals: false }
  );
  assert.ok(buffs.every((b) => b.typeHrid !== '/buff_types/damage'));
  assert.equal(buffs.length, 2);
});

test('partyShrineLevels is a fallback for a build with no shrines of its own', () => {
  // The null-vs-{} distinction from utils/guildBuffs.js ownsShrines: an ABSENT
  // key defers to the party knobs, an empty object means "captured, owns none"
  // and must not.
  const partyShrineLevels = { [SPIRIT]: 1 };
  assert.equal(
    resolvePlayerExtraBuffs({}, { partyShrineLevels, includeSeals: false }).length,
    2,
    'no key at all defers to the party-wide knobs'
  );
  assert.deepEqual(
    resolvePlayerExtraBuffs({ guildShrines: {} }, { partyShrineLevels, includeSeals: false }),
    [],
    'an empty object owns nothing and must not inherit'
  );
  // And on the zone/optimiser paths there is no fallback to be had at all.
  assert.deepEqual(resolvePlayerExtraBuffs({}, { includeSeals: false }), []);
});

// -----------------------------------------------------------------------------
// The absence of `guildShrines` is data, and round-trips must not destroy it
// -----------------------------------------------------------------------------

test('an imported set without guildShrines leaves the key ABSENT', () => {
  // The whole point of the undefined-vs-{} contract. Defaulting this to `{}`
  // here would make the party-wide fallback unreachable for every set written
  // before the field existed: `ownsShrines` reads `{}` as "captured, owns none",
  // so a trial seat built from an older export would silently simulate with no
  // shrines while the header's levels sat there being ignored.
  const player = exportFormatToPlayer({ player: {}, abilities: [] }, 1);
  assert.equal('guildShrines' in player, false, 'absence must survive the read');
  assert.equal(
    resolvePlayerExtraBuffs(player, {
      partyShrineLevels: { [SPIRIT]: 1 },
      includeSeals: false,
    }).length,
    2,
    'and must therefore still defer to the party-wide knobs'
  );
  // The two fields that genuinely have no fallback are defaulted, deliberately.
  assert.deepEqual(player.personalBuffs, []);
  assert.deepEqual(player.abilityMemory, {});
});

test('a set that states guildShrines round-trips it', () => {
  const exported = playerToExportFormat(
    {
      equipment: {},
      abilities: [],
      food: [],
      drinks: [],
      guildShrines: { [SPIRIT]: 3 },
      personalBuffs: [DAMAGE_SEAL],
    },
    '/actions/combat/fly',
    0,
    24
  );
  const player = exportFormatToPlayer(exported, 1);
  assert.deepEqual(player.guildShrines, { [SPIRIT]: 3 });
  assert.deepEqual(player.personalBuffs, [DAMAGE_SEAL]);
  // An explicitly empty object is a statement too, and must survive as one.
  const emptied = exportFormatToPlayer({ ...exported, guildShrines: {} }, 1);
  assert.deepEqual(emptied.guildShrines, {});
  assert.deepEqual(
    resolvePlayerExtraBuffs(emptied, {
      partyShrineLevels: { [SPIRIT]: 1 },
      includeSeals: false,
    }),
    [],
    'owning none must not inherit the party default'
  );
});

// -----------------------------------------------------------------------------
// The API honours the per-player tail
// -----------------------------------------------------------------------------

test('two players in one party can carry different buffs', () => {
  // derivePlayerBounds builds the Player exactly as the simulation will
  // (api/lib/triggerSearch/poolWorker.js), so it is the cheapest place to prove
  // the DTO's own extraBuffs survive. The Spirit shrine is the lever because
  // it moves maxHitpoints, which bounds reports directly.
  const buffed = realDTO('player1');
  const plain = realDTO('player2');
  buffed.extraBuffs = resolvePlayerExtraBuffs({ guildShrines: { [SPIRIT]: 20 } });
  assert.ok(buffed.extraBuffs.length > 0, 'the fixture player really is buffed');

  const bounds = derivePlayerBounds([buffed, plain]);
  assert.ok(
    bounds.players[0].maxHitpoints > bounds.players[1].maxHitpoints,
    'the shrined player must be tougher than their unshrined partymate'
  );
  assert.ok(bounds.players[0].maxManapoints > bounds.players[1].maxManapoints);
});

test('a shared extraBuffs list still reaches every player', () => {
  // The per-player tail is ADDITIVE. A DTO without the field must behave
  // exactly as it did before the field existed, or every payload written by an
  // older client starts simulating differently.
  const shared = resolvePlayerExtraBuffs({ guildShrines: { [SPIRIT]: 20 } });
  const withShared = derivePlayerBounds([realDTO('player1'), realDTO('player2')], {
    extraBuffs: shared,
  });
  const without = derivePlayerBounds([realDTO('player1'), realDTO('player2')]);

  assert.ok(withShared.players[0].maxHitpoints > without.players[0].maxHitpoints);
  assert.equal(withShared.players[0].maxHitpoints, withShared.players[1].maxHitpoints);
});
