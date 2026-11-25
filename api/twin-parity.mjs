#!/usr/bin/env node
// =============================================================================
// twin-parity — differential harness: the Rust twin (rust/) against frozen
// goldens (fixtures/twin/goldens.json), bit for bit, on the same seeded random
// stream. The goldens were frozen on the retired JS engine and the twin matched
// them before it was deleted; an intentional change re-freezes them.
//
//   npm run twin:check -- selftest [--engine=native|wasm]
//   npm run twin:check -- check [--only=a,b] [--seeds=N] [--engines=native,wasm]
//   npm run twin:freeze -- [--only=a,b] [--seeds=N] [--engine=native|wasm]
//   npm run twin:trace -- <caseId> [--seed=N] [--limit=300000] [--engines=native,wasm]
//
// `check` runs every case under withSeed on each engine and compares it with
// the goldens, which `freeze` records (on wasm unless --engine says otherwise;
// with --only it updates just those cases). Compared:
// digest(canonical(result)) AND the end Math.random.state(): equal digests
// with unequal end states mean the twin drew a different number of randoms
// and happened to land on the same tree. Trial cases also compare the digest
// of extractTrialSummary(result) and of aggregateTrialResults over 3
// iterations on one stream. Exit 1 on any mismatch.
//
// `trace` records one line per processed event on two twin backends (native
// and wasm by default) — time, type, unit, rng state, heap size, HPs — finds
// the first record that differs, and re-runs a deep window (heap contents)
// around it.
//
// Every case calls the product entry points (runSimulation,
// runGuildTrialSimulation, the eval engine's runZone/runTrial) with the backend
// registered in shared/twinEngine.js, which is what CSIM_ENGINE sets in
// production. So the seams themselves are under test.
// =============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import { withSeed, canonical, digest, mulberry32 } from './lib/determinism.mjs';
import { runSimulation, runGuildTrialSimulation, loadGameData } from './lib/simulator.js';
import { allEvalCases, seedsFor, EVAL_HOURS, buildNamesFor, BUILDS } from './eval/cases.mjs';
import { loadEngine } from './eval/engine.mjs';
import { toCsimPlayer } from './bench/builds.mjs';
import { setTwinBackend, getTwinBackend, runTwin, twinRunRequest } from '../shared/twinEngine.js';
import { TRIAL_START_TIER } from '../shared/trialLadder.js';
import { nativeBackend } from './lib/twin/native.mjs';
import { wasmBackend } from './lib/twin/wasm.mjs';

const { extractTrialSummary, aggregateTrialResults } = await import('../shared/guildTrialStats.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'src', 'combatsimulator', 'data');
const FIX_DIR = join(ROOT, 'fixtures', 'sim');
const GOLDEN_FILE = join(ROOT, 'fixtures', 'twin', 'goldens.json');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const BACKENDS = { native: nativeBackend, wasm: wasmBackend };
const makeBackend = async (name) => {
  const make = BACKENDS[name];
  if (!make) {
    console.error(`twin: unknown engine "${name}" (known: ${Object.keys(BACKENDS).join(', ')})`);
    process.exit(2);
  }
  return make();
};

/** Run fn with backend b registered. */
async function on(b, fn) {
  setTwinBackend(b);
  try {
    return await fn();
  } finally {
    setTwinBackend(null);
  }
}

// ---- cases ------------------------------------------------------------------
// A case is { id, seeds, run(), agg?() }. run() is one product call on the
// CURRENT (already seeded) stream; agg() is a 3-iteration trial aggregate.

const engine = await loadEngine(ROOT);
const { gameData } = engine;
setTwinBackend(null); // CSIM_ENGINE may be set; this harness picks per engine

const trialAgg = (kase) => async () => {
  const summaries = [];
  for (let i = 0; i < 3; i++) summaries.push(extractTrialSummary(await engine.runTrial(kase)));
  return aggregateTrialResults(summaries, { startTier: kase.startTier ?? TRIAL_START_TIER });
};

function fixtureCases() {
  return readdirSync(FIX_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const fx = JSON.parse(readFileSync(join(FIX_DIR, f), 'utf8'));
    return { id: basename(f, '.json'), seeds: [fx.seed], run: () => runSimulation(structuredClone(fx.request)) };
  });
}

