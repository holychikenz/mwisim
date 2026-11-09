// =============================================================================
// candidateOptimizer — defaults and pure helpers for the Loadout and Abilities
// tools. Framework-free (api/tests import it); components live in
// CandidateOptimizerPanel.jsx and CandidateResults.jsx.
// =============================================================================
import { resolvePlayer } from './characterStore';
import { toPlayerDTO } from './playerDTO';

/** On a planet: rank on encounters, or on encounters per hour of TOTAL time (shared/consumableCost.js). */
export const OBJECTIVE_OPTIONS = [
  { value: 'effectiveEncountersPerHour', label: 'Effective EPH' },
  { value: 'encountersPerHour', label: 'EPH' },
];
/** Fidelity mirrors api/lib/equipmentScan/scan.js DEFAULT_SCAN. */
export const DEFAULT_LOADOUT_OPT_CONFIG = { objective: 'effectiveEncountersPerHour', hours: 24, replicates: 6, alpha: 0.05 };
export const DEFAULT_ABILITY_OPT_CONFIG = { ...DEFAULT_LOADOUT_OPT_CONFIG, search: 'swaps', passes: 2,
  coordinates: ['s0', 's1', 's2', 's3', 's4', 'order'] };
// A stored config is used only if it has every default key with the default's type; the API clamps the values.
const sameShape = (defaults) => (v) => !!v && typeof v === 'object' && Object.entries(defaults)
  .every(([k, d]) => (Array.isArray(d) ? Array.isArray(v[k]) : typeof v[k] === typeof d));
export const isLoadoutOptConfig = sameShape(DEFAULT_LOADOUT_OPT_CONFIG);
export const isAbilityOptConfig = sameShape(DEFAULT_ABILITY_OPT_CONFIG);

/** Whose loadout the tools vary: the picked slot while it is selected, else the main character's slot, else the first selected. */
export function pickSubjectSlot({ selectedParty, party, mainId, picked }) {
  const mainSlot = mainId == null ? null : selectedParty.find((id) => party[id]?.characterId === mainId) ?? null;
  const slot = selectedParty.includes(picked) ? picked : mainSlot ?? selectedParty[0] ?? null;
  return { slot, index: selectedParty.indexOf(slot), mainSlot };
}

/** One candidate per OTHER saved loadout of `character`. The API gives each the slot's hrid, buffs and level gap. */
export function loadoutCandidates(character, currentLoadoutName) {
  return Object.entries(character?.loadouts || {})
    .filter(([name]) => name !== currentLoadoutName)
    .map(([name, loadout]) => ({ name, player: toPlayerDTO(resolvePlayer(character, loadout)) }));
}
