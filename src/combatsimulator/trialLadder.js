// The guild-trial ladder's constants, with no engine imports: GuildTrial reads them, and so do
// guildTrialStats and the twin-only callers (api/lib/simulator.js, shared/guildTrialRuns.js),
// which must not load the JS engine to learn them.
export const TRIAL_START_TIER = 100;
export const TRIAL_TIER_STEP = 10;
export const TRIAL_MAX_TIER = 300;
// Hard stop: 1 hour of simulated trial time.
export const TRIAL_DURATION_NS = 3600 * 1e9;