function evalCases(nSeeds) {
  return allEvalCases().map((kase) => {
    const seeds = seedsFor(kase.id, nSeeds);
    if (kase.kind === 'labyrinth') return { id: kase.id, seeds, run: () => engine.runLab(kase, EVAL_HOURS) };
    if (kase.kind === 'zone') return { id: kase.id, seeds, run: () => engine.runZone(kase, EVAL_HOURS) };
    return { id: kase.id, seeds, trialResult: true, run: () => engine.runTrial(kase), agg: trialAgg(kase) };
  });
}

// Live cases the recorded corpus does not exercise (risk R9).
function extraCases(nSeeds) {
  const melee = toCsimPlayer(BUILDS.melee, { level: 200, index: 1, items: gameData.itemDetailMap, abilityData: gameData.abilityDetailMap });
  const houses = {
    ...melee,
    houseRooms: { '/house_rooms/dojo': 4, '/house_rooms/gym': 6, '/house_rooms/armory': 3, '/house_rooms/library': 2 },
    // Every achievement of every tier but the last, so most tier buffs apply and one does not.
    achievements: Object.fromEntries(Object.values(loadGameData('achievementDetailMap')).filter((a) => a.tierHrid !== '/achievement_tiers/champion').map((a) => [a.hrid, true])),
    extraBuffs: [
      { uniqueHrid: '/buff_uniques/force_combat_guild_buff', typeHrid: '/buff_types/damage', ratioBoost: 0.006, ratioBoostLevelBonus: 0.003, flatBoost: 0, flatBoostLevelBonus: 0, startTime: '0001-01-01T00:00:00Z', duration: 0 },
    ],
  };
  const party = (n, level) =>
    buildNamesFor({ party: ['tank', 'healer', 'melee', 'ranged', 'magic'], n }).map((name, i) =>
      toCsimPlayer(BUILDS[name], { level, index: i + 1, items: gameData.itemDetailMap, abilityData: gameData.abilityDetailMap })
    );
  const guildBuffs = [
    { uniqueHrid: '/buff_uniques/guild_building_dojo', typeHrid: '/buff_types/attack_level', ratioBoost: 0, ratioBoostLevelBonus: 0, flatBoost: 4, flatBoostLevelBonus: 0, startTime: '0001-01-01T00:00:00Z', duration: 0 },
    { uniqueHrid: '/buff_uniques/guild_building_gym', typeHrid: '/buff_types/melee_level', ratioBoost: 0, ratioBoostLevelBonus: 0, flatBoost: 6, flatBoostLevelBonus: 0, startTime: '0001-01-01T00:00:00Z', duration: 0 },
  ];
  const seeds = (id) => seedsFor(id, nSeeds);
  const housesReq = { players: [houses], zone: { zoneHrid: '/actions/combat/gobo_planet', difficultyTier: 0 }, simulationTimeLimit: 3600e9, extra: { mooPass: true, comExp: 10, comDrop: 5 } };
  const den = { players: party(5, 600), zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0 }, extra: {} };
  // The trial extras go through runGuildTrialSimulation, so they compare its
  // { aggregate, summaries }, not a raw SimResult.
  const swarm = { players: party(5, 600), guildBuffs, trialHrid: '/guild_combat/swarm', startTier: 100, trialOptions: {} };
  const jelly = { players: party(5, 600), trialHrid: '/guild_combat/jellyfish', startTier: 100, trialOptions: { enemyScale: 0.8 } };
  // A labyrinth with house rooms, achievements and a guild buff, so buffSources has every source.
  const labHouses = { players: [{ ...houses, food: [null, null, null], drinks: [null, null, null] }], labyrinth: { labyrinthHrid: '/monsters/cyclops', roomLevel: 60, crates: ['/items/expert_coffee_crate'] }, simulationTimeLimit: 1800e9 };
  const lab = (spec) => () => runTwin(getTwinBackend(), twinRunRequest(structuredClone(spec)));
  const trial = (spec, iterations) => () => runGuildTrialSimulation({ ...structuredClone(spec), iterations });
  return [
    { id: 'twin-houses', seeds: seeds('twin-houses'), run: () => runSimulation(structuredClone(housesReq)) },
    { id: 'twin-lab-houses', seeds: seeds('twin-lab-houses'), run: lab(labHouses) },
    { id: 'twin-run-mode', seeds: seeds('twin-run-mode'), run: () => runSimulation({ ...structuredClone(den), maxRuns: 3 }) },
    { id: 'twin-trial-swarm', seeds: seeds('twin-trial-swarm'), run: trial(swarm, 1), agg: trial(swarm, 3) },
    { id: 'twin-trial-jellyfish', seeds: seeds('twin-trial-jellyfish'), run: trial(jelly, 1), agg: trial(jelly, 3) },
  ];
}

