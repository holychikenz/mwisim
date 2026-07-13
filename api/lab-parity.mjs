#!/usr/bin/env node
// =============================================================================
// lab-parity — record & check simulator-vs-game parity for labyrinth stats.
//
// Run via the JSON-import loader (see package.json scripts):
//   npm run lab:check                       # diff every fixture, exit 1 on drift
//   npm run lab:record -- <monsterHrid> <roomLevel> [label]   # scaffold a fixture
//
// A fixture (csim/fixtures/lab/*.json) records the EXPECTED game numbers and
// the inputs needed to recompute the simulator's numbers:
//   {
//     "label": "...",
//     "monster": { "hrid": "/monsters/cyclops", "roomLevel": 150 },
//     "player":  null | { "dto": {...}, "crates": [...], "labUpgrades": {...} },
//     "tolerance": { "abs": 0.5, "rel": 0.005 },
//     "expected": {
//       "source": "game" | "sim-baseline",
//       "monster": { "<derivedStat>": <value>, ..., "abilities": [{hrid, level}] },
//       "player":  { "<derivedStat>": <value>, ... } | null
//     }
//   }
// `record` seeds `expected` from the simulator (source "sim-baseline"); replace
// those numbers with the values you read in-game and set source to "game".
// =============================================================================

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { computeLabMonsterStats, computeLabPlayerStats } from './lib/labStats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, '..', 'fixtures', 'lab');

const DEFAULT_TOL = { abs: 0.5, rel: 0.005 };

// ---- helpers ---------------------------------------------------------------

function listFixtures(target) {
  const path = target || FIX_DIR;
  if (existsSync(path) && statSync(path).isFile()) return [path];
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((f) => f.endsWith('.json')).map((f) => join(path, f));
}

function fmt(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : Number(v.toFixed(4)).toString();
}

function within(expected, got, tol) {
  if (typeof expected !== 'number' || typeof got !== 'number') return expected === got;
  return Math.abs(got - expected) <= Math.max(tol.abs, tol.rel * Math.abs(expected));
}

// Diff one expected stat block against a computed `derived` map.
function diffStats(expected, derived, tol, rows) {
  let drift = 0;
  for (const [k, exp] of Object.entries(expected)) {
    if (k === 'abilities') continue;
    const got = derived[k];
    const ok = within(exp, got, tol);
    if (!ok) drift++;
    rows.push({
      stat: k,
      expected: fmt(exp),
      sim: got === undefined ? '(absent)' : fmt(got),
      delta: typeof exp === 'number' && typeof got === 'number' ? fmt(Number((got - exp).toFixed(4))) : '',
      ok,
    });
  }
  return drift;
}

function diffAbilities(expected, got, rows) {
  let drift = 0;
  const gotByHrid = new Map((got || []).map((a) => [a.hrid, a]));
  for (const a of expected || []) {
    const g = gotByHrid.get(a.hrid);
    const ok = !!g && (a.level == null || g.level === a.level);
    if (!ok) drift++;
    rows.push({
      stat: `ability ${a.hrid.split('/').pop()}`,
      expected: `lv${a.level ?? '?'}`,
      sim: g ? `lv${g.level}` : '(absent)',
      delta: '',
      ok,
    });
  }
  return drift;
}

function printTable(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  const w = { stat: 26, expected: 12, sim: 12, delta: 10 };
  console.log(
    '  ' + pad('stat', w.stat) + pad('game/expected', w.expected + 2) +
    pad('sim', w.sim) + pad('Δ', w.delta) + 'status'
  );
  for (const r of rows) {
    console.log(
      '  ' + pad(r.stat, w.stat) + pad(r.expected, w.expected + 2) +
      pad(r.sim, w.sim) + pad(r.delta, w.delta) + (r.ok ? 'ok' : '✗ DRIFT')
    );
  }
}

// ---- commands --------------------------------------------------------------

