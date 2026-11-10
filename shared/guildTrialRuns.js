// =============================================================================
// guildTrialRuns — the guild-trial iteration loop (build players → GuildTrial →
// simulate → summary), shared by the browser shard worker (src/worker.js
// start_guild_trial) and the headless API (api/lib/simulator.js
// runGuildTrialSimulation).
// =============================================================================

import CombatSimulator from '../src/combatsimulator/combatSimulator.js';
import Player from '../src/combatsimulator/player.js';
import GuildTrial from '../src/combatsimulator/guildTrial.js';
import { extractTrialSummary } from '../src/combatsimulator/guildTrialStats.js';
import { getTwinBackend, runTwin, twinTrialRequest } from './twinEngine.js';

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
  startTier = GuildTrial.START_TIER,
  participantCount,
  trialOptions = {},
  iterations,
  onIteration,
}) {
  const summaries = [];
  const twin = getTwinBackend();
  if (twin) {
    // One batch request on one stream; the twin's progress counts completed iterations,
    // so onIteration still fires as each finishes (and before a mid-batch error).
    let done = 0;
    const fire = (n) => { for (; done < n; done++) onIteration?.(done + 1); }; // not `?.(++done)`: an absent callback skips its arguments
    const simResults = await runTwin(twin, twinTrialRequest({ players: playersData, partyBuffs, trialHrid, startTier, participantCount, trialOptions, iterations }), fire);
    fire(simResults.length); // backends without progress
    // shortcut: the batch holds every full SimResult until here; summarise in Rust if trial batches outgrow memory.
    return simResults.map(extractTrialSummary);
  }
  for (let it = 0; it < iterations; it++) {
    const players = playersData.map((dto) => {
      const p = Player.createFromDTO(structuredClone(dto));
      p.zoneBuffs = []; // no labyrinth crates in trials
      // `Player.createFromDTO` ignores `extraBuffs`, so it reaches this line
      // only via the DTO itself; a DTO without it gets the party buffs alone.
      p.extraBuffs = partyBuffs.concat(dto.extraBuffs || []);
      return p;
    });
    const guildTrial = new GuildTrial(trialHrid, startTier, participantCount ?? players.length, trialOptions);
    const combatSimulator = new CombatSimulator(players, null, null, { guildTrial });
    const simResult = await combatSimulator.simulate(GuildTrial.TRIAL_DURATION_NS);
    summaries.push(extractTrialSummary(simResult));
    onIteration?.(it + 1);
  }
  return summaries;
}
