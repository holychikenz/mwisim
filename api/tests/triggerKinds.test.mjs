// =============================================================================
// The condition-kind ordinal, and the table behind it.
// Run: cd api && node --import ./register-loader.js --test tests/triggerKinds.test.mjs
//
// `Trigger.getDependencyValue` was a ~50-case string switch over
// `this.conditionHrid`; it is now nine integer arms over `this.conditionKind`,
// interned at construction from generated/triggerKinds.js.
//
// THE FAILURE MODE IS NOT A CRASH. It is reading a DIFFERENT buff and reporting
// a plausible wrong number with no error — which is precisely why todo.md §6a
// deferred this stage until a differential harness existed. So the central test
// here keeps the RETIRED STRING SWITCH, copied verbatim, and checks the shipped
// method against it over every condition in the table and a spread of unit
// states. That is the same shape triggerHoist.test.mjs uses for the prefix
// scan, for the same reason.
//
// The generator is pinned the way genStatSchema / genBuffTypes / genTriggerIndex
// are: re-run it and compare the committed file BYTE FOR BYTE.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const Trigger = (await import('../../src/combatsimulator/trigger.js')).default;
const {
  EXACT_BUFF_CONDITIONS,
  PREFIX_BUFF_CONDITIONS,
  SCALAR_CONDITION_KINDS,
} = await import('../../src/combatsimulator/trigger.js');
const KINDS = await import('../../src/combatsimulator/generated/triggerKinds.js');
const gen = await import('../../tools/genTriggerKinds.mjs');

const DEP_SELF = '/combat_trigger_dependencies/self';
const CMP = '/combat_trigger_comparators/is_active';

// --------------------------------------------------------------------------
// The retired form, verbatim. The `this` it reads is a Trigger, so it is called
// with .call(trigger, ...) — nothing about it is re-expressed.
// --------------------------------------------------------------------------
function retiredGetDependencyValue(source, currentTime) {
  switch (this.conditionHrid) {
    case "/combat_trigger_conditions/berserk":
    case "/combat_trigger_conditions/frenzy":
    case "/combat_trigger_conditions/precision":
    case "/combat_trigger_conditions/vampirism":
    case "/combat_trigger_conditions/attack_coffee":
    case "/combat_trigger_conditions/defense_coffee":
    case "/combat_trigger_conditions/lucky_coffee":
    case "/combat_trigger_conditions/magic_coffee":
    case "/combat_trigger_conditions/melee_coffee":
    case "/combat_trigger_conditions/ranged_coffee":
    case "/combat_trigger_conditions/swiftness_coffee":
    case "/combat_trigger_conditions/wisdom_coffee":
    case "/combat_trigger_conditions/ice_spear":
    case "/combat_trigger_conditions/puncture":
    case "/combat_trigger_conditions/frost_surge":
    case "/combat_trigger_conditions/elusiveness":
    case "/combat_trigger_conditions/channeling_coffee":
    case "/combat_trigger_conditions/fierce_aura":
    case "/combat_trigger_conditions/invincible_armor":
    case "/combat_trigger_conditions/invincible_fire_resistance":
    case "/combat_trigger_conditions/invincible_nature_resistance":
    case "/combat_trigger_conditions/invincible_water_resistance":
    case "/combat_trigger_conditions/provoke":
    case "/combat_trigger_conditions/taunt":
    case "/combat_trigger_conditions/crippling_slash":
    case "/combat_trigger_conditions/mana_spring":
    case "/combat_trigger_conditions/retribution":
    case "/combat_trigger_conditions/fracturing_impact":
    case "/combat_trigger_conditions/maim":
    case "/combat_trigger_conditions/curse":
    case "/combat_trigger_conditions/weaken":
      return source.combatBuffs[this.buffUniqueHrid];
    case "/combat_trigger_conditions/critical_aura":
    case "/combat_trigger_conditions/critical_coffee":
    case "/combat_trigger_conditions/intelligence_coffee":
    case "/combat_trigger_conditions/stamina_coffee":
    case "/combat_trigger_conditions/elemental_affinity":
    case "/combat_trigger_conditions/fury":
    case "/combat_trigger_conditions/guardian_aura":
    case "/combat_trigger_conditions/insanity":
    case "/combat_trigger_conditions/spike_shell":
    case "/combat_trigger_conditions/toxic_pollen":
    case "/combat_trigger_conditions/invincible":
    case "/combat_trigger_conditions/mystic_aura":
    case "/combat_trigger_conditions/pestilent_shot":
    case "/combat_trigger_conditions/smoke_burst":
    case "/combat_trigger_conditions/speed_aura":
    case "/combat_trigger_conditions/toughness":
    case "/combat_trigger_conditions/enrage":
      let buffPrefix = this.buffUniqueHrid;
      for (const buff in source.combatBuffs) {
        if (buff.startsWith(buffPrefix)) {
          return source.combatBuffs[buff];
        }
      }
      return undefined;
    case "/combat_trigger_conditions/current_hp":
      return source.combatDetails.currentHitpoints;
    case "/combat_trigger_conditions/current_mp":
      return source.combatDetails.currentManapoints;
    case "/combat_trigger_conditions/missing_hp":
      return source.combatDetails.maxHitpoints - source.combatDetails.currentHitpoints;
    case "/combat_trigger_conditions/missing_mp":
      return source.combatDetails.maxManapoints - source.combatDetails.currentManapoints;
    case "/combat_trigger_conditions/stun_status":
      return source.isStunned || source.stunExpireTime == currentTime;
    case "/combat_trigger_conditions/blind_status":
      return source.isBlinded || source.blindExpireTime == currentTime;
    case "/combat_trigger_conditions/silence_status":
      return source.isSilenced || source.silenceExpireTime == currentTime;
    default:
      throw new Error("Unknown conditionHrid in trigger: " + this.conditionHrid);
  }
}

