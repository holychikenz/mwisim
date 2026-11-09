// Roboburble's tools (ui/src/assistant): validation at the trust boundary, name
// resolution, the ten tools against the app's real game data, and undo.
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildGameData, getFood, getDrinks, getAuras, getCombatAbilities } = await import('../../ui/src/hooks/useGameData.js');
const store = await import('../../ui/src/utils/characterStore.js');
const { DEFAULT_TRIAL_CONFIG } = await import('../../ui/src/utils/roster.js');
const { validateArgs } = await import('../../ui/src/assistant/schema.js');
const { SLOTS, catalog, resolveName } = await import('../../ui/src/assistant/catalog.js');
const { editPlayer, undoPatch, describeNow } = await import('../../ui/src/assistant/state.js');
const { REGISTRY, toolSpecs, executeTool } = await import('../../ui/src/assistant/tools.js');

const gameData = buildGameData();
const ctx = { gameData };
const I = (h) => `/items/${h}`;
const A = (h) => `/abilities/${h}`;
const E = (s) => `/equipment_types/${s}`;
const gear = (h, n) => ({ itemHrid: I(h), enhancementLevel: n });

function makeStore() {
  let s = store.emptyStore();
  const ada = {
    ...store.createCharacter({ name: 'Ada', id: 'ada' }),
    staminaLevel: 90, intelligenceLevel: 80, attackLevel: 95, meleeLevel: 92, defenseLevel: 85, rangedLevel: 1, magicLevel: 1,
    abilityLevels: { [A('cleave')]: 12, [A('fierce_aura')]: 5 },
    loadouts: {
      tank: {
        equipment: {
          [E('head')]: gear('crimson_helmet', 20),
          [E('body')]: gear('griffin_tunic', 7),
          [E('legs')]: gear('griffin_chaps', 0),
          [E('back')]: gear('chimerical_quiver', 19),
          [E('main_hand')]: gear('cheese_sword', 3),
          [E('off_hand')]: gear('cheese_buckler', 5),
          [E('feet')]: null,
        },
        food: [{ itemHrid: I('donut'), triggers: [{ t: 'keep' }] }, null, null],
        drinks: [{ itemHrid: I('stamina_coffee'), triggers: [] }, null, null],
        abilities: [{ hrid: A('fierce_aura'), triggers: [] }, { hrid: A('cleave'), triggers: [] }, null, null, null],
        triggerMemory: {},
      },
      dps: { equipment: { [E('head')]: gear('crimson_helmet', 10) } },
    },
  };
  const bea = { ...store.createCharacter({ name: 'Bea', id: 'bea' }), loadouts: { mage: {} } };
  s = store.upsertCharacter(s, ada);
  s = store.upsertCharacter(s, bea);
  return s;
}

const LAB = {
  monsterHrid: '/monsters/cyclops', roomLevel: 100,
  crates: { tea: I('expert_tea_crate'), coffee: I('expert_coffee_crate'), food: I('expert_food_crate') },
  upgrades: { combatDamage: 0, attackSpeed: 0, castSpeed: 0, criticalRate: 0 },
};

function makeState(over = {}) {
  return {
    gameData, characters: makeStore(),
    party: { 1: { characterId: 'ada', loadoutName: 'tank' }, 2: { characterId: 'bea', loadoutName: 'mage' }, 3: null, 4: null, 5: null },
    activeTab: 1, selectedPlayers: [1, 2], roster: [], selectedEntryId: null,
    simMode: 'zone', optTarget: 'zone', zone: '/actions/combat/smelly_planet', difficultyTier: 0, duration: 24,
    labConfig: LAB, trialConfig: { ...DEFAULT_TRIAL_CONFIG },
    results: null, loading: false, progress: 0, error: null, runDisabled: false,
    ...over,
  };
}
const trialState = (over = {}) => makeState({
  simMode: 'guildTrial', roster: [{ id: 'r1', characterId: 'ada', loadoutName: 'tank', count: 2 }], selectedEntryId: 'r1', ...over,
});

let seq = 0;
const run = (state, name, args) => executeTool({ id: `t${seq++}`, name, args }, state, ctx);
const commit = (state, out) => ({ ...state, ...out.next });
const player = (state, characterId, loadoutName) => store.resolveRef(state.characters, { characterId, loadoutName });
const eqOf = (state, slot, cid = 'ada', lo = 'tank') => player(state, cid, lo).equipment[E(slot)];

