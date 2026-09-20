#!/usr/bin/env node
// =============================================================================
// sim-parity — record & check BIT-IDENTICAL SimResult output across engine
// changes. Follows the fixture convention of lab-parity.mjs (record/check pair,
// fixtures under csim/fixtures/), but answers a different question.
//
//   npm run sim:check    # re-run every fixture, exit 1 on ANY difference
//   npm run sim:record   # (re-)record every fixture from the current engine
//
// WHY THIS EXISTS
// ---------------
// The engine seeds nothing: it calls bare Math.random() at 26 sites, so two
// runs of the same input already differ and "the numbers look similar" proves
// nothing about a performance change. This harness installs a seeded PRNG over
// Math.random for the duration of a run, which makes the whole simulation a
// pure function of (inputs, seed). A fixture therefore pins the EXACT
// SimResult, and any behavioural drift — a dropped stat, a stale buff index, a
// reordered heap scan — shows up as a diff rather than as noise.
//
// The three scenarios exercise the changed code differently on purpose:
//   bare-solo    no equipment at all  → the equipment-sum cache sums nothing
//   geared-solo  full kit + consumables + abilities → cache + buff churn
//   geared-party 5 players in a dungeon → the heap is deep and stat recomputes
//                are the dominant cost (this is the shape the work targets)
//
// RE-RECORDING is correct when the GAME DATA or a combat RULE changes; it is
// NOT correct as a way to make a failing optimisation pass. If sim:check fails
// after a performance change, the change altered behaviour.
// =============================================================================

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { runSimulation, loadGameData } from './lib/simulator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, '..', 'fixtures', 'sim');

// ---- deterministic randomness ----------------------------------------------

// mulberry32 — small, fast, and good enough that a seed change visibly
// reshuffles the run. The engine only ever needs a uniform in [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Install over the global Math.random for the duration of `fn`. Every engine
// call site uses the global, so this captures all 26 of them without the
// engine knowing anything about seeding.
async function withSeed(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return await fn();
  } finally {
    Math.random = real;
  }
}

// ---- canonical serialisation -----------------------------------------------

// Key-sorted, with the JSON-hostile values the engine can produce spelled out
// rather than silently coerced (JSON.stringify turns NaN/Infinity into null,
// which would hide exactly the kind of drift we are looking for).
function canonical(value, seen = new Set()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number') {
    if (Number.isNaN(value)) return '@NaN';
    if (value === Infinity) return '@Infinity';
    if (value === -Infinity) return '@-Infinity';
    return value;
  }
  if (t === 'bigint') return '@bigint:' + value.toString();
  if (t === 'undefined') return '@undefined';
  if (t === 'function') return '@function';
  if (t !== 'object') return value;
  if (seen.has(value)) return '@circular';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => canonical(v, seen));
    if (value instanceof Map) {
      return { '@map': [...value.entries()].map(([k, v]) => [canonical(k, seen), canonical(v, seen)]).sort() };
    }
    if (value instanceof Set) {
      return { '@set': [...value].map((v) => canonical(v, seen)).sort() };
    }
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key], seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

