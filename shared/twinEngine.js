// =============================================================================
// twinEngine — the backend registry for the Rust combat engine (the twin,
// rust/), and the JSON boundary to it. Isomorphic: Node and the browser
// worker both import it; the backend (native child process or wasm) is
// registered by the caller.
//
// The twin TAKES OVER THE JS RANDOM STREAM rather than being given a seed:
// under a seeded Math.random (api/lib/determinism.mjs mulberry32, whose whole
// state is one u32 behind `.state()`), it continues the exact stream and the
// end state is written back, so a seeded caller's stream stays one continuous sequence.
// Unseeded, the twin is seeded from one Math.random() draw.
// =============================================================================

import { applySimSettings } from './simSettings.js';

let backend = null; // set by the caller (api/lib/twin/index.mjs, src/worker.js)
export const setTwinBackend = (b) => { backend = b; };
export const getTwinBackend = () => backend;

/** The data files the twin reads, keyed by base name (reaches Rust as rust/src/generated.rs TWIN_DATA_NAMES, via tools/genRustTables.mjs). */
export const TWIN_DATA_NAMES = [
  'abilityDetailMap',
  'abilitySlotsLevelRequirementList',
  'achievementDetailMap',
  'achievementTierDetailMap',
  'actionDetailMap',
  'combatMonsterDetailMap',
  'combatStyleDetailMap',
  'combatTriggerDependencyDetailMap',
  'enhancementLevelTotalBonusMultiplierTable',
  'guildTrialDetailMap',
  'houseRoomDetailMap',
  'itemDetailMap',
  'labyrinthCrateDetailMap',
];

/** The twin's request shapes, written once; every seam builds its request here. */
export const twinZoneRequest = ({ players, partyBuffs = [], zone, simulationTimeLimit, runLimits }) =>
  ({ kind: 'zone', players, partyBuffs, zone, simulationTimeLimit, ...(runLimits ? { runLimits } : {}) });
/**
 * `labyrinth` is { labyrinthHrid, roomLevel, crates }; the crates become the players' zone buffs, as `new Labyrinth` makes them
 * (absent or null crates are none). `runLimits` is carried so the twin refuses it.
 */
export const twinLabRequest = ({ players, partyBuffs = [], labyrinth, simulationTimeLimit, runLimits }) =>
  ({ kind: 'labyrinth', players, partyBuffs, labyrinth, simulationTimeLimit, ...(runLimits ? { runLimits } : {}) });
/** One simulate() job: a zone when `zone` is set, else a labyrinth room. */
export const twinRunRequest = ({ zone, labyrinth, ...rest }) => (zone ? twinZoneRequest({ zone, ...rest }) : twinLabRequest({ labyrinth, ...rest }));
/** With `iterations`, the twin runs that many trials on one stream and resolves to an array of SimResults. */
export const twinTrialRequest = ({ players, partyBuffs = [], trialHrid, startTier, participantCount, trialOptions, iterations }) =>
  ({ kind: 'trial', players, partyBuffs, guildTrial: { trialHrid, startTier, participantCount: participantCount ?? players.length, trialOptions }, ...(iterations !== undefined ? { iterations } : {}) });

// The values JSON cannot carry, spelled as canonical() spells them.
const SENTINELS = new Map([['@undefined', undefined], ['@NaN', NaN], ['@Infinity', Infinity], ['@-Infinity', -Infinity]]);

/** Turn the twin's sentinel strings back into real values, in place. */
export function reviveTwinResult(v) {
  if (typeof v === 'string') return SENTINELS.has(v) ? SENTINELS.get(v) : v;
  if (v && typeof v === 'object') for (const k of Object.keys(v)) v[k] = reviveTwinResult(v[k]);
  return v;
}

const ERROR_KINDS = { Error, TypeError, RangeError };

// An error with no `rngState` is a refusal made before or mid-run with the stream state
// unknown: the seeded stream cannot be continued truthfully, so any further seeded twin
// use throws rather than diverging.
function poisonSeededStream(reason) {
  Math.random.state = () => {
    throw new Error(`seeded Math.random is unusable by the twin: an earlier twin-only error (${reason}) left its state unknown`);
  };
}

// One twin run at a time, so two runs never take the same stream state.
let chain = Promise.resolve();

/**
 * Run one request on backend `b` ({ run(json, onProgress) -> Promise<json> }).
 * Resolves to a SimResult (an array of them for a batch request). `onProgress(x)` is the
 * run's progress fraction, or for a batch the number of iterations completed.
 * On an error the stream is advanced as far as the run drew before it threw.
 */
export function runTwin(b, request, onProgress) {
  if (!b) return Promise.reject(new Error('no csim twin backend registered: call selectTwinFromEnv() (api/lib/twin/index.mjs) or setTwinBackend() first'));
  const job = chain.then(async () => {
    const seeded = typeof Math.random.state === 'function';
    const rngState = seeded ? Math.random.state() : (Math.random() * 4294967296) >>> 0;
    const settings = { monsterStartCooldown: applySimSettings().monsterStartCooldown };
    const res = JSON.parse(await b.run(JSON.stringify({ ...request, settings, rngState }), onProgress));
    if (seeded) {
      if (res.rngState !== undefined) Math.random.state(res.rngState);
      else poisonSeededStream(res.error);
    }
    if (!res.ok) throw new (ERROR_KINDS[res.errorKind] ?? Error)(res.error);
    return reviveTwinResult(res.simResults ?? res.simResult);
  });
  chain = job.catch(() => {});
  return job;
}
