// =============================================================================
// rankCandidates — the paired run over whole candidates (Loadout, Abilities).
// Driven by a SYNTHETIC evaluator with a closed-form answer, as
// equipmentScan.test.mjs drives scanEquipment.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates, scanEquipment } from '../lib/equipmentScan/scan.js';

/** Deterministic, seedable noise in [-1, 1) (as equipmentScan.test.mjs). */
function hashNoise(...parts) {
  let h = 2166136261;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 2 ** 32) * 2 - 1;
}

const BASE = 100;
const PLAYERS = [{ hrid: 'player1', value: 0 }];

/** Objective = BASE + the subject's `value` (+ seed-only noise), every metric derived from it. */
function evaluator({ objective = 'encountersPerHour', fixed = null, pairedNoise = 0 } = {}) {
  return async (jobs) => jobs.map((job) => {
    const value = fixed ?? BASE + job.playerDTOs[0].value + pairedNoise * hashNoise('seed', job.seed);
    return {
      id: job.id,
      metrics: { [objective]: value, encountersPerHour: value, effectiveEncountersPerHour: value, deathsPerHour: 0 },
    };
  });
}

const applyCandidate = (dtos, row) => dtos.map((dto) => ({ ...dto, value: row.value }));

const CANDIDATES = [
  { id: 'c', label: 'C', value: -3, abilities: ['z'] },
  { id: 'a', label: 'A', value: 5, abilities: ['x'] },
  { id: 'b', label: 'B', value: 0, abilities: ['y'] },
];

test('rankCandidates ranks whole candidates best first with exact paired deltas', async () => {
  const replicates = 4;
  const result = await rankCandidates({
    playerDTOs: PLAYERS, candidates: CANDIDATES, evaluate: evaluator(), applyCandidate,
    objective: 'encountersPerHour', hours: 1, replicates,
  });
  assert.deepEqual(result.rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(result.rows.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(result.rows.map((r) => r.delta), [5, 0, -3]);
  for (const row of result.rows) assert.equal(row.deltaPct, row.delta / BASE);
  assert.equal(result.rows[0].significantFamilywise, true);
  assert.equal(result.rows[1].significantFamilywise, false);
  assert.equal(result.familySize, 3);
  assert.equal(result.simulationsRun, 4 * replicates);
  assert.equal(result.inconclusive, false);
  assert.equal(result.baseline.metrics.encountersPerHour, BASE);
  // The caller's fields ride through.
  assert.equal(result.rows[0].label, 'A');
  assert.deepEqual(result.rows[0].abilities, ['x']);
});

test('rankCandidates: nothing better is inconclusive; a clear rate pinned at 100 is the ceiling', async () => {
  const worse = await rankCandidates({
    playerDTOs: PLAYERS, candidates: CANDIDATES.filter((c) => c.value <= 0), evaluate: evaluator(), applyCandidate,
    objective: 'encountersPerHour', hours: 1, replicates: 3,
  });
  assert.equal(worse.inconclusive, true);
  const ceiling = await rankCandidates({
    playerDTOs: PLAYERS, candidates: CANDIDATES, evaluate: evaluator({ objective: 'clearRatePercent', fixed: 100 }),
    applyCandidate, objective: 'clearRatePercent', hours: 1, replicates: 3,
  });
  assert.equal(ceiling.saturated, 'ceiling');
});

test('rankCandidates: seed-only noise cancels in the pairing', async () => {
  const result = await rankCandidates({
    playerDTOs: PLAYERS, candidates: CANDIDATES, evaluate: evaluator({ pairedNoise: 20 }), applyCandidate,
    objective: 'encountersPerHour', hours: 1, replicates: 6,
  });
  const byId = Object.fromEntries(result.rows.map((r) => [r.id, r.delta]));
  assert.ok(Math.abs(byId.a - 5) < 1e-9);
  assert.ok(Math.abs(byId.b) < 1e-9);
  assert.ok(Math.abs(byId.c + 3) < 1e-9);
});

test('rankCandidates rejects with the caller\'s cancel message; scanEquipment keeps its own', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    rankCandidates({
      playerDTOs: PLAYERS, candidates: CANDIDATES, evaluate: evaluator(), applyCandidate,
      objective: 'encountersPerHour', hours: 1, replicates: 2, signal: controller.signal,
      cancelMessage: 'Loadout comparison cancelled',
    }),
    { name: 'AbortError', message: 'Loadout comparison cancelled' },
  );
  await assert.rejects(
    scanEquipment({
      playerDTOs: PLAYERS, candidates: [{ id: 'x', scannable: true, value: 1 }], evaluate: evaluator(), applyCandidate,
      objective: 'encountersPerHour', hours: 1, replicates: 2, signal: controller.signal,
    }),
    { name: 'AbortError', message: 'Equipment scan cancelled' },
  );
});
