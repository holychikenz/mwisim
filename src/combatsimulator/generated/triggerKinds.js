// =============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by tools/genTriggerKinds.mjs from the grouping lists in
// src/combatsimulator/trigger.js; see that file for why the grouping is read
// from the engine rather than derived from the game data, and
// api/tests/triggerKinds.test.mjs, which re-runs the generator and compares
// this file byte for byte. Regenerate with:
//
//     node tools/genTriggerKinds.mjs
//
// Kind ordinals come from a sort of the kind NAMES and entries are sorted by
// condition hrid, so this file is a pure function of its input and a change
// lands as a reviewable diff rather than a silent renumbering.
// =============================================================================

// 0 means "this table has never seen this condition". It routes to
// getDependencyValue's `default:` arm, which throws exactly as it always did —
// at evaluation, not at construction, because api/lib/triggerSearch builds
// Trigger objects speculatively. The three multi-target conditions
// (lowest_hp_percentage, number_of_active_units, number_of_dead_units) are
// resolved in isActiveMultiTarget and are legitimately unknown here.
export const KIND_UNKNOWN = 0;
export const KIND_BLIND_STATUS = 1;
export const KIND_CURRENT_HP = 2;
export const KIND_CURRENT_MP = 3;
export const KIND_EXACT_BUFF = 4;
export const KIND_MISSING_HP = 5;
export const KIND_MISSING_MP = 6;
export const KIND_PREFIX_BUFF = 7;
export const KIND_SILENCE_STATUS = 8;
export const KIND_STUN_STATUS = 9;

export const TRIGGER_KIND_COUNT = 10;

/**
 * condition hrid -> condition kind ordinal.
 * Null-prototype: no inherited keys to shadow a condition named `constructor`.
 */
export const TRIGGER_CONDITION_KIND = Object.freeze(Object.assign(Object.create(null), {
    "/combat_trigger_conditions/attack_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/berserk": 4, // EXACT_BUFF
    "/combat_trigger_conditions/blind_status": 1, // BLIND_STATUS
    "/combat_trigger_conditions/channeling_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/crippling_slash": 4, // EXACT_BUFF
    "/combat_trigger_conditions/critical_aura": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/critical_coffee": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/current_hp": 2, // CURRENT_HP
    "/combat_trigger_conditions/current_mp": 3, // CURRENT_MP
    "/combat_trigger_conditions/curse": 4, // EXACT_BUFF
    "/combat_trigger_conditions/defense_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/elemental_affinity": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/elusiveness": 4, // EXACT_BUFF
    "/combat_trigger_conditions/enrage": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/fierce_aura": 4, // EXACT_BUFF
    "/combat_trigger_conditions/fracturing_impact": 4, // EXACT_BUFF
    "/combat_trigger_conditions/frenzy": 4, // EXACT_BUFF
    "/combat_trigger_conditions/frost_surge": 4, // EXACT_BUFF
    "/combat_trigger_conditions/fury": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/guardian_aura": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/ice_spear": 4, // EXACT_BUFF
    "/combat_trigger_conditions/insanity": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/intelligence_coffee": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/invincible": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/invincible_armor": 4, // EXACT_BUFF
    "/combat_trigger_conditions/invincible_fire_resistance": 4, // EXACT_BUFF
    "/combat_trigger_conditions/invincible_nature_resistance": 4, // EXACT_BUFF
    "/combat_trigger_conditions/invincible_water_resistance": 4, // EXACT_BUFF
    "/combat_trigger_conditions/lucky_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/magic_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/maim": 4, // EXACT_BUFF
    "/combat_trigger_conditions/mana_spring": 4, // EXACT_BUFF
    "/combat_trigger_conditions/melee_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/missing_hp": 5, // MISSING_HP
    "/combat_trigger_conditions/missing_mp": 6, // MISSING_MP
    "/combat_trigger_conditions/mystic_aura": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/pestilent_shot": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/precision": 4, // EXACT_BUFF
    "/combat_trigger_conditions/provoke": 4, // EXACT_BUFF
    "/combat_trigger_conditions/puncture": 4, // EXACT_BUFF
    "/combat_trigger_conditions/ranged_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/retribution": 4, // EXACT_BUFF
    "/combat_trigger_conditions/silence_status": 8, // SILENCE_STATUS
    "/combat_trigger_conditions/smoke_burst": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/speed_aura": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/spike_shell": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/stamina_coffee": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/stun_status": 9, // STUN_STATUS
    "/combat_trigger_conditions/swiftness_coffee": 4, // EXACT_BUFF
    "/combat_trigger_conditions/taunt": 4, // EXACT_BUFF
    "/combat_trigger_conditions/toughness": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/toxic_pollen": 7, // PREFIX_BUFF
    "/combat_trigger_conditions/vampirism": 4, // EXACT_BUFF
    "/combat_trigger_conditions/weaken": 4, // EXACT_BUFF
    "/combat_trigger_conditions/wisdom_coffee": 4, // EXACT_BUFF
}));
