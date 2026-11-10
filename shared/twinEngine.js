// =============================================================================
// twinEngine — the switch between the JS combat engine and its Rust twin
// (rust/), and the JSON boundary to the twin. Isomorphic: Node and the browser
// worker both import it; the backend (native child process or wasm) is
// registered by the caller.
//
// The twin TAKES OVER THE JS RANDOM STREAM rather than being given a seed:
// under a seeded Math.random (api/lib/determinism.mjs mulberry32, whose whole
// state is one u32 behind `.state()`), it continues the exact stream and the
// end state is written back, so a seeded caller cannot tell which engine ran.
// Unseeded, the twin is seeded from one Math.random() draw.
// =============================================================================

import { applySimSettings } from '../src/combatsimulator/simSettings.js';

let backend = null; // null = the JS engine
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

/** Whether a worker job runs on the wasm twin: toggle on, and not a labyrinth (not ported). */
export const wantsWasmTwin = (job) => job.extra?.experimental?.engine === 'wasm' && !job.labyrinth;

/** The twin's request shapes, written once; every seam builds its request here. */
export const twinZoneRequest = ({ players, partyBuffs = [], zone, simulationTimeLimit, runLimits }) =>
  ({ kind: 'zone', players, partyBuffs, zone, simulationTimeLimit, ...(runLimits ? { runLimits } : {}) });
export const twinTrialRequest = ({ players, partyBuffs = [], trialHrid, startTier, participantCount, trialOptions }) =>
  ({ kind: 'trial', players, partyBuffs, guildTrial: { trialHrid, startTier, participantCount: participantCount ?? players.length, trialOptions } });

// The values JSON cannot carry, spelled as canonical() spells them.
const SENTINELS = new Map([['@undefined', undefined], ['@NaN', NaN], ['@Infinity', Infinity], ['@-Infinity', -Infinity]]);

/** Turn the twin's sentinel strings back into real values, in place. */
export function reviveTwinResult(v) {
  if (typeof v === 'string') return SENTINELS.has(v) ? SENTINELS.get(v) : v;
  if (v && typeof v === 'object') for (const k of Object.keys(v)) v[k] = reviveTwinResult(v[k]);
  return v;
}

// One twin run at a time, so two runs never take the same stream state.
let chain = Promise.resolve();

/**
 * Run one request on backend `b` ({ run(json, onProgress) -> Promise<json> }).
 * Resolves to a SimResult. `onProgress(fraction)` is the JS "progress" event (wasm only).
 */
export function runTwin(b, request, onProgress) {
  const job = chain.then(async () => {
    const seeded = typeof Math.random.state === 'function';
    const rngState = seeded ? Math.random.state() : (Math.random() * 4294967296) >>> 0;
    const settings = { monsterStartCooldown: applySimSettings().monsterStartCooldown };
    const res = JSON.parse(await b.run(JSON.stringify({ ...request, settings, rngState }), onProgress));
    if (!res.ok) throw new (res.errorKind === 'RangeError' ? RangeError : Error)(res.error);
    if (seeded) Math.random.state(res.rngState);
    return reviveTwinResult(res.simResult);
  });
  chain = job.catch(() => {});
  return job;
}
