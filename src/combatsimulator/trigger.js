import { combatTriggerDependencyDetailMap } from "./dataProvider";
import { BUFF_UNIQUE_BY_CONDITION } from "./generated/triggerIndex";
import {
    TRIGGER_CONDITION_KIND,
    KIND_UNKNOWN,
    KIND_EXACT_BUFF,
    KIND_PREFIX_BUFF,
    KIND_CURRENT_HP,
    KIND_CURRENT_MP,
    KIND_MISSING_HP,
    KIND_MISSING_MP,
    KIND_STUN_STATUS,
    KIND_BLIND_STATUS,
    KIND_SILENCE_STATUS,
} from "./generated/triggerKinds";

// MWIX adaptation (performance): the grouping of getDependencyValue's switch,
// as lists. Extracted MECHANICALLY from the string switch these replace — see
// the note above getDependencyValue — and read by tools/genTriggerKinds.mjs,
// which compiles them into generated/triggerKinds.js. They encode ENGINE
// SEMANTICS, not game data: which condition reads its buff by exact hrid and
// which by prefix is a property of this method, not of the bestiary, and
// deriving it from the data would silently change behaviour. Do not delete
// them — they are the generator's input and the tests' reference.
export const EXACT_BUFF_CONDITIONS = [
    "/combat_trigger_conditions/berserk",
    "/combat_trigger_conditions/frenzy",
    "/combat_trigger_conditions/precision",
    "/combat_trigger_conditions/vampirism",
    "/combat_trigger_conditions/attack_coffee",
    "/combat_trigger_conditions/defense_coffee",
    "/combat_trigger_conditions/lucky_coffee",
    "/combat_trigger_conditions/magic_coffee",
    "/combat_trigger_conditions/melee_coffee",
    "/combat_trigger_conditions/ranged_coffee",
    "/combat_trigger_conditions/swiftness_coffee",
    "/combat_trigger_conditions/wisdom_coffee",
    "/combat_trigger_conditions/ice_spear",
    "/combat_trigger_conditions/puncture",
    "/combat_trigger_conditions/frost_surge",
    "/combat_trigger_conditions/elusiveness",
    "/combat_trigger_conditions/channeling_coffee",
    "/combat_trigger_conditions/fierce_aura",
    "/combat_trigger_conditions/invincible_armor",
    "/combat_trigger_conditions/invincible_fire_resistance",
    "/combat_trigger_conditions/invincible_nature_resistance",
    "/combat_trigger_conditions/invincible_water_resistance",
    "/combat_trigger_conditions/provoke",
    "/combat_trigger_conditions/taunt",
    "/combat_trigger_conditions/crippling_slash",
    "/combat_trigger_conditions/mana_spring",
    "/combat_trigger_conditions/retribution",
    "/combat_trigger_conditions/fracturing_impact",
    "/combat_trigger_conditions/maim",
    "/combat_trigger_conditions/curse",
    "/combat_trigger_conditions/weaken",
];

export const PREFIX_BUFF_CONDITIONS = [
    "/combat_trigger_conditions/critical_aura",
    "/combat_trigger_conditions/critical_coffee",
    "/combat_trigger_conditions/intelligence_coffee",
    "/combat_trigger_conditions/stamina_coffee",
    "/combat_trigger_conditions/elemental_affinity",
    "/combat_trigger_conditions/fury",
    "/combat_trigger_conditions/guardian_aura",
    "/combat_trigger_conditions/insanity",
    "/combat_trigger_conditions/spike_shell",
    "/combat_trigger_conditions/toxic_pollen",
    "/combat_trigger_conditions/invincible",
    "/combat_trigger_conditions/mystic_aura",
    "/combat_trigger_conditions/pestilent_shot",
    "/combat_trigger_conditions/smoke_burst",
    "/combat_trigger_conditions/speed_aura",
    "/combat_trigger_conditions/toughness",
    "/combat_trigger_conditions/enrage",
];

export const SCALAR_CONDITION_KINDS = {
    "/combat_trigger_conditions/current_hp": "CURRENT_HP",
    "/combat_trigger_conditions/current_mp": "CURRENT_MP",
    "/combat_trigger_conditions/missing_hp": "MISSING_HP",
    "/combat_trigger_conditions/missing_mp": "MISSING_MP",
    "/combat_trigger_conditions/stun_status": "STUN_STATUS",
    "/combat_trigger_conditions/blind_status": "BLIND_STATUS",
    "/combat_trigger_conditions/silence_status": "SILENCE_STATUS",
};

