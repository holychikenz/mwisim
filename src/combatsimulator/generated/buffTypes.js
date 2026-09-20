// =============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by tools/genBuffTypes.mjs; see that file for why this is generated
// rather than typed, and api/tests/buffTypes.test.mjs, which re-runs the
// generator and compares this file byte for byte. Regenerate with:
//
//     node tools/genBuffTypes.mjs
//
// Ordinals are assigned by sorting the hrids, so the table is a pure function
// of the game data and a data update lands as a reviewable diff.
// =============================================================================

/** ordinal -> buff-type hrid. */
export const BUFF_TYPE_NAMES = Object.freeze([
    "/buff_types/accuracy",
    "/buff_types/action_level",
    "/buff_types/action_speed",
    "/buff_types/alchemy_level",
    "/buff_types/alchemy_success",
    "/buff_types/armor",
    "/buff_types/artisan",
    "/buff_types/attack_level",
    "/buff_types/attack_speed",
    "/buff_types/blessed",
    "/buff_types/brewing_level",
    "/buff_types/cast_speed",
    "/buff_types/cheesesmithing_level",
    "/buff_types/combat_drop_quantity",
    "/buff_types/combat_drop_rate",
    "/buff_types/combat_experience",
    "/buff_types/cooking_level",
    "/buff_types/crafting_level",
    "/buff_types/critical_damage",
    "/buff_types/critical_rate",
    "/buff_types/damage",
    "/buff_types/damage_taken",
    "/buff_types/defense_level",
    "/buff_types/efficiency",
    "/buff_types/elemental_thorns",
    "/buff_types/enhancing_level",
    "/buff_types/enhancing_success",
    "/buff_types/essence_find",
    "/buff_types/evasion",
    "/buff_types/fire_amplify",
    "/buff_types/fire_resistance",
    "/buff_types/foraging_level",
    "/buff_types/fury_accuracy",
    "/buff_types/fury_damage",
    "/buff_types/gathering",
    "/buff_types/gourmet",
    "/buff_types/healing_amplify",
    "/buff_types/hp_regen",
    "/buff_types/intelligence_level",
    "/buff_types/labyrinth_double_progress",
    "/buff_types/life_steal",
    "/buff_types/magic_level",
    "/buff_types/mana_leech",
    "/buff_types/max_hitpoints",
    "/buff_types/max_manapoints",
    "/buff_types/melee_level",
    "/buff_types/milking_level",
    "/buff_types/mp_regen",
    "/buff_types/nature_amplify",
    "/buff_types/nature_resistance",
    "/buff_types/physical_amplify",
    "/buff_types/physical_thorns",
    "/buff_types/processing",
    "/buff_types/ranged_level",
    "/buff_types/rare_find",
    "/buff_types/retaliation",
    "/buff_types/skilling_experience",
    "/buff_types/stamina_level",
    "/buff_types/success_rate",
    "/buff_types/tailoring_level",
    "/buff_types/task_action_speed",
    "/buff_types/tenacity",
    "/buff_types/threat",
    "/buff_types/water_amplify",
    "/buff_types/water_resistance",
    "/buff_types/wisdom",
    "/buff_types/woodcutting_level",
]);

/** buff-type hrid -> ordinal. Null-prototype: no inherited keys to shadow. */
export const BUFF_TYPE = Object.freeze(Object.assign(Object.create(null), {
    "/buff_types/accuracy": 0,
    "/buff_types/action_level": 1,
    "/buff_types/action_speed": 2,
    "/buff_types/alchemy_level": 3,
    "/buff_types/alchemy_success": 4,
    "/buff_types/armor": 5,
    "/buff_types/artisan": 6,
    "/buff_types/attack_level": 7,
    "/buff_types/attack_speed": 8,
    "/buff_types/blessed": 9,
    "/buff_types/brewing_level": 10,
    "/buff_types/cast_speed": 11,
    "/buff_types/cheesesmithing_level": 12,
    "/buff_types/combat_drop_quantity": 13,
    "/buff_types/combat_drop_rate": 14,
    "/buff_types/combat_experience": 15,
    "/buff_types/cooking_level": 16,
    "/buff_types/crafting_level": 17,
    "/buff_types/critical_damage": 18,
    "/buff_types/critical_rate": 19,
    "/buff_types/damage": 20,
    "/buff_types/damage_taken": 21,
    "/buff_types/defense_level": 22,
    "/buff_types/efficiency": 23,
    "/buff_types/elemental_thorns": 24,
    "/buff_types/enhancing_level": 25,
    "/buff_types/enhancing_success": 26,
    "/buff_types/essence_find": 27,
    "/buff_types/evasion": 28,
    "/buff_types/fire_amplify": 29,
    "/buff_types/fire_resistance": 30,
    "/buff_types/foraging_level": 31,
    "/buff_types/fury_accuracy": 32,
    "/buff_types/fury_damage": 33,
    "/buff_types/gathering": 34,
    "/buff_types/gourmet": 35,
    "/buff_types/healing_amplify": 36,
    "/buff_types/hp_regen": 37,
    "/buff_types/intelligence_level": 38,
    "/buff_types/labyrinth_double_progress": 39,
    "/buff_types/life_steal": 40,
    "/buff_types/magic_level": 41,
    "/buff_types/mana_leech": 42,
    "/buff_types/max_hitpoints": 43,
    "/buff_types/max_manapoints": 44,
    "/buff_types/melee_level": 45,
    "/buff_types/milking_level": 46,
    "/buff_types/mp_regen": 47,
    "/buff_types/nature_amplify": 48,
    "/buff_types/nature_resistance": 49,
    "/buff_types/physical_amplify": 50,
    "/buff_types/physical_thorns": 51,
    "/buff_types/processing": 52,
    "/buff_types/ranged_level": 53,
    "/buff_types/rare_find": 54,
    "/buff_types/retaliation": 55,
    "/buff_types/skilling_experience": 56,
    "/buff_types/stamina_level": 57,
    "/buff_types/success_rate": 58,
    "/buff_types/tailoring_level": 59,
    "/buff_types/task_action_speed": 60,
    "/buff_types/tenacity": 61,
    "/buff_types/threat": 62,
    "/buff_types/water_amplify": 63,
    "/buff_types/water_resistance": 64,
    "/buff_types/wisdom": 65,
    "/buff_types/woodcutting_level": 66,
}));

export const BUFF_TYPE_COUNT = 67;

/**
 * Intern a buff-type hrid. An hrid this table has never seen MUST throw:
 * returning undefined would index the dense boost arrays at `undefined`,
 * silently contributing nothing, and the simulation would report a plausible
 * but wrong number with no error anywhere. Regenerate the table instead.
 */
export function buffTypeOrdinal(typeHrid) {
    const ordinal = BUFF_TYPE[typeHrid];
    if (ordinal === undefined) {
        throw new Error(
            "Unknown buff type: " + typeHrid +
            " — regenerate src/combatsimulator/generated/buffTypes.js" +
            " with `node tools/genBuffTypes.mjs`"
        );
    }
    return ordinal;
}
