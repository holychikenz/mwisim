//! ability.js, including the Blaze/Bloom pseudo-abilities (H20-H22).

use crate::buff::Buff;
use crate::data::{AbilityData, AbilityEffectData, GameData, TriggerDto};
use crate::js::{s, S, MIN_SAFE_INTEGER};
use crate::trigger::Trigger;
use crate::unit::Unit;
use std::rc::Rc;

#[derive(Clone, Debug)]
pub struct AbilityEffect {
    pub target_type: S,
    pub effect_type: S,
    pub combat_style_hrid: S,
    pub damage_type: S,
    pub damage_flat: f64,
    pub damage_ratio: f64,
    pub bonus_accuracy_ratio: f64,
    pub damage_over_time_ratio: f64,
    pub damage_over_time_duration: f64,
    pub armor_damage_ratio: f64,
    pub hp_drain_ratio: f64,
    pub pierce_chance: f64,
    pub blind_chance: f64,
    pub blind_duration: f64,
    pub silence_chance: f64,
    pub silence_duration: f64,
    pub stun_chance: f64,
    pub stun_duration: f64,
    pub spend_hp_ratio: f64,
    pub buffs: Option<Vec<Buff>>,
}

#[derive(Clone, Debug)]
pub struct Ability {
    pub hrid: S,
    pub level: f64,
    pub mana_cost: f64,
    pub cooldown_duration: f64,
    pub cast_duration: f64,
    pub is_special_ability: bool,
    pub effects: Rc<Vec<AbilityEffect>>,
    pub triggers: Vec<Trigger>,
    pub last_used: f64,
}

fn effect(e: &AbilityEffectData, level: f64) -> Result<AbilityEffect, String> {
    let lv = level - 1.0;
    Ok(AbilityEffect {
        target_type: s(&e.target_type),
        effect_type: s(&e.effect_type),
        combat_style_hrid: s(&e.combat_style_hrid),
        damage_type: s(&e.damage_type),
        damage_flat: e.base_damage_flat + lv * e.base_damage_flat_level_bonus,
        damage_ratio: e.base_damage_ratio + lv * e.base_damage_ratio_level_bonus,
        bonus_accuracy_ratio: e.bonus_accuracy_ratio + lv * e.bonus_accuracy_ratio_level_bonus,
        damage_over_time_ratio: e.damage_over_time_ratio,
        damage_over_time_duration: e.damage_over_time_duration,
        armor_damage_ratio: e.armor_damage_ratio + lv * e.armor_damage_ratio_level_bonus,
        hp_drain_ratio: e.hp_drain_ratio,
        pierce_chance: e.pierce_chance,
        blind_chance: e.blind_chance,
        blind_duration: e.blind_duration,
        silence_chance: e.silence_chance,
        silence_duration: e.silence_duration,
        stun_chance: e.stun_chance,
        stun_duration: e.stun_duration,
        spend_hp_ratio: e.spend_hp_ratio,
        buffs: match &e.buffs {
            None => None,
            Some(bs) => Some(bs.iter().map(|b| Buff::leveled(b, level)).collect::<Result<_, _>>()?),
        },
    })
}

fn pseudo(hrid: &str) -> Option<AbilityData> {
    let j = match hrid {
        "blaze" => r#"{"manaCost":0,"cooldownDuration":0,"castDuration":0,"isSpecialAbility":false,
            "abilityEffects":[{"targetType":"allEnemies","effectType":"/ability_effect_types/damage","combatStyleHrid":"/combat_styles/magic","damageType":"/damage_types/fire","baseDamageFlat":0,"baseDamageFlatLevelBonus":0.0,"baseDamageRatio":0.3,"baseDamageRatioLevelBonus":0,"bonusAccuracyRatio":0,"bonusAccuracyRatioLevelBonus":0,"damageOverTimeRatio":0,"damageOverTimeDuration":0,"armorDamageRatio":0,"armorDamageRatioLevelBonus":0,"hpDrainRatio":0,"pierceChance":0,"blindChance":0,"blindDuration":0,"silenceChance":0,"silenceDuration":0,"stunChance":0,"stunDuration":0,"spendHpRatio":0,"buffs":null}],
            "defaultCombatTriggers":[{"dependencyHrid":"/combat_trigger_dependencies/all_enemies","conditionHrid":"/combat_trigger_conditions/number_of_active_units","comparatorHrid":"/combat_trigger_comparators/greater_than_equal","value":1},{"dependencyHrid":"/combat_trigger_dependencies/all_enemies","conditionHrid":"/combat_trigger_conditions/current_hp","comparatorHrid":"/combat_trigger_comparators/greater_than_equal","value":1}]}"#,
        "bloom" => r#"{"manaCost":0,"cooldownDuration":0,"castDuration":0,"isSpecialAbility":false,
            "abilityEffects":[{"targetType":"lowestHpAlly","effectType":"/ability_effect_types/heal","combatStyleHrid":"/combat_styles/magic","damageType":"","baseDamageFlat":10,"baseDamageFlatLevelBonus":0,"baseDamageRatio":0.15,"baseDamageRatioLevelBonus":0,"bonusAccuracyRatio":0,"bonusAccuracyRatioLevelBonus":0,"damageOverTimeRatio":0,"damageOverTimeDuration":0,"armorDamageRatio":0,"armorDamageRatioLevelBonus":0,"hpDrainRatio":0,"pierceChance":0,"blindChance":0,"blindDuration":0,"silenceChance":0,"silenceDuration":0,"stunChance":0,"stunDuration":0,"spendHpRatio":0,"buffs":null}],
            "defaultCombatTriggers":[{"dependencyHrid":"/combat_trigger_dependencies/all_allies","conditionHrid":"/combat_trigger_conditions/lowest_hp_percentage","comparatorHrid":"/combat_trigger_comparators/less_than_equal","value":100}]}"#,
        _ => return None,
    };
    serde_json::from_str(j).ok()
}

impl Ability {
    /// `new Ability(hrid, level = 1, triggers = null)`.
    pub fn new(data: &GameData, hrid: &str, level: f64, triggers: Option<&[TriggerDto]>) -> Result<Ability, String> {
        let owned;
        let a: &AbilityData = match data.abilities.get(hrid) {
            Some(a) => a,
            None => {
                owned = pseudo(hrid).ok_or_else(|| format!("No ability found for hrid: {hrid}"))?;
                &owned
            }
        };
        let effects = a.ability_effects.iter().map(|e| effect(e, level)).collect::<Result<Vec<_>, _>>()?;
        let triggers = match triggers {
            Some(t) => t.iter().map(|t| Trigger::new(data, t)).collect(),
            None => a.default_combat_triggers.iter().flatten().map(|t| Trigger::new(data, t)).collect(),
        };
        Ok(Ability {
            hrid: s(hrid),
            level,
            mana_cost: a.mana_cost,
            cooldown_duration: a.cooldown_duration,
            cast_duration: a.cast_duration,
            is_special_ability: a.is_special_ability,
            effects: Rc::new(effects),
            triggers,
            last_used: MIN_SAFE_INTEGER,
        })
    }

    /// The stun/silence/cooldown part of shouldTrigger; the caller then evaluates triggers.
    pub fn ready(&self, now: f64, source: &Unit) -> bool {
        if source.is_stunned || source.is_silenced {
            return false;
        }
        let haste = source.cd.cs.ability_haste;
        let mut cooldown = self.cooldown_duration;
        if haste > 0.0 {
            cooldown = cooldown * 100.0 / (100.0 + haste);
        }
        !(self.last_used + cooldown > now)
    }
}
