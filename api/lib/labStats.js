// =============================================================================
// labStats — compute the simulator's lab-scaled stats (player + monster) so a
// parity harness can diff them against numbers recorded from the live game.
//
// Both computations reproduce exactly what the engine uses in a labyrinth run:
//   - Monster: spawned and scaled by room level (deterministic; no loadout).
//   - Player:  built from a DTO, given the crate buffs (zoneBuffs) + lab-shop
//     upgrade buffs (extraBuffs) exactly as src/worker.js does, then reset
//     (clearBuffs → updateCombatDetails) — the same path processCombatStartEvent
//     drives, so the result matches SimResult.playerStats.
// Both come from the wasm twin (api/lib/unitDetails.js), not the JS engine.
// =============================================================================

import { buildCrateBuffs, buildLabUpgradeBuffs } from './target.js';

import { monsterDetails, playerDetails } from './unitDetails.js';

const { abilityDetailMap } = await import('../../shared/dataProvider.js');

function round(v) {
  return typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v;
}

// Top-level combatDetails holds the DERIVED stats (totalArmor, resistances,
// accuracy/damage/evasion ratings, levels, max HP/MP, ...) — what the game's
// sheet shows. The nested combatStats object holds the *base* inputs; we skip
// it here, but surface the one derived combatStat worth tracking.
const TRANSIENT = new Set(['currentHitpoints', 'currentManapoints']);

function extractDerived(unit) {
  const { combatDetails } = unit;
  const derived = {};
  for (const [k, v] of Object.entries(combatDetails)) {
    if (TRANSIENT.has(k)) continue; // combat state, not a stat-sheet value
    if (v === null || typeof v !== 'object') derived[k] = round(v);
  }
  // The engine keeps these buffed values inside combatStats; the game's sheet
  // has them top-level (attackInterval in ns, as the game records it).
  derived.attackInterval = combatDetails.combatStats.attackInterval;
  derived.totalCastSpeed = round(combatDetails.combatStats.castSpeed);
  derived.attackIntervalSeconds = round(combatDetails.combatStats.attackInterval / 1e9);
  derived.combatLevel = round(combatLevel(unit));
  return derived;
}

// The game's sheet value: from UNBUFFED levels and not floored (e.g. 140.2).
function combatLevel(u) {
  const offence = Math.max(u.meleeLevel, u.rangedLevel, u.magicLevel);
  const best = Math.max(u.attackLevel, u.defenseLevel, offence);
  return 0.1 * (u.staminaLevel + u.intelligenceLevel + u.attackLevel + u.defenseLevel + offence) + 0.5 * best;
}

// An entry as the twin returns it; a refused entry throws its error.
function unit(entry) {
  if (!entry.ok) throw new Error(entry.error);
  return entry;
}

export function computeLabMonsterStats(monsterHrid, roomLevel) {
  const m = unit(monsterDetails([{ hrid: monsterHrid, difficultyTier: 0, roomLevel }])[0]);
  return {
    monsterHrid,
    roomLevel,
    derived: extractDerived(m),
    abilities: m.abilities.map((a) => ({
      hrid: a.hrid,
      name: abilityDetailMap[a.hrid]?.name,
      level: a.level,
    })),
  };
}

export function computeLabPlayerStats(dto, { crates = [], labUpgrades = {} } = {}) {
  // Crate buffs → zoneBuffs, and the lab-shop upgrades → extraBuffs. Both now
  // come from api/lib/target.js, which the optimisers' worker also uses: this
  // file used to carry its own copy of the upgrade table, and two copies of a
  // mirror of src/worker.js is one too many to keep honest. extraBuffs is the
  // upgrades ALONE (the DTO's own extraBuffs are not added), as it always was here.
  const player = unit(playerDetails([{ ...dto, extraBuffs: undefined }], {
    zoneBuffs: buildCrateBuffs(crates),
    partyBuffs: buildLabUpgradeBuffs(labUpgrades),
  })[0]); // generatePermanentBuffs + reset(0) → clearBuffs → updateCombatDetails (combat-start state)

  return {
    baseLevels: {
      stamina: player.staminaLevel,
      intelligence: player.intelligenceLevel,
      attack: player.attackLevel,
      melee: player.meleeLevel,
      defense: player.defenseLevel,
      ranged: player.rangedLevel,
      magic: player.magicLevel,
    },
    // The combat style the sim's loadout resolves to (from the main-hand
    // weapon). The parity harness compares this to the recorded game style to
    // detect a fixture captured with a mismatched loadout.
    combatStyleHrid: player.combatDetails.combatStats.combatStyleHrid,
    derived: extractDerived(player),
  };
}