function allCases(nSeeds) {
  return [...fixtureCases(), ...evalCases(nSeeds), ...extraCases(nSeeds)];
}

/** Run fn on a fresh seeded stream with backend b; return its value and the end state. */
async function seeded(b, seed, fn) {
  return on(b, () =>
    withSeed(seed, async () => {
      const value = await fn();
      return { value, state: Math.random.state() };
    })
  );
}

// ---- check / freeze -----------------------------------------------------------

/** The cases --only names, or all; exits 2 on an unknown id. */
function selectCases(nSeeds) {
  const only = flag('only');
  const cases = allCases(nSeeds);
  if (!only) return cases;
  const want = new Set(only.split(','));
  const missing = [...want].filter((id) => !cases.some((c) => c.id === id));
  if (missing.length) {
    console.error(`twin: unknown case id(s): ${missing.join(', ')}`);
    process.exit(2);
  }
  return cases.filter((c) => want.has(c.id));
}

/** One case and seed on backend b: the golden record (digests and end rng states). */
async function observe(b, kase, seed) {
  const r = await seeded(b, seed, kase.run);
  const rec = { digest: digest(canonical(r.value)), rng: r.state };
  if (kase.trialResult) rec.summary = digest(canonical(extractTrialSummary(r.value)));
  if (kase.agg) {
    const a = await seeded(b, seed, kase.agg);
    rec.agg = digest(canonical(a.value));
    rec.aggRng = a.state;
  }
  return rec;
}

const readGoldens = () => (existsSync(GOLDEN_FILE) ? JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) : {});

async function cmdFreeze() {
  const nSeeds = Number(flag('seeds', '4'));
  const engineName = flag('engine', 'wasm');
  const cases = selectCases(nSeeds).filter((c) => !c.skip);
  // --only updates those cases and keeps the rest; a full freeze rewrites the file, dropping retired cases.
  const goldens = flag('only') ? readGoldens() : {};
  const b = await makeBackend(engineName);
  for (const kase of cases) {
    goldens[kase.id] = {};
    for (const seed of kase.seeds) goldens[kase.id][seed] = await observe(b, kase, seed);
    console.log(`  FROZE    ${engineName} ${kase.id} (${kase.seeds.length} seeds)`);
  }
  b.close?.();
  const sorted = Object.fromEntries(Object.keys(goldens).sort().map((id) => [id, goldens[id]]));
  mkdirSync(dirname(GOLDEN_FILE), { recursive: true });
  // One case per line: a re-freeze diffs as the cases it changed.
  const lines = Object.entries(sorted).map(([id, bySeed]) => `  ${JSON.stringify(id)}: ${JSON.stringify(bySeed)}`);
  writeFileSync(GOLDEN_FILE, `{\n${lines.join(',\n')}\n}\n`);
  console.log(`\ntwin:freeze ${engineName}: ${cases.length} cases -> ${GOLDEN_FILE}`);
}

