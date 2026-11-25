// The guild-trial ladder's constants, with no engine imports, for guildTrialStats and the
// twin callers (api/lib/simulator.js, shared/guildTrialRuns.js). The twin's own copy is
// rust/src/guild_trial.rs.
export const TRIAL_START_TIER = 100;
export const TRIAL_TIER_STEP = 10;
export const TRIAL_MAX_TIER = 300;
// Hard stop: 1 hour of simulated trial time.
export const TRIAL_DURATION_NS = 3600 * 1e9;
