// =============================================================================
// guildTrialRuns — the guild-trial iteration loop (twin requests → summaries),
// shared by the browser shard worker (src/worker.js start_guild_trial) and the
// headless API (api/lib/simulator.js runGuildTrialSimulation). Party buffs and
// each DTO's own extraBuffs travel separately in the request; the twin appends
// the DTO's after the party's, per member.
// =============================================================================

import { extractTrialSummary } from './guildTrialStats.js';
import { TRIAL_START_TIER } from './trialLadder.js';
import { getTwinBackend, runTwin, twinTrialRequest } from './twinEngine.js';

/** Iterations per twin request: bounds the full SimResults (~118 KB each) held at once. */
export const TWIN_TRIAL_CHUNK = 32;

/**
 * Run `iterations` full trials and return one summary per iteration.
 *
 * @param {object} args
 * @param {object[]} args.players        player DTOs; each may carry its own
 *   `extraBuffs` (per-member shrines and seals), appended after `partyBuffs`
 * @param {object[]} args.partyBuffs     buffs every member gets (community, guild buildings)
 * @param {string} args.trialHrid
 * @param {number} [args.startTier]
 * @param {number} [args.participantCount]  default players.length; drives monster scaling
 * @param {object} [args.trialOptions]
 * @param {number} args.iterations
 * @param {(done: number) => void} [args.onIteration]
 * @returns {Promise<object[]>}
 */
export async function runTrialIterations({
  players: playersData,
  partyBuffs,
  trialHrid,
  startTier = TRIAL_START_TIER,
  participantCount,
  trialOptions = {},
  iterations,
  onIteration,
}) {
  const summaries = [];
  const twin = getTwinBackend();
  // Batch requests of at most TWIN_TRIAL_CHUNK iterations, so at most that many full
  // SimResults are alive at once. runTwin threads the seeded stream from one request into
  // the next, so the chunks draw exactly what one batch would. The twin's
  // progress counts completed iterations, so onIteration fires as each finishes (and
  // before a mid-chunk error).
  let done = 0;
  const fire = (n) => { for (; done < n; done++) onIteration?.(done + 1); }; // not `?.(++done)`: an absent callback skips its arguments
  for (let start = 0; start < iterations; start += TWIN_TRIAL_CHUNK) {
    const n = Math.min(TWIN_TRIAL_CHUNK, Math.ceil(iterations - start)); // ceil: a fractional count (10.5) runs 11, as the old loop did; the twin takes only integers
    const simResults = await runTwin(twin, twinTrialRequest({ players: playersData, partyBuffs, trialHrid, startTier, participantCount, trialOptions, iterations: n }), (k) => fire(start + k));
    fire(start + simResults.length); // backends without progress
    for (const r of simResults) summaries.push(extractTrialSummary(r));
  }
  return summaries;
}