const FIELDS = [['digest', 'result'], ['rng', 'rng end state'], ['summary', 'trial summary'], ['agg', 'aggregate x3'], ['aggRng', 'aggregate x3 rng end state']];

async function cmdCheck() {
  const nSeeds = Number(flag('seeds', '4'));
  const engines = flag('engines', 'native').split(',');
  const cases = selectCases(nSeeds);
  const goldens = readGoldens();

  let match = 0;
  let bad = 0;
  let skipped = 0;
  for (const engineName of engines) {
    const b = await makeBackend(engineName);
    for (const kase of cases) {
      if (kase.skip) {
        console.log(`  SKIP     ${engineName} ${kase.id} (${kase.skip})`);
        skipped++;
        continue;
      }
      for (const seed of kase.seeds) {
        let want;
        let got;
        try {
          want = goldens[kase.id]?.[seed];
          if (!want) {
            console.log(`  MISSING  ${engineName} ${kase.id} seed=${seed}: no golden (npm run twin:freeze -- --only=${kase.id} --seeds=${nSeeds})`);
            bad++;
            continue;
          }
          got = await observe(b, kase, seed);
        } catch (err) {
          console.log(`  ERROR    ${engineName} ${kase.id} seed=${seed}: ${err?.message ?? err}`);
          bad++;
          continue;
        }
        const problems = FIELDS.filter(([k]) => want[k] !== got[k]);
        if (problems.length === 0) {
          match++;
          console.log(`  MATCH    ${engineName} ${kase.id} seed=${seed} ${got.digest.slice(0, 16)} rng=${got.rng}`);
          continue;
        }
        bad++;
        console.log(`  MISMATCH ${engineName} ${kase.id} seed=${seed}`);
        for (const [k, what] of problems) {
          console.log(`           ${what}: golden ${String(want[k]).slice(0, 16)} ${engineName} ${String(got[k]).slice(0, 16)}`);
        }
      }
    }
    b.close?.();
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`twin:check ${engines.join(',')} vs golden: ${match} match, ${bad} mismatch, ${skipped} skipped`);
  process.exit(bad ? 1 : 0);
}

// ---- trace ------------------------------------------------------------------

// A trace record: [n, time, type, unit, rng, heapLen, playerHp[], enemyHp[]|null, (heap)] per event.

/** The product call on backend b, with the trace window injected into its one twin request. */
async function twinTrace(b, kase, seed, from, to, deep) {
  let trace = null;
  const tracing = {
    run: async (json, onProgress) => {
      if (trace) throw new Error(`twin: ${kase.id} makes more than one twin request; trace a single-request case`);
      const res = JSON.parse(await b.run(JSON.stringify({ ...JSON.parse(json), trace: { from, to, deep } }), onProgress));
      trace = res.trace ?? [];
      return JSON.stringify(res);
    },
  };
  await on(tracing, () => withSeed(seed, kase.run));
  return trace;
}

