// =============================================================================
// equipmentScan tests
//
// Run from api/:  npm test
//
// Three layers, and the middle one is the reason this file is long.
//
//   * candidates — pure data predicates over the bundled itemDetailMap. Cheap.
//
//   * stats — the numerics. These are the tests that matter. An error bar that is
//     quietly wrong is far worse than no error bar, because the whole point of
//     the scan is to distinguish a real gain from a lucky one, and a reader has
//     no way to audit a confidence interval by eye. So the t machinery is pinned
//     against published quantiles, and the paired comparison is pinned against
//     cases whose answer is known by construction.
//
//   * scan — the funnel, driven by a SYNTHETIC evaluator with a closed-form
//     answer. No worker threads, no simulations; scanEquipment takes `evaluate`
//     as a parameter precisely so this is possible.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAVEATED_STATS,
  DEFAULT_STEP,
  MAX_ENHANCEMENT_LEVEL,
  applyEnhancement,
  caveatFor,
  enumerateEquipment,
  hasLiveEnhancementBonus,
  liveEnhancementStats,
  multiplierRatio,
} from '../lib/equipmentScan/candidates.js';

import {
  incompleteBeta,
  mean,
  pairedComparison,
  sidakAlpha,
  studentTCritical,
  studentTTwoSidedP,
  variance,
} from '../lib/equipmentScan/stats.js';

import { DEFAULT_SCAN, estimateWorkload, scanEquipment } from '../lib/equipmentScan/scan.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Deterministic, seedable noise in [-1, 1). Not cryptographic; just repeatable. */
function hashNoise(...parts) {
  let h = 2166136261;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 2 ** 32) * 2 - 1;
}

function playerWith(equipment) {
  return [{ hrid: 'player1', equipment }];
}

// A build whose head and main hand both enhance, so most tests have two rows.
const TWO_SLOT_BUILD = playerWith({
  '/equipment_types/head': { hrid: '/items/cheese_helmet', enhancementLevel: 0 },
  '/equipment_types/main_hand': { hrid: '/items/cheese_sword', enhancementLevel: 0 },
});

/**
 * Build a synthetic evaluator whose objective is an exact linear function of the
 * enhancement levels, plus optional noise.
 *
 * @param {object} opts
 * @param {number} opts.base            objective at zero enhancement
 * @param {Record<string, number>} opts.weights   slotKey -> objective per level
 * @param {number} [opts.pairedNoise]   amplitude of noise that depends only on the seed
 * @param {number} [opts.jobNoise]      amplitude of noise that also depends on the job
 */
function syntheticEvaluator({ base, weights, pairedNoise = 0, jobNoise = 0 }) {
  const calls = { batches: 0, jobs: 0 };
  const evaluate = async (jobs) => {
    calls.batches += 1;
    calls.jobs += jobs.length;
    return jobs.map((job) => {
      const equipment = job.playerDTOs[0].equipment;
      let value = base;
      for (const [slotKey, weight] of Object.entries(weights)) {
        value += (equipment[slotKey]?.enhancementLevel || 0) * weight;
      }
      // Seed-only noise is what a perfectly paired design would face: it cancels
      // exactly in the difference. Job noise does not cancel.
      value += pairedNoise * hashNoise('seed', job.seed);
      value += jobNoise * hashNoise('job', job.id, job.seed);
      return {
        id: job.id,
        metrics: {
          encountersPerHour: value,
          effectiveEncountersPerHour: value,
          deathsPerHour: 0,
          experiencePerHour: value * 10,
          damagePerSecond: value / 10,
          consumablesPerHour: 0,
          consumableSecondsPerHour: 0,
          enemyKillsPerHour: value,
          outOfManaSecondsPerHour: 0,
          consumableCostsKnown: false,
          ranOutOfMana: false,
        },
      };
    });
  };
  return { evaluate, calls };
}

// ===========================================================================
// candidates
// ===========================================================================

test('MAX_ENHANCEMENT_LEVEL comes from the multiplier table and is +20', () => {
  assert.equal(MAX_ENHANCEMENT_LEVEL, 20);
});

test('enumerateEquipment marks a normal item scannable and steps it by six', () => {
  const rows = enumerateEquipment(TWO_SLOT_BUILD);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.scannable, true);
    assert.equal(row.step, DEFAULT_STEP);
    assert.equal(row.targetLevel, 6);
    assert.equal(row.reason, null);
  }
});

