#!/usr/bin/env node
// =============================================================================
// eval/backrun.mjs — run the corpus against an OLDER engine and report a verdict
//
//   npm run eval:backrun                          # against dabf8c9 (pre-optimisation)
//   npm run eval:backrun -- --against=<ref>
//   npm run eval:backrun -- --all-perf            # every perf commit in the span
//   npm run eval:backrun -- --bisect              # every commit in the span
//   npm run eval:backrun -- --kinds=all --seeds=8 --record=path.json
//
// THE QUESTION IT ANSWERS
// -----------------------
// "Did 34 commits of performance work change what the engine computes?" The
// corpus in fixtures/eval was recorded at HEAD. This tool extracts an older
// src/combatsimulator/ and re-runs the same cases at the same seeds against it.
//
// WHAT A CROSS-VERSION HASH MATCH DOES AND DOES NOT PROVE
// -------------------------------------------------------
// A MATCH is very strong evidence: the two engines consumed identical random
//   draws in identical order and produced an identical result tree. Nothing
//   short of a change that is invisible in the whole SimResult survives it.
// A MISMATCH proves only that RNG CONSUMPTION ORDER or the RESULT TREE changed.
//   It is NOT proof of a bug. Hoisting an allocation out of a loop can reorder
//   two independent draws without touching the distribution either produces.
// ON A MISMATCH the verdict escalates to Tier B across all seeds. Agreement
//   there makes the change CONSISTENT WITH behaviour preservation. That is a
//   weaker statement than Tier A's and must never be reported as the same one,
//   which is why the recorded verdict always names the tier it rests on.
//
// WHY git archive AND NOT git worktree
// ------------------------------------
// A worktree is a checkout of the whole repository, including api/ — and api/
// is exactly what must NOT change between the two measurements. Running the
// old engine through the old harness would fold harness drift into the engine
// comparison; running it through a worktree's api/ also means a second
// node_modules and a second loader. `git archive <ref> src/combatsimulator`
// extracts ~4.7 MB of engine and nothing else, into a scratch directory the
// CURRENT api/eval/engine.mjs then loads. One harness, two engines.
//
// It also has to land at that path: api/loader.js resolves bare specifiers
// (heap-js) ONLY when the importing file's path contains the literal substring
// "/src/combatsimulator/". `git archive <ref> src/combatsimulator | tar -x -C
// <scratch>/<ref>` produces <scratch>/<ref>/src/combatsimulator/…, which does.
//
// THE heap-js CONTROL
// -------------------
// bb4d767 re-pinned heap-js from ^2.2.0 to exactly 2.7.1. The loader resolves
// it from the CURRENT node_modules whichever engine is loaded, so both engines
// get 2.7.1. That is the correct control — it isolates engine source, which is
// what the question is about — but it means this tool says nothing about
// whether the dependency bump itself changed anything.
// =============================================================================

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { allEvalCases, DEFAULT_SEEDS } from './cases.mjs';
import { loadEngine } from './engine.mjs';
import { measureCase, compare, listFixtures } from './run.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const RECORDS_DIR = join(__dirname, 'records');

/** The last pre-optimisation commit. */
const DEFAULT_AGAINST = 'dabf8c9';

// ---- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

// ---- ref resolution ---------------------------------------------------------

function resolveRefs() {
  if (flag('bisect')) {
    return git('log', '--format=%h', '--reverse', `${DEFAULT_AGAINST}..HEAD`).split('\n').filter(Boolean);
  }
  if (flag('all-perf')) {
    const refs = git('log', '--format=%h %s', '--reverse', `${DEFAULT_AGAINST}..HEAD`)
      .split('\n')
      .filter((line) => /^[0-9a-f]+ perf/i.test(line))
      .map((line) => line.split(' ')[0]);
    if (!refs.length) throw new Error('backrun: --all-perf matched no commit');
    return refs;
  }
  return [arg('against', DEFAULT_AGAINST)];
}

// ---- the data guard ---------------------------------------------------------

