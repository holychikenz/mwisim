// =============================================================================
// eval/engine.mjs — the engine-agnostic adapter
//
// loadEngine(root) loads the combat engine rooted at `root` (a directory that
// contains src/combatsimulator/) and returns { runZone, runLab, runTrial }.
// `root` is the working tree for a normal run and a `git archive` extraction of
// an older commit for a back-run, and nothing else changes.
//
// WHY THIS DUPLICATES runSimulation's BODY INSTEAD OF IMPORTING IT
// ----------------------------------------------------------------
// api/lib/simulator.js is NOT imported here, deliberately. That file itself
// drifted across the optimisation span being measured, so importing the
// historical copy alongside the historical engine would fold harness changes
// into the engine comparison, and importing the CURRENT copy against a
// historical engine would be a version mismatch waiting to throw. Either way
// the answer would no longer be a statement about the engine alone.
//
// The cost of that decision is a duplicated ~12-line calling convention that
// can silently drift from the real one. It is paid for by ONE TEST:
// api/tests/evalHarness.test.mjs asserts that runZone() here and
// runSimulation() in api/lib/simulator.js produce the IDENTICAL hash at HEAD,
// for a solo and a party case. If that test is ever deleted or weakened, this
// file becomes a second engine harness nobody is checking.
//
// THE LABYRINTH AND THE TRIAL are constructed the same way, mirroring
// api/lib/triggerSearch/poolWorker.js and runGuildTrialSimulation respectively.
// Note in particular that `labyrinth` is CombatSimulator's THIRD positional
// argument: whichever of zone/labyrinth is absent must be passed as an explicit
// null, or the options object lands in the labyrinth slot, `this.labyrinth`
// goes truthy, and startNewEncounter() throws on the first encounter. The same
// trap is documented in api/lib/simulator.js and api/lib/simulationWorker.js.
//
// SEEDING is the caller's business (api/eval/run.mjs wraps each call in
// withSeed). This module only runs the simulation.
// =============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { BUILDS, toCsimPlayer } from '../bench/builds.mjs';
import { buildNamesFor } from './cases.mjs';

/**
 * @param {string} root  a directory containing src/combatsimulator/
 * @returns {Promise<{root: string, gameData: object, runZone: Function, runLab: Function, runTrial: Function}>}
 */
export async function loadEngine(root) {
  const src = join(root, 'src', 'combatsimulator');
  const mod = (file) => import(pathToFileURL(join(src, file)).href);

  const CombatSimulator = (await mod('combatSimulator.js')).default;
  const Player = (await mod('player.js')).default;
  const Zone = (await mod('zone.js')).default;
  const Labyrinth = (await mod('labyrinth.js')).default;
  const GuildTrial = (await mod('guildTrial.js')).default;

  const data = (name) => JSON.parse(readFileSync(join(src, 'data', `${name}.json`), 'utf8'));
  const gameData = {
    itemDetailMap: data('itemDetailMap'),
    abilityDetailMap: data('abilityDetailMap'),
    actionDetailMap: data('actionDetailMap'),
    combatMonsterDetailMap: data('combatMonsterDetailMap'),
    guildTrialDetailMap: data('guildTrialDetailMap'),
  };

  // Built from the same BUILDS declaration and the same adapter the bench uses,
  // against WHICHEVER engine's item data is loaded — so each engine is fed gear
  // it agrees exists, and the two are never fed different gear.
  const dtosFor = (kase) =>
    buildNamesFor(kase).map((name, i) =>
      toCsimPlayer(BUILDS[name], {
        level: kase.level,
        index: i + 1,
        items: gameData.itemDetailMap,
        abilityData: gameData.abilityDetailMap,
      })
    );

  // The engine chatters to stdout on the dungeon and trial paths.
  const quietly = async (fn) => {
    const real = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = real;
    }
  };

  function instantiate(playerDTOs, zone, labyrinth, options) {
    const players = [];
    for (let i = 0; i < playerDTOs.length; i++) {
      const player = Player.createFromDTO(structuredClone(playerDTOs[i]));
      player.zoneBuffs = zone?.buffs || labyrinth?.buffs || [];
      // No community, seal or guild buffs anywhere in the corpus: they are a
      // caller's circumstance, not an engine property, and folding one in would
      // make every hash depend on a number nobody would think to check.
      player.extraBuffs = [];
      players.push(player);
    }
    return new CombatSimulator(players, zone, labyrinth, options);
  }

  return {
    root,
    gameData,

    /** An open zone or a dungeon. Mirrors runSimulation()'s main-thread branch. */
    async runZone(kase, hours) {
      const zone = new Zone(`/actions/combat/${kase.zone}`, kase.tier);
      const simulator = instantiate(dtosFor(kase), zone, null, { enableHpMpVisualization: false });
      return quietly(() => simulator.simulate(hours * 3600e9));
    },

    /**
     * One labyrinth room, for `hours` of simulated time — many attempts, each
     * ended by a kill or the engine's 120 s room timer.
     *
     * Food and drinks are blanked because the game confiscates them at the
     * door; supply crates are the only nutrition inside, and they arrive as the
     * Labyrinth's own buffs. Stripping is inlined rather than imported from
     * api/lib/target.js for the reason in this file's header.
     */
    async runLab(kase, hours) {
      const labyrinth = new Labyrinth(kase.monster, kase.roomLevel, kase.crates || []);
      const dtos = dtosFor(kase).map((dto) => ({ ...dto, food: [null, null, null], drinks: [null, null, null] }));
      const simulator = instantiate(dtos, null, labyrinth, { enableHpMpVisualization: false });
      return quietly(() => simulator.simulate(hours * 3600e9));
    },

    /**
     * ONE guild-trial iteration. `hours` is ignored: a trial's length is the
     * engine's own GuildTrial.TRIAL_DURATION_NS, not a caller's choice, and
     * overriding it would make the tier reached incomparable with the game's.
     */
    async runTrial(kase) {
      const dtos = dtosFor(kase);
      const guildTrial = new GuildTrial(kase.trial, kase.startTier ?? GuildTrial.START_TIER, dtos.length, {});
      const simulator = instantiate(dtos, null, null, { guildTrial });
      return quietly(() => simulator.simulate(GuildTrial.TRIAL_DURATION_NS));
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
