// =============================================================================
// evalHarness tests
//
// Run from api/:  npm test
//
// Five guards on api/eval/. They are not tests of the simulator — the corpus in
// fixtures/eval is that — they are tests of the things the corpus CANNOT catch
// because it would be recorded through them.
//
//   1. the duplicated calling convention still calls the engine the same way
//   2. the wall-clock redaction works
//   3. the wall-clock redaction is not over-broad
//   4. seeds are stable and independent of catalogue order
//   5. the case validator reports every violation, not the first
//
// Test 1 is the one that matters. api/eval/engine.mjs deliberately does not
// import api/lib/simulator.js (see that file's header: the historical copy
// drifted across the span being measured, so importing it would confound the
// harness with the engine). The price is a duplicated ~12-line body that can
// silently diverge from the real one, and this test is the only thing standing
// between that duplication and a corpus recorded through a harness that quietly
// stopped simulating what the product simulates.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { canonical, digest, withSeed, REDACTED } from '../lib/determinism.mjs';
import { allEvalCases, seedsFor, validateEvalCases, fnv1a32, EVAL_HOURS } from '../eval/cases.mjs';
import { loadEngine } from '../eval/engine.mjs';
import { runSimulation } from '../lib/simulator.js';
import { BUILDS, partyBuilds, toCsimPlayer } from '../bench/builds.mjs';

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// -- 1. the harness calls the engine exactly as the product does -------------

test('eval/engine.mjs reproduces runSimulation() bit for bit', async () => {
  const engine = await loadEngine(ROOT);
  const { itemDetailMap: items, abilityDetailMap: abilityData } = engine.gameData;
  const cases = allEvalCases();

  // One solo and one five-player dungeon: the two shapes whose calling
  // conventions differ most (single player vs. structuredClone of five, open
  // zone vs. dungeon wave machinery).
  for (const id of ['melee-solo', 'dungeon-den-600']) {
    const kase = cases.find((c) => c.id === id);
    assert.ok(kase, `case ${id} missing from the catalogue`);

    const seed = seedsFor(id, 1)[0];

    const viaHarness = await withSeed(seed, () => engine.runZone(kase, EVAL_HOURS));

    // The product path, built from the same catalogue declaration so the only
    // difference under test is the calling convention itself.
    const players = partyBuilds(kase).map((name, i) =>
      toCsimPlayer(BUILDS[name], { level: kase.level, index: i + 1, items, abilityData })
    );
    const realLog = console.log;
    console.log = () => {};
    let viaProduct;
    try {
      viaProduct = await withSeed(seed, () =>
        runSimulation({
          players,
          zone: { zoneHrid: `/actions/combat/${kase.zone}`, difficultyTier: kase.tier },
          simulationTimeLimit: EVAL_HOURS * 3600e9,
          extra: {},
        })
      );
    } finally {
      console.log = realLog;
    }

    assert.equal(
      digest(canonical(viaHarness)),
      digest(canonical(viaProduct)),
      `${id}: api/eval/engine.mjs and api/lib/simulator.js no longer agree. One of them changed ` +
        `how the engine is called, and every fixture in fixtures/eval was recorded through the former.`
    );
  }
});

// -- 2. the redaction works --------------------------------------------------

test('canonical() redacts the wall-clock stamp on wipeEvents', () => {
  // src/combatsimulator/simResult.js:197 stamps each wipe with
  // new Date().toISOString(). Two runs identical in every other respect must
  // hash the same, or a wipe-heavy case can never be a fixture.
  const make = (stamp) => ({
    encounters: 7,
    wipeEvents: [
      { simulationTime: 1000, wave: 3, logs: ['a'], timestamp: stamp },
      { simulationTime: 2000, wave: 4, logs: ['b'], timestamp: stamp },
    ],
  });

  const a = canonical(make('2026-09-21T07:00:00.000Z'));
  const b = canonical(make('2026-09-21T09:30:11.921Z'));

  assert.equal(digest(a), digest(b));
  assert.equal(a.wipeEvents[0].timestamp, REDACTED);
  // Everything else in the wipe survives — the redaction replaces one field,
  // it does not blank the event.
  assert.equal(a.wipeEvents[0].wave, 3);
  assert.equal(a.wipeEvents[1].simulationTime, 2000);
});

// -- 3. the redaction is not over-broad --------------------------------------

