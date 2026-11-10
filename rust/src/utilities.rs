//! combatUtilities.js. Every expression keeps its JS operation order (H4) and
//! every Math.random draw its position and count (H5).

use crate::ability::AbilityEffect;
use crate::js::{self, pow};
use crate::rng::Mulberry32;
use crate::unit::{style_index, Unit, MAGIC_STYLE, SMASH};

pub fn random_int(rng: &mut Mulberry32, mut min: f64, mut max: f64) -> f64 {
    if max < min {
        std::mem::swap(&mut min, &mut max);
    }
    let min_ceil = min.ceil();
    let max_floor = max.floor();
    if min.floor() == max_floor {
        return ((min + max) / 2.0 + rng.next_f64()).floor();
    }
    let min_tail = -1.0 * (min - min_ceil);
    let max_tail = max - max_floor;
    let balanced_weight = 2.0 * min_tail + (max_floor - min_ceil);
    let balanced_average = (max_floor + min_ceil) / 2.0;
    let average = (max + min) / 2.0;
    let extra_tail_weight = (balanced_weight * (average - balanced_average)) / (max_floor + 1.0 - average);
    let extra_tail_chance = (extra_tail_weight / (extra_tail_weight + balanced_weight)).abs();
    if rng.next_f64() < extra_tail_chance {
        if max_tail > min_tail {
            return (max_floor + 1.0).floor();
        } else {
            return (min_ceil - 1.0).floor();
        }
    }
    if max_tail > min_tail {
        (min + rng.next_f64() * (max_floor + min_tail - min + 1.0)).floor()
    } else {
        (min_ceil - max_tail + rng.next_f64() * (max - (min_ceil - max_tail) + 1.0)).floor()
    }
}

#[derive(Clone, Debug, Default)]
pub struct AttackResult {
    pub damage_done: f64,
    pub did_hit: bool,
    pub thorn_damage_done: f64,
    pub thorn_type: &'static str,
    pub retaliation_damage_done: f64,
    pub life_steal_heal: f64,
    pub hp_drain: f64,
    pub mana_leech_mana: f64,
}

