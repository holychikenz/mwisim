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

/** The iron-character Select options, [{ value: gameCharacterId, label: in-game name }], snapshots with a name only. */
export function snapshotOptions(snapshots) {
  return Object.entries(snapshots || {})
    .filter(([, data]) => typeof data?.character?.name === 'string')
    .map(([characterId, data]) => ({ value: characterId, label: data.character.name }));
}
