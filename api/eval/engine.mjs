// =============================================================================
// eval/engine.mjs — the eval harness's calling convention
//
// loadEngine(root) returns { root, gameData, runZone, runLab, runTrial } on the
// Rust twin that CSIM_ENGINE selects (api/lib/twin/index.mjs). `root` must be
// this checkout: back-runs against older engines retired with the JS engine.
//
// WHY THIS DUPLICATES runSimulation's BODY INSTEAD OF IMPORTING IT
// ----------------------------------------------------------------
// The eval corpus feeds the twin with no community, seal or guild buffs, which
// runSimulation would fold in from `extra`. The cost is a duplicated few-line
// calling convention that can silently drift from the real one. It is paid for
// by ONE TEST: api/tests/evalHarness.test.mjs asserts that runZone() here and
// runSimulation() in api/lib/simulator.js produce the IDENTICAL hash, for a
// solo and a party case. If that test is ever deleted or weakened, this file
// becomes a second engine harness nobody is checking.
//
// SEEDING is the caller's business (api/eval/run.mjs wraps each call in
// withSeed). This module only runs the simulation.
// =============================================================================

import { readFileSync, realpathSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { buildNamesFor } from './cases.mjs';
import { selectTwinFromEnv } from '../lib/twin/index.mjs';
import { getTwinBackend, runTwin, twinRunRequest, twinTrialRequest } from '../../shared/twinEngine.js';
import { TRIAL_START_TIER } from '../../shared/trialLadder.js';

const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string} [root]  this checkout (the only engine there is now)
 * @returns {Promise<{root: string, gameData: object, runZone: Function, runLab: Function, runTrial: Function}>}
 */
export async function loadEngine(root = HERE_ROOT) {
  if (realpathSync(resolve(root)) !== realpathSync(HERE_ROOT)) {
    throw new Error(`eval: loadEngine(${root}): only this checkout's twin can run (back-runs retired with the JS engine)`);
  }
  await selectTwinFromEnv();
  // Read per call: api/twin-parity.mjs registers a different backend per side.
  const twin = () => getTwinBackend();
  const src = join(root, 'src', 'combatsimulator');

  const data = (name) => JSON.parse(readFileSync(join(src, 'data', `${name}.json`), 'utf8'));
  const gameData = {
    itemDetailMap: data('itemDetailMap'),
    abilityDetailMap: data('abilityDetailMap'),
    actionDetailMap: data('actionDetailMap'),
    combatMonsterDetailMap: data('combatMonsterDetailMap'),
    guildTrialDetailMap: data('guildTrialDetailMap'),
  };

  // Built from the same BUILDS declaration and the same adapter the bench uses.
  // No community, seal or guild buffs anywhere in the corpus: they are a
  // caller's circumstance, not an engine property.
  const dtosFor = (kase) =>
    buildNamesFor(kase).map((name, i) =>
      toCsimPlayer(BUILDS[name], {
        level: kase.level,
        index: i + 1,
        items: gameData.itemDetailMap,
        abilityData: gameData.abilityDetailMap,
      })
    );

  return {
    root,
    gameData,

    /** An open zone or a dungeon. Mirrors runSimulation(). */
    async runZone(kase, hours) {
      const zone = { zoneHrid: `/actions/combat/${kase.zone}`, difficultyTier: kase.tier };
      return runTwin(twin(), twinRunRequest({ players: dtosFor(kase), zone, simulationTimeLimit: hours * 3600e9 }));
    },

    /**
     * One labyrinth room, for `hours` of simulated time — many attempts, each
     * ended by a kill or the engine's 120 s room timer.
     *
     * Food and drinks are blanked because the game confiscates them at the
     * door; supply crates are the only nutrition inside, and they arrive as the
     * labyrinth's own buffs. Stripping is inlined rather than imported from
     * api/lib/target.js for the reason in this file's header.
     */
    async runLab(kase, hours) {
      const dtos = dtosFor(kase).map((dto) => ({ ...dto, food: [null, null, null], drinks: [null, null, null] }));
      const labyrinth = { labyrinthHrid: kase.monster, roomLevel: kase.roomLevel, crates: kase.crates || [] };
      return runTwin(twin(), twinRunRequest({ players: dtos, labyrinth, simulationTimeLimit: hours * 3600e9 }));
    },

    /**
     * ONE guild-trial iteration. `hours` is ignored: a trial's length is the
     * engine's own trial duration, not a caller's choice, and overriding it
     * would make the tier reached incomparable with the game's.
     */
    async runTrial(kase) {
      return runTwin(twin(), twinTrialRequest({ players: dtosFor(kase), trialHrid: kase.trial, startTier: kase.startTier ?? TRIAL_START_TIER, trialOptions: {} }));
    },
  };
}

/** Dispatch on kind, so callers never switch on it themselves. */
export async function runCase(engine, kase, hours) {
  if (kase.kind === 'zone') return engine.runZone(kase, hours);
  if (kase.kind === 'labyrinth') return engine.runLab(kase, hours);
  if (kase.kind === 'trial') return engine.runTrial(kase);
  throw new Error(`eval: unknown case kind "${kase.kind}"`);
}
