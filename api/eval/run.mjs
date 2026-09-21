#!/usr/bin/env node
// =============================================================================
// eval/run.mjs — record and check the evaluation corpus
//
//   npm run eval:check                     # both tiers, every case, exit 1 on fail
//   npm run eval:record                    # (re-)record the corpus from this engine
//   npm run eval:check -- --only=dungeon-den-600,trial-badger-5
//   npm run eval:check -- --tier=stats     # statistical tier only
//   npm run eval:check -- --seeds=4        # a faster, weaker check
//   npm run eval:check -- --json=out.json  # machine-readable
//
// TWO TIERS, KEPT STRICTLY APART
// ------------------------------
// TIER A — STRICT, same engine. Per (case, seed), the sha256 of the redacted
//   canonical SimResult must match exactly. This is the day-to-day gate: it
//   fails on ANY behaviour change, including ones too small to see in a mean.
//
// TIER B — STATISTICAL, across engines. Asserts the ensemble MEAN of the case's
//   headline quantity over the S seeds. It survives a legitimate refactor that
//   reorders RNG draws without changing the distribution — the exact case Tier A
//   cannot distinguish from a bug.
//
// THE TOLERANCE IS COMPUTED, NOT CHOSEN
// -------------------------------------
// At record time the sample mean and sd over the S seeds are stored. At check:
//
//     band = max( 4 * sd_rec * sqrt(2/S) ,  0.0025 * |mean_rec| )
//     pass <=> |mean_new - mean_rec| <= band
//
// sd*sqrt(2/S) is the standard error of the DIFFERENCE of two S-sample means
// under equal variance — the conservative case, where the two engines' draws
// are independent rather than shared. k = 4 gives ≈6e-5 two-sided per test;
// over ~29 cases the family-wise false-alarm rate is ≈1.8e-3, or about one
// spurious red per 550 clean runs.
//
// The 0.25 % FLOOR exists because discrete quantities can have sd = 0. Every
// seed of a guild trial may clear exactly the same tier, which collapses the
// 4·SE term to zero and makes the band unsatisfiable by any change at all. The
// floor also absorbs cross-platform float noise. BOTH terms are written into
// the fixture, so a reader can see which one bound.
//
// RE-RECORDING IS NOT HOW YOU MAKE A FAILING OPTIMISATION PASS. See
// fixtures/eval/README.md.
// =============================================================================

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { withSeed, canonical, digest, headline } from '../lib/determinism.mjs';
import { allEvalCases, seedsFor, validateEvalCases, DEFAULT_SEEDS, EVAL_HOURS } from './cases.mjs';
import { loadEngine, runCase } from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIX_DIR = join(__dirname, '..', '..', 'fixtures', 'eval');
const DEFAULT_ROOT = join(__dirname, '..', '..');

// ---- tolerance --------------------------------------------------------------

export const BAND_K = 4;
export const BAND_FLOOR_FRAC = 0.0025;