test('1: catalog matches useGameData filters; 14 slots', () => {
  const c = catalog(gameData);
  assert.equal(c.food.length, getFood(gameData.items).length);
  assert.equal(c.drinks.length, getDrinks(gameData.items).length);
  assert.equal(c.auras.length, getAuras(gameData.abilities).length);
  assert.equal(c.abilities.length, getCombatAbilities(gameData.abilities).length);
  assert.equal(SLOTS.length, 14);
  assert.equal(catalog(gameData), c, 'cached per gameData');
});

test('2: resolveName — hrid, exact, case, unique words, ambiguous, unknown', () => {
  const c = catalog(gameData);
  assert.equal(resolveName(c.gear, I('cheese_sword'), 'item').item.name, 'Cheese Sword');
  assert.equal(resolveName(c.gear, 'Cheese Sword', 'item').item.hrid, I('cheese_sword'));
  assert.equal(resolveName(c.gear, 'cHEESE sWORD', 'item').item.hrid, I('cheese_sword'));
  assert.equal(resolveName(c.trials, 'badger', 'zone').item.name, 'Trial Badger');
  const amb = resolveName(c.gear, 'cheese', 'item');
  assert.ok(amb.error);
  const listed = amb.error.split(':')[1].split(',').filter(s => /\w/.test(s) && !/more/.test(s));
  assert.ok(listed.length <= 5, amb.error);
  const unk = resolveName(c.gear, 'cheese swrod', 'item');
  assert.match(unk.error, /Unknown item 'cheese swrod'\. Close: /);
});

test('3: every enhance +1 — caps at 20, skips empty, touches only that loadout', () => {
  const s = makeState();
  const out = run(s, 'adjust_enhancement', { delta: 1 });
  assert.ok(!out.isError, out.content);
  const n = commit(s, out);
  assert.equal(eqOf(n, 'body').enhancementLevel, 8);
  assert.equal(eqOf(n, 'legs').enhancementLevel, 1);
  assert.equal(eqOf(n, 'back').enhancementLevel, 20);
  assert.equal(eqOf(n, 'main_hand').enhancementLevel, 4);
  assert.equal(eqOf(n, 'off_hand').enhancementLevel, 6);
  assert.equal(eqOf(n, 'head').enhancementLevel, 20);
  assert.equal(eqOf(n, 'feet'), null);
  assert.match(out.content, /5 item/);
  // upsertCharacter re-sanitises every loadout, so dps is equal in value, not by reference.
  assert.deepEqual(n.characters.characters.ada.loadouts.dps, s.characters.characters.ada.loadouts.dps);
  assert.equal(n.characters.characters.bea, s.characters.characters.bea);
});

test('4: value clamps to 0..20', () => {
  const s = makeState();
  const hi = commit(s, run(s, 'adjust_enhancement', { value: 25 }));
  assert.equal(eqOf(hi, 'legs').enhancementLevel, 20);
  const lo = commit(s, run(s, 'adjust_enhancement', { value: -3 }));
  assert.equal(eqOf(lo, 'head').enhancementLevel, 0);
});

test('5: named slots only; unknown slot invalid; named empty slot reported', () => {
  const s = makeState();
  const out = run(s, 'adjust_enhancement', { delta: 2, slots: ['Main Hand', 'body'] });
  const n = commit(s, out);
  assert.equal(eqOf(n, 'main_hand').enhancementLevel, 5);
  assert.equal(eqOf(n, 'body').enhancementLevel, 9);
  assert.equal(eqOf(n, 'legs').enhancementLevel, 0);
  assert.ok(run(s, 'adjust_enhancement', { delta: 1, slots: ['tail'] }).isError);
  const feet = run(s, 'adjust_enhancement', { delta: 1, slots: ['feet', 'head'] });
  assert.match(feet.content, /feet/);
});

test('6: player targeting', () => {
  const s = makeState();
  for (const p of [2, 'bea']) {
    const out = run(s, 'set_skill_level', { skill: 'attack', level: 50, player: p });
    assert.ok(!out.isError, out.content);
    assert.equal(commit(s, out).characters.characters.bea.attackLevel, 50);
  }
  assert.equal(run(s, 'adjust_enhancement', { delta: 1, player: 4 }).content, 'P4 is empty.');
  assert.ok(run(s, 'adjust_enhancement', { delta: 1, value: 3 }).isError);
  assert.ok(run(s, 'adjust_enhancement', {}).isError);
});