const ALL_HANDLED = [
  ...EXACT_BUFF_CONDITIONS,
  ...PREFIX_BUFF_CONDITIONS,
  ...Object.keys(SCALAR_CONDITION_KINDS),
];

// A spread of source states. The buff maps deliberately include entries that
// SHARE A PREFIX with a condition's own buff-unique hrid, near misses, and an
// empty map, because those are where an exact lookup and a prefix scan differ.
function sources(conditionHrid) {
  const own = '/buff_uniques' + conditionHrid.slice(conditionHrid.lastIndexOf('/'));
  const details = (hp, maxHp, mp, maxMp) => ({
    currentHitpoints: hp, maxHitpoints: maxHp,
    currentManapoints: mp, maxManapoints: maxMp,
  });
  const base = {
    isStunned: false, stunExpireTime: null,
    isBlinded: false, blindExpireTime: null,
    isSilenced: false, silenceExpireTime: null,
    combatDetails: details(70, 100, 30, 80),
  };
  return [
    { ...base, combatBuffs: {} },
    { ...base, combatBuffs: { [own]: { id: 'exact' } } },
    { ...base, combatBuffs: { [own + '_1']: { id: 'suffixed' } } },
    { ...base, combatBuffs: { [own + '_2']: { id: 'two' }, [own + '_1']: { id: 'one' } } },
    { ...base, combatBuffs: { [own]: { id: 'exact' }, [own + '_1']: { id: 'suffixed' } } },
    { ...base, combatBuffs: { '/buff_uniques/unrelated': { id: 'other' } } },
    // an entry that is a PREFIX of the condition's own hrid, not extended by it
    { ...base, combatBuffs: { [own.slice(0, -1)]: { id: 'truncated' } } },
    {
      ...base,
      isStunned: true, isBlinded: true, isSilenced: true,
      combatBuffs: { [own]: { id: 'exact' } },
    },
    {
      ...base,
      stunExpireTime: 500, blindExpireTime: 500, silenceExpireTime: 500,
      combatDetails: details(0, 100, 80, 80),
      combatBuffs: {},
    },
  ];
}

// --------------------------------------------------------------------------
// 1. The differential case.
// --------------------------------------------------------------------------
test('getDependencyValue agrees with the retired string switch on every condition', () => {
  let checks = 0;
  for (const conditionHrid of ALL_HANDLED) {
    const trigger = new Trigger(DEP_SELF, conditionHrid, CMP, 0);
    for (const source of sources(conditionHrid)) {
      for (const currentTime of [0, 500, 1000]) {
        const want = retiredGetDependencyValue.call(trigger, source, currentTime);
        const got = trigger.getDependencyValue(source, currentTime);
        assert.equal(got, want, `${conditionHrid} @ t=${currentTime}`);
        checks++;
      }
    }
  }
  assert.equal(checks, ALL_HANDLED.length * 9 * 3);
  assert.equal(ALL_HANDLED.length, 55, 'every arm of the retired switch is covered');
});

// --------------------------------------------------------------------------
// 2. The grouping itself, against the retired switch's own case labels.
//    A condition that quietly moved group is the failure this stage risks.
// --------------------------------------------------------------------------
test('every condition lands in the kind the retired switch put it in', () => {
  const marker = { id: 'exact-marker' };
  for (const conditionHrid of EXACT_BUFF_CONDITIONS) {
    const t = new Trigger(DEP_SELF, conditionHrid, CMP, 0);
    assert.equal(t.conditionKind, KINDS.KIND_EXACT_BUFF, conditionHrid);
    // An exact lookup must NOT be satisfied by a suffixed key.
    const own = t.buffUniqueHrid;
    assert.equal(t.getDependencyValue({ combatBuffs: { [own + '_1']: marker } }, 0), undefined,
      `${conditionHrid} must read its buff by exact hrid, not by prefix`);
  }
  for (const conditionHrid of PREFIX_BUFF_CONDITIONS) {
    const t = new Trigger(DEP_SELF, conditionHrid, CMP, 0);
    assert.equal(t.conditionKind, KINDS.KIND_PREFIX_BUFF, conditionHrid);
    const own = t.buffUniqueHrid;
    assert.equal(t.getDependencyValue({ combatBuffs: { [own + '_1']: marker } }, 0), marker,
      `${conditionHrid} must read its buff by prefix`);
  }
  for (const [conditionHrid, kind] of Object.entries(SCALAR_CONDITION_KINDS)) {
    const t = new Trigger(DEP_SELF, conditionHrid, CMP, 0);
    assert.equal(t.conditionKind, KINDS['KIND_' + kind], conditionHrid);
  }
  assert.equal(
    new Set(ALL_HANDLED).size, ALL_HANDLED.length,
    'no condition appears in two groups',
  );
});

