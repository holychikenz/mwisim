// =============================================================================
// stats — paired-difference statistics for the equipment scan
//
// The quantity being measured is small and the measurement is noisy, which is
// the whole difficulty. TRIGGER-OPTIMIZER.md records the run-to-run spread of
// encounters/hour at 24 simulated hours: 0.077% on `fly`, 2.942% on
// `enchanted_fortress`. A single +1 on one glove will not clear the latter. Six
// levels might, and only just — so the arithmetic that decides "this is a real
// gain" has to be right rather than merely plausible.
//
// THREE DECISIONS, EACH LOAD-BEARING.
//
// 1. PAIRED, NOT UNPAIRED. Every candidate is run on the SAME set of seeds as
//    the baseline, and the statistic is the mean of the per-seed differences
//    rather than the difference of the means. This is the common-random-numbers
//    trick, and its appeal is that it can only help: if the two runs correlate,
//    var(d) < var(a) + var(b) and the test gains power; if the seed buys no
//    correlation at all, var(d) equals var(a) + var(b) and the test is exactly
//    the unpaired one. Validity never depends on the correlation, only power.
//
//    Whether it DOES correlate is an empirical question and not an obvious one.
//    The two builds share a seed, so they share the spawn sequence — until the
//    stronger build kills something a fraction faster, consumes a different
//    number of draws, and the streams slide out of step. So `pairingEfficiency`
//    is computed and reported rather than assumed: it is the fraction of
//    variance the pairing actually removed on this run, on this zone.
//
// 2. STUDENT-t, NOT NORMAL. With six replicates the sample standard deviation is
//    itself a poor estimate, and 1.96 standard errors is not a 95% interval —
//    it is nearer 88%. t at five degrees of freedom is 2.571. Using the normal
//    quantile at these sample sizes would systematically overstate confidence,
//    which is precisely the failure mode this file exists to prevent. The
//    quantile is computed rather than looked up so the replicate count is free.
//
// 3. A FAMILY-WISE FLAG ALONGSIDE THE PER-SLOT ONE. Fourteen slots tested at 95%
//    confidence yield, under a true null, about a 51% chance that at least one
//    slot looks significant. Ranking then puts that accident at the top, which
//    is the one place a reader will look. So each row carries BOTH: `significant`
//    (this slot's gain differs from zero) and `significantFamilywise` (it
//    survives a Sidak correction for having asked the question of every slot at
//    once). The headline claim — "spend your next levels here" — is a family-wise
//    claim and is flagged as such.
//
// The t machinery is the regularised incomplete beta function by continued
// fraction (Lentz), the CDF built on it, and the quantile by bisection. It is
// textbook and it is exact to the precision anyone here needs; the alternative,
// a hard-coded 95% table, would have foreclosed decision 3.
// =============================================================================

/** Convergence controls for the continued fraction. Ample for double precision. */
const BETACF_MAX_ITERATIONS = 300;
const BETACF_EPSILON = 1e-14;
const BETACF_TINY = 1e-300;

/** Log-gamma, Lanczos approximation (g=7, n=9). Accurate to ~15 digits. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) {
    // Reflection: G(x)G(1-x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction core of the incomplete beta, evaluated by Lentz's method. */
function betacf(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETACF_TINY) d = BETACF_TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= BETACF_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETACF_TINY) d = BETACF_TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < BETACF_TINY) c = BETACF_TINY;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETACF_TINY) d = BETACF_TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < BETACF_TINY) c = BETACF_TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < BETACF_EPSILON) break;
  }
  return h;
}

/**
 * Regularised incomplete beta function I_x(a, b).
 *
 * @param {number} a
 * @param {number} b
 * @param {number} x  in [0, 1]
 * @returns {number}
 */
