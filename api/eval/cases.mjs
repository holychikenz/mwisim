// =============================================================================
// eval/cases.mjs — WHAT the evaluation corpus runs, and at WHICH seeds
//
// ONE CATALOGUE, NOT TWO
// ----------------------
// The zone cases are `CASES` from ../bench/builds.mjs, imported UNCHANGED. Not
// copied, not reshaped, not re-tuned. The bench catalogue is the standard
// candle and its in-file rule is absolute: do not edit an existing build or
// case. A second catalogue carrying "the same" builds is a catalogue that will
// silently fork, and then the eval and the benchmark are measuring two
// different games while reporting one number each.
//
// The labyrinth and guild-trial cases cannot be expressed in `CASES` — they
// have no `zone`, and `validateCases()` requires one — so they are declared
// here. They still import BUILDS, so the GEAR can never fork even though the
// case list does.
//
// FIXED DURATION, NOT kase.hours[0]
// ---------------------------------
// Every case runs for exactly EVAL_HOURS of simulated time, declared here.
// `hours` in builds.mjs is a bench tuning knob: the two points of the
// marginal-slope fit, chosen per case so the slow ones do not dominate the
// candle's wall clock. Coupling the fixture corpus to it would mean that
// retuning the benchmark — an explicitly welcome, non-behavioural act —
// silently invalidated every recorded hash.
//
// SEEDS DERIVED FROM THE CASE ID
// ------------------------------
//   seed_i = fnv1a32(case.id) + i * 7919
// A case's seeds depend on its own id and nothing else, so adding, removing or
// reordering a case never renumbers another case's seeds — and so a re-record
// of one case is a one-file diff rather than a corpus-wide churn.
// 7919 is prime and much larger than the number of seeds, which keeps the
// stride from aliasing with mulberry32's additive constant.
// =============================================================================

import { BUILDS, CASES, MIXED_PARTY, partyBuilds } from '../bench/builds.mjs';

export { BUILDS, CASES, MIXED_PARTY, partyBuilds };

/** Simulated hours per run. See the header: deliberately NOT kase.hours[0]. */
export const EVAL_HOURS = 1;

/** Seeds per case. 16 is what the recorded standard errors were computed at. */
export const DEFAULT_SEEDS = 16;

const SEED_STRIDE = 7919;

/** FNV-1a, 32-bit. Chosen for being short, stable and trivially reimplementable. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The seed list for a case id. Pure in the id — see the header.
 * @param {string} id
 * @param {number} [count]
 * @returns {number[]}
 */
export function seedsFor(id, count = DEFAULT_SEEDS) {
  const base = fnv1a32(id);
  return Array.from({ length: count }, (_, i) => (base + i * SEED_STRIDE) >>> 0);
}

// ---- labyrinth cases --------------------------------------------------------
// A labyrinth run reports `encounters: 0` — the room timer, not the spawn
// table, governs it — so its meaningful quantities are `labyAttemptCount` and
// `labRoomOutcomes.length`. The asserted headline is attempts, because it is
// the denominator of the clear rate the optimiser ranks on: if attempts move,
// every clear rate this repo has ever quoted moved with them.
//
// Consumables are confiscated at the labyrinth door (api/lib/target.js), so
// these builds are run with food and drinks stripped. Crates are the only
// nutrition inside, which is what the crate variants are for.

