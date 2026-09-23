// =============================================================================
// equipmentDungeon tests
//
// Run from api/:  npm test
//
// The equipment optimiser ranks a dungeon on completed runs per hour, exactly as
// the trigger optimiser does (see dungeonTarget.test.mjs for why: inside a
// dungeon `encounters` counts waves). Zones and labyrinths are unchanged.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareEquipmentRun } from '../routes/optimizeEquipment.js';
import { DUNGEON_REPORTED_METRICS, REPORTED_METRICS, reportedMetricsFor } from '../lib/triggerSearch/score.js';
import { scanEquipment } from '../lib/equipmentScan/scan.js';

const player = { hrid: 'player1', name: 'Alice', equipment: {}, abilities: [], food: [], drinks: [] };
const priced = { '/items/marsberry_donut': 30 };

test('a dungeon target ranks equipment on completions per hour', () => {
  const body = { players: [player], zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0 } };
  const run = prepareEquipmentRun(body);
  assert.equal(run.target.dungeon, true);
  assert.equal(run.objective, 'completionsPerHour');
  assert.equal(reportedMetricsFor(run.target), DUNGEON_REPORTED_METRICS);
  assert.ok(DUNGEON_REPORTED_METRICS.includes('dungeonFailuresPerHour'));
});

test('a dungeon with priced food ranks on completions per hour of total time', () => {
  const body = {
    players: [player],
    zone: { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0 },
    consumableCosts: priced,
  };
  assert.equal(prepareEquipmentRun(body).objective, 'effectiveCompletionsPerHour');
});

test('a planet keeps encounters per hour', () => {
  const zone = { zoneHrid: '/actions/combat/fly', difficultyTier: 0 };
  const plain = prepareEquipmentRun({ players: [player], zone });
  assert.equal(plain.target.dungeon, false);
  assert.equal(plain.objective, 'encountersPerHour');
  assert.equal(reportedMetricsFor(plain.target), REPORTED_METRICS);
  assert.equal(
    prepareEquipmentRun({ players: [player], zone, consumableCosts: priced }).objective,
    'effectiveEncountersPerHour'
  );
});

test('a labyrinth keeps its completion chance', () => {
  const run = prepareEquipmentRun({
    players: [player],
    labyrinth: { labyrinthHrid: '/monsters/cyclops', roomLevel: 100 },
    consumableCosts: priced,
  });
  assert.equal(run.target.kind, 'labyrinth');
  assert.equal(run.target.dungeon, false);
  assert.equal(run.objective, 'clearRatePercent');
});

// -- saturation on a dungeon nobody finishes -----------------------------------

const candidates = [
  { id: '0:/equipment_types/head', scannable: true, step: 6, requestedStep: 6 },
  { id: '0:/equipment_types/body', scannable: true, step: 6, requestedStep: 6 },
];

const scan = (rateOf) =>
  scanEquipment({
    playerDTOs: [{ hrid: 'player1' }],
    candidates,
    evaluate: async (jobs) =>
      jobs.map((job) => {
        const [id] = String(job.id).split('#');
        return { id: job.id, metrics: { completionsPerHour: rateOf(id), deathsPerHour: 0 } };
      }),
    applyCandidate: (dtos) => dtos,
    objective: 'completionsPerHour',
    hours: 1,
    replicates: 3,
  });

test('a dungeon nobody finishes, with or without the upgrade, is pinned at the floor', async () => {
  const result = await scan(() => 0);
  assert.equal(result.saturated, 'floor');
});

test('the floor is not claimed when an upgrade does finish runs', async () => {
  // The baseline finishes nothing; +6 on the helmet makes it finish some. That
  // is the most useful answer the scan can give, not "no run ever completes".
  const result = await scan((id) => (id === '0:/equipment_types/head' ? 0.5 : 0));
  assert.equal(result.saturated, null);
});

test('a dungeon with completions is ranked in the ordinary way', async () => {
  const result = await scan((id) => (id === '0:/equipment_types/head' ? 3.6 : 3));
  assert.equal(result.objective, 'completionsPerHour');
  assert.equal(result.saturated, null);
  assert.equal(result.rows[0].id, '0:/equipment_types/head');
  assert.ok(Math.abs(result.rows[0].perLevel - 0.1) < 1e-9, '0.6 runs/h over a +6 probe');
});

test('from a baseline that finishes nothing, upgrades rank on their absolute gain', async () => {
  // No percentage exists against a zero baseline, so every row's perLevelPct is
  // null; without a fallback they would all tie and fall back to id order.
  // Head is the bigger rescue and sorts AFTER body by id, so id order alone
  // would get this wrong.
  const result = await scan((id) =>
    id === '0:/equipment_types/head' ? 0.6 : id === '0:/equipment_types/body' ? 0.3 : 0
  );
  assert.equal(result.rows[0].perLevelPct, null);
  assert.equal(result.rows[0].id, '0:/equipment_types/head', 'the bigger rescue first');
  assert.equal(result.inconclusive, false);
});