test('7: set_equipment — infer slot, two-hand exclusivity, keep +N, clamp', () => {
  let s = makeState();
  let out = run(s, 'set_equipment', { item: 'Cursed Bow' });
  assert.ok(!out.isError, out.content);
  s = commit(s, out);
  assert.equal(eqOf(s, 'two_hand').itemHrid, I('cursed_bow'));
  assert.equal(eqOf(s, 'main_hand'), null);
  assert.equal(eqOf(s, 'off_hand'), null);
  s = commit(s, run(s, 'set_equipment', { item: 'Cheese Sword' }));
  assert.equal(eqOf(s, 'main_hand').itemHrid, I('cheese_sword'));
  assert.equal(eqOf(s, 'two_hand'), null);
  s = commit(s, run(s, 'set_equipment', { item: 'Azure Helmet' }));
  assert.deepEqual(eqOf(s, 'head'), gear('azure_helmet', 20));
  s = commit(s, run(s, 'set_equipment', { item: 'Griffin Tunic', enhancement: 30 }));
  assert.equal(eqOf(s, 'body').enhancementLevel, 20);
});

test('8: set_equipment rejections and unequip', () => {
  const s = makeState();
  assert.match(run(s, 'set_equipment', { item: 'Griffin Tunic', slot: 'head' }).content, /body gear, not head/);
  assert.match(run(s, 'set_equipment', { item: 'Rainbow Brush' }).content, /not combat gear/);
  const amb = run(s, 'set_equipment', { item: 'azure' }).content;
  assert.match(amb, /Several items match 'azure': Azure Boots/);
  assert.doesNotMatch(amb, /Alembic|Brush/, 'only combat gear is offered');
  assert.match(run(s, 'set_equipment', { item: 'Griffin Tunik' }).content, /Close: /);
  assert.ok(run(s, 'set_equipment', { item: null }).isError);
  const n = commit(s, run(s, 'set_equipment', { slot: 'head', item: null }));
  assert.equal(eqOf(n, 'head'), null);
});

test('9: set_skill_level clamps 1..200, all, character-wide', () => {
  const s = makeState();
  let n = commit(s, run(s, 'set_skill_level', { skill: 'attack', level: 250 }));
  assert.equal(player(n, 'ada', 'dps').attackLevel, 200);
  n = commit(s, run(s, 'set_skill_level', { skill: 'magic', delta: -500 }));
  assert.equal(player(n, 'ada', 'tank').magicLevel, 1);
  n = commit(s, run(s, 'set_skill_level', { skill: 'all', level: 100 }));
  for (const k of ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic']) {
    assert.equal(player(n, 'ada', 'dps')[`${k}Level`], 100);
  }
});

test('10: set_zone on a planet', () => {
  const s = makeState();
  const n = commit(s, run(s, 'set_zone', { zone: 'Bear With It', tier: 3, hours: 12 }));
  assert.equal(n.zone, '/actions/combat/bear_with_it');
  assert.equal(n.difficultyTier, 3);
  assert.equal(n.duration, 12);
  assert.equal(commit(s, run(s, 'set_zone', { zone: 'Bear With It', tier: 9 })).difficultyTier, 5);
  assert.match(run(s, 'set_zone', { zone: 'Bear Kingdom' }).content, /Close: .*Bear With It/);
});

test('11: set_zone on a dungeon clamps tier and does not write hours', () => {
  const s = makeState();
  const out = run(s, 'set_zone', { zone: 'Chimerical Den', tier: 3, hours: 12 });
  const n = commit(s, out);
  assert.equal(n.difficultyTier, 2);
  assert.equal(n.duration, 24);
  assert.match(out.content, /dungeon/i);
});

test('12: set_zone for the labyrinth and a trial', () => {
  const s = makeState();
  const lab = commit(s, run(s, 'set_zone', { zone: 'Cyclops', level: 900 }));
  assert.equal(lab.simMode, 'labyrinth');
  assert.equal(lab.labConfig.roomLevel, 500);
  assert.equal(lab.labConfig.crates, LAB.crates);
  const trial = commit(s, run(s, 'set_zone', { zone: 'Trial Swarm', tier: 25 }));
  assert.equal(trial.simMode, 'guildTrial');
  assert.equal(trial.trialConfig.trialHrid, '/guild_combat/swarm');
  assert.equal(trial.trialConfig.startTier, 300);
});

test('13: set_zone navigation follows the header rule', () => {
  const gearZone = makeState({ simMode: 'equipOpt', optTarget: 'zone' });
  const n = commit(gearZone, run(gearZone, 'set_zone', { zone: 'Cyclops' }));
  assert.equal(n.simMode, 'equipOpt');
  assert.equal(n.optTarget, 'labyrinth');
  const t = commit(gearZone, run(gearZone, 'set_zone', { zone: 'Trial Badger' }));
  assert.equal(t.simMode, 'guildTrial');
  const costs = makeState({ simMode: 'itemCosts' });
  assert.ok(run(costs, 'set_zone', { tier: 2 }).isError);
});

