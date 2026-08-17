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
// =============================================================================

import { buildCrateBuffs, buildLabUpgradeBuffs } from './target.js';

const Player = (await import('../../src/combatsimulator/player.js')).default;
const Monster = (await import('../../src/combatsimulator/monster.js')).default;
const { abilityDetailMap } = await import('../../src/combatsimulator/dataProvider.js');

function round(v) {
  return typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v;
}

// Top-level combatDetails holds the DERIVED stats (totalArmor, resistances,
// accuracy/damage/evasion ratings, levels, max HP/MP, ...) — what the game's
// sheet shows. The nested combatStats object holds the *base* inputs; we skip
// it here, but surface the one derived combatStat worth tracking.
const TRANSIENT = new Set(['currentHitpoints', 'currentManapoints']);

function extractDerived(combatDetails) {
  const derived = {};
  for (const [k, v] of Object.entries(combatDetails)) {
    if (TRANSIENT.has(k)) continue; // combat state, not a stat-sheet value
    if (v === null || typeof v !== 'object') derived[k] = round(v);
  }
  // attackInterval is stored in nanoseconds; surface seconds to match the game.
  derived.attackIntervalSeconds = round(combatDetails.combatStats.attackInterval / 1e9);
  return derived;
}

export function computeLabMonsterStats(monsterHrid, roomLevel) {
  const m = new Monster(monsterHrid, 0, roomLevel);
  m.updateCombatDetails(); // re-copies base then scales; idempotent.
  return {
    monsterHrid,
    roomLevel,
    derived: extractDerived(m.combatDetails),
    abilities: (m.abilities || []).filter(Boolean).map((a) => ({
      hrid: a.hrid,
      name: abilityDetailMap[a.hrid]?.name,
      level: a.level,
    })),
  };
}

export function computeLabPlayerStats(dto, { crates = [], labUpgrades = {} } = {}) {
  const player = Player.createFromDTO(structuredClone(dto));

  // Crate buffs → zoneBuffs, and the lab-shop upgrades → extraBuffs. Both now
  // come from api/lib/target.js, which the optimisers' worker also uses: this
  // file used to carry its own copy of the upgrade table, and two copies of a
  // mirror of src/worker.js is one too many to keep honest.
  player.zoneBuffs = buildCrateBuffs(crates);
  player.extraBuffs = buildLabUpgradeBuffs(labUpgrades);

  player.generatePermanentBuffs();
  player.reset(); // reset(0) → clearBuffs → updateCombatDetails (combat-start state)

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
    derived: extractDerived(player.combatDetails),
  };
}
