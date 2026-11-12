// =============================================================================
// characterSnapshots — raw `init_character_data` snapshots, keyed by the game
// characterId: what the iron item-time valuation (rust/src/lib.rs item_values,
// run in src/worker.js) reads, and what CharacterImport re-imports from.
//
// Kept OUT of csim_characters on purpose: a snapshot is ~100-300 KB, and the
// store is exported and shared, which a snapshot must never be. Written by the
// csim-import userscript (userscript/csim-import.user.js) through
// installSnapshotBridge below; a snapshot is the character as of the last game
// load, so reload the game to refresh it.
//
// Framework-free, localStorage only inside function bodies (node tests import it).
// =============================================================================

export const SNAPSHOTS_KEY = 'csim_character_snapshots';

/** { [gameCharacterId]: characterData }, or {} when absent or unreadable. */
export function loadSnapshots() {
  try {
    const v = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The iron-character Select options, [{ value: gameCharacterId, label: in-game name }], snapshots with a name only. */
export function snapshotOptions(snapshots) {
  return Object.entries(snapshots || {})
    .filter(([, data]) => typeof data?.character?.name === 'string')
    .map(([characterId, data]) => ({ value: characterId, label: data.character.name }));
}

export const SNAPSHOT_MESSAGE = 'csim-import:snapshots';
export const SNAPSHOT_READY = 'csim-import:ready';
/** Fired on window after a write, so the hooks reading snapshots re-read them. */
export const SNAPSHOTS_EVENT = 'csim-snapshots';
// The same allowlist as userscript/csim-import.user.js (a test checks they agree).
export const SNAPSHOT_KEYS = [
  'character',
  'characterSkills', 'characterItems', 'characterLoadoutMap', 'characterHouseRoomMap',
  'actionTypeDrinkSlotsMap', 'actionTypeFoodSlotsMap', 'noncombatStats',
  'communityActionTypeBuffsMap', 'houseActionTypeBuffsMap', 'achievementActionTypeBuffsMap',
  'consumableActionTypeBuffsMap', 'equipmentActionTypeBuffsMap', 'guildActionTypeBuffsMap',
  'mooPassActionTypeBuffsMap', 'personalActionTypeBuffsMap',
  'characterAbilities', 'abilityCombatTriggersMap', 'consumableCombatTriggersMap',
  'characterAchievements', 'characterGuildBuffMap',
  'characterActions'
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The snapshots in a userscript message, re-filtered to the allowlist, or null
 * when the message is not one. Trust boundary: anything on the page can post, so
 * every entry must be keyed by its own numeric character id and carry a name,
 * and nothing outside SNAPSHOT_KEYS (nor any character field but id and name) survives.
 */
export function snapshotsFromMessage(data) {
  if (data?.type !== SNAPSHOT_MESSAGE || !isObject(data.snapshots)) return null;
  const out = {};
  for (const [id, snap] of Object.entries(data.snapshots)) {
    const c = snap?.character;
    if (!isObject(snap) || !isObject(c) || !/^\d+$/.test(id) || String(c.id) !== id || typeof c.name !== 'string') continue;
    const clean = { character: { id: c.id, name: c.name } };
    for (const key of SNAPSHOT_KEYS) {
      if (key !== 'character' && (isObject(snap[key]) || Array.isArray(snap[key]))) clean[key] = snap[key];
    }
    out[id] = clean;
  }
  return out;
}

/** Merge `incoming` over the stored snapshots (by id) and tell the readers. False when storage refused it. */
export function saveSnapshots(incoming) {
  try {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify({ ...loadSnapshots(), ...incoming }));
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(SNAPSHOTS_EVENT));
  return true;
}

/** Listen for the userscript (same window, same origin only), then ask it to send. Once, at startup. */
export function installSnapshotBridge() {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const snapshots = snapshotsFromMessage(e.data);
    if (snapshots && Object.keys(snapshots).length) saveSnapshots(snapshots);
  });
  window.postMessage({ type: SNAPSHOT_READY }, window.location.origin);
}
