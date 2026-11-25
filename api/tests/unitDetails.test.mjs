// =============================================================================
// unitDetails parity: the wasm twin's player_details / monster_details against
// JS Player / Monster, bit for bit (assert.deepStrictEqual compares numbers with
// Object.is), on every fixture build, with and without buffs, and on every
// monster at tiers 0-5 and at labyrinth room levels. The JS engine is the oracle
// while it exists; skipped when rust/pkg is not built.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const skip = !existsSync(fileURLToPath(new URL('rust/pkg/csim_twin_bg.wasm', ROOT))) && 'wasm engine not built';

const { playerDetails, monsterDetails, checkPlayerDto } = await import('../lib/unitDetails.js');
const Player = (await import('../../src/combatsimulator/player.js')).default;
const Monster = (await import('../../src/combatsimulator/monster.js')).default;
const dp = await import('../../shared/dataProvider.js');
const { buildCrateBuffs, knownCrates } = await import('../lib/target.js');
const { buildLabUpgradeBuffs } = await import('../../shared/labUpgrades.js');
const { buildCommunityBuffs } = await import('../../shared/communityBuffs.js');
const { SEAL_OPTIONS, resolveSealBuffs } = await import('../../shared/personalBuffs.js');
const { GUILD_COMBAT_BUFFS, MAX_GUILD_BUFF_LEVEL, resolveGuildBuffs } = await import('../../ui/src/utils/guildBuffs.js');
const { BUILDS, CASES, LAB_CASES, TRIAL_CASES, partyBuilds } = await import('../eval/cases.mjs');
const { toCsimPlayer } = await import('../bench/builds.mjs');

const LEVELS = ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'].map((k) => `${k}Level`);
const pick = (u) => ({ ...Object.fromEntries(LEVELS.map((k) => [k, u[k]])), combatDetails: u.combatDetails });

// bounds.js's composition: zoneBuffs, then partyBuffs + the DTO's own extraBuffs.
function jsPlayer(dto, zoneBuffs, partyBuffs) {
  const p = Player.createFromDTO(structuredClone(dto));
  p.zoneBuffs = zoneBuffs;
  p.extraBuffs = partyBuffs.concat(dto.extraBuffs || []);
  p.generatePermanentBuffs();
  p.reset();
  return pick(p);
}

// ---- the builds ------------------------------------------------------------
const dtos = [];
for (const f of readdirSync(new URL('fixtures/sim/', ROOT)).filter((f) => f.endsWith('.json'))) {
  dtos.push(...JSON.parse(readFileSync(new URL(`fixtures/sim/${f}`, ROOT), 'utf8')).request.players);
}
const evalBuilds = new Set();
for (const k of [...CASES, ...TRIAL_CASES]) for (const name of partyBuilds(k)) evalBuilds.add(`${name}|${k.level}`);
for (const k of LAB_CASES) evalBuilds.add(`${k.build}|${k.level}`);
for (const name of Object.keys(BUILDS)) evalBuilds.add(`${name}|100`);
for (const key of evalBuilds) {
  const [name, level] = key.split('|');
  dtos.push(toCsimPlayer(BUILDS[name], { level: Number(level), index: 1, items: dp.itemDetailMap, abilityData: dp.abilityDetailMap }));
}
const labFixtures = readdirSync(new URL('fixtures/lab/', ROOT))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(`fixtures/lab/${f}`, ROOT), 'utf8')))
  .filter((fx) => fx.player?.dto);
for (const fx of labFixtures) dtos.push(fx.player.dto);