pub fn process_attack(
    rng: &mut Mulberry32,
    source: &mut Unit,
    target: &mut Unit,
    effect: Option<&AbilityEffect>,
) -> Result<AttackResult, String> {
    let combat_style = match effect {
        Some(e) => e.combat_style_hrid.clone(),
        None => source.cd.cs.combat_style_hrid.clone(),
    };
    let damage_type = match effect {
        Some(e) => e.damage_type.clone(),
        None => source.cd.cs.damage_type.clone(),
    };

    let si = style_index(&combat_style).ok_or_else(|| format!("Unknown combat style: {combat_style}"))?;
    let mut source_accuracy_rating = source.cd.accuracy_rating[si];
    let source_auto_attack_max_damage = source.cd.max_damage[si];
    let target_evasion_rating = target.cd.evasion_rating[si];

    let s = &source.cd;
    let t = &target.cd;
    let (source_damage_multiplier, source_resistance, source_penetration, target_resistance, target_thorn_power, target_penetration, thorn_type) =
        match &*damage_type {
            "/damage_types/physical" => (
                1.0 + s.cs.physical_amplify,
                s.total_armor,
                s.cs.armor_penetration,
                t.total_armor,
                t.cs.physical_thorns,
                t.cs.armor_penetration,
                "physicalThorns",
            ),
            "/damage_types/water" => (
                1.0 + s.cs.water_amplify,
                s.total_water_resistance,
                s.cs.water_penetration,
                t.total_water_resistance,
                t.cs.elemental_thorns,
                t.cs.water_penetration,
                "elementalThorns",
            ),
            "/damage_types/nature" => (
                1.0 + s.cs.nature_amplify,
                s.total_nature_resistance,
                s.cs.nature_penetration,
                t.total_nature_resistance,
                t.cs.elemental_thorns,
                t.cs.nature_penetration,
                "elementalThorns",
            ),
            "/damage_types/fire" => (
                1.0 + s.cs.fire_amplify,
                s.total_fire_resistance,
                s.cs.fire_penetration,
                t.total_fire_resistance,
                t.cs.elemental_thorns,
                t.cs.fire_penetration,
                "elementalThorns",
            ),
            _ => return Err(format!("Unknown damage type: {damage_type}")),
        };

    let mut crit_chance = 0.0;
    let bonus_crit_chance = s.cs.critical_rate;
    let bonus_crit_damage = s.cs.critical_damage;

    if let Some(e) = effect {
        source_accuracy_rating *= 1.0 + e.bonus_accuracy_ratio;
    }

    let hit_chance =
        pow(source_accuracy_rating, 1.4) / (pow(source_accuracy_rating, 1.4) + pow(target_evasion_rating, 1.4));

    if &*combat_style == "/combat_styles/ranged" {
        crit_chance = 0.3 * hit_chance;
    }
    crit_chance = crit_chance + bonus_crit_chance;

    let base_damage_flat = effect.map(|e| e.damage_flat).unwrap_or(0.0);
    let base_damage_ratio = effect.map(|e| e.damage_ratio).unwrap_or(1.0);
    let armor_damage_ratio_flat = match effect {
        Some(e) => e.armor_damage_ratio * s.total_armor,
        None => 0.0,
    };

    let mut source_min_damage = source_damage_multiplier * (1.0 + base_damage_flat + armor_damage_ratio_flat);
    let mut source_max_damage =
        source_damage_multiplier * (base_damage_ratio * source_auto_attack_max_damage + base_damage_flat + armor_damage_ratio_flat);

    if rng.next_f64() < crit_chance {
        source_max_damage = source_max_damage * (1.0 + bonus_crit_damage);
        source_min_damage = source_max_damage;
    }

    let mut damage_roll = random_int(rng, source_min_damage, source_max_damage);
    // TASK_DAMAGE_APPLIES = false: taskDamageMultiplier is 1.
    damage_roll *= 1.0;
    damage_roll *= 1.0 + t.cs.damage_taken;
    if effect.is_none() {
        damage_roll += damage_roll * s.cs.auto_attack_damage;
    } else {
        damage_roll *= 1.0 + s.cs.ability_damage;
    }

    let mut damage_done = 0.0;
    let mut thorn_damage_done = 0.0;
    let mut did_hit = false;
    if rng.next_f64() < hit_chance {
        did_hit = true;
        let mut penetrated_target_resistance = target_resistance;
        if source_penetration > 0.0 && target_resistance > 0.0 {
            penetrated_target_resistance = target_resistance / (1.0 + source_penetration);
        }
        let mut target_damage_taken_ratio = 100.0 / (100.0 + penetrated_target_resistance);
        if penetrated_target_resistance < 0.0 {
            target_damage_taken_ratio = (100.0 - penetrated_target_resistance) / 100.0;
        }
        let mitigated_damage = (target_damage_taken_ratio * damage_roll).ceil();
        damage_done = js::min(mitigated_damage, target.cd.current_hitpoints);
        target.cd.current_hitpoints -= damage_done;
    }

    let target_alive = target.cd.current_hitpoints > 0.0;

    if target_alive && target_thorn_power > 0.0 && target_resistance > -99.0 {
        let mut penetrated_source_resistance = source_resistance;
        if source_resistance > 0.0 {
            penetrated_source_resistance = source_resistance / (1.0 + target_penetration);
        }
        let mut source_damage_taken_ratio = 100.0 / (100.0 + penetrated_source_resistance);
        if penetrated_source_resistance < 0.0 {
            source_damage_taken_ratio = (100.0 - penetrated_source_resistance) / 100.0;
        }
        let target_task_damage_multiplier = 1.0;
        let source_damage_taken_multiplier = 1.0 + source.cd.cs.damage_taken;
        let target_damage_multiplier = target_task_damage_multiplier * source_damage_taken_multiplier;
        let thorns_damage_roll = random_int(
            rng,
            1.0,
            target_damage_multiplier * target.cd.defensive_max_damage * (1.0 + target_resistance / 100.0) * target_thorn_power,
        );
        let mitigated_thorns_damage = (source_damage_taken_ratio * thorns_damage_roll).ceil();
        thorn_damage_done = js::min(mitigated_thorns_damage, source.cd.current_hitpoints);
        source.cd.current_hitpoints -= thorn_damage_done;
    }

    let mut retaliation_damage_done = 0.0;
    if target_alive && target.cd.cs.retaliation > 0.0 {
        let retaliation_hit_chance = pow(target.cd.accuracy_rating[SMASH], 1.4)
            / (pow(target.cd.accuracy_rating[SMASH], 1.4) + pow(source.cd.evasion_rating[SMASH], 1.4));
        if retaliation_hit_chance > rng.next_f64() {
            let mut source_effective_armor = source.cd.total_armor;
            if source_effective_armor > 0.0 {
                source_effective_armor = source_effective_armor / (1.0 + target.cd.cs.armor_penetration);
            }
            let mut source_damage_taken_ratio = 100.0 / (100.0 + source_effective_armor);
            if source_effective_armor < 0.0 {
                source_damage_taken_ratio = (100.0 - source_effective_armor) / 100.0;
            }
            let target_task_damage_multiplier = 1.0;
            let source_damage_taken_multiplier = 1.0 + source.cd.cs.damage_taken;
            let retaliation_damage_multiplier = target_task_damage_multiplier * source_damage_taken_multiplier;

            let mut premitigated_damage = damage_roll;
            premitigated_damage = js::min(premitigated_damage, target.cd.defensive_max_damage * 5.0);

            let retaliation_min_damage = retaliation_damage_multiplier * target.cd.cs.retaliation * premitigated_damage;
            let retaliation_max_damage =
                retaliation_damage_multiplier * target.cd.cs.retaliation * (target.cd.defensive_max_damage + premitigated_damage);
            let retaliation_damage_roll = random_int(rng, retaliation_min_damage, retaliation_max_damage);
            let mitigated = (source_damage_taken_ratio * retaliation_damage_roll).ceil();
            retaliation_damage_done = js::min(mitigated, source.cd.current_hitpoints);
            source.cd.current_hitpoints -= retaliation_damage_done;
        }
    }

    let mut life_steal_heal = 0.0;
    if effect.is_none() && did_hit && source.cd.cs.life_steal > 0.0 {
        life_steal_heal = source.add_hitpoints((source.cd.cs.life_steal * damage_done).floor());
    }

    let mut hp_drain = 0.0;
    if let Some(e) = effect {
        if did_hit && e.hp_drain_ratio > 0.0 {
            let healing_amplify = 1.0 + source.cd.cs.healing_amplify;
            hp_drain = source.add_hitpoints((e.hp_drain_ratio * damage_done * healing_amplify).floor());
        }
    }

    let mut mana_leech_mana = 0.0;
    if effect.is_none() && did_hit && source.cd.cs.mana_leech > 0.0 {
        mana_leech_mana = source.add_manapoints((source.cd.cs.mana_leech * damage_done).floor());
    }

    Ok(AttackResult {
        damage_done,
        did_hit,
        thorn_damage_done,
        thorn_type,
        retaliation_damage_done,
        life_steal_heal,
        hp_drain,
        mana_leech_mana,
    })
}