// =============================================================================
// MWIX adaptation (performance): two values hoisted into the constructor.
//
// A CPU profile of the geared-party dungeon put trigger evaluation at 15% of
// engine self time, getDependencyValue alone at 6.7%, and both of the values
// below were being recomputed on every single evaluation despite being pure
// functions of fields that never change after construction:
//
//   dependencyDetail  a lookup into combatTriggerDependencyDetailMap, run once
//                     per trigger per evaluation in isActive().
//   buffUniqueHrid    "/buff_uniques" + conditionHrid.slice(lastIndexOf("/")),
//                     a lastIndexOf plus a slice plus a concatenation, built
//                     twice over in getDependencyValue's two buff groups.
//
// The hoist alone REGRESSED floor-party by 1.2%, losing five of six
// counterbalanced rounds at --reps=9: that case spawns many monsters into cheap
// fights, every spawn constructs its abilities and so its triggers, and the
// hoist had merely moved the concatenation from evaluation to construction. The
// hrid therefore comes from a build-time table (tools/genTriggerIndex.mjs),
// which makes the constructor a single lookup and hands every trigger the SAME
// interned string instead of a freshly allocated one. The fallback keeps a
// condition the table has never seen working, computing the identical string,
// because api/lib/triggerSearch builds Trigger objects speculatively and a
// throw would turn a speculative trigger into a crash.
//
// dependencyDetail stores the map ENTRY rather than its isSingleTarget field so
// that an unknown dependencyHrid still throws its TypeError from isActive(), at
// the same site and on the same evaluation as before, rather than being turned
// into a construction-time failure for a trigger that might never be evaluated.
// api/lib/triggerSearch builds a great many Trigger objects speculatively.
//
// Safe against dataProvider.setOverrides() because that must be called before a
// CombatSimulator is constructed, and every Trigger is built after — including
// the ones inside `new Ability("blaze")` during a run, which read the same
// already-installed maps.
// =============================================================================
class Trigger {
    constructor(dependencyHrid, conditionHrid, comparatorHrid, value = 0) {
        this.dependencyHrid = dependencyHrid;
        this.conditionHrid = conditionHrid;
        this.comparatorHrid = comparatorHrid;
        this.value = value;
        this.dependencyDetail = combatTriggerDependencyDetailMap[dependencyHrid];
        this.buffUniqueHrid =
            BUFF_UNIQUE_BY_CONDITION[conditionHrid] ??
            "/buff_uniques" + conditionHrid.slice(conditionHrid.lastIndexOf("/"));
        this.conditionKind = TRIGGER_CONDITION_KIND[conditionHrid] ?? KIND_UNKNOWN;
    }

    static createFromDTO(dto) {
        let trigger = new Trigger(dto.dependencyHrid, dto.conditionHrid, dto.comparatorHrid, dto.value);

        return trigger;
    }

    isActive(source, target, friendlies, enemies, currentTime) {
        if (this.dependencyDetail.isSingleTarget) {
            return this.isActiveSingleTarget(source, target, currentTime);
        } else {
            return this.isActiveMultiTarget(friendlies, enemies, currentTime);
        }
    }

    isActiveSingleTarget(source, target, currentTime) {
        let dependencyValue;
        switch (this.dependencyHrid) {
            case "/combat_trigger_dependencies/self":
                dependencyValue = this.getDependencyValue(source, currentTime);
                break;
            case "/combat_trigger_dependencies/targeted_enemy":
                if (!target) {
                    return false;
                }
                dependencyValue = this.getDependencyValue(target, currentTime);
                break;
            default:
                throw new Error("Unknown dependencyHrid in trigger: " + this.dependencyHrid);
        }

        return this.compareValue(dependencyValue);
    }

    isActiveMultiTarget(friendlies, enemies, currentTime) {
        let dependency;
        switch (this.dependencyHrid) {
            case "/combat_trigger_dependencies/all_allies":
                dependency = friendlies;
                break;
            case "/combat_trigger_dependencies/all_enemies":
                if (!enemies) {
                    return false;
                }
                dependency = enemies;
                break;
            default:
                throw new Error("Unknown dependencyHrid in trigger: " + this.dependencyHrid);
        }

        let dependencyValue;
        switch (this.conditionHrid) {
            case "/combat_trigger_conditions/number_of_active_units":
                dependencyValue = dependency.filter((unit) => unit.combatDetails.currentHitpoints > 0).length;
                break;
            case "/combat_trigger_conditions/number_of_dead_units":
                dependencyValue = dependency.filter((unit) => unit.combatDetails.currentHitpoints <= 0).length;
                break;
            case "/combat_trigger_conditions/lowest_hp_percentage":
                dependencyValue = dependency.filter((unit) => unit.combatDetails.currentHitpoints > 0).reduce((prev, curr) => {
                    let currentHpPercentage = curr.combatDetails.currentHitpoints / curr.combatDetails.maxHitpoints;
                    return currentHpPercentage < prev ? currentHpPercentage : prev;
                }, 2) * 100;
                break;
            default:
                dependencyValue = dependency
                    .filter((unit) => unit.combatDetails.currentHitpoints > 0)
                    .map((unit) => this.getDependencyValue(unit, currentTime))
                    .reduce((prev, cur) => prev + cur, 0);
                break;
        }

        return this.compareValue(dependencyValue);
    }