// Every house room at 8, every achievement, and per-player shrines + seals on the DTO.
const loaded = (dto) => ({
  ...dto,
  houseRooms: Object.fromEntries(Object.keys(dp.houseRoomDetailMap).map((h) => [h, 8])),
  achievements: Object.fromEntries(Object.keys(dp.achievementDetailMap).map((h) => [h, true])),
  extraBuffs: resolveGuildBuffs(Object.fromEntries(GUILD_COMBAT_BUFFS.map((b) => [b.hrid, MAX_GUILD_BUFF_LEVEL])))
    .concat(resolveSealBuffs(SEAL_OPTIONS.map((o) => o.value))),
});
const zoneWithBuffs = Object.values(dp.actionDetailMap).find((a) => a.combatZoneInfo && a.buffs?.length);
const VARIANTS = [
  ['bare', (d) => d, [], []],
  ['zone buffs', (d) => d, zoneWithBuffs.buffs, []],
  ['all crates + lab upgrades', (d) => d, buildCrateBuffs(knownCrates()), buildLabUpgradeBuffs({ combatDamage: 20, attackSpeed: 20, castSpeed: 20, criticalRate: 20 })],
  ['houses, achievements, shrines, seals, community', loaded, zoneWithBuffs.buffs, buildCommunityBuffs({ mooPass: true, comExp: 20, comDrop: 20 })],
];

test('player_details equals JS Player on every fixture build, with and without buffs', { skip }, () => {
  let n = 0;
  for (const [label, shape, zoneBuffs, partyBuffs] of VARIANTS) {
    const shaped = dtos.map(shape);
    const twin = playerDetails(shaped, { zoneBuffs, partyBuffs });
    shaped.forEach((dto, i) => {
      assert.equal(twin[i].ok, true, `${label} ${dto.hrid}: ${twin[i].error}`);
      assert.deepStrictEqual(pick(twin[i]), jsPlayer(dto, zoneBuffs, partyBuffs), `${label} ${dto.hrid}`);
      n++;
    });
  }
  assert.ok(n >= 4 * 20, `only ${n} player cases`);
});

test('player_details equals labStats on the lab fixtures (crates as zoneBuffs, upgrades as party, no DTO extraBuffs)', { skip }, () => {
  for (const fx of labFixtures) {
    const zoneBuffs = buildCrateBuffs(fx.player.crates || []);
    const partyBuffs = buildLabUpgradeBuffs(fx.player.labUpgrades || {});
    const dto = { ...fx.player.dto, extraBuffs: undefined };
    const [twin] = playerDetails([dto], { zoneBuffs, partyBuffs });
    assert.deepStrictEqual(pick(twin), jsPlayer(dto, zoneBuffs, partyBuffs), fx.label);
  }
});

test('monster_details equals JS Monster at every tier and at labyrinth room levels', { skip }, () => {
  const list = [];
  for (const hrid of Object.keys(dp.combatMonsterDetailMap)) {
    for (let t = 0; t <= 5; t++) list.push({ hrid, difficultyTier: t, roomLevel: 0 });
    for (const roomLevel of [20, 60, 100, 150, 250, 400]) list.push({ hrid, difficultyTier: 0, roomLevel });
  }
  const twin = monsterDetails(list);
  list.forEach(({ hrid, difficultyTier, roomLevel }, i) => {
    const m = new Monster(hrid, difficultyTier, roomLevel);
    m.updateCombatDetails();
    const js = { ...pick(m), abilities: m.abilities.filter(Boolean).map((a) => ({ hrid: a.hrid, level: a.level })) };
    assert.deepStrictEqual({ ...pick(twin[i]), abilities: twin[i].abilities }, js, `${hrid} T${difficultyTier} R${roomLevel}`);
  });
  assert.ok(list.length > 1000);
});

test('bad input: an unknown monster and a malformed DTO are per-entry errors, as JS throws', { skip }, () => {
  const [m] = monsterDetails([{ hrid: '/monsters/nope' }]);
  assert.equal(m.ok, false);
  assert.throws(() => new Monster('/monsters/nope'));
  const bad = { ...dtos[0], equipment: { '/equipment_types/main_hand': { hrid: '/items/nope', enhancementLevel: 0 } } };
  assert.throws(() => Player.createFromDTO(structuredClone(bad)));
  assert.equal(checkPlayerDto(bad).ok, false);
  assert.deepStrictEqual(checkPlayerDto(dtos[0]), { ok: true });
  assert.equal(checkPlayerDto({ hrid: 'x' }).ok, false);
  assert.throws(() => playerDetails([dtos[0]], { zoneBuffs: [{ typeHrid: '/buff_types/nope' }] }));
});