export function incompleteBeta(a, b, x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  // The fraction converges quickly only for x < (a+1)/(a+b+2); use the symmetry
  // I_x(a,b) = 1 - I_{1-x}(b,a) elsewhere.
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-sided Student-t tail probability: P(|T| >= |t|) with `df` degrees of freedom.
 *
 * @param {number} t
 * @param {number} df
 * @returns {number}
 */
export function studentTTwoSidedP(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

/**
 * Critical t value for a two-sided test at significance `alpha`.
 *
 * Bisection on the tail probability, which is monotone in t. Fifty iterations
 * over [0, 1e3] resolves to ~1e-12, far past anything that matters here.
 *
 * @param {number} alpha  e.g. 0.05 for 95% confidence
 * @param {number} df
 * @returns {number}
 */
export function studentTCritical(alpha, df) {
  if (!(df > 0) || !(alpha > 0) || !(alpha >= Number.EPSILON) || alpha >= 1) return Infinity;
  let low = 0;
  let high = 1e3;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (studentTTwoSidedP(mid, df) > alpha) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Per-comparison alpha that holds the FAMILY-wise error rate at `alpha` across
 * `count` independent tests (Sidak). Slightly less brutal than Bonferroni and
 * exact under independence; the tests here are near enough independent, sharing
 * only the baseline.
 *
 * @param {number} alpha
 * @param {number} count
 * @returns {number}
 */
export function sidakAlpha(alpha, count) {
  const n = Math.max(1, Math.floor(count) || 1);
  if (n === 1) return alpha;
  return 1 - (1 - alpha) ** (1 / n);
}

/** Sample mean. */
export function mean(values) {
  const list = (values || []).filter(Number.isFinite);
  if (!list.length) return 0;
  return list.reduce((total, value) => total + value, 0) / list.length;
}

/** Sample variance with Bessel's correction. Zero for fewer than two samples. */
export function variance(values) {
  const list = (values || []).filter(Number.isFinite);
  if (list.length < 2) return 0;
  const m = mean(list);
  return list.reduce((total, value) => total + (value - m) ** 2, 0) / (list.length - 1);
}

/**
 * Paired comparison of a candidate against a baseline over shared seeds.
 *
 * Both arrays must be index-aligned by seed: `candidate[i]` and `baseline[i]`
 * are the same seed. Entries where either side is not finite are dropped as a
 * pair, so one failed simulation costs its partner rather than corrupting the
 * mean.
 *
 * @param {number[]} candidateSamples
 * @param {number[]} baselineSamples
 * @param {object} [opts]
 * @param {number} [opts.alpha]            per-comparison significance, default 0.05
 * @param {number} [opts.familySize]       number of candidates tested together
 * @returns {object}
 */
export function pairedComparison(candidateSamples, baselineSamples, { alpha = 0.05, familySize = 1 } = {}) {
  const pairs = [];
  const length = Math.min(candidateSamples?.length || 0, baselineSamples?.length || 0);
  for (let i = 0; i < length; i += 1) {
    const a = Number(candidateSamples[i]);
    const b = Number(baselineSamples[i]);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push({ a, b });
  }

  const n = pairs.length;
  const candidateMean = mean(pairs.map((p) => p.a));
  const baselineMean = mean(pairs.map((p) => p.b));
  const differences = pairs.map((p) => p.a - p.b);
  const deltaMean = mean(differences);

  const base = {
    samples: n,
    candidateMean,
    baselineMean,
    deltaMean,
    deltaSd: 0,
    deltaSe: 0,
    df: Math.max(0, n - 1),
    tStatistic: null,
    pValue: null,
    tCritical: null,
    tCriticalFamilywise: null,
    marginOfError: null,
    marginOfErrorFamilywise: null,
    confidenceLow: null,
    confidenceHigh: null,
    significant: false,
    significantFamilywise: false,
    pairingEfficiency: null,
  };

  // One replicate gives a difference but no error bar at all. Reporting the
  // difference with `significant: false` is the honest reading: we measured
  // something and have no idea whether it is real.
  if (n < 2) return base;

  const deltaVariance = variance(differences);
  const deltaSd = Math.sqrt(deltaVariance);
  const deltaSe = deltaSd / Math.sqrt(n);
  const df = n - 1;

  const tCritical = studentTCritical(alpha, df);
  const tCriticalFamilywise = studentTCritical(sidakAlpha(alpha, familySize), df);
  const marginOfError = tCritical * deltaSe;
  const marginOfErrorFamilywise = tCriticalFamilywise * deltaSe;

  // A zero standard error means every replicate agreed exactly. That happens
  // with a deterministic evaluator (the tests) and, in principle, on a build
  // whose outcome does not depend on the RNG at all. Treat a non-zero mean as
  // significant and a zero mean as not, rather than dividing by zero.
  const degenerate = !(deltaSe > 0);
  const tStatistic = degenerate ? null : deltaMean / deltaSe;

  // The pairing's actual payoff on this run: how much of the variance that an
  // unpaired comparison would have carried was removed by sharing seeds.
  const unpairedVariance = variance(pairs.map((p) => p.a)) + variance(pairs.map((p) => p.b));
  const pairingEfficiency =
    unpairedVariance > 0 ? Math.max(-1, Math.min(1, 1 - deltaVariance / unpairedVariance)) : null;

  return {
    ...base,
    deltaSd,
    deltaSe,
    df,
    tStatistic,
    pValue: degenerate ? null : studentTTwoSidedP(tStatistic, df),
    tCritical,
    tCriticalFamilywise,
    marginOfError,
    marginOfErrorFamilywise,
    confidenceLow: deltaMean - marginOfError,
    confidenceHigh: deltaMean + marginOfError,
    significant: degenerate ? Math.abs(deltaMean) > 0 : Math.abs(deltaMean) > marginOfError,
    significantFamilywise: degenerate
      ? Math.abs(deltaMean) > 0
      : Math.abs(deltaMean) > marginOfErrorFamilywise,
    pairingEfficiency,
  };
}
