import Ability from "./ability";
import CombatUnit from "./combatUnit";
import Consumable from "./consumable";
import Equipment from "./equipment";
import HouseRoom from "./houseRoom";
import Achievement from "./achievement";
import { copyEquipmentTotals, makeEquipmentTotals } from "./generated/statSchema";

// =============================================================================
// MWIX adaptation (performance): the equipment stat list, hoisted out of
// updateCombatDetails().
//
// These are the stats whose value on a player is the plain SUM over worn
// equipment. Upstream declares this array inline inside updateCombatDetails,
// which reallocates it — and re-derives all 70 sums — on every call. Hoisting
// it gives the cache below something to enumerate, and makes the list a thing
// that can be asserted about (see api/tests/statCaching.test.mjs).
//
// If you add or remove a name here you are changing what equipment contributes
// to a player. Two of these names carry DIGITS ("hpRegenPer10",
// "mpRegenPer10"); any tooling that rediscovers this list by pattern-matching
// must allow for that. An earlier attempt scraped it with /"([a-zA-Z]+)"/ and
// silently dropped exactly those two, which moved kills/hr by 2%.
// =============================================================================
export const EQUIPMENT_COMBAT_STATS = [
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
    "staminaExperience",
    "intelligenceExperience",
    "attackExperience",
    "defenseExperience",
    "meleeExperience",
    "rangedExperience",
    "magicExperience",
    "retaliation",
];

class Player extends CombatUnit {
    equipment = {
        "/equipment_types/head": null,
        "/equipment_types/body": null,
        "/equipment_types/legs": null,
        "/equipment_types/feet": null,
        "/equipment_types/hands": null,
        "/equipment_types/main_hand": null,
        "/equipment_types/two_hand": null,
        "/equipment_types/off_hand": null,
        "/equipment_types/pouch": null,
        "/equipment_types/back": null,
    };

    constructor() {
        super();

        this.isPlayer = true;
        this.hrid = "player";
    }

    static createFromDTO(dto) {
        let player = new Player();

        player.staminaLevel = dto.staminaLevel;
        player.intelligenceLevel = dto.intelligenceLevel;
        player.attackLevel = dto.attackLevel;
        player.meleeLevel = dto.meleeLevel;
        player.defenseLevel = dto.defenseLevel;
        player.rangedLevel = dto.rangedLevel;
        player.magicLevel = dto.magicLevel;

        player.hrid = dto.hrid;

        for (const [key, value] of Object.entries(dto.equipment)) {
            player.equipment[key] = value ? Equipment.createFromDTO(value) : null;
        }

        player.food = dto.food.map((food) => (food ? Consumable.createFromDTO(food) : null));
        player.drinks = dto.drinks.map((drink) => (drink ? Consumable.createFromDTO(drink) : null));
        player.abilities = dto.abilities.map((ability) => (ability ? Ability.createFromDTO(ability) : null));
        Object.entries(dto.houseRooms).forEach(houseRoom => {
            if (houseRoom[1] > 0) {
                player.houseRooms.push(new HouseRoom(houseRoom[0], houseRoom[1]))
            }
        });

        player.achievements = new Achievement(dto.achievements);

        player.debuffOnLevelGap = dto.debuffOnLevelGap;

        return player;
    }

