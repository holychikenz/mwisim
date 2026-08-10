// =============================================================================
// Guild expansion parity (game patch 7/13/2026).
// Run: cd api && node --import ./register-loader.js --test tests/guildBuffs.test.mjs
//
// Three things under test:
//
//  1. LEVEL RESOLUTION. Guild buffs resolve as `base + bonus * (level - 1)`,
//     so level 1 yields the BASE value. Ground truth: a character with
//     force_combat at level 2 gets server-resolved
//     guildActionTypeBuffsMap["/action_types/combat"] damage ratioBoost 0.006
//     — i.e. 0.003 + 0.003 * (2 - 1). The earlier `base + level * bonus`
//     overstated every shrine by one full level step.
//
//  2. SPIRIT SHRINE. /buff_types/max_hitpoints and /buff_types/max_manapoints
//     are new in this patch. Nothing upstream read them, so the Spirit shrine
//     was a silent no-op. They must reach maxHitpoints/maxManapoints, and must
//     do so IDEMPOTENTLY — updateCombatDetails() re-runs on every buff
//     add/remove, so a bonus folded into persistent state would compound.
//
//  3. GUILD CREDIT CONVERSION. Loot re-expressed as guild credits, taking the
//     highest-tier option when an item offers several.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CombatUnit = (await import('../../src/combatsimulator/combatUnit.js')).default;
const {
  resolveGuildBuffs,
  resolveGuildBuildingBuffs,
  GUILD_COMBAT_BUFFS,
  GUILD_COMBAT_BUILDINGS,
} = await import('../../ui/src/utils/guildBuffs.js');
const {
  convertDropsToCredits,
  pickHighestTierConversion,
} = await import('../../ui/src/utils/guildCredits.js');

const FORCE = '/guild_buffs/force_combat';
const SPIRIT = '/guild_buffs/spirit_combat';
const TEMPO = '/guild_buffs/tempo_combat';
const DOJO = '/guild_buildings/dojo';

const byType = (buffs, typeHrid) => buffs.find((b) => b.typeHrid === typeHrid);

// ---------------------------------------------------------------- resolution

test('shrine level 1 yields the BASE value, not base + one bonus step', () => {
  const resolved = resolveGuildBuffs({ [FORCE]: 1 });
  const damage = byType(resolved, '/buff_types/damage');
  assert.ok(damage, 'force_combat should emit a damage buff');
  assert.equal(damage.ratioBoost, 0.003);
});

test('shrine level 2 matches server-resolved ground truth (0.006, not 0.009)', () => {
  const resolved = resolveGuildBuffs({ [FORCE]: 2 });
  const damage = byType(resolved, '/buff_types/damage');
  // Rounded because 0.003 + 0.003 is not exact in binary floating point.
  assert.equal(Number(damage.ratioBoost.toFixed(10)), 0.006);
});

test('shrine level 20 gives +6% damage, +8% attack speed, +0.08 cast speed', () => {
  const resolved = resolveGuildBuffs({ [FORCE]: 20, [TEMPO]: 20 });
  assert.equal(Number(byType(resolved, '/buff_types/damage').ratioBoost.toFixed(10)), 0.06);
  assert.equal(Number(byType(resolved, '/buff_types/attack_speed').ratioBoost.toFixed(10)), 0.08);
  // Tempo mixes forms: attack_speed is a RATIO, cast_speed is FLAT.
  assert.equal(Number(byType(resolved, '/buff_types/cast_speed').flatBoost.toFixed(10)), 0.08);
  assert.equal(byType(resolved, '/buff_types/cast_speed').ratioBoost, 0);
});

test('level 0 or absent omits the shrine entirely', () => {
  assert.deepEqual(resolveGuildBuffs({ [FORCE]: 0 }), []);
  assert.deepEqual(resolveGuildBuffs({}), []);
  assert.deepEqual(resolveGuildBuffs(), []);
});

