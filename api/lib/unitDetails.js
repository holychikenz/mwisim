// =============================================================================
// unitDetails — a player's or monster's derived combat stats from the wasm twin
// (rust/src/lib.rs `player_details` / `monster_details`), synchronously.
//
// Portable: api/lib/triggerSearch/bounds.js runs in Node and in the browser's
// optimiser workers. Node loads api/lib/twin/wasm.mjs (fs), the browser
// src/twinWasm.js; the Node path is a non-literal import so Vite never bundles it.
//
//   playerDetails(dtos, { partyBuffs, zoneBuffs, bare }) -> [entry]
//     each player as a zone run builds it at combat start: zoneBuffs, then
//     partyBuffs + the DTO's own extraBuffs, generatePermanentBuffs(), reset().
//     bare: true is `Player.createFromDTO(dto); updateCombatDetails()` alone (buffs ignored).
//   monsterDetails([{ hrid, difficultyTier = 0, roomLevel = 0 }]) -> [entry]
//     `new Monster(hrid, tier, roomLevel); updateCombatDetails()`.
//   entry = { ok: true, hrid, staminaLevel..magicLevel (unboosted), combatDetails
//             (the JS object: top-level scalars + combatStats), abilities? (monsters:
//             [{hrid, level}] after the minDifficultyTier filter) } | { ok: false, error }
//   checkPlayerDto(dto) -> { ok: true } | { ok: false, error }: ok exactly when createFromDTO would not throw
// A malformed buff list throws (err.twinRefusal); a bad DTO or unknown monster is a per-entry error.
// =============================================================================

import { reviveTwinResult } from '../../shared/twinEngine.js';

let runSync = null;
let reload = null; // a fresh instance after a trap (the loaders drop a trapped one)
let loadError = null;
try {
  if (globalThis.process?.versions?.node) {
    const nodeLoader = './twin/wasm.mjs';
    const m = await import(/* @vite-ignore */ nodeLoader);
    reload = () => m.wasmBackend();
    await reload();
    runSync = m.runSync; // reads the module's current instance on every call
  } else {
    const { loadWasmTwin } = await import('../../src/twinWasm.js');
    reload = async () => { runSync = (await loadWasmTwin()).runSync; };
    await reload();
  }
} catch (e) {
  // Not thrown here: a build without rust/pkg must still load every module that imports this one.
  loadError = e;
}

function call(request) {
  if (!runSync) throw loadError;
  let out;
  try {
    out = runSync(JSON.stringify(request));
  } catch (e) {
    // This call fails; re-instantiate in the background so later calls do not hit a dropped or unsound instance.
    if (e instanceof WebAssembly.RuntimeError) reload().catch(() => {});
    throw e;
  }
  const res = JSON.parse(out);
  if (!res.ok) throw Object.assign(new Error(res.error), { twinRefusal: true });
  return reviveTwinResult(res.units);
}

export function playerDetails(dtos, { partyBuffs = [], zoneBuffs = [], bare = false } = {}) {
  return call({ kind: 'player_details', players: dtos, partyBuffs, zoneBuffs, bare });
}

export function monsterDetails(list) {
  return call({ kind: 'monster_details', monsters: list });
}

export function checkPlayerDto(dto) {
  // JS takes any hrid (even none); the twin's DTO wants a string, which only matters to a run.
  const probe = dto && typeof dto === 'object' ? { ...dto, hrid: String(dto.hrid) } : dto;
  const [r] = playerDetails([probe], { bare: true });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