/**
 * Game data must be byte-identical across the span, or the comparison is
 * meaningless: a monster whose HP changed produces a different fight for
 * reasons that have nothing to do with how fast the engine is.
 *
 * Refuses rather than warns, and names the files, because a warning printed
 * above a green table is a warning nobody reads.
 */
function assertDataUnchanged(ref) {
  let changed = '';
  try {
    execFileSync('git', ['diff', '--quiet', ref, 'HEAD', '--', 'src/combatsimulator/data'], { cwd: REPO });
    return;
  } catch {
    changed = git('diff', '--name-only', ref, 'HEAD', '--', 'src/combatsimulator/data');
  }
  if (flag('allow-data-change')) {
    console.error(
      `\n  ⚠ GAME DATA DIFFERS between ${ref} and HEAD, and --allow-data-change was passed.\n` +
        `    Every result below conflates engine changes with data changes:\n` +
        changed.split('\n').map((f) => `      ${f}`).join('\n') +
        '\n'
    );
    return;
  }
  console.error(
    `backrun: REFUSING to compare ${ref} with HEAD — src/combatsimulator/data differs:\n` +
      changed.split('\n').map((f) => `  ${f}`).join('\n') +
      `\n\nA data change makes the comparison meaningless: a different monster is a different\n` +
      `fight, and no amount of hash agreement would say anything about the engine.\n` +
      `Pass --allow-data-change if you understand that and want the numbers anyway.`
  );
  process.exit(2);
}

// ---- engine extraction ------------------------------------------------------

/**
 * Extract <ref>:src/combatsimulator into <scratch>/<ref>/src/combatsimulator.
 * The nesting is not incidental — see the header: the loader keys on the
 * literal path substring.
 */