function digest(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// A handful of headline numbers, so a failing fixture reads as something a
// human can reason about before diffing the full tree.
function headline(result) {
  return {
    encounters: result?.encounters ?? null,
    elapsedTime: result?.elapsedTime ?? null,
    dungeonsCompleted: result?.dungeonsCompleted ?? null,
    deathCount: result?.deaths ? Object.keys(result.deaths).length : null,
    experienceKeys: result?.experienceGained ? Object.keys(result.experienceGained).length : null,
  };
}

// ---- scenarios --------------------------------------------------------------

// Built from the shipped game data so the fixture request is reproducible, then
// FROZEN INTO the fixture file — a recorded fixture never re-derives its input.
const GEARED_KIT = [
  '/items/acrobatic_hood', '/items/master_attack_charm', '/items/expert_task_badge',
  '/items/anchorbound_plate_body', '/items/anchorbound_plate_legs', '/items/cursed_bow',
  '/items/bishops_codex', '/items/pathbreaker_boots', '/items/dodocamel_gauntlets',
  '/items/chimerical_quiver_refined', '/items/philosophers_earrings',
  '/items/philosophers_necklace', '/items/philosophers_ring', '/items/small_pouch',
];
const GEARED_ABILITIES = [
  '/abilities/aqua_arrow', '/abilities/berserk', '/abilities/cleave',
  '/abilities/crippling_slash', '/abilities/critical_aura',
];

function triggersOf(detail) {
  return (detail?.defaultCombatTriggers || []).map((t) => ({
    dependencyHrid: t.dependencyHrid,
    conditionHrid: t.conditionHrid,
    comparatorHrid: t.comparatorHrid,
    value: t.value,
  }));
}

function makePlayerDTO({ hrid, level, geared }) {
  const items = loadGameData('itemDetailMap');
  const abilityMap = loadGameData('abilityDetailMap');

  const equipment = {};
  const food = [];
  const drinks = [];
  let abilities = [];

  if (geared) {
    for (const itemHrid of GEARED_KIT) {
      const type = items[itemHrid]?.equipmentDetail?.type;
      if (!type) throw new Error(`Unknown or non-equippable item: ${itemHrid}`);
      equipment[type] = { hrid: itemHrid, enhancementLevel: 5 };
    }
    abilities = GEARED_ABILITIES.map((h) => ({
      hrid: h, level: 10, triggers: triggersOf(abilityMap[h]),
    }));
    // Deterministic pick: highest item level first, hrid as the tiebreak so the
    // choice never depends on Object key order.
    const pick = (category, n) =>
      Object.values(items)
        .filter((i) =>
          i.consumableDetail &&
          i.categoryHrid === category &&
          (i.itemLevel || 0) <= level &&
          i.consumableDetail.usableInActionTypeMap?.['/action_types/combat'])
        .sort((a, b) => (b.itemLevel || 0) - (a.itemLevel || 0) || a.hrid.localeCompare(b.hrid))
        .slice(0, n)
        .map((i) => ({ hrid: i.hrid, triggers: triggersOf(i.consumableDetail) }));
    food.push(...pick('/item_categories/food', 3));
    drinks.push(...pick('/item_categories/drink', 3));
  }

  return {
    hrid,
    staminaLevel: level, intelligenceLevel: level, attackLevel: level,
    meleeLevel: level, defenseLevel: level, rangedLevel: level, magicLevel: level,
    equipment, food, drinks, abilities,
    houseRooms: {}, achievements: {}, debuffOnLevelGap: 0,
  };
}

// Durations are short on purpose: long enough that every scenario resolves many
// encounters (and, for the party, several dungeon runs), short enough that a
// fixture stays a few tens of KB and sim:check finishes in seconds.
const SCENARIOS = {
  'bare-solo': () => ({
    label: 'bare solo player — no equipment, fly T0 L40',
    seed: 12345,
    request: {
      players: [makePlayerDTO({ hrid: 'player1', level: 40, geared: false })],
      zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 },
      simulationTimeLimit: 10 * 60 * 1e9,
      extra: {},
    },
  }),
  'geared-solo': () => ({
    // A zone that actually hurts: on an easy zone the player is never touched,
    // so defensive stats never reach the result and the fixture would be blind
    // to a dropped armor/evasion/resistance term.
    label: 'geared solo player — infernal_abyss T0 L100',
    seed: 23456,
    request: {
      players: [makePlayerDTO({ hrid: 'player1', level: 100, geared: true })],
      zone: { zoneHrid: '/actions/combat/infernal_abyss', difficultyTier: 0 },
      simulationTimeLimit: 10 * 60 * 1e9,
      extra: {},
    },
  }),
  'geared-party': () => ({
    label: 'geared 5-player party — chimerical_den dungeon T0 L600',
    seed: 34567,
    request: {
      players: [1, 2, 3, 4, 5].map((i) =>
        makePlayerDTO({ hrid: 'player' + i, level: 600, geared: true })),
      zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0 },
      simulationTimeLimit: 10 * 60 * 1e9,
      extra: {},
    },
  }),
};