    updateCombatDetails() {
        if (this.equipment["/equipment_types/main_hand"]) {
            this.combatDetails.combatStats.combatStyleHrid =
                this.equipment["/equipment_types/main_hand"].getCombatStyle();
            this.combatDetails.combatStats.damageType = this.equipment["/equipment_types/main_hand"].getDamageType();
            this.combatDetails.combatStats.attackInterval =
                this.equipment["/equipment_types/main_hand"].getCombatStat("attackInterval");
            this.combatDetails.combatStats.primaryTraining = 
                this.equipment["/equipment_types/main_hand"].getPrimaryTraining();
        } else if (this.equipment["/equipment_types/two_hand"]) {
            this.combatDetails.combatStats.combatStyleHrid =
                this.equipment["/equipment_types/two_hand"].getCombatStyle();
            this.combatDetails.combatStats.damageType = this.equipment["/equipment_types/two_hand"].getDamageType();
            this.combatDetails.combatStats.attackInterval =
                this.equipment["/equipment_types/two_hand"].getCombatStat("attackInterval");
            this.combatDetails.combatStats.primaryTraining = 
                this.equipment["/equipment_types/two_hand"].getPrimaryTraining();
        } else {
            this.combatDetails.combatStats.combatStyleHrid = "/combat_styles/smash";
            this.combatDetails.combatStats.damageType = "/damage_types/physical";
            this.combatDetails.combatStats.attackInterval = 3000000000;
            this.combatDetails.combatStats.primaryTraining = "/skills/melee";
        }

        if (this.equipment["/equipment_types/charm"]) {
            this.combatDetails.combatStats.focusTraining = this.equipment["/equipment_types/charm"].getFocusTraining();
        } else {
            this.combatDetails.combatStats.focusTraining = "";
        }

        // MWIX adaptation (performance): copy the 70 equipment sums from a
        // per-player cache instead of re-deriving them.
        //
        // Upstream computes each of the 70 stats as
        //   Object.values(this.equipment).filter(...).map(...).reduce(...)
        // — 210 array allocations and ~1 050 property lookups PER CALL. One
        // simulated hour of chimerical_den T0 / L600 / 5 geared players calls
        // this method 2 574 times, and the .map closure alone held 16.2% of
        // self time in the CPU profile (the .reduce another 3.1%).
        //
        // Equipment is immutable for the duration of a simulation, so the sums
        // are constant and computing them once is exact, not approximate. The
        // browser UI is the one place that DOES swap gear on a live Player
        // (src/main.js updateEquipmentState, then updateCombatStatsUI ->
        // updateCombatDetails), so the cache is validated against a cheap
        // allocation-free signature rather than trusted blindly.
        let totals = this._equipmentStatTotals;
        if (totals === undefined || this._equipmentChanged()) {
            totals = this._equipmentStatTotals = this._computeEquipmentStatTotals();
        }
        copyEquipmentTotals(this.combatDetails.combatStats, totals);

        if (this.equipment["/equipment_types/pouch"]) {
            this.combatDetails.combatStats.foodSlots =
                1 + this.equipment["/equipment_types/pouch"].getCombatStat("foodSlots");
            this.combatDetails.combatStats.drinkSlots =
                1 + this.equipment["/equipment_types/pouch"].getCombatStat("drinkSlots");
        } else {
            this.combatDetails.combatStats.foodSlots = 1;
            this.combatDetails.combatStats.drinkSlots = 1;
        }

        super.updateCombatDetails();
    }

    // Sum every stat in EQUIPMENT_COMBAT_STATS over the worn equipment, exactly
    // as upstream's inline filter/map/reduce did, and snapshot the equipment
    // this result was derived from.
    _computeEquipmentStatTotals() {
        let worn = Object.values(this.equipment).filter((equipment) => equipment != null);

        let totals = makeEquipmentTotals();
        for (let i = 0; i < EQUIPMENT_COMBAT_STATS.length; i++) {
            let stat = EQUIPMENT_COMBAT_STATS[i];
            let sum = 0;
            for (let j = 0; j < worn.length; j++) {
                sum += worn[j].getCombatStat(stat);
            }
            totals[stat] = sum;
        }

        // Flat [slotKey, piece, enhancementLevel, ...]. Flat rather than nested so
        // the validity check below can walk it without allocating.
        let signature = [];
        for (const [slot, piece] of Object.entries(this.equipment)) {
            signature.push(slot, piece, piece == null ? null : piece.enhancementLevel);
        }
        this._equipmentSignature = signature;

        return totals;
    }

    // True when this.equipment no longer matches the snapshot the cached totals
    // were computed from. ~30 identity comparisons and no allocation, against
    // the 210 allocations a recompute costs — cheap enough to run every call,
    // which is what lets the browser's equip-then-recompute path stay correct.
    // Fails SAFE in every direction: anything it cannot account for — a slot
    // added or removed, a different piece, a re-enhanced piece — reads as
    // changed and triggers a recompute.
    _equipmentChanged() {
        let signature = this._equipmentSignature;
        let i = 0;
        for (const slot in this.equipment) {
            let piece = this.equipment[slot];
            if (
                signature[i] !== slot ||
                signature[i + 1] !== piece ||
                signature[i + 2] !== (piece == null ? null : piece.enhancementLevel)
            ) {
                return true;
            }
            i += 3;
        }
        return i !== signature.length;
    }
}

export default Player;
