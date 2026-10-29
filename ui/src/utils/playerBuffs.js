// =============================================================================
// playerBuffs — the buffs a single character carries on their OWN account.
// -----------------------------------------------------------------------------
// Guild shrines are bought per member and seals are equipped per character, so
// neither is a property of the party. They used to be two party-wide knobs in
// the header's Buffs popover; they are now per-player controls in each
// character's "Houses, Achievements & Buffs" panel, and this is the one place
// that turns those controls into finished buff objects.
//
// One helper rather than five call sites, because App.jsx builds player DTOs in
// five different places (zone/lab, the All-Zones sweep, the two optimiser
// payloads and the trial roster) and a resolver that disagreed with itself
// across two of them would show up as a build that simulates differently
// depending on which button was pressed.
//
// The result lands on the DTO as `extraBuffs`, which its consumers concatenate
// onto their shared list: src/worker.js (both cases), api/lib/simulator.js
// `runSimulation`, and the trigger search's poolWorker and bounds.
//
// ONE consumer deliberately does not: `runGuildTrialSimulation` in
// api/lib/simulator.js still OVERWRITES `extraBuffs`, because SCLIRoster folds
// shrines in around that overwrite and pins it by a test in that repo. The
// comment at that line has the detail. Nothing in csim reaches it — the browser
// trial path is src/worker.js, which does concat — but a reader counting
// consumers deserves to know the set is not uniform.
// =============================================================================
import { resolveGuildBuffs, resolveUnitShrineBuffs } from './guildBuffs';
import { resolveSealBuffs } from '../../../shared/personalBuffs.js';

/**
 * @param {object} player  a zone player or a trial master build
 * @param {object} [opts]
 * @param {Record<string, number>|null} [opts.partyShrineLevels]  GUILD TRIALS
 *   ONLY: the trial header's party-wide fallback, used for builds that never
 *   got their own `guildShrines` (the null-vs-{} distinction documented at
 *   length on `ownsShrines` in utils/guildBuffs.js — `{}` means "captured, owns
 *   none" and must NOT fall back). Omit it on the zone / labyrinth / sweep /
 *   optimiser paths, where shrines are strictly per-player and there is no
 *   party-wide knob left to fall back to.
 * @param {boolean} [opts.includeSeals=true]  false for guild trials and the
 *   labyrinth (see sealsApply): the game grants neither community buffs nor
 *   seals inside a trial, which is why the header hides the Buffs control in
 *   trial mode.
 * @returns {Array<object>} finished buff objects for the DTO's `extraBuffs`
 */
export function resolvePlayerExtraBuffs(
  player,
  { partyShrineLevels = null, includeSeals = true } = {}
) {
  const shrines = partyShrineLevels
    ? resolveUnitShrineBuffs(player, partyShrineLevels)
    : resolveGuildBuffs(player?.guildShrines || {});
  return includeSeals ? shrines.concat(resolveSealBuffs(player?.personalBuffs)) : shrines;
}

/**
 * Whether seals apply to a run: every seal's description reads "Only effective
 * outside of Labyrinth and Guild Trial". The maze context runs a zone under
 * labyrinth rules, and an optimiser aimed at a labyrinth is a labyrinth run.
 *
 * @param {object} ctx
 * @param {string} ctx.simMode
 * @param {'zone'|'labyrinth'} [ctx.optTarget]  read only in the optimiser modes
 * @param {boolean} [ctx.mazeContext]
 */
export function sealsApply({ simMode, optTarget = 'zone', mazeContext = false }) {
  if (simMode === 'guildTrial' || simMode === 'labyrinth') return false;
  if (simMode === 'triggerOpt' || simMode === 'equipOpt') return optTarget !== 'labyrinth';
  return !mazeContext;
}