test('canonical() redacts only wipeEvents timestamps, and only that field', () => {
  // A real difference inside a wipe event must still reach the hash.
  const wipes = (wave) => ({ wipeEvents: [{ wave, timestamp: 'x' }] });
  assert.notEqual(digest(canonical(wipes(3))), digest(canonical(wipes(4))));

  // A `timestamp` that is NOT inside wipeEvents is ordinary data. The redaction
  // is keyed on the containing field for exactly this reason: a leaf-name rule
  // would blank a field that carries real information somewhere else.
  const elsewhere = (t) => ({ auctions: [{ timestamp: t }], timestamp: t });
  const c1 = canonical(elsewhere('2026-01-01T00:00:00Z'));
  const c2 = canonical(elsewhere('2026-01-02T00:00:00Z'));
  assert.notEqual(digest(c1), digest(c2));
  assert.notEqual(c1.timestamp, REDACTED);
  assert.notEqual(c1.auctions[0].timestamp, REDACTED);
});

// -- 4. seeds are stable, and independent of catalogue order -----------------

test('seedsFor() is stable and depends on nothing but the case id', () => {
  // Pinned literals, not a recomputation: a change to fnv1a32 or the stride
  // renumbers every seed in the corpus, which invalidates all 464 hashes. That
  // is allowed, but it must be a deliberate act that reddens this test first.
  assert.equal(fnv1a32('melee-solo'), 2849011765);
  assert.deepEqual(seedsFor('melee-solo', 3), [2849011765, 2849019684, 2849027603]);

  // Independent of position in the catalogue: the seeds a case gets are the
  // same whether it is first, last, or in a list of one. Adding or removing a
  // case therefore never renumbers another case's seeds.
  const all = allEvalCases();
  const target = 'dungeon-fort-t2';
  const inPlace = seedsFor(all.find((c) => c.id === target).id, 16);
  const shuffled = [...all].reverse();
  assert.deepEqual(seedsFor(shuffled.find((c) => c.id === target).id, 16), inPlace);

  // And a prefix of a longer seed list is the shorter seed list, so
  // `--seeds=4` checks the same four runs the corpus recorded first.
  assert.deepEqual(seedsFor(target, 4), inPlace.slice(0, 4));

  // No two cases share a seed list.
  const firsts = new Set(all.map((c) => seedsFor(c.id, 1)[0]));
  assert.equal(firsts.size, all.length, 'two cases collide on their first seed');
});

// -- 5. the validator reports everything at once -----------------------------

test('validateEvalCases() reports every violation, not the first', async () => {
  const engine = await loadEngine(ROOT);

  const bad = [
    // five players in an open zone — the game caps `fly` well below that
    { id: 'too-big', kind: 'zone', metric: 'encounters', zone: 'fly', tier: 0, level: 10, n: 5, party: 'bare' },
    // a zone that does not exist
    { id: 'no-zone', kind: 'zone', metric: 'encounters', zone: 'not_a_zone', tier: 0, level: 10, n: 1, party: 'bare' },
    // a build that does not exist
    { id: 'no-build', kind: 'zone', metric: 'encounters', zone: 'fly', tier: 0, level: 10, n: 1, party: 'nope' },
    // a monster that exists but is not a labyrinth monster
    {
      id: 'no-labmon', kind: 'labyrinth', metric: 'labyAttemptCount',
      build: 'bare', n: 1, level: 10, monster: '/monsters/fly', roomLevel: 10, crates: [],
    },
    // a guild trial that does not exist
    { id: 'no-trial', kind: 'trial', metric: 'trialMaxTierCleared', party: 'bare', n: 1, level: 10, trial: '/guild_combat/nope' },
  ];

  assert.throws(
    () => validateEvalCases(engine.gameData, bad),
    (err) => {
      // All five, in one throw. A validator that dies on the first violation
      // hides the other four and costs a fix-rerun cycle each — the same
      // reasoning as validateCases() in bench/builds.mjs.
      assert.match(err.message, /too-big: party of 5 but fly allows/);
      assert.match(err.message, /no-zone: no such combat zone "not_a_zone"/);
      assert.match(err.message, /no-build: no such build "nope"/);
      assert.match(err.message, /no-labmon: .*is not a labyrinth monster/);
      assert.match(err.message, /no-trial: no such guild trial/);
      return true;
    }
  );

  // And the real catalogue passes.
  validateEvalCases(engine.gameData);
});