test('14: set_consumables', () => {
  const s = makeState();
  const n = commit(s, run(s, 'set_consumables', { food: ['Gummy', 'Donut'], drinks: [] }));
  const p = player(n, 'ada', 'tank');
  assert.equal(p.food[0].itemHrid, I('gummy'));
  assert.deepEqual(p.food[0].triggers, [{ t: 'keep' }]);
  assert.equal(p.food[1].itemHrid, I('donut'));
  assert.equal(p.food[2], null);
  assert.deepEqual(p.drinks, [null, null, null]);
  assert.ok(run(s, 'set_consumables', { food: ['Donut', 'Donut'] }).isError);
  assert.match(run(s, 'set_consumables', { food: ['Stamina Coffee'] }).content, /drink/i);
  assert.ok(run(s, 'set_consumables', { food: ['Donut', 'Gummy', 'Cupcake', 'Yogurt'] }).isError);
  assert.ok(run(s, 'set_consumables', {}).isError);
  assert.match(run(trialState(), 'set_consumables', { food: ['Donut'] }).content, /[Tt]rial/);
  assert.match(run(makeState({ simMode: 'labyrinth' }), 'set_consumables', { food: ['Donut'] }).content, /stripped/);
});

test('15: set_abilities keeps remembered levels, defaults triggers', () => {
  const s = makeState();
  const out = run(s, 'set_abilities', { aura: 'Fierce Aura', abilities: ['Cleave', 'Puncture'] });
  assert.ok(!out.isError, out.content);
  const p = player(commit(s, out), 'ada', 'tank');
  assert.equal(p.abilities[0].hrid, A('fierce_aura'));
  assert.equal(p.abilities[1].hrid, A('cleave'));
  assert.equal(p.abilities[1].level, 12);
  assert.equal(p.abilities[2].hrid, A('puncture'));
  assert.deepEqual(p.abilities[2].triggers, gameData.abilities[A('puncture')].defaultCombatTriggers);
  assert.equal(p.abilities[3], null);
  assert.ok(run(s, 'set_abilities', { aura: 'Cleave' }).isError);
  assert.ok(run(s, 'set_abilities', { abilities: ['Fierce Aura'] }).isError);
  assert.ok(run(s, 'set_abilities', { abilities: ['Cleave', 'Cleave'] }).isError);
});

test('16: navigate', () => {
  const s = makeState();
  let n = commit(s, run(s, 'navigate', { target: 'lab', tool: 'gear' }));
  assert.equal(n.simMode, 'equipOpt');
  assert.equal(n.optTarget, 'labyrinth');
  const out = run(s, 'navigate', { target: 'trial', tool: 'gear' });
  assert.equal(commit(s, out).simMode, 'guildTrial');
  assert.match(out.content, /Simulate only/);
  assert.equal(commit(s, run(s, 'navigate', { tool: 'costs' })).simMode, 'itemCosts');
  assert.ok(run(s, 'navigate', { target: 'moon' }).isError);
});

test('17: run_simulation', () => {
  assert.equal(run(makeState(), 'run_simulation', {}).action, 'run');
  for (const s of [
    makeState({ loading: true }),
    makeState({ runDisabled: true }),
    makeState({ simMode: 'itemCosts' }),
    makeState({ selectedPlayers: [3] }),
    trialState({ roster: [] }),
  ]) {
    const out = run(s, 'run_simulation', {});
    assert.ok(out.isError && !out.action, out.content);
  }
  assert.equal(run(trialState(), 'run_simulation', {}).action, 'run');
});

test('18: get_state and describeNow use names and stay small', () => {
  const s = makeState();
  const text = run(s, 'get_state', {}).content;
  assert.ok(!text.includes('/items/') && !text.includes('/abilities/'), text);
  assert.match(text, /Crimson Helmet \+20/);
  assert.match(describeNow(s), /Smelly Planet T0/);
  // Five fully equipped members.
  let big = s.characters;
  const full = Object.fromEntries(SLOTS.map(sl => [E(sl), gear('chimerical_quiver', 20)]));
  const party = {};
  for (let i = 1; i <= 5; i++) {
    big = store.upsertCharacter(big, { ...store.createCharacter({ name: `Member Number ${i}`, id: `m${i}` }), loadouts: { main: { equipment: full } } });
    party[i] = { characterId: `m${i}`, loadoutName: 'main' };
  }
  const bigText = run({ ...s, characters: big, party, selectedPlayers: [1, 2, 3, 4, 5] }, 'get_state', {}).content;
  assert.ok(bigText.length <= 1400, bigText.length);
  assert.match(run(trialState(), 'get_state', {}).content, /Ada \(tank\) ×2/);
});