// ---- run --------------------------------------------------------------------

async function runFixture(fx) {
  // NOTE: runSimulation is called with no onProgress, which is what makes it
  // take the MAIN-THREAD branch (api/lib/simulator.js). That matters: the
  // worker_threads branch runs the engine in another realm, where this
  // process's Math.random override does not reach it — the runs would be
  // unseeded and every fixture would be pure noise that never reproduces.
  // If you ever add an onProgress argument here, the harness silently stops
  // proving anything.
  const log = console.log;
  console.log = () => {}; // the engine chatters on the dungeon path
  try {
    return await withSeed(fx.seed, () =>
      runSimulation(structuredClone(fx.request)));
  } finally {
    console.log = log;
  }
}

function listFixtures() {
  if (!existsSync(FIX_DIR)) return [];
  return readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => join(FIX_DIR, f));
}

// Walk two canonical trees and report the first few leaf paths that differ.
function firstDiffs(a, b, path = '', out = [], limit = 12) {
  if (out.length >= limit) return out;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: path || '(root)', expected: sa, got: sb });
    return out;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (out.length >= limit) break;
    firstDiffs(a?.[k], b?.[k], path ? `${path}.${k}` : k, out, limit);
  }
  return out;
}

async function cmdCheck() {
  const files = listFixtures();
  if (files.length === 0) {
    console.error(`No fixtures in ${FIX_DIR}. Record them first:  npm run sim:record`);
    process.exit(2);
  }
  let failures = 0;
  for (const file of files) {
    const fx = JSON.parse(readFileSync(file, 'utf8'));
    const result = await runFixture(fx);
    const got = canonical(result);
    const gotHash = digest(got);
    if (gotHash === fx.expected.sha256) {
      console.log(`  ok    ${basename(file)}  ${fx.label}`);
      continue;
    }
    failures++;
    console.log(`  DRIFT ${basename(file)}  ${fx.label}`);
    console.log(`        sha256 expected ${fx.expected.sha256.slice(0, 16)}  got ${gotHash.slice(0, 16)}`);
    console.log(`        headline expected ${JSON.stringify(fx.expected.headline)}`);
    console.log(`        headline got      ${JSON.stringify(headline(result))}`);
    for (const d of firstDiffs(fx.expected.result, got)) {
      console.log(`        ${d.path}: expected ${String(d.expected).slice(0, 80)} got ${String(d.got).slice(0, 80)}`);
    }
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Checked ${files.length} fixture(s); ${failures} drifted.`);
  if (failures) {
    console.log('A drift means the engine no longer reproduces the recorded run bit for bit.');
    console.log('That is a BEHAVIOUR change, not noise — the run is seeded.');
  }
  process.exit(failures ? 1 : 0);
}

async function cmdRecord(only) {
  mkdirSync(FIX_DIR, { recursive: true });
  const names = only ? [only] : Object.keys(SCENARIOS);
  for (const name of names) {
    const build = SCENARIOS[name];
    if (!build) {
      console.error(`Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(2);
    }
    const spec = build();
    const fx = { name, ...spec };
    const result = await runFixture(fx);
    const canon = canonical(result);
    fx.expected = { sha256: digest(canon), headline: headline(result), result: canon };
    const path = join(FIX_DIR, `${name}.json`);
    writeFileSync(path, JSON.stringify(fx, null, 2) + '\n');
    console.log(`Wrote ${path}  sha256=${fx.expected.sha256.slice(0, 16)}  ${JSON.stringify(fx.expected.headline)}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'check': await cmdCheck(); break;
  case 'record': await cmdRecord(rest[0]); break;
  default:
    console.log('Usage:');
    console.log('  npm run sim:check              # bit-identical replay of every fixture');
    console.log('  npm run sim:record [scenario]  # (re-)record goldens from the current engine');
    process.exit(cmd ? 2 : 0);
}