async function cmdTrace() {
  const id = argv.find((a) => !a.startsWith('--') && a !== 'trace');
  const kase = allCases(16).find((c) => c.id === id);
  if (!kase || kase.skip) {
    console.error(`twin: no traceable case "${id}"`);
    process.exit(2);
  }
  const seed = Number(flag('seed', String(kase.seeds[0])));
  const limit = Number(flag('limit', '300000'));
  const [na, nb] = flag('engines', 'native,wasm').split(',');
  const a = await makeBackend(na);
  const b = await makeBackend(nb);
  const sj = await twinTrace(a, kase, seed, 0, limit, false);
  const st = await twinTrace(b, kase, seed, 0, limit, false);
  const len = Math.min(sj.length, st.length);
  let k = -1;
  for (let i = 0; i < len; i++) {
    if (JSON.stringify(sj[i]) !== JSON.stringify(st[i])) {
      k = i;
      break;
    }
  }
  if (k === -1 && sj.length === st.length) {
    console.log(`twin:trace ${id} seed=${seed}: ${len} events, no divergence (${na} vs ${nb})`);
    a.close?.();
    b.close?.();
    process.exit(0);
  }
  if (k === -1) k = len;
  const from = Math.max(0, k - 20);
  const dj = await twinTrace(a, kase, seed, from, k + 1, true);
  const dt = await twinTrace(b, kase, seed, from, k + 1, true);
  console.log(`twin:trace ${id} seed=${seed}: first divergence at event ${k} (${na} ${sj.length} events, ${nb} ${st.length})`);
  for (let i = 0; i < Math.max(dj.length, dt.length); i++) {
    const x = JSON.stringify(dj[i]?.slice(0, 8));
    const y = JSON.stringify(dt[i]?.slice(0, 8));
    console.log(`${x === y ? ' ' : '>'} ${na} ${x}`);
    if (x !== y) console.log(`> ${nb} ${y}`);
  }
  const hj = dj[dj.length - 1]?.[8];
  const ht = dt[dt.length - 1]?.[8];
  console.log(`heap at ${k}:\n  ${na} ${JSON.stringify(hj)}\n  ${nb} ${JSON.stringify(ht)}`);
  a.close?.();
  b.close?.();
  process.exit(1);
}

// ---- selftest ---------------------------------------------------------------

/** Every numeric literal in the data files, as written. */
function dataNumberLiterals() {
  const out = new Set();
  for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
    const t = readFileSync(join(DATA_DIR, f), 'utf8');
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"') {
        for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++;
      } else if (c === '-' || (c >= '0' && c <= '9')) {
        const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(t.slice(i, i + 40));
        out.add(m[0]);
        i += m[0].length - 1;
      }
    }
  }
  return [...out];
}

async function cmdSelftest() {
  const b = await makeBackend(flag('engine', 'native'));
  const r = mulberry32(12345);
  const draws = Array.from({ length: 1000 }, () => r());
  const jitter = mulberry32(99);
  const xs = Array.from({ length: 100000 }, (_, i) => 10 + i * 0.05 + jitter() * 0.05);
  const lits = dataNumberLiterals();
  const res = JSON.parse(await b.selftest(JSON.stringify({ seed: 12345, draws: 1000, pow: xs, numbers: lits })));
  if (!res.ok) throw new Error(res.error);
  const rngOk = draws.filter((v, i) => Object.is(v, res.rng[i])).length;
  const powOk = xs.filter((x, i) => Object.is(Math.pow(x, 1.4), res.pow[i])).length;
  const numOk = lits.filter((l, i) => Object.is(JSON.parse(l), res.numbers[i])).length;
  console.log(`rng ${rngOk}/${draws.length}  pow ${powOk}/${xs.length}  numbers ${numOk}/${lits.length}`);
  b.close?.();
  process.exit(rngOk === draws.length && powOk === xs.length && numOk === lits.length ? 0 : 1);
}

const cmd = argv.find((a) => !a.startsWith('--'));
switch (cmd) {
  case 'selftest': await cmdSelftest(); break;
  case 'check': await cmdCheck(); break;
  case 'freeze': await cmdFreeze(); break;
  case 'trace': await cmdTrace(); break;
  default:
    console.log('Usage:');
    console.log('  npm run twin:check -- selftest [--engine=native|wasm]');
    console.log('  npm run twin:check -- check [--only=a,b] [--seeds=N] [--engines=native,wasm]');
    console.log('  npm run twin:freeze -- [--only=a,b] [--seeds=N] [--engine=native|wasm]');
    console.log('  npm run twin:trace -- <caseId> [--seed=N] [--limit=300000] [--engines=native,wasm]');
    process.exit(cmd ? 2 : 0);
}