export const LAB_CASES = [
  {
    id: 'lab-cyclops-150',
    kind: 'labyrinth',
    // A room the build cannot clear: measured, all 30 attempts time out. The
    // metric is therefore pinned at ceil(3600 / 120) and carries no combat
    // information — which is the point. It pins the ROOM TIMER path, the one
    // place a labyrinth run's length is decided by the engine's clock rather
    // than by damage, and where an off-by-one in the timeout reschedule would
    // change the attempt count without changing any fight. Tier A still hashes
    // the whole tree, so the combat inside those 30 attempts is not unchecked.
    build: 'melee',
    n: 1,
    level: 200,
    monster: '/monsters/cyclops',
    roomLevel: 150,
    crates: [],
    metric: 'labyAttemptCount',
  },
  {
    id: 'lab-cyclops-60-crates',
    kind: 'labyrinth',
    // The same monster in a room the build clears, with all three expert
    // crates. This is the only path on which zoneBuffs come from a Labyrinth
    // rather than a Zone, and the crates are load-bearing in the metric:
    // measured at room 60, the same build takes ~45 attempts an hour bare and
    // ~62 with crates, so a crate buff silently dropped moves the mean by 27 %
    // and reddens Tier B on its own.
    build: 'melee',
    n: 1,
    level: 200,
    monster: '/monsters/cyclops',
    roomLevel: 60,
    crates: ['/items/expert_food_crate', '/items/expert_coffee_crate', '/items/expert_tea_crate'],
    metric: 'labyAttemptCount',
  },
  {
    id: 'lab-siren-250',
    kind: 'labyrinth',
    // A caster in a deeper room: the out-of-mana branches, against a monster
    // scaled well past the build, so attempts end in timeouts as well as kills.
    build: 'magic',
    n: 1,
    level: 200,
    monster: '/monsters/siren',
    roomLevel: 250,
    crates: ['/items/basic_coffee_crate'],
    metric: 'labyAttemptCount',
  },
  {
    id: 'lab-mimic-80-bare',
    kind: 'labyrinth',
    // The floor, in a labyrinth: no kit, a shallow room, so the attempt count
    // is high and the per-attempt cost is nearly all event loop.
    build: 'bare',
    n: 1,
    level: 100,
    monster: '/monsters/mimic',
    roomLevel: 80,
    crates: [],
    metric: 'labyAttemptCount',
  },
];

// ---- guild-trial cases ------------------------------------------------------
// ONE ITERATION PER SEED. runGuildTrialSimulation defaults to iterations: 100
// and aggregates them, which is the right shape for a player asking "how far
// will we get?" and the wrong shape here: the ensemble we are asserting is the
// S seeds, and 100 internal iterations under one seed would fold the variance
// away inside the run and cost a hundred times the wall clock for it.
//
// The asserted headline is trialMaxTierCleared — the number the guild reads off
// the board. trialTiersCleared and trialFinalTierHpRemovedFrac ride along in
// the strict-tier hash regardless.

export const TRIAL_CASES = [
  {
    id: 'trial-badger-5',
    kind: 'trial',
    party: MIXED_PARTY,
    n: 5,
    level: 600,
    trial: '/guild_combat/badger',
    startTier: 100,
    metric: 'trialMaxTierCleared',
  },
  {
    id: 'trial-badger-3',
    kind: 'trial',
    // Three of the same five-build party. A short-handed guild climbs a
    // shorter ladder (tier 110 against the full party's 140), so the two cases
    // between them assert that participant scaling still bites.
    //
    // NOT a lower LEVEL: measured, a level-200 three-player party clears no
    // tier at all, giving mean 0 and sd 0 — and a mean of zero defeats the
    // 0.25 % floor as well as the 4·SE term, leaving a band of exactly zero.
    // A case that asserts "still clears nothing" is a case that can only ever
    // report that the build is too weak.
    party: MIXED_PARTY,
    n: 3,
    level: 600,
    trial: '/guild_combat/badger',
    startTier: 100,
    metric: 'trialMaxTierCleared',
  },
  {
    id: 'trial-badger-5-tanks',
    kind: 'trial',
    // Five tanks: the trial runs long, so the ladder climbs further and the
    // buff-scan path carries the cost rather than the damage path.
    party: 'tank',
    n: 5,
    level: 600,
    trial: '/guild_combat/badger',
    startTier: 100,
    metric: 'trialMaxTierCleared',
  },
];

/**
 * Every case in the corpus, in a single uniform shape.
 *
 * A zone case keeps its bench declaration verbatim under `kase`; the eval adds
 * only `kind`, `id` and `metric`. `metric` names the SimResult field the
 * statistical tier asserts the ensemble mean of.
 *
 * @returns {Array<object>}
 */
