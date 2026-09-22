// =============================================================================
// refRepair — every reference holder, rewritten TOGETHER.
// -----------------------------------------------------------------------------
// There are exactly TWO holders of a `{characterId, loadoutName}` reference:
//
//   1. `party`  — App.jsx's five zone/lab slots, `{1..5: null | ref}`.
//   2. `roster` — App.jsx's guild-trial rows, `[{id, characterId, loadoutName,
//                 count}]`, with `selectedEntryId` as its dependent.
//
// `characterStore.js` knows about neither, deliberately — it stores characters,
// not the things that point at them — so this knowledge lives here rather than
// being pushed down a layer. This module imports only from characterStore.js
// (no cycle) and is PURE: it never touches `localStorage`, React or Mantine.
//
// WHY IT EXISTS. The same operation had two half-repairs pointing in opposite
// directions: App's `handleDeleteLoadout` mended `characters` and `roster` and
// never `party`; `LoadoutManager`'s own `handleDelete` mended `characters` and
// the ONE party slot it was invoked from and never `roster` — and could not see
// the other four slots, so the same pair bound twice still dangled. Renaming
// was worse still: the only rename entry point in the app never touched `party`
// at all. One helper, one snapshot, one rewrite.
//
// THE DROP RULE. A reference whose target no longer exists is DROPPED, never
// repointed: a party slot becomes `null`, a roster row is removed, and
// `selectedEntryId` falls back to the first surviving row. Repointing at a
// surviving loadout (what LoadoutManager used to do) FABRICATES A BINDING THE
// USER NEVER MADE — deleting "tank" would silently re-gear twenty trial seats
// into "mage" and produce wrong numbers that look entirely right. A visibly
// empty slot is a better failure than a plausible wrong one, and both empty
// states already render honestly.
//
// The unit of work is a WORLD: `{characters, party, roster, selectedEntryId}`
// in, a new world out. App.jsx holds those four as sibling `useState`, so one
// handler can set all four from one returned object.
// =============================================================================

import { deleteCharacter, deleteLoadout, renameLoadout } from './characterStore.js';

/** Does this reference still resolve to a stored (character, loadout) pair? */
const refExists = (store, ref) =>
  Boolean(ref?.characterId && store?.characters?.[ref.characterId]?.loadouts?.[ref.loadoutName]);

/** Is this reference the exact (character, loadout) pair just deleted? */
const refIsDoomed = (ref, doomed) =>
  Boolean(doomed && ref
    && ref.characterId === doomed.characterId
    && ref.loadoutName === doomed.loadoutName);

/**
 * Drop every reference that no longer resolves, from BOTH holders, together.
 *
 * This also clears PRE-EXISTING dangles as a side effect. That is intentional:
 * a dangling reference is already non-functional, so this is self-healing
 * rather than data loss.
 *
 * `doomed` names a pair that must be dropped BY IDENTITY, whatever the store
 * now says about it. Resolvability alone is not enough: `deleteLoadout` keeps a
 * character wearable by re-creating a blank `default` when its last loadout
 * goes (characterStore.js), so deleting the sole loadout of a freshly imported
 * character — whose one loadout IS called `default` — makes the name spring
 * back into existence before this sweep ever runs. Every reference would then
 * still resolve, stay bound, and silently simulate empty gear: the exact
 * plausible-wrong-answer this module's drop rule exists to prevent.
 */
function dropDangling(world, doomed = null) {
  const { characters } = world;
  const survives = (ref) => refExists(characters, ref) && !refIsDoomed(ref, doomed);
  const party = {};
  for (const [slot, ref] of Object.entries(world.party || {})) {
    party[slot] = survives(ref) ? ref : null;
  }
  const roster = (world.roster || []).filter(survives);
  const selectedEntryId = roster.some(e => e.id === world.selectedEntryId)
    ? world.selectedEntryId
    : (roster[0]?.id ?? null);
  return { characters, party, roster, selectedEntryId };
}

/** Delete a loadout and drop every reference to it. @returns {object} world */
export function deleteLoadoutEverywhere(world, characterId, loadoutName) {
  return dropDangling(
    { ...world, characters: deleteLoadout(world.characters, characterId, loadoutName) },
    { characterId, loadoutName }
  );
}

/** Delete a character and drop every reference to it. @returns {object} world */
export function deleteCharacterEverywhere(world, characterId) {
  return dropDangling({
    ...world,
    characters: deleteCharacter(world.characters, characterId)
  });
}

/**
 * Rename a loadout and follow it in both holders.
 *
 * No `dropDangling` pass: `uniqueLoadoutName` guarantees the new name is not
 * already taken on that character, so a rename cannot dangle anything and
 * cannot produce a roster duplicate. Running one anyway would silently eat
 * pre-existing dangles during an unrelated rename.
 *
 * @returns {{characters, party, roster, selectedEntryId, name}} — `name` is the
 *   name actually used after deduping, and equals `from` when nothing happened.
 */
export function renameLoadoutEverywhere(world, characterId, from, to) {
  const { store, name } = renameLoadout(world.characters, characterId, from, to);
  if (name === from) return { ...world, name };
  const rewrite = (ref) =>
    (ref?.characterId === characterId && ref?.loadoutName === from)
      ? { ...ref, loadoutName: name }
      : ref;
  const party = {};
  for (const [slot, ref] of Object.entries(world.party || {})) party[slot] = rewrite(ref);
  return {
    characters: store,
    party,
    roster: (world.roster || []).map(rewrite),
    selectedEntryId: world.selectedEntryId,
    name
  };
}