test('19: get_results summaries', () => {
  const H = 3600e9;
  const cases = [
    { results: { encounters: 120, simulatedTime: 2 * H, experienceGained: { player1: { attack: 1000, melee: 1000 } }, deaths: { player1: 2 }, meta: { playerNames: { player1: 'Ada' } } }, re: /60\.0 encounters\/h.*Ada 1,000 XP\/h/s },
    { results: { isLabyrinth: true, encounters: 3, labyAttemptCount: 4, simulatedTime: H }, re: /3 of 4/ },
    { results: { isDungeon: true, dungeonsCompleted: 9, dungeonsFailed: 1, simulatedTime: H }, re: /9 completed, 1 failed/ },
    { results: { __kind: 'guildTrial', aggregate: { expectedTiersCleared: 3.25, expectedMaxTierCleared: 130 } }, re: /3\.25/ },
    { results: { __kind: 'equipOpt' }, re: /pane/ },
    { results: null, loading: true, progress: 42.5, re: /Running 43%/ },
    { results: null, re: /No results/ },
  ];
  for (const c of cases) {
    const text = run(makeState({ results: c.results, loading: !!c.loading, progress: c.progress || 0 }), 'get_results', {}).content;
    assert.match(text, c.re);
    assert.ok(text.length <= 800);
  }
});

test('20: trust boundary — readable errors, no state change', () => {
  const s = makeState();
  const bad = [
    executeTool({ id: 'x', name: 'launch_rockets', args: {} }, s, ctx),
    run(s, 'adjust_enhancement', { delta: 1, colour: 'red' }),
    run(s, 'adjust_enhancement', { delta: 'lots' }),
    run(s, 'set_skill_level', { level: 3 }),
    executeTool({ id: 'y', name: 'get_state', args: {}, argsError: 'Unexpected token' }, s, ctx),
  ];
  for (const out of bad) {
    assert.ok(out.isError, JSON.stringify(out));
    assert.equal(out.next, undefined);
    assert.ok(out.content.length > 10);
  }
  assert.match(bad[1].content, /Allowed: .*delta/);
  assert.deepEqual(validateArgs(REGISTRY.adjust_enhancement.parameters, { delta: '3', slots: 'Main Hand' }).value, { delta: 3, slots: ['main_hand'] });
  assert.equal(toolSpecs().length, 10);
});

test('21: undo restores by reference and leaves other characters alone', () => {
  const s = makeState();
  const out = run(s, 'adjust_enhancement', { delta: 1 });
  const s1 = commit(s, out);
  const s2 = commit(s1, run(s1, 'set_skill_level', { skill: 'attack', level: 7, player: 'Bea' }));
  const s3 = { ...s2, ...undoPatch(s2, out.undo) };
  assert.equal(s3.characters.characters.ada, s.characters.characters.ada);
  assert.equal(s3.characters.characters.bea.attackLevel, 7);
  // A later Ada edit is overwritten by the older snapshot (documented).
  const s4 = commit(s1, run(s1, 'set_skill_level', { skill: 'attack', level: 7 }));
  assert.equal({ ...s4, ...undoPatch(s4, out.undo) }.characters.characters.ada.attackLevel, 95);
  // set_zone undo restores every slice it wrote.
  const c = makeState({ simMode: 'itemCosts' });
  const zoneOut = run(c, 'set_zone', { zone: 'Bear With It', tier: 3, hours: 12 });
  const c1 = commit(c, zoneOut);
  assert.equal(c1.simMode, 'zone');
  const c2 = { ...c1, ...undoPatch(c1, zoneOut.undo) };
  for (const k of ['zone', 'difficultyTier', 'duration', 'simMode', 'optTarget']) assert.equal(c2[k], c[k], k);
  // A character deleted since cannot be undone back into existence.
  const gone = { ...s1, characters: store.deleteCharacter(s1.characters, 'ada') };
  assert.match(undoPatch(gone, out.undo).error, /no longer exists/);
  // No change, no undo.
  const none = run(s, 'adjust_enhancement', { value: 20, slots: ['head'] });
  assert.equal(none.undo, undefined);
});

test('22: editPlayer is lossless', () => {
  const s = makeState();
  const ref = { characterId: 'ada', loadoutName: 'tank' };
  const flat = store.resolveRef(s.characters, ref);
  assert.deepEqual(store.resolveRef(editPlayer(s.characters, ref, flat), ref), flat);
});