test('enumerateEquipment clamps the step at the cap rather than overshooting it', () => {
  // An over-cap level indexes past the multiplier table, yielding undefined and
  // hence NaN stats: a simulation that neither throws nor means anything.
  const rows = enumerateEquipment(
    playerWith({ '/equipment_types/head': { hrid: '/items/cheese_helmet', enhancementLevel: 17 } })
  );
  assert.equal(rows[0].scannable, true);
  assert.equal(rows[0].step, 3);
  assert.equal(rows[0].targetLevel, MAX_ENHANCEMENT_LEVEL);
  assert.equal(rows[0].requestedStep, DEFAULT_STEP);
});

test('enumerateEquipment skips an item already at the cap', () => {
  const rows = enumerateEquipment(
    playerWith({ '/equipment_types/head': { hrid: '/items/cheese_helmet', enhancementLevel: 20 } })
  );
  assert.equal(rows[0].scannable, false);
  assert.match(rows[0].reason, /already at \+20/);
});

test('enumerateEquipment skips an item with no combat stat gains from enhancing', () => {
  const rows = enumerateEquipment(
    playerWith({
      '/equipment_types/charm': { hrid: '/items/advanced_alchemy_charm', enhancementLevel: 0 },
    })
  );
  assert.equal(rows[0].scannable, false);
  assert.match(rows[0].reason, /no combat stat gains/);
});

test('enumerateEquipment reports an unknown hrid rather than throwing', () => {
  const rows = enumerateEquipment(
    playerWith({ '/equipment_types/head': { hrid: '/items/not_a_real_item', enhancementLevel: 0 } })
  );
  assert.equal(rows[0].scannable, false);
  assert.equal(rows[0].reason, 'unknown item');
});

test('enumerateEquipment ignores empty slots', () => {
  const rows = enumerateEquipment(
    playerWith({
      '/equipment_types/head': null,
      '/equipment_types/body': { hrid: '', enhancementLevel: 0 },
    })
  );
  assert.equal(rows.length, 0);
});

test('hasLiveEnhancementBonus mirrors the engine gate on the BASE stat', () => {
  // Equipment.getCombatStat consults the bonus only when the base stat is
  // truthy, so a bonus on an absent stat is dead weight in the engine and must
  // be dead weight here too.
  assert.equal(
    hasLiveEnhancementBonus({
      equipmentDetail: { combatStats: { armor: 2 }, combatEnhancementBonuses: { armor: 0.04 } },
    }),
    true
  );
  assert.equal(
    hasLiveEnhancementBonus({
      equipmentDetail: { combatStats: { armor: 0 }, combatEnhancementBonuses: { armor: 0.04 } },
    }),
    false
  );
  assert.equal(
    hasLiveEnhancementBonus({
      equipmentDetail: { combatStats: { armor: 2 }, combatEnhancementBonuses: {} },
    }),
    false
  );
  assert.equal(hasLiveEnhancementBonus({}), false);
});

test('a task badge is scanned but carries the engine caveat', () => {
  // The engine multiplies EVERY damage roll by (1 + taskDamage) with no test that
  // the target is on task, so this row is right only for an always-on-task
  // player. Measured and flagged rather than excluded — see CAVEATED_STATS.
  const rows = enumerateEquipment(
    playerWith({
      '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 3 },
    })
  );
  assert.equal(rows[0].scannable, true);
  assert.deepEqual(rows[0].gainedStats, ['taskDamage']);
  assert.equal(rows[0].caveat, CAVEATED_STATS.taskDamage);
});

test('an ordinary item gains several stats and carries no caveat', () => {
  const rows = enumerateEquipment(
    playerWith({ '/equipment_types/head': { hrid: '/items/cheese_helmet', enhancementLevel: 0 } })
  );
  assert.ok(rows[0].gainedStats.includes('armor'));
  assert.equal(rows[0].caveat, null);
});

test('caveatFor fires only when every gained stat is caveated', () => {
  assert.equal(caveatFor(['taskDamage']), CAVEATED_STATS.taskDamage);
  // Mixed: the item is measured fairly enough that a warning would be noise.
  assert.equal(caveatFor(['taskDamage', 'armor']), null);
  assert.equal(caveatFor(['armor']), null);
  assert.equal(caveatFor([]), null);
});