/// The heal roll of processHeal / processRevive (read from the source only).
pub fn heal_roll(rng: &mut Mulberry32, source: &Unit, e: &AbilityEffect) -> Result<f64, String> {
    if &*e.combat_style_hrid != "/combat_styles/magic" {
        return Err(format!("Heal ability effect not supported for combat style: {}", e.combat_style_hrid));
    }
    let healing_amplify = 1.0 + source.cd.cs.healing_amplify;
    let magic_max_damage = source.cd.max_damage[MAGIC_STYLE];
    let min_heal = healing_amplify * (1.0 + e.damage_flat);
    let max_heal = healing_amplify * (e.damage_ratio * magic_max_damage + e.damage_flat);
    Ok(random_int(rng, min_heal, max_heal))
}

pub fn process_spend_hp(source: &mut Unit, e: &AbilityEffect) -> f64 {
    let current_hp = source.cd.current_hitpoints;
    let spent = (current_hp * e.spend_hp_ratio).floor();
    source.cd.current_hitpoints -= spent;
    spent
}

pub fn calculate_tick_value(total_value: f64, total_ticks: f64, current_tick: f64) -> f64 {
    let current_sum = ((current_tick * total_value) / total_ticks).floor();
    let previous_sum = (((current_tick - 1.0) * total_value) / total_ticks).floor();
    current_sum - previous_sum
}
