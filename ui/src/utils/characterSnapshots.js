// =============================================================================
// characterSnapshots — raw `init_character_data` snapshots, keyed by the game
// characterId: what the iron item-time valuation (rust/src/lib.rs item_values,
// run in src/worker.js) reads, and what CharacterImport re-imports from.
//
// Kept OUT of csim_characters on purpose: a snapshot is ~100-300 KB, and the
// store is exported and shared, which a snapshot must never be. Written by the
// csim-import userscript (not yet built); until then this is empty and the
// cached iron times in csim_prices stand.
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

/** The roster shape prices.js matchWebappCharacter reads: { characters: [name], details: [{ name, characterId }] }. */
export function snapshotRoster(snapshots) {
  const details = Object.entries(snapshots || {})
    .map(([characterId, data]) => ({ name: data?.character?.name, characterId }))
    .filter((d) => typeof d.name === 'string');
  return { characters: details.map((d) => d.name), details };
}

/** The snapshot whose in-game name is `name`, or null. */
export function snapshotByName(snapshots, name) {
  return Object.values(snapshots || {}).find((data) => data?.character?.name === name) || null;
}