test('liveEnhancementStats lists exactly the stats the engine will move', () => {
  const stats = liveEnhancementStats({
    equipmentDetail: {
      combatStats: { armor: 2, criticalRate: 0 },
      combatEnhancementBonuses: { armor: 0.04, criticalRate: 0.002, evasion: 0.1 },
    },
  });
  // criticalRate has a zero base so the engine ignores it; evasion has no base
  // stat at all. Only armor survives.
  assert.deepEqual(stats, ['armor']);
});

test('multiplierRatio is exactly 1 for a single level and above 1 for six', () => {
  assert.equal(multiplierRatio(0, 1), 1);
  // The table is convex, so a six-level probe buys more per level than the next
  // single level does. The reported per-level figure is optimistic by this much.
  assert.ok(multiplierRatio(0, 6) > 1);
  assert.ok(multiplierRatio(0, 6) < 1.5);
  assert.equal(multiplierRatio(20, 20), null);
});

test('applyEnhancement deep-clones and never mutates the caller', () => {
  const [row] = enumerateEquipment(TWO_SLOT_BUILD);
  const applied = applyEnhancement(TWO_SLOT_BUILD, row);
  assert.equal(applied[0].equipment[row.slotKey].enhancementLevel, 6);
  assert.equal(TWO_SLOT_BUILD[0].equipment[row.slotKey].enhancementLevel, 0);
  assert.notEqual(applied[0], TWO_SLOT_BUILD[0]);
});

test('applyEnhancement clamps to the cap and rejects an empty slot', () => {
  const [row] = enumerateEquipment(TWO_SLOT_BUILD);
  const applied = applyEnhancement(TWO_SLOT_BUILD, { ...row, targetLevel: 99 });
  assert.equal(applied[0].equipment[row.slotKey].enhancementLevel, MAX_ENHANCEMENT_LEVEL);
  assert.throws(
    () => applyEnhancement(TWO_SLOT_BUILD, { ...row, slotKey: '/equipment_types/feet' }),
    /has nothing in/
  );
});

// ===========================================================================
// stats — the numerics
// ===========================================================================

test('incompleteBeta obeys the reflection identity across the branch boundary', () => {
  for (const [a, b] of [[0.5, 3], [2, 5], [7, 0.5], [1, 1]]) {
    for (const x of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const left = incompleteBeta(a, b, x);
      const right = 1 - incompleteBeta(b, a, 1 - x);
      assert.ok(Math.abs(left - right) < 1e-10, `I_${x}(${a},${b}) mismatch: ${left} vs ${right}`);
    }
  }
  assert.equal(incompleteBeta(2, 3, 0), 0);
  assert.equal(incompleteBeta(2, 3, 1), 1);
});

test('studentTCritical matches published two-sided 95% quantiles', () => {
  // Any statistics table. These are the numbers the confidence intervals rest on.
  const expected = { 1: 12.706, 2: 4.303, 5: 2.571, 10: 2.228, 20: 2.086, 30: 2.042 };
  for (const [df, value] of Object.entries(expected)) {
    const actual = studentTCritical(0.05, Number(df));
    assert.ok(
      Math.abs(actual - value) < 0.001,
      `t(0.05, ${df}) = ${actual}, expected ${value}`
    );
  }
  // Converges on the normal quantile as df grows.
  assert.ok(Math.abs(studentTCritical(0.05, 100000) - 1.95996) < 0.001);
});

test('studentTCritical matches published quantiles at other confidence levels', () => {
  assert.ok(Math.abs(studentTCritical(0.01, 5) - 4.032) < 0.001);
  assert.ok(Math.abs(studentTCritical(0.1, 5) - 2.015) < 0.001);
  // Monotone: a stricter test demands a larger t.
  assert.ok(studentTCritical(0.001, 5) > studentTCritical(0.01, 5));
  assert.ok(studentTCritical(0.01, 5) > studentTCritical(0.05, 5));
});

test('studentTTwoSidedP is 1 at zero and falls monotonically', () => {
  assert.ok(Math.abs(studentTTwoSidedP(0, 5) - 1) < 1e-12);
  assert.ok(studentTTwoSidedP(1, 5) > studentTTwoSidedP(2, 5));
  assert.ok(studentTTwoSidedP(2, 5) > studentTTwoSidedP(4, 5));
  // Round-trip against the quantile.
  assert.ok(Math.abs(studentTTwoSidedP(studentTCritical(0.05, 9), 9) - 0.05) < 1e-9);
});