export function allEvalCases() {
  const zone = CASES.map((kase) => ({
    id: kase.id,
    kind: 'zone',
    metric: 'encounters',
    zone: kase.zone,
    tier: kase.tier,
    level: kase.level,
    n: kase.n,
    party: kase.party,
  }));
  return [...zone, ...LAB_CASES, ...TRIAL_CASES];
}

/**
 * Resolve a case's party to one build name per player. Zone and trial cases
 * carry `party` + `n`; labyrinth cases carry a single `build`.
 */
export function buildNamesFor(kase) {
  if (kase.kind === 'labyrinth') return Array.from({ length: kase.n || 1 }, () => kase.build);
  return partyBuilds(kase);
}

/**
 * Assert every eval case is legal, reporting ALL violations at once rather than
 * the first — mirroring validateCases() in bench/builds.mjs, and for the same
 * reason: a run that dies on violation one hides violations two through five,
 * and the fix-rerun loop costs more than the listing does.
 *
 * Zone legality (party size, tier) is delegated to validateCases so there is
 * exactly one copy of that rule. What is checked here is what that function
 * cannot see: unknown builds, unknown labyrinth monsters, unknown trials, and
 * duplicate ids across the three sub-catalogues.
 *
 * @param {object} gameData { actionDetailMap, combatMonsterDetailMap, guildTrialDetailMap }
 */
export function validateEvalCases(gameData, cases = allEvalCases()) {
  const { actionDetailMap = {}, combatMonsterDetailMap = {}, guildTrialDetailMap = {} } = gameData || {};
  const bad = [];
  const seen = new Set();

  for (const kase of cases) {
    if (seen.has(kase.id)) bad.push(`${kase.id}: duplicate case id`);
    seen.add(kase.id);

    for (const name of buildNamesFor(kase)) {
      if (!BUILDS[name]) bad.push(`${kase.id}: no such build "${name}"`);
    }

    if (kase.kind === 'zone') {
      const action = actionDetailMap[`/actions/combat/${kase.zone}`];
      if (!action) {
        bad.push(`${kase.id}: no such combat zone "${kase.zone}"`);
        continue;
      }
      const maxParty = Number(action.maxPartySize) || 0;
      if (maxParty > 0 && kase.n > maxParty) {
        bad.push(`${kase.id}: party of ${kase.n} but ${kase.zone} allows ${maxParty}`);
      }
      const maxTier = Number(action.maxDifficulty) || 0;
      if (kase.tier < 0 || kase.tier > maxTier) {
        bad.push(`${kase.id}: tier ${kase.tier} but ${kase.zone} has tiers 0..${maxTier}`);
      }
    } else if (kase.kind === 'labyrinth') {
      const monster = combatMonsterDetailMap[kase.monster];
      if (!monster) bad.push(`${kase.id}: no such monster "${kase.monster}"`);
      else if (!monster.isLabyrinthMonster) bad.push(`${kase.id}: "${kase.monster}" is not a labyrinth monster`);
      if (!(kase.roomLevel >= 1 && kase.roomLevel <= 500)) {
        bad.push(`${kase.id}: roomLevel ${kase.roomLevel} outside 1..500`);
      }
      // A labyrinth room is a duel. Five players in one is not a load the game
      // can produce, and a number taken from it describes nothing.
      if ((kase.n || 1) !== 1) bad.push(`${kase.id}: a labyrinth room takes 1 player, not ${kase.n}`);
    } else if (kase.kind === 'trial') {
      if (!guildTrialDetailMap[kase.trial]) bad.push(`${kase.id}: no such guild trial "${kase.trial}"`);
      if (kase.n < 1 || kase.n > 5) bad.push(`${kase.id}: a guild trial takes 1..5 players, not ${kase.n}`);
    } else {
      bad.push(`${kase.id}: unknown kind "${kase.kind}"`);
    }
  }

  if (bad.length) throw new Error(`eval: invalid case(s)\n  ${bad.join('\n  ')}`);
}
