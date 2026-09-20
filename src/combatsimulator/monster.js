import Ability from "./ability";
import CombatUnit from "./combatUnit";
import { combatMonsterDetailMap } from "./dataProvider";
import Drops from "./drops";

// =============================================================================
// MWIX adaptation (performance): the monster zero-fill stat list, hoisted out
// of updateCombatDetails().
//
// A monster's combatStats are copied from its game-data entry, which carries
// only the stats that monster actually has. These are the names that must be
// forced to 0 when the entry omits them. Upstream declares this array INLINE
// inside updateCombatDetails, so a fresh 63-element array literal was
// allocated and walked on every recompute — and every monster is reset, and so
// recomputed, at each of the 600+ encounters in a simulated hour. A CPU
// profile of magic-solo + buffstack-solo put this one forEach at 2.8% of self
// time. Hoisting is pure bookkeeping — same names, same order, same writes —
// so it cannot move a number, and sim:check stayed 3/3.
//
// The list below was moved VERBATIM: not retyped, not regenerated. Two of
// these names carry DIGITS ("hpRegenPer10", "mpRegenPer10"); the scraping
// mistake that once dropped exactly those two from EQUIPMENT_COMBAT_STATS (see
// the header in player.js) would drop them here too and silently give every
// monster zero regen. Asserted in api/tests/statCaching.test.mjs.
// =============================================================================
export const MONSTER_ZEROED_COMBAT_STATS = [
    "stabAccuracy",
    "slashAccuracy",
    "smashAccuracy",
    "rangedAccuracy",
    "magicAccuracy",
    "stabDamage",
    "slashDamage",
    "smashDamage",
    "rangedDamage",
    "magicDamage",
    "defensiveDamage",
    "taskDamage",
    "physicalAmplify",
    "waterAmplify",
    "natureAmplify",
    "fireAmplify",
    "healingAmplify",
    "stabEvasion",
    "slashEvasion",
    "smashEvasion",
    "rangedEvasion",
    "magicEvasion",
    "armor",
    "waterResistance",
    "natureResistance",
    "fireResistance",
    "maxHitpoints",
    "maxManapoints",
    "lifeSteal",
    "hpRegenPer10",
    "mpRegenPer10",
    "physicalThorns",
    "elementalThorns",
    "combatDropRate",
    "combatRareFind",
    "combatDropQuantity",
    "combatExperience",
    "criticalRate",
    "criticalDamage",
    "armorPenetration",
    "waterPenetration",
    "naturePenetration",
    "firePenetration",
    "abilityHaste",
    "tenacity",
    "manaLeech",
    "castSpeed",
    "threat",
    "parry",
    "mayhem",
    "pierce",
    "curse",
    "fury",
    "weaken",
    "ripple",
    "bloom",
    "blaze",
    "attackSpeed",
    "foodHaste",
    "drinkConcentration",
    "autoAttackDamage",
    "abilityDamage",
    "retaliation",
];

// =============================================================================
// MWIX adaptation (performance): the game-data stat-block copy in
// updateCombatDetails(), flattened.
//
// Upstream copies a monster's base stat block with
//
//     for (const [key, value] of Object.entries(gameMonster.combatDetails.combatStats))
//
// which allocates an outer array plus one two-element array PER STAT, PER
// MONSTER, PER ENCOUNTER — and a simulated hour holds 200-800 encounters, each
// resetting (and so recomputing) every monster in it. A CPU profile put this
// single loop at 5.7% of self time on melee-solo, 6.3% on buffstack-solo and
// 4.2% on dungeon-den-600.
//
// The source block is static game data. We cache its key and value arrays the
// first time we see it and thereafter walk two flat arrays with an index loop:
// same keys, in Object.keys order (which is Object.entries order), same values,
// written in the same sequence. It is a change of iteration mechanism only and
// cannot move a number; sim:check stayed 3/3.
//
// Keyed by the combatStats OBJECT, not by monster hrid. dataProvider's
// setOverrides() can replace the whole monster map at runtime (MWIX live data,
// and api/lib/simulator.js passes clientData through it), and every override
// installs fresh nested objects. An hrid-keyed cache would then serve a
// previous game version's stats with no error at all; identity-keyed, a
// replaced block is simply a cache miss. A WeakMap so an overridden block is
// collectable.
// =============================================================================
const _statBlockCache = new WeakMap();

function _flatStatBlock(combatStats) {
    let flat = _statBlockCache.get(combatStats);
    if (!flat) {
        const keys = Object.keys(combatStats);
        const values = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
            values[i] = combatStats[keys[i]];
        }
        flat = { keys, values };
        _statBlockCache.set(combatStats, flat);
    }
    return flat;
}

class Monster extends CombatUnit {

    difficultyTier = 0;

    LabyrinthMonsterBaseRoomLevel = 100; //Base stats are designed for room level 100, and scale proportionally
    roomLevel = 0;

    // Guild Trial participant HP scaling. 1 = no scaling (every non-trial
    // monster). GuildTrial.getEncounter() sets this to (1 + 0.01 * participants)
    // so a trial monster's max HP grows +1% per participant. Applied in
    // updateCombatDetails() AFTER the base max-HP is computed so it survives
    // every stat recompute (e.g. a curse/weaken buff re-running
    // updateCombatDetails) instead of a one-shot mutation the next recompute
    // would wipe.
    trialHpScaleFactor = 1;

