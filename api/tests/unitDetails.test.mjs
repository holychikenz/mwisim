// =============================================================================
// unitDetails smoke test: the wasm twin's player_details / monster_details
// answer ok on every fixture build (with and without buffs) and every monster at
// tiers 0-5 and labyrinth room levels, and refuse what the JS engine refused.
// They were checked bit for bit against JS Player / Monster before JS was
// deleted; lab:check (fixtures/lab) still pins their numbers. Skipped when
// rust/pkg is not built.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const skip = !existsSync(fileURLToPath(new URL('rust/pkg/csim_twin_bg.wasm', ROOT))) && 'wasm engine not built';

const { playerDetails, monsterDetails, checkPlayerDto } = await import('../lib/unitDetails.js');
const dp = await import('../../shared/dataProvider.js');
const { buildCrateBuffs, knownCrates } = await import('../lib/target.js');
const { buildLabUpgradeBuffs } = await import('../../shared/labUpgrades.js');
const { buildCommunityBuffs } = await import('../../shared/communityBuffs.js');
const { SEAL_OPTIONS, resolveSealBuffs } = await import('../../shared/personalBuffs.js');
const { GUILD_COMBAT_BUFFS, MAX_GUILD_BUFF_LEVEL, resolveGuildBuffs } = await import('../../ui/src/utils/guildBuffs.js');
const { BUILDS, CASES, LAB_CASES, TRIAL_CASES, partyBuilds } = await import('../eval/cases.mjs');
const { toCsimPlayer } = await import('../bench/builds.mjs');

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

test('player_details answers ok on every fixture build, with and without buffs', { skip }, () => {
  let n = 0;
  for (const [label, shape, zoneBuffs, partyBuffs] of VARIANTS) {
    const shaped = dtos.map(shape);
    const twin = playerDetails(shaped, { zoneBuffs, partyBuffs });
    shaped.forEach((dto, i) => {
      assert.equal(twin[i].ok, true, `${label} ${dto.hrid}: ${twin[i].error}`);
      assert.ok(twin[i].combatDetails.maxHitpoints > 0, `${label} ${dto.hrid}`);
      n++;
    });
  }
  assert.ok(n >= 4 * 20, `only ${n} player cases`);
  for (const d of playerDetails(dtos, { bare: true })) assert.equal(d.ok, true, d.error);
});

test('monster_details answers ok at every tier and at labyrinth room levels', { skip }, () => {
  const list = [];
  for (const hrid of Object.keys(dp.combatMonsterDetailMap)) {
    for (let t = 0; t <= 5; t++) list.push({ hrid, difficultyTier: t, roomLevel: 0 });
    for (const roomLevel of [20, 60, 100, 150, 250, 400]) list.push({ hrid, difficultyTier: 0, roomLevel });
  }
  const twin = monsterDetails(list);
  twin.forEach((m, i) => assert.equal(m.ok, true, `${list[i].hrid}: ${m.error}`));
  assert.ok(list.length > 1000);
});

test('bad input: an unknown monster and a malformed DTO are per-entry errors; an unknown buff type throws', { skip }, () => {
  const [m] = monsterDetails([{ hrid: '/monsters/nope' }]);
  assert.equal(m.ok, false);
  const bad = { ...dtos[0], equipment: { '/equipment_types/main_hand': { hrid: '/items/nope', enhancementLevel: 0 } } };
  assert.equal(checkPlayerDto(bad).ok, false);
  assert.deepStrictEqual(checkPlayerDto(dtos[0]), { ok: true });
  assert.equal(checkPlayerDto({ hrid: 'x' }).ok, false);
  assert.throws(() => playerDetails([dtos[0]], { zoneBuffs: [{ typeHrid: '/buff_types/nope' }] }));
});

test('checkPlayerDto refuses exactly what Player.createFromDTO threw on (recorded on the JS engine)', { skip }, () => {
  const base = dtos.find((d) => Object.keys(d.equipment).length);
  const without = (k) => Object.fromEntries(Object.entries(base).filter(([kk]) => kk !== k));
  const cases = [
    ['good', base, true],
    ['empty', {}, false],
    ['null', null, false],
    ['numericHrid', { ...base, hrid: 7 }, true],
    ['unknownItem', { ...base, equipment: { ...base.equipment, '/equipment_types/head': { hrid: '/items/nope', enhancementLevel: 0 } } }, false],
    ['unknownAbility', { ...base, intelligenceLevel: 200, abilities: [{ hrid: '/abilities/nope', level: 1, triggers: [] }] }, false],
    ['unknownFood', { ...base, food: [{ hrid: '/items/nope', triggers: [] }] }, false],
    ['unknownHouse', { ...base, houseRooms: { '/house_rooms/nope': 1 } }, false],
    ...['equipment', 'food', 'drinks', 'abilities', 'houseRooms', 'achievements'].map((k) => [`no ${k}`, without(k), false]),
    ...['hrid', 'staminaLevel'].map((k) => [`no ${k}`, without(k), true]),
  ];
  for (const [label, dto, jsOk] of cases) assert.equal(checkPlayerDto(dto).ok, jsOk, label);
});

test('a wasm trap fails that call only; the next one runs on a fresh instance', { skip }, async () => {
  const { wasmTestHooks } = await import('../lib/twin/wasm.mjs');
  const loads = wasmTestHooks.loads;
  wasmTestHooks.trapNextRun = true;
  assert.throws(() => monsterDetails([{ hrid: '/monsters/fly' }]), WebAssembly.RuntimeError);
  // Before the reload lands (it is async; this is not), a call fails cleanly instead of using the trapped instance.
  assert.throws(() => monsterDetails([{ hrid: '/monsters/fly' }]), /reloading after a crash/);
  for (let i = 0; i < 200 && wasmTestHooks.loads === loads; i++) await new Promise((r) => setTimeout(r, 10)); // the background re-instantiation
  assert.equal(wasmTestHooks.loads, loads + 1);
  assert.equal(monsterDetails([{ hrid: '/monsters/fly' }])[0].ok, true);
});