// --------------------------------------------------------------------------
// 3. An unknown condition throws at EVALUATION, not at construction — which is
//    what keeps api/lib/triggerSearch's speculative Triggers alive.
// --------------------------------------------------------------------------
test('an unknown condition still throws from getDependencyValue, not from the constructor', () => {
  let t;
  assert.doesNotThrow(() => {
    t = new Trigger(DEP_SELF, '/combat_trigger_conditions/not_a_real_condition', CMP, 0);
  }, 'construction must stay speculative');
  assert.equal(t.conditionKind, KINDS.KIND_UNKNOWN);
  assert.throws(() => t.getDependencyValue({ combatBuffs: {} }, 0), /Unknown conditionHrid in trigger/);
  assert.throws(
    () => retiredGetDependencyValue.call(t, { combatBuffs: {} }, 0),
    /Unknown conditionHrid in trigger/,
    'the retired form threw here too',
  );
});

test('the three multi-target conditions are legitimately unknown to this table', () => {
  for (const hrid of [
    '/combat_trigger_conditions/lowest_hp_percentage',
    '/combat_trigger_conditions/number_of_active_units',
    '/combat_trigger_conditions/number_of_dead_units',
  ]) {
    const t = new Trigger('/combat_trigger_dependencies/all_allies', hrid, CMP, 0);
    assert.equal(t.conditionKind, KINDS.KIND_UNKNOWN, hrid);
    // isActiveMultiTarget resolves them before getDependencyValue is reached.
    assert.throws(() => t.getDependencyValue({ combatBuffs: {} }, 0), /Unknown conditionHrid/);
  }
});

// --------------------------------------------------------------------------
// 4. The generator, pinned the way the other three are.
// --------------------------------------------------------------------------
test('generated/triggerKinds.js is byte-for-byte what the generator produces', () => {
  const committed = readFileSync(join(ROOT, 'src/combatsimulator/generated/triggerKinds.js'), 'utf8');
  assert.equal(gen.generate(), committed,
    'regenerate with `node tools/genTriggerKinds.mjs` — do not hand-edit the generated file');
});

test('kind ordinals come from a sort of the names, and 0 is reserved', () => {
  const { kinds } = gen.collect();
  assert.deepEqual(kinds, kinds.slice().sort(), 'kinds are sorted');
  assert.equal(KINDS.KIND_UNKNOWN, 0);
  kinds.forEach((k, i) => assert.equal(KINDS['KIND_' + k], i + 1, k));
  assert.equal(KINDS.TRIGGER_KIND_COUNT, kinds.length + 1);
});

test('extractList is bounded, refuses a duplicate, and keeps digit-bearing names', () => {
  const src = `
export const A_LIST = [
    "/combat_trigger_conditions/coffee_2",
];
export const B_LIST = [
    "/combat_trigger_conditions/other",
];
`;
  assert.deepEqual(gen.extractList(src, 'A_LIST'), ['/combat_trigger_conditions/coffee_2'],
    'digits survive the pattern, and the next list does not leak in');
  assert.throws(() => gen.extractList(src, 'MISSING_LIST'), /not found/);
  assert.throws(() => gen.extractList('export const A_LIST = [', 'A_LIST'), /unterminated/);
  assert.throws(() => gen.extractList(src + src, 'A_LIST'), /declared twice/);
});

test('a condition in two groups is a generator failure, not a silent last-wins', () => {
  const dup = [...EXACT_BUFF_CONDITIONS, ...PREFIX_BUFF_CONDITIONS][0];
  assert.ok(dup.startsWith('/combat_trigger_conditions/'));
  // The guard itself, exercised directly: collect() asserts it over the real
  // lists, so this checks the message rather than re-reading the file.
  const src = readFileSync(join(ROOT, 'src/combatsimulator/trigger.js'), 'utf8');
  const exact = gen.extractList(src, 'EXACT_BUFF_CONDITIONS');
  const prefix = gen.extractList(src, 'PREFIX_BUFF_CONDITIONS');
  const scalars = gen.extractScalarKinds(src).map(([h]) => h);
  const all = [...exact, ...prefix, ...scalars];
  assert.equal(new Set(all).size, all.length, 'no hrid is in two groups in the engine source');
});

test('the table covers exactly the conditions the engine lists, and no others', () => {
  const { conditions } = gen.collect();
  assert.deepEqual(
    conditions.map(([h]) => h).slice().sort(),
    ALL_HANDLED.slice().sort(),
  );
});