test('levels are clamped to the max and negatives are treated as off', () => {
  const overMax = resolveGuildBuffs({ [FORCE]: 999 });
  const atMax = resolveGuildBuffs({ [FORCE]: 20 });
  assert.equal(overMax[0].ratioBoost, atMax[0].ratioBoost);
  assert.deepEqual(resolveGuildBuffs({ [FORCE]: -5 }), []);
});

test('resolved buffs zero their per-level bonus fields so nothing double-counts', () => {
  for (const b of resolveGuildBuffs({ [FORCE]: 7, [SPIRIT]: 7, [TEMPO]: 7 })) {
    assert.equal(b.ratioBoostLevelBonus, 0);
    assert.equal(b.flatBoostLevelBonus, 0);
  }
});

test('guild building level 20 gives +40 to its combat level', () => {
  const resolved = resolveGuildBuildingBuffs({ [DOJO]: 20 });
  const attack = byType(resolved, '/buff_types/attack_level');
  assert.equal(attack.flatBoost, 40); // 2 + 2 * 19
  assert.equal(attack.ratioBoost, 0);
});

test('guild buildings cover only combat-relevant buildings', () => {
  // Skilling buildings (brewery, kitchen, …) raise levels the combat engine
  // never reads, so they are deliberately absent.
  const hrids = GUILD_COMBAT_BUILDINGS.map((b) => b.hrid);
  assert.ok(hrids.includes('/guild_buildings/dojo'));
  assert.ok(!hrids.includes('/guild_buildings/brewery'));
  assert.ok(!hrids.includes('/guild_buildings/kitchen'));
});

test('every shrine definition carries at least one buff', () => {
  assert.equal(GUILD_COMBAT_BUFFS.length, 5);
  for (const def of GUILD_COMBAT_BUFFS) {
    assert.ok(def.buffs.length > 0, `${def.hrid} has no buffs`);
  }
});

// ------------------------------------------------------------ spirit shrine

/** A monster-flavoured unit (isPlayer=false skips the player-only regen branch). */
function makeUnit() {
  const unit = new CombatUnit();
  unit.isPlayer = false;
  for (const stat of ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic']) {
    unit[stat + 'Level'] = 100;
  }
  return unit;
}

test('Spirit shrine actually raises max HP and MP (was a silent no-op)', () => {
  const base = makeUnit();
  base.clearBuffs();
  const baseHp = base.combatDetails.maxHitpoints;
  const baseMp = base.combatDetails.maxManapoints;
  assert.ok(baseHp > 0 && baseMp > 0);

  const buffed = makeUnit();
  for (const b of resolveGuildBuffs({ [SPIRIT]: 20 })) {
    buffed.addPermanentBuff(b);
  }
  buffed.clearBuffs(); // seeds combatBuffs from permanentBuffs, then recomputes

  // Spirit at level 20 is +20% to each.
  assert.equal(buffed.combatDetails.maxHitpoints, Math.floor(baseHp * 1.2));
  assert.equal(buffed.combatDetails.maxManapoints, Math.floor(baseMp * 1.2));
});

test('the max HP/MP boost is idempotent across repeated recomputes', () => {
  // updateCombatDetails() runs again on every buff add/remove. If the boost
  // were folded into combatStats with `+=` it would compound each time.
  const unit = makeUnit();
  for (const b of resolveGuildBuffs({ [SPIRIT]: 20 })) {
    unit.addPermanentBuff(b);
  }
  unit.clearBuffs();
  const first = unit.combatDetails.maxHitpoints;

  for (let i = 0; i < 10; i++) unit.updateCombatDetails();
  assert.equal(unit.combatDetails.maxHitpoints, first);
});

test('a flat max-HP boost adds before the ratio multiplies', () => {
  const unit = makeUnit();
  unit.addPermanentBuff({
    uniqueHrid: '/buff_uniques/test_max_hp',
    typeHrid: '/buff_types/max_hitpoints',
    flatBoost: 500,
    ratioBoost: 1, // +100%
    duration: 0,
  });
  unit.clearBuffs();
  // (10 * (10 + 100) + 0 + 500) * (1 + 0 + 1) = 1600 * 2
  assert.equal(unit.combatDetails.maxHitpoints, 3200);
});