test('sidakAlpha tightens with the number of comparisons', () => {
  assert.equal(sidakAlpha(0.05, 1), 0.05);
  // Fourteen slots tested at once: about a 51% chance of one false positive
  // under a true null unless the per-test bar moves.
  assert.ok(Math.abs(sidakAlpha(0.05, 14) - 0.003657) < 1e-5);
  assert.ok(sidakAlpha(0.05, 14) < sidakAlpha(0.05, 5));
  // By construction the family-wise rate is held at alpha.
  const n = 14;
  assert.ok(Math.abs(1 - (1 - sidakAlpha(0.05, n)) ** n - 0.05) < 1e-12);
});

test('mean and variance use Bessel correction and tolerate short input', () => {
  assert.equal(mean([]), 0);
  assert.equal(variance([]), 0);
  assert.equal(variance([5]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(variance([1, 2, 3]), 1);
});

test('pairedComparison with one replicate reports the difference but claims nothing', () => {
  const result = pairedComparison([12], [10]);
  assert.equal(result.samples, 1);
  assert.equal(result.deltaMean, 2);
  assert.equal(result.significant, false);
  assert.equal(result.marginOfError, null);
});

test('pairedComparison detects a constant offset as significant', () => {
  // Seed-only noise cancels exactly, so the differences are identical and the
  // standard error is zero. A real gain measured with no spread is real.
  const baseline = [10, 12, 9, 11, 13, 10];
  const candidate = baseline.map((value) => value + 2);
  const result = pairedComparison(candidate, baseline, { alpha: 0.05, familySize: 10 });
  assert.equal(result.samples, 6);
  assert.ok(Math.abs(result.deltaMean - 2) < 1e-12);
  assert.equal(result.deltaSd, 0);
  assert.equal(result.significant, true);
  assert.equal(result.significantFamilywise, true);
  assert.ok(result.pairingEfficiency > 0.99);
});

test('pairedComparison calls a zero-mean difference insignificant', () => {
  const baseline = [10, 12, 9, 11, 13, 10];
  // Differences +1, -1, +1, -1, -1, +1: spread without drift.
  const candidate = [11, 11, 10, 10, 12, 11];
  const result = pairedComparison(candidate, baseline, { alpha: 0.05, familySize: 1 });
  assert.ok(Math.abs(result.deltaMean) < 1e-9);
  assert.equal(result.significant, false);
});

test('pairedComparison holds the family-wise bar above the per-comparison one', () => {
  const baseline = [10, 12, 9, 11, 13, 10];
  const candidate = [11, 12.5, 10, 11.4, 13.9, 10.6];
  const single = pairedComparison(candidate, baseline, { alpha: 0.05, familySize: 1 });
  const family = pairedComparison(candidate, baseline, { alpha: 0.05, familySize: 14 });
  assert.equal(single.marginOfError, family.marginOfError);
  assert.ok(family.marginOfErrorFamilywise > single.marginOfError);
  // Same evidence, stricter claim: family-wise significance implies per-test.
  assert.ok(!family.significantFamilywise || family.significant);
});

test('pairedComparison drops a failed simulation pairwise, not unilaterally', () => {
  // A hole on either side must remove the PAIR. Keeping the partner would
  // compare a candidate seed against a baseline from a different seed, which is
  // exactly the correlation the paired design exists to exploit.
  const baseline = [10, 12, NaN, 11];
  const candidate = [12, 14, 13, NaN];
  const result = pairedComparison(candidate, baseline);
  assert.equal(result.samples, 2);
  assert.equal(result.deltaMean, 2);
});

test('pairedComparison reports the pairing efficiency it actually achieved', () => {
  // Independent noise on each side: sharing a seed bought nothing, and the
  // paired test degenerates to the unpaired one. Reported, not hidden.
  const baseline = [10, 14, 9, 13, 8, 12];
  const candidate = [13, 9, 14, 8, 13, 10];
  const result = pairedComparison(candidate, baseline);
  assert.ok(result.pairingEfficiency < 0.5);
  assert.ok(result.pairingEfficiency >= -1 && result.pairingEfficiency <= 1);
});

test('pairedComparison confidence interval brackets the mean symmetrically', () => {
  const baseline = [10, 12, 9, 11, 13, 10];
  const candidate = [11, 12.5, 10, 11.4, 13.9, 10.6];
  const result = pairedComparison(candidate, baseline);
  assert.ok(result.confidenceLow < result.deltaMean);
  assert.ok(result.confidenceHigh > result.deltaMean);
  const width = result.confidenceHigh - result.confidenceLow;
  assert.ok(Math.abs(width - 2 * result.marginOfError) < 1e-12);
  // Significance and the interval must agree: excluding zero IS the test.
  assert.equal(result.significant, result.confidenceLow > 0 || result.confidenceHigh < 0);
});

// ===========================================================================
// scan
// ===========================================================================

test('estimateWorkload counts the baseline once per replicate', () => {
  const workload = estimateWorkload(14, { hours: 24, replicates: 6 });
  assert.equal(workload.perReplicate, 15);
  assert.equal(workload.total, 90);
  assert.equal(workload.simulatedHours, 2160);
});

test('estimateWorkload floors the replicate count at one', () => {
  assert.equal(estimateWorkload(3, { hours: 10, replicates: 0 }).replicates, DEFAULT_SCAN.replicates);
});

test('scanEquipment recovers a known per-level value and ranks by it', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  // Head is worth twice the main hand per level, and both are exactly linear —
  // so the per-level figures must come back as the weights themselves.
  const { evaluate, calls } = syntheticEvaluator({
    base: 100,
    weights: { '/equipment_types/head': 2, '/equipment_types/main_hand': 1 },
    pairedNoise: 5,
  });

  const result = await scanEquipment({
    playerDTOs: TWO_SLOT_BUILD,
    candidates,
    evaluate,
    applyCandidate: applyEnhancement,
    objective: 'encountersPerHour',
    hours: 24,
    replicates: 4,
  });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].slotKey, '/equipment_types/head');
  assert.equal(result.rows[1].slotKey, '/equipment_types/main_hand');
  assert.ok(Math.abs(result.rows[0].perLevel - 2) < 1e-9);
  assert.ok(Math.abs(result.rows[1].perLevel - 1) < 1e-9);
  // The whole probe bought six levels' worth.
  assert.ok(Math.abs(result.rows[0].probeDelta - 12) < 1e-9);
  // The percentage is relative to the baseline this run actually measured, which
  // the seed noise moves off 100 — not to the noiseless 100 it was built from.
  const measuredBaseline = result.rows[0].statistics.baselineMean;
  assert.ok(Math.abs(result.rows[0].perLevelPct - 2 / measuredBaseline) < 1e-12);
  // Seed-only noise cancels in the pairing, so both are called real.
  assert.ok(result.rows.every((row) => row.significant));
  assert.equal(result.inconclusive, false);
  assert.equal(result.simulationsRun, 12);
  assert.equal(calls.jobs, 12);
  assert.equal(calls.batches, 4);
});