    // =========================================================================
    // MWIX adaptation (performance): a condition-KIND ordinal, interned at
    // construction, in place of a ~50-case string switch.
    //
    // getDependencyValue held 8.2% of engine self time and ran after every
    // event, for every trigger of every ability of every living unit. Its 55
    // handled conditions fall into only NINE distinct arms — which is what
    // makes the switch worth collapsing rather than reordering.
    //
    // WHERE THE GROUPING CAME FROM. It was extracted MECHANICALLY from the
    // string switch this replaces, by parsing its case labels and grouping them
    // by the arm they fall through to, and the lists at the top of this file
    // are that extraction's output. It was NOT re-derived by hand, and it is
    // NOT derived from the game data: which conditions read their buff by exact
    // hrid and which by prefix is engine semantics, and the failure mode of
    // getting it wrong is reading a DIFFERENT buff and reporting a plausible
    // wrong number with no error at all. tools/genTriggerKinds.mjs compiles the
    // lists into generated/triggerKinds.js; api/tests/triggerKinds.test.mjs
    // re-runs the generator byte for byte and checks this method against the
    // retired string switch, kept there verbatim as the oracle, over every
    // condition in the table.
    //
    // AN UNKNOWN CONDITION STILL THROWS, AND STILL FROM HERE. KIND_UNKNOWN is 0
    // and falls to the `default:` arm below, so the error is the same error, at
    // the same site, on the same evaluation. Interning it into a throw at
    // CONSTRUCTION would break api/lib/triggerSearch, which builds Trigger
    // objects speculatively — the same argument that made BUFF_UNIQUE_BY_CONDITION
    // fall back rather than throw. Three conditions rely on this: the
    // multi-target ones are resolved in isActiveMultiTarget and never arrive.
    // =========================================================================
    getDependencyValue(source, currentTime) {
        switch (this.conditionKind) {
            case KIND_EXACT_BUFF:
                return source.combatBuffs[this.buffUniqueHrid];
            case KIND_PREFIX_BUFF:
                let buffPrefix = this.buffUniqueHrid;
                for (const buff in source.combatBuffs) {
                    if (buff.startsWith(buffPrefix)) {
                        return source.combatBuffs[buff];
                    }
                }
                return undefined;
            case KIND_CURRENT_HP:
                return source.combatDetails.currentHitpoints;
            case KIND_CURRENT_MP:
                return source.combatDetails.currentManapoints;
            case KIND_MISSING_HP:
                return source.combatDetails.maxHitpoints - source.combatDetails.currentHitpoints;
            case KIND_MISSING_MP:
                return source.combatDetails.maxManapoints - source.combatDetails.currentManapoints;
            case KIND_STUN_STATUS:
                // Replicate the game's behaviour of "stun status active" triggers activating
                // immediately after the stun has worn off
                return source.isStunned || source.stunExpireTime == currentTime;
            case KIND_BLIND_STATUS:
                return source.isBlinded || source.blindExpireTime == currentTime;
            case KIND_SILENCE_STATUS:
                return source.isSilenced || source.silenceExpireTime == currentTime;
            default:
                throw new Error("Unknown conditionHrid in trigger: " + this.conditionHrid);
        }
    }

    compareValue(dependencyValue) {
        switch (this.comparatorHrid) {
            case "/combat_trigger_comparators/greater_than_equal":
                return dependencyValue >= this.value;
            case "/combat_trigger_comparators/less_than_equal":
                return dependencyValue <= this.value;
            case "/combat_trigger_comparators/is_active":
                return !!dependencyValue;
            case "/combat_trigger_comparators/is_inactive":
                return !dependencyValue;
            default:
                throw new Error("Unknown comparatorHrid in trigger: " + this.comparatorHrid);
        }
    }
}

export default Trigger;