// -------------------------------------------------------- credit conversion

test('the highest-tier conversion wins when several are offered', () => {
  const chosen = pickHighestTierConversion([
    { creditItemHrid: '/items/red_guild_credit', itemCount: 1, creditCount: 4000 },
    { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 80 },
  ]);
  assert.equal(chosen.creditItemHrid, '/items/gold_guild_credit');
});

test('tier order does not depend on array order', () => {
  // Same pair, reversed. Ranking must not rely on "last element wins".
  const chosen = pickHighestTierConversion([
    { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 80 },
    { creditItemHrid: '/items/red_guild_credit', itemCount: 1, creditCount: 4000 },
  ]);
  assert.equal(chosen.creditItemHrid, '/items/gold_guild_credit');
});

test('no conversions yields null', () => {
  assert.equal(pickHighestTierConversion([]), null);
  assert.equal(pickHighestTierConversion(undefined), null);
});

test('drops convert to credits and aggregate per tier, highest tier first', () => {
  const items = {
    '/items/widget': {
      name: 'Widget',
      guildCreditConversions: [
        { creditItemHrid: '/items/red_guild_credit', itemCount: 1, creditCount: 4000 },
        { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 80 },
      ],
    },
    '/items/trinket': {
      name: 'Trinket',
      guildCreditConversions: [
        { creditItemHrid: '/items/gold_guild_credit', itemCount: 2, creditCount: 10 },
      ],
    },
    '/items/rock': { name: 'Rock' }, // no conversion at all
    '/items/gold_guild_credit': { name: 'Gold Guild Credit' },
  };
  const drops = [
    { itemHrid: '/items/widget', name: 'Widget', amount: 10, perHour: 5 },
    { itemHrid: '/items/trinket', name: 'Trinket', amount: 4, perHour: 2 },
    { itemHrid: '/items/rock', name: 'Rock', amount: 99, perHour: 50 },
  ];

  const { rows, totals, convertedCount, unconvertedCount } = convertDropsToCredits(drops, items);

  assert.equal(convertedCount, 2);
  assert.equal(unconvertedCount, 1);
  assert.equal(rows.length, 3);

  // Widget: gold wins → 80 per item → 10 * 80 = 800
  assert.equal(rows[0].creditItemHrid, '/items/gold_guild_credit');
  assert.equal(rows[0].creditAmount, 800);
  assert.equal(rows[0].creditPerHour, 400);
  assert.equal(rows[0].conversionOptionCount, 2);

  // Trinket: 10 credits per 2 items = 5 each → 4 * 5 = 20
  assert.equal(rows[1].creditsPerItem, 5);
  assert.equal(rows[1].creditAmount, 20);

  assert.equal(rows[2].convertible, false);

  // Both converted into the same tier, so they aggregate into one total.
  assert.equal(totals.length, 1);
  assert.equal(totals[0].creditItemHrid, '/items/gold_guild_credit');
  assert.equal(totals[0].amount, 820);
  assert.equal(totals[0].perHour, 410);
});

test('a zero or missing itemCount does not produce Infinity', () => {
  const items = {
    '/items/bad': {
      name: 'Bad',
      guildCreditConversions: [
        { creditItemHrid: '/items/gold_guild_credit', itemCount: 0, creditCount: 100 },
      ],
    },
  };
  const { rows, totals, unconvertedCount } = convertDropsToCredits(
    [{ itemHrid: '/items/bad', name: 'Bad', amount: 5, perHour: 1 }],
    items
  );
  assert.equal(rows[0].convertible, false);
  assert.equal(unconvertedCount, 1);
  assert.equal(totals.length, 0);
});

test('empty drops convert to an empty result', () => {
  const { rows, totals } = convertDropsToCredits([], {});
  assert.deepEqual(rows, []);
  assert.deepEqual(totals, []);
});