test('scanEquipment divides by the step actually used, not the one requested', async () => {
  // An item at +17 is probed three levels. Dividing by six would halve its worth.
  const build = playerWith({
    '/equipment_types/head': { hrid: '/items/cheese_helmet', enhancementLevel: 17 },
  });
  const candidates = enumerateEquipment(build);
  assert.equal(candidates[0].step, 3);

  const { evaluate } = syntheticEvaluator({
    base: 100,
    weights: { '/equipment_types/head': 2 },
  });
  const result = await scanEquipment({
    playerDTOs: build,
    candidates,
    evaluate,
    applyCandidate: applyEnhancement,
    objective: 'encountersPerHour',
    replicates: 3,
  });

  assert.ok(Math.abs(result.rows[0].probeDelta - 6) < 1e-9);
  assert.ok(Math.abs(result.rows[0].perLevel - 2) < 1e-9);
});

test('scanEquipment calls a run inconclusive when nothing clears the noise', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  const { evaluate } = syntheticEvaluator({
    base: 100,
    weights: { '/equipment_types/head': 0, '/equipment_types/main_hand': 0 },
    jobNoise: 20,
  });

  const result = await scanEquipment({
    playerDTOs: TWO_SLOT_BUILD,
    candidates,
    evaluate,
    applyCandidate: applyEnhancement,
    objective: 'encountersPerHour',
    replicates: 6,
  });

  assert.equal(result.inconclusive, true);
  assert.ok(result.rows.every((row) => !row.significant));
  // The noise is still measured and reported rather than swallowed.
  assert.equal(result.noise.calibrated, true);
  assert.ok(result.noise.coefficientOfVariation > 0);
});