function extractEngine(scratch, ref) {
  const root = join(scratch, ref);
  mkdirSync(root, { recursive: true });
  const tar = execFileSync('git', ['archive', ref, 'src/combatsimulator'], {
    cwd: REPO,
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', root], { input: tar, maxBuffer: 256 * 1024 * 1024 });
  if (!existsSync(join(root, 'src', 'combatsimulator', 'combatSimulator.js'))) {
    throw new Error(`backrun: extraction of ${ref} produced no engine at ${root}`);
  }
  return root;
}

// ---- main -------------------------------------------------------------------

const seedCount = Number(arg('seeds', String(DEFAULT_SEEDS)));
// Zone cases only by default. That is the 22-case set every prior reading in
// this repo was taken on, and it keeps the headline number comparable with
// them. --kinds=all widens it to the labyrinth and guild-trial cases too.
const kinds = arg('kinds', 'zone') === 'all' ? null : new Set(arg('kinds', 'zone').split(','));

const fixtures = listFixtures().map((f) => JSON.parse(readFileSync(f, 'utf8')));
if (!fixtures.length) {
  console.error('backrun: no fixtures — record them first:  npm run eval:record');
  process.exit(2);
}
const selected = fixtures.filter((fx) => !kinds || kinds.has(fx.kind));
const knownIds = new Set(allEvalCases().map((c) => c.id));
for (const fx of selected) {
  if (!knownIds.has(fx.id)) {
    console.error(`backrun: fixture "${fx.id}" is not in the catalogue — re-record before comparing.`);
    process.exit(2);
  }
}

const refs = resolveRefs();
const scratch = mkdtempSync(join(arg('scratch', tmpdir()), 'csim-backrun-'));
const cleanup = () => rmSync(scratch, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

console.log(`backrun: HEAD ${git('rev-parse', '--short', 'HEAD')} vs ${refs.length} ref(s)`);
console.log(`         ${selected.length} case(s) × ${seedCount} seeds = ${selected.length * seedCount} runs per ref`);
console.log(
  `         heap-js is resolved from the CURRENT node_modules for BOTH engines (pinned 2.7.1 by\n` +
    `         bb4d767), which isolates engine source and says nothing about the dependency bump.`
);
console.log(`         scratch: ${scratch}\n`);

const reports = [];

for (const ref of refs) {
  assertDataUnchanged(ref);
  const subject = git('log', '-1', '--format=%s', ref);
  const root = extractEngine(scratch, ref);

  const engine = await loadEngine(root);
  const rows = [];
  const t0 = performance.now();
  for (const fx of selected) {
    const fresh = await measureCase(engine, fx.case, seedCount);
    rows.push(compare(fx, fresh));
  }
  const wall = (performance.now() - t0) / 1000;

  const totalRuns = rows.reduce((a, r) => a + r.seeds, 0);
  const totalMatched = rows.reduce((a, r) => a + r.strictMatched, 0);
  const strictAll = totalMatched === totalRuns;
  const statsFailed = rows.filter((r) => !r.statsPass);
  const worstPct = rows.reduce((a, r) => Math.max(a, Math.abs(r.deltaPct)), 0);

  // The verdict names the tier it rests on. See the header: these are three
  // different strengths of claim and collapsing them is how "we checked" turns
  // into something nobody can audit later.
  const verdict = strictAll
    ? 'behaviour preserved (Tier A)'
    : statsFailed.length === 0
      ? 'consistent with behaviour preservation (Tier B only — RNG order or result tree changed)'
      : 'BEHAVIOUR CHANGED (both tiers)';

  const idW = Math.max(6, ...rows.map((r) => r.id.length));
  console.log(`── ${ref}  ${subject}`);
  for (const r of rows) {
    const mark = r.strictPass ? ' ' : '!';
    console.log(
      `   ${mark} ${r.id.padEnd(idW)}  strict ${String(r.strictMatched).padStart(3)}/${r.seeds}` +
        `   ${r.metric} ${r.meanRecorded.toFixed(2)} → ${r.meanFresh.toFixed(2)}` +
        `   Δ ${r.deltaPct.toFixed(2)}%   ${r.statsPass ? 'stats ok' : 'STATS FAIL'}`
    );
  }
  console.log(
    `   Tier A ${totalMatched}/${totalRuns} · Tier B ${rows.length - statsFailed.length}/${rows.length} ` +
      `· worst |Δ| ${worstPct.toFixed(2)}% · ${wall.toFixed(1)}s`
  );
  console.log(`   VERDICT: ${verdict}\n`);

  reports.push({
    ref,
    subject,
    strictMatched: totalMatched,
    strictTotal: totalRuns,
    statsPassed: rows.length - statsFailed.length,
    statsTotal: rows.length,
    worstAbsDeltaPct: worstPct,
    verdict,
    wallSeconds: Number(wall.toFixed(1)),
    cases: rows.map((r) => ({
      id: r.id,
      metric: r.metric,
      strict: `${r.strictMatched}/${r.seeds}`,
      meanRecorded: r.meanRecorded,
      meanOld: r.meanFresh,
      deltaPct: r.deltaPct,
      band: r.band,
      statsPass: r.statsPass,
    })),
  });
}

// ---- record -----------------------------------------------------------------

const recordPath =
  arg('record') ||
  (refs.length === 1
    ? join(RECORDS_DIR, `${new Date().toISOString().slice(0, 10)}-${refs[0]}-vs-HEAD.json`)
    : null);

if (recordPath) {
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(
    recordPath,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        head: git('rev-parse', 'HEAD'),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        seeds: seedCount,
        kinds: kinds ? [...kinds] : 'all',
        caveats: [
          'Bit-identity is of the CANONICAL SimResult tree, with wipeEvents[*].timestamp redacted (src/combatsimulator/simResult.js:197).',
          'Under a seeded global Math.random (mulberry32), on the MAIN-THREAD branch only — a worker realm does not see the override.',
          'heap-js held at 2.7.1 for both engines: the loader resolves it from the current node_modules whichever engine is loaded.',
          'Game data asserted byte-identical across the span before running; the comparison is refused otherwise.',
          'A Tier A match is strong evidence of behaviour preservation. A Tier A mismatch proves only that RNG consumption order or the result tree changed — Tier B agreement is then weaker evidence and is labelled as such.',
        ],
        reports,
      },
      null,
      2
    )
  );
  console.log(`wrote ${recordPath}`);
}

const anyChanged = reports.some((r) => r.verdict.startsWith('BEHAVIOUR CHANGED'));
process.exit(anyChanged ? 1 : 0);