export function meanOf(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). Zero for a single sample. */
export function sdOf(xs) {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

/**
 * The two terms of the band, and the band itself. Both terms are returned so
 * the fixture records which one bound.
 */
export function bandFor(mean, sd, s) {
  const se = sd * Math.sqrt(2 / s);
  const statistical = BAND_K * se;
  const floor = BAND_FLOOR_FRAC * Math.abs(mean);
  return { se, statistical, floor, band: Math.max(statistical, floor) };
}

// ---- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) || null;
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// ---- the measurement --------------------------------------------------------

/**
 * Run one case at S seeds against one engine.
 *
 * @returns {Promise<{runs: Array, values: number[]}>}
 */
export async function measureCase(engine, kase, seedCount) {
  const runs = [];
  let first = true;
  for (const seed of seedsFor(kase.id, seedCount)) {
    const result = await withSeed(seed, () => runCase(engine, kase, EVAL_HOURS));
    const value = Number(result?.[kase.metric] ?? 0);
    // Deliberately NOT the whole headline() per seed. `encounters` is already
    // `value` for a zone case, `elapsedTime` is null on every SimResult the
    // engine produces and `experienceKeys` is a constant 5 — storing the four
    // of them 464 times cost 45 % of the corpus to say nothing. Deaths and
    // dungeons are kept because they are the two numbers that actually orient a
    // reader looking at a drifted hash. The full headline of the first seed is
    // recorded once per fixture for the same purpose.
    runs.push({
      seed,
      sha256: digest(canonical(result)),
      value,
      deaths: result?.deaths ? Object.values(result.deaths).reduce((a, b) => a + b, 0) : 0,
      dungeons: result?.dungeonsCompleted ?? 0,
      _headline: first ? headline(result) : null,
    });
    first = false;
  }
  const firstHeadline = runs[0]?._headline ?? null;
  for (const r of runs) delete r._headline;
  return { runs, values: runs.map((r) => r.value), firstHeadline };
}

// ---- fixture i/o ------------------------------------------------------------

const fixturePath = (id) => join(FIX_DIR, `${id}.json`);

/**
 * Written by hand rather than JSON.stringify(_, null, 2) so that each run is
 * ONE LINE. A 16-line block of one-line runs is a diff a reviewer can read; the
 * same data pretty-printed is 130 lines per case and nobody reads it twice.
 */
function serialiseFixture(fx) {
  const runLines = fx.runs.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  const head = { ...fx };
  delete head.runs;
  const body = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${body},\n  "runs": [\n${runLines}\n  ]\n}\n`;
}

export function listFixtures() {
  if (!existsSync(FIX_DIR)) return [];
  return readdirSync(FIX_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(FIX_DIR, f));
}

// ---- commands ---------------------------------------------------------------

function selectCases(only) {
  const wanted = only ? new Set(only.split(',')) : null;
  const cases = allEvalCases().filter((c) => !wanted || wanted.has(c.id));
  if (!cases.length) {
    console.error(`eval: --only matched no case. Known ids:\n  ${allEvalCases().map((c) => c.id).join('\n  ')}`);
    process.exit(2);
  }
  return cases;
}

async function openEngine(root) {
  const engine = await loadEngine(root);
  validateEvalCases(engine.gameData);
  return engine;
}

async function cmdRecord() {
  const seedCount = Number(arg('seeds', String(DEFAULT_SEEDS)));
  const engine = await openEngine(arg('engine', DEFAULT_ROOT));
  const cases = selectCases(arg('only'));
  mkdirSync(FIX_DIR, { recursive: true });

  for (const kase of cases) {
    const t0 = performance.now();
    const { runs, values, firstHeadline } = await measureCase(engine, kase, seedCount);
    const mean = meanOf(values);
    const sd = sdOf(values);
    const b = bandFor(mean, sd, seedCount);

    const fx = {
      id: kase.id,
      kind: kase.kind,
      metric: kase.metric,
      evalHours: EVAL_HOURS,
      case: kase,
      recordedAt: new Date().toISOString(),
      // Recorded so a check on another platform can say so out loud rather than
      // silently attributing a float difference to the engine. See the
      // cross-platform section of api/eval/README.md.
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      seeds: seedCount,
      headlineFirstSeed: firstHeadline,
      stats: {
        mean,
        sd,
        standardErrorOfDifference: b.se,
        bandStatistical: b.statistical,
        bandFloor: b.floor,
        band: b.band,
        boundBy: b.statistical >= b.floor ? 'statistical' : 'floor',
      },
      runs,
    };
    writeFileSync(fixturePath(kase.id), serialiseFixture(fx));
    console.log(
      `  wrote ${kase.id.padEnd(22)} ${kase.metric}: mean ${mean.toFixed(2)} sd ${sd.toFixed(2)} ` +
        `band ±${b.band.toFixed(3)} (${fx.stats.boundBy})  ${((performance.now() - t0) / 1000).toFixed(1)}s`
    );
  }
  console.log(`\nRecorded ${cases.length} case(s) at ${seedCount} seeds into ${FIX_DIR}`);
}

/**
 * Compare a fresh measurement against a fixture. Exported so backrun.mjs runs
 * the identical comparison rather than a second, subtly different one.
 */
export function compare(fx, fresh) {
  const byHash = new Map(fx.runs.map((r) => [r.seed, r.sha256]));
  let matched = 0;
  const mismatches = [];
  for (const r of fresh.runs) {
    if (byHash.get(r.seed) === r.sha256) matched++;
    else mismatches.push({ seed: r.seed, expected: byHash.get(r.seed) || null, got: r.sha256 });
  }

  const mean = meanOf(fresh.values);
  const b = { band: fx.stats.band, se: fx.stats.standardErrorOfDifference };
  const delta = mean - fx.stats.mean;
  const z = b.se > 0 ? delta / b.se : null;

  return {
    id: fx.id,
    metric: fx.metric,
    seeds: fresh.runs.length,
    strictMatched: matched,
    strictPass: matched === fresh.runs.length,
    mismatches,
    meanRecorded: fx.stats.mean,
    meanFresh: mean,
    delta,
    deltaPct: fx.stats.mean !== 0 ? (delta / fx.stats.mean) * 100 : 0,
    band: b.band,
    z,
    statsPass: Math.abs(delta) <= b.band,
  };
}

async function cmdCheck() {
  const files = listFixtures();
  if (files.length === 0) {
    console.error(`No fixtures in ${FIX_DIR} — record them first:  npm run eval:record`);
    process.exit(2);
  }

  const tier = arg('tier', 'both');
  if (!['strict', 'stats', 'both'].includes(tier)) {
    console.error(`eval: --tier must be strict, stats or both (got "${tier}")`);
    process.exit(2);
  }
  const only = arg('only');
  const wanted = only ? new Set(only.split(',')) : null;

  const engine = await openEngine(arg('engine', DEFAULT_ROOT));

  const rows = [];
  let strictFail = 0;
  let statsFail = 0;
  let platformWarned = false;

  for (const file of files) {
    const fx = JSON.parse(readFileSync(file, 'utf8'));
    if (wanted && !wanted.has(fx.id)) continue;

    const here = `${process.platform}/${process.arch}`;
    if (!platformWarned && (fx.platform !== here || fx.node.split('.')[0] !== process.version.split('.')[0])) {
      platformWarned = true;
      console.error(
        `\n  ⚠ PLATFORM MISMATCH — corpus recorded on ${fx.node} ${fx.platform}, ` +
          `running on ${process.version} ${here}.\n` +
          `    Math.random is overridden, so that source of divergence is neutralised, but float\n` +
          `    formatting and structuredClone behaviour across engines/platforms are not guaranteed.\n` +
          `    A strict-tier failure here may be a PLATFORM difference, not an engine change.\n` +
          `    See "Cross-platform" in api/eval/README.md before re-recording anything.\n`
      );
    }

    const seedCount = Number(arg('seeds', String(fx.seeds)));
    const fresh = await measureCase(engine, fx.case, seedCount);
    const cmp = compare(fx, fresh);
    rows.push(cmp);
    if (tier !== 'stats' && !cmp.strictPass) strictFail++;
    if (tier !== 'strict' && !cmp.statsPass) statsFail++;
  }

  if (!rows.length) {
    console.error(`eval: --only matched no fixture.`);
    process.exit(2);
  }

  // ---- table ----
  const idW = Math.max(6, ...rows.map((r) => r.id.length));
  const head = [
    'case'.padEnd(idW),
    'strict'.padStart(7),
    'metric'.padEnd(20),
    'mean (rec → new)'.padEnd(22),
    'Δ%'.padStart(8),
    'z'.padStart(7),
    'band'.padStart(9),
    'stats'.padStart(6),
  ];
  console.log();
  console.log(head.join(' | '));
  console.log(head.map((h) => '-'.repeat(h.length)).join('-|-'));
  for (const r of rows) {
    console.log(
      [
        r.id.padEnd(idW),
        `${r.strictMatched}/${r.seeds}`.padStart(7),
        r.metric.padEnd(20),
        `${r.meanRecorded.toFixed(3)} → ${r.meanFresh.toFixed(3)}`.padEnd(22),
        `${r.deltaPct.toFixed(2)}%`.padStart(8),
        (r.z === null ? 'sd=0' : r.z.toFixed(2)).padStart(7),
        `±${r.band.toFixed(3)}`.padStart(9),
        (r.statsPass ? 'ok' : 'FAIL').padStart(6),
      ].join(' | ')
    );
  }

  console.log(`\n${'='.repeat(60)}`);
  const totalRuns = rows.reduce((a, r) => a + r.seeds, 0);
  const totalMatched = rows.reduce((a, r) => a + r.strictMatched, 0);
  console.log(`Tier A (strict):      ${totalMatched}/${totalRuns} hashes matched across ${rows.length} case(s).`);
  console.log(`Tier B (statistical): ${rows.length - rows.filter((r) => !r.statsPass).length}/${rows.length} case means within band.`);

  if (strictFail) {
    console.log(
      `\n${strictFail} case(s) DRIFTED on the strict tier. A mismatch proves only that RNG\n` +
        `consumption order or the result tree changed — it is NOT by itself proof of a bug.\n` +
        `Read the Tier B column: agreement there makes the change CONSISTENT WITH behaviour\n` +
        `preservation, which is weaker than the strict tier's evidence and must be named as such.`
    );
    for (const r of rows.filter((x) => !x.strictPass)) {
      const m = r.mismatches[0];
      console.log(
        `  ${r.id}: ${r.seeds - r.strictMatched} seed(s) differ, first seed ${m.seed} ` +
          `expected ${String(m.expected).slice(0, 12)} got ${m.got.slice(0, 12)}`
      );
    }
  }
  if (statsFail) {
    console.log(`\n${statsFail} case(s) FAILED the statistical tier — the ensemble mean moved beyond the recorded band.`);
  }

  const jsonOut = arg('json');
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        { checkedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, tier, rows },
        null,
        2
      )
    );
    console.error(`wrote ${jsonOut}`);
  }

  const failed = (tier !== 'stats' && strictFail) || (tier !== 'strict' && statsFail);
  process.exit(failed ? 1 : 0);
}

// ---- entry -------------------------------------------------------------------

// Guarded: backrun.mjs imports measureCase/compare/listFixtures from here so
// that the two tools cannot drift on what a comparison means. Without this an
// import would run the CLI, print usage and exit(0) out from under the caller.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) switch (cmd) {
  case 'check':
    await cmdCheck();
    break;
  case 'record':
    await cmdRecord();
    break;
  default:
    console.log('Usage:');
    console.log('  npm run eval:check  [-- --only= --seeds= --tier=strict|stats|both --engine= --json=]');
    console.log('  npm run eval:record [-- --only= --seeds= --engine=]');
    process.exit(cmd ? 2 : 0);
}