test('scanEquipment reports progress monotonically and bounded', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  const { evaluate } = syntheticEvaluator({ base: 100, weights: {} });
  const seen = [];

  await scanEquipment({
    playerDTOs: TWO_SLOT_BUILD,
    candidates,
    evaluate,
    applyCandidate: applyEnhancement,
    objective: 'encountersPerHour',
    replicates: 3,
    onProgress: (progress) => seen.push(progress),
  });

  assert.ok(seen.length > 0);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i].progress >= seen[i - 1].progress, 'progress went backwards');
  }
  assert.ok(seen.every((p) => p.progress >= 0 && p.progress <= 1));
  assert.equal(seen[seen.length - 1].progress, 1);
});

test('scanEquipment survives individual simulation failures', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  let call = 0;
  const evaluate = async (jobs) =>
    jobs.map((job) => {
      call += 1;
      // Fail one candidate simulation in the first batch.
      if (call === 2) return { id: job.id, error: 'worker died' };
      const level = job.playerDTOs[0].equipment['/equipment_types/head'].enhancementLevel;
      return { id: job.id, metrics: { encountersPerHour: 100 + level, effectiveEncountersPerHour: 100 + level } };
    });

  const result = await scanEquipment({
    playerDTOs: TWO_SLOT_BUILD,
    candidates,
    evaluate,
    applyCandidate: applyEnhancement,
    objective: 'encountersPerHour',
    replicates: 3,
  });

  const head = result.rows.find((row) => row.slotKey === '/equipment_types/head');
  assert.equal(head.statistics.samples, 2, 'the failed replicate should be dropped, not zeroed');
  assert.ok(Math.abs(head.perLevel - 1) < 1e-9, 'surviving replicates still give the right answer');
});

test('scanEquipment refuses a selection with nothing to scan', async () => {
  await assert.rejects(
    scanEquipment({
      playerDTOs: TWO_SLOT_BUILD,
      candidates: [],
      evaluate: async () => [],
      applyCandidate: applyEnhancement,
    }),
    /No scannable equipment/
  );
});

test('scanEquipment throws when every baseline simulation fails', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  const evaluate = async (jobs) =>
    jobs.map((job) =>
      job.id.startsWith('baseline')
        ? { id: job.id, error: 'boom' }
        : { id: job.id, metrics: { encountersPerHour: 100 } }
    );

  await assert.rejects(
    scanEquipment({
      playerDTOs: TWO_SLOT_BUILD,
      candidates,
      evaluate,
      applyCandidate: applyEnhancement,
      objective: 'encountersPerHour',
      replicates: 2,
    }),
    /Every baseline simulation failed/
  );
});

test('scanEquipment aborts promptly when signalled', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  const controller = new AbortController();
  const { evaluate } = syntheticEvaluator({ base: 100, weights: {} });
  controller.abort();

  await assert.rejects(
    scanEquipment({
      playerDTOs: TWO_SLOT_BUILD,
      candidates,
      evaluate,
      applyCandidate: applyEnhancement,
      objective: 'encountersPerHour',
      replicates: 3,
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError'
  );
});

test('scanEquipment carries the per-slot metadata a UI needs to render a row', async () => {
  const candidates = enumerateEquipment(TWO_SLOT_BUILD);
  const { evaluate } = syntheticEvaluator({
    base: 100,
    weights: { '/equipment_types/head': 2, '/equipment_types/main_hand': 1 },
  });
  const result = await scanEquipment({
    playerDTOs: TWO_SLOT_BUILD,
    candidates,
    evaluate,
    applyCandidate: applyEnhancement,
    objective: 'encountersPerHour',
    replicates: 3,
  });

  const row = result.rows[0];
  for (const key of ['rank', 'slotName', 'itemName', 'itemHrid', 'currentLevel', 'targetLevel', 'step']) {
    assert.ok(row[key] !== undefined, `row is missing ${key}`);
  }
  assert.ok(row.metrics.encountersPerHour > 0);
  assert.ok(row.deltas.encountersPerHour);
  assert.equal(result.familySize, 2);
  assert.equal(result.baseline.usableSamples, 3);
});