function cmdCheck(target) {
  const files = listFixtures(target);
  if (files.length === 0) {
    console.log(`No fixtures found in ${target || FIX_DIR}.`);
    console.log('Create one with:  npm run lab:record -- /monsters/<name> <roomLevel>');
    process.exit(0);
  }

  let totalDrift = 0;
  let baselineCount = 0;
  for (const file of files) {
    const fx = JSON.parse(readFileSync(file, 'utf8'));
    const tol = { ...DEFAULT_TOL, ...(fx.tolerance || {}) };
    const exp = fx.expected || {};
    const isBaseline = exp.source !== 'game';
    if (isBaseline) baselineCount++;

    const rows = [];
    let drift = 0;
    let styleNote = null;

    if (fx.monster && exp.monster) {
      const got = computeLabMonsterStats(fx.monster.hrid, fx.monster.roomLevel);
      drift += diffStats(exp.monster, got.derived, tol, rows);
      if (exp.monster.abilities) drift += diffAbilities(exp.monster.abilities, got.abilities, rows);
    }
    if (fx.player && fx.player.dto && exp.player) {
      const got = computeLabPlayerStats(fx.player.dto, {
        crates: fx.player.crates || [],
        labUpgrades: fx.player.labUpgrades || {},
      });
      drift += diffStats(exp.player, got.derived, tol, rows);

      // Loadout-consistency guard: the recorded game sheet and the DTO are
      // captured from independent sources. If their combat styles differ, the
      // fixture was recorded with a mismatched loadout (e.g. a ranged sheet
      // against a flail DTO) and the drift is spurious — not a sim bug.
      const cs = fx._gameRaw && fx._gameRaw.playerCombatDetails && fx._gameRaw.playerCombatDetails.combatStats;
      const gameStyle = cs && ((cs.combatStyleHrids && cs.combatStyleHrids[0]) || cs.combatStyleHrid);
      if (gameStyle && got.combatStyleHrid && gameStyle !== got.combatStyleHrid) {
        styleNote = { sim: got.combatStyleHrid, game: gameStyle };
      }
    }

    const tag = isBaseline ? ' [sim-baseline — replace expected with game values]' : '';
    console.log(`\n■ ${fx.label || basename(file)}  (${basename(file)})${tag}`);
    if (rows.length === 0) {
      console.log('  (nothing to compare — fixture has no expected stats)');
    } else {
      printTable(rows);
    }
    if (styleNote) {
      const s = (h) => String(h).split('/').pop();
      console.log(`  ⚠ LOADOUT MISMATCH — sim fights ${s(styleNote.sim)}, game recorded ${s(styleNote.game)}. ` +
        `The DTO and recorded sheet used different loadouts; this drift is spurious. ` +
        `Re-record with the room's loadout assigned (the recorder now refuses such captures).`);
    }
    if (drift) console.log(`  → ${drift} stat(s) DRIFTED`);
    totalDrift += drift;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Checked ${files.length} fixture(s); ${totalDrift} drift(s).`);
  if (baselineCount) {
    console.log(`Note: ${baselineCount} fixture(s) still hold sim-baseline expectations — ` +
      `paste real game numbers and set "source":"game" to make them true parity checks.`);
  }
  process.exit(totalDrift > 0 ? 1 : 0);
}

function cmdRecord(args) {
  const [monsterHrid, roomLevelRaw, ...labelParts] = args;
  if (!monsterHrid || !roomLevelRaw) {
    console.error('Usage: npm run lab:record -- /monsters/<name> <roomLevel> [label]');
    process.exit(2);
  }
  const roomLevel = Number(roomLevelRaw);
  const got = computeLabMonsterStats(monsterHrid, roomLevel);
  const slug = monsterHrid.split('/').pop();
  const fileName = `${slug}.room${roomLevel}.json`;
  const path = join(FIX_DIR, fileName);

  const fixture = {
    label: labelParts.join(' ') || `${slug} — room ${roomLevel}`,
    monster: { hrid: monsterHrid, roomLevel },
    player: null,
    tolerance: DEFAULT_TOL,
    expected: {
      source: 'sim-baseline',
      monster: { ...got.derived, abilities: got.abilities },
      player: null,
    },
  };

  mkdirSync(FIX_DIR, { recursive: true });
  if (existsSync(path) && !args.includes('--force')) {
    console.error(`Refusing to overwrite ${path} (pass --force to replace).`);
    process.exit(2);
  }
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`Wrote ${path}`);
  console.log('Now replace expected.monster with the values you read in-game, ' +
    'and set expected.source to "game".');
}

// ---- entry -----------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'check':
    cmdCheck(rest[0]);
    break;
  case 'record':
    cmdRecord(rest);
    break;
  default:
    console.log('Usage:');
    console.log('  npm run lab:check                    # diff fixtures vs simulator');
    console.log('  npm run lab:record -- /monsters/<name> <roomLevel> [label]');
    process.exit(cmd ? 2 : 0);
}