    constructor(hrid, difficultyTier = 0, roomLevel = 0) {
        super();

        this.isPlayer = false;
        this.hrid = hrid;
        this.difficultyTier = difficultyTier;
        this.roomLevel = roomLevel
        if (this.roomLevel <= 0) {
            this.roomLevel = this.LabyrinthMonsterBaseRoomLevel;
        }

        let gameMonster = combatMonsterDetailMap[this.hrid];
        if (!gameMonster) {
            throw new Error("No monster found for hrid: " + this.hrid);
        }

        this.enrageTime = gameMonster.enrageTime;

        let labyrinthScaleFactor = this.roomLevel / this.LabyrinthMonsterBaseRoomLevel;
        for (let i = 0; i < gameMonster.abilities.length; i++) {
            if (gameMonster.abilities[i].minDifficultyTier > this.difficultyTier) {
                continue;
            }
            this.abilities[i] = new Ability(gameMonster.abilities[i].abilityHrid, Math.floor(gameMonster.abilities[i].level * labyrinthScaleFactor));
        }
        if(gameMonster.dropTable)
        for (let i = 0; i < gameMonster.dropTable.length; i++) {
            this.dropTable[i] = new Drops(gameMonster.dropTable[i].itemHrid, gameMonster.dropTable[i].dropRate, gameMonster.dropTable[i].minCount, gameMonster.dropTable[i].maxCount, gameMonster.dropTable[i].difficultyTier);
        }
        // Guild trial monsters carry no loot (dropTable / rareDropTable are
        // null). Guard the rare-drop loop like the drop loop above so they load.
        if(gameMonster.rareDropTable)
        for (let i = 0; i < gameMonster.rareDropTable.length; i++) {
            let dropTableItem = (gameMonster.dropTable && i < gameMonster.dropTable.length) ? gameMonster.dropTable[i] : null;
            let difficultyTier = dropTableItem?.difficultyTier ?? gameMonster.rareDropTable[i].minDifficultyTier;

            this.rareDropTable[i] = new Drops(gameMonster.rareDropTable[i].itemHrid, gameMonster.rareDropTable[i].dropRate, gameMonster.rareDropTable[i].minCount, difficultyTier);
        }
    }

    updateCombatDetails() {
        let gameMonster = combatMonsterDetailMap[this.hrid];

        let levelMultiplier = 1.0 + 0.25 * this.difficultyTier;
        let defLevelMultiplier = 1.0 + 0.15 * this.difficultyTier;
        let levelBonus = 20.0 * this.difficultyTier;

        let labyrinthScaleFactor = this.roomLevel / this.LabyrinthMonsterBaseRoomLevel;

        this.staminaLevel = levelMultiplier * (gameMonster.combatDetails.staminaLevel + levelBonus) * labyrinthScaleFactor;
        this.intelligenceLevel = levelMultiplier * (gameMonster.combatDetails.intelligenceLevel + levelBonus) * labyrinthScaleFactor;
        this.attackLevel = levelMultiplier * (gameMonster.combatDetails.attackLevel + levelBonus) * labyrinthScaleFactor;
        this.meleeLevel = levelMultiplier * (gameMonster.combatDetails.meleeLevel + levelBonus) * labyrinthScaleFactor;
        this.defenseLevel = defLevelMultiplier * (gameMonster.combatDetails.defenseLevel + levelBonus) * labyrinthScaleFactor;
        this.rangedLevel = levelMultiplier * (gameMonster.combatDetails.rangedLevel + levelBonus) * labyrinthScaleFactor;
        this.magicLevel = levelMultiplier * (gameMonster.combatDetails.magicLevel + levelBonus) * labyrinthScaleFactor;
        
        let expMultiplier = 1.0 + 0.5 * this.difficultyTier;
        let expBonus = 5.0 * this.difficultyTier;

        this.experience = expMultiplier * (gameMonster.experience + expBonus);

        this.combatDetails.combatStats.combatStyleHrid = gameMonster.combatDetails.combatStats.combatStyleHrids[0];

        // Flat key/value walk over the cached stat block — see
        // _flatStatBlock above. Identical keys, order and values.
        const flat = _flatStatBlock(gameMonster.combatDetails.combatStats);
        const flatKeys = flat.keys;
        const flatValues = flat.values;
        for (let i = 0; i < flatKeys.length; i++) {
            this.combatDetails.combatStats[flatKeys[i]] = flatValues[i];
        }

        this.combatDetails.combatStats.armor *= labyrinthScaleFactor;
        this.combatDetails.combatStats.waterResistance *= labyrinthScaleFactor;
        this.combatDetails.combatStats.natureResistance *= labyrinthScaleFactor;
        this.combatDetails.combatStats.fireResistance *= labyrinthScaleFactor;

        // Zero-fill the stats this monster's game-data entry omits. Hoisted
        // list, plain loop — see MONSTER_ZEROED_COMBAT_STATS above.
        for (let i = 0; i < MONSTER_ZEROED_COMBAT_STATS.length; i++) {
            let stat = MONSTER_ZEROED_COMBAT_STATS[i];
            if (gameMonster.combatDetails.combatStats[stat] == null) {
                this.combatDetails.combatStats[stat] = 0;
            }
        }

        if (this.combatDetails.combatStats.attackInterval == 0) {
            this.combatDetails.combatStats.attackInterval = gameMonster.combatDetails.attackInterval;
        }

        super.updateCombatDetails();

        // Guild Trial: +1% max HP per participant. Re-applied on every recompute
        // (see field comment). No-op for all non-trial monsters (factor === 1).
        if (this.trialHpScaleFactor && this.trialHpScaleFactor !== 1) {
            this.combatDetails.maxHitpoints = Math.floor(
                this.combatDetails.maxHitpoints * this.trialHpScaleFactor
            );
        }
    }
}

export default Monster;
