//! Game data (dataProvider.js + data/*.json). Only the fields the engine reads;
//! unknown fields are skipped. A missing number deserialises to NaN, which is
//! how `undefined` behaves in every arithmetic and comparison the engine does.

use crate::generated;
use crate::js::{s, OrderedMap, S};
use crate::unit::stat_index;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::rc::Rc;

fn nan() -> f64 {
    f64::NAN
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawBuff {
    #[serde(default)]
    pub unique_hrid: String,
    #[serde(default)]
    pub type_hrid: String,
    #[serde(default = "nan", deserialize_with = "buff_num")]
    pub ratio_boost: f64,
    #[serde(default = "nan", deserialize_with = "buff_num")]
    pub ratio_boost_level_bonus: f64,
    #[serde(default = "nan", deserialize_with = "buff_num")]
    pub flat_boost: f64,
    #[serde(default = "nan", deserialize_with = "buff_num")]
    pub flat_boost_level_bonus: f64,
    #[serde(default = "nan", deserialize_with = "buff_num")]
    pub duration: f64,
    #[serde(default)]
    pub multiplier_for_skill_hrid: Option<String>,
    #[serde(default)]
    pub multiplier_per_skill_level: Option<f64>,
}

/// A buff number. null is 0, as every JS use site makes it (arithmetic, `?? 0`, `|| 0`).
/// A string or boolean is refused: JS would concatenate (`"0.1" + 0`), which the twin does not reproduce.
fn buff_num<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    match Value::deserialize(d)? {
        Value::Null => Ok(0.0),
        Value::Number(n) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        v => Err(serde::de::Error::custom(format!("buff number must be a JSON number or null, got {v}"))),
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDto {
    #[serde(default)]
    pub dependency_hrid: String,
    #[serde(default)]
    pub condition_hrid: String,
    #[serde(default)]
    pub comparator_hrid: String,
    #[serde(default, deserialize_with = "num_or_nan")]
    pub value: f64,
}

/// `Number(v)` of a DTO number; a trigger value is a number in every real DTO.
pub fn num_or_nan<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(crate::js::number(&Value::deserialize(d)?))
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AbilityEffectData {
    #[serde(default)]
    pub target_type: String,
    #[serde(default)]
    pub effect_type: String,
    #[serde(default)]
    pub combat_style_hrid: String,
    #[serde(default)]
    pub damage_type: String,
    #[serde(default = "nan")]
    pub base_damage_flat: f64,
    #[serde(default = "nan")]
    pub base_damage_flat_level_bonus: f64,
    #[serde(default = "nan")]
    pub base_damage_ratio: f64,
    #[serde(default = "nan")]
    pub base_damage_ratio_level_bonus: f64,
    #[serde(default = "nan")]
    pub bonus_accuracy_ratio: f64,
    #[serde(default = "nan")]
    pub bonus_accuracy_ratio_level_bonus: f64,
    #[serde(default = "nan")]
    pub damage_over_time_ratio: f64,
    #[serde(default = "nan")]
    pub damage_over_time_duration: f64,
    #[serde(default = "nan")]
    pub armor_damage_ratio: f64,
    #[serde(default = "nan")]
    pub armor_damage_ratio_level_bonus: f64,
    #[serde(default = "nan")]
    pub hp_drain_ratio: f64,
    #[serde(default = "nan")]
    pub pierce_chance: f64,
    #[serde(default = "nan")]
    pub blind_chance: f64,
    #[serde(default = "nan")]
    pub blind_duration: f64,
    #[serde(default = "nan")]
    pub silence_chance: f64,
    #[serde(default = "nan")]
    pub silence_duration: f64,
    #[serde(default = "nan")]
    pub stun_chance: f64,
    #[serde(default = "nan")]
    pub stun_duration: f64,
    #[serde(default = "nan")]
    pub spend_hp_ratio: f64,
    #[serde(default)]
    pub buffs: Option<Vec<RawBuff>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AbilityData {
    #[serde(default = "nan")]
    pub mana_cost: f64,
    #[serde(default = "nan")]
    pub cooldown_duration: f64,
    #[serde(default = "nan")]
    pub cast_duration: f64,
    #[serde(default)]
    pub is_special_ability: bool,
    #[serde(default)]
    pub ability_effects: Vec<AbilityEffectData>,
    #[serde(default)]
    pub default_combat_triggers: Option<Vec<TriggerDto>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AchievementData {
    #[serde(default)]
    pub hrid: String,
    #[serde(default)]
    pub tier_hrid: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AchievementTierData {
    #[serde(default)]
    pub hrid: String,
    pub buff: RawBuff,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Spawn {
    pub combat_monster_hrid: String,
    #[serde(default = "nan")]
    pub difficulty_tier: f64,
    #[serde(default = "nan")]
    pub rate: f64,
    #[serde(default = "nan")]
    pub strength: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RandomSpawnInfo {
    #[serde(default = "nan")]
    pub max_spawn_count: f64,
    #[serde(default = "nan")]
    pub max_total_strength: f64,
    #[serde(default)]
    pub spawns: Option<Vec<Spawn>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FightInfo {
    pub random_spawn_info: RandomSpawnInfo,
    #[serde(default)]
    pub boss_spawns: Option<Vec<Spawn>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInfo {
    #[serde(default = "nan")]
    pub max_waves: f64,
    #[serde(default)]
    pub random_spawn_info_map: Option<OrderedMap<RandomSpawnInfo>>,
    #[serde(default)]
    pub fixed_spawns_map: Option<OrderedMap<Vec<Spawn>>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CombatZoneInfo {
    #[serde(default)]
    pub is_dungeon: bool,
    pub fight_info: FightInfo,
    pub dungeon_info: DungeonInfo,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionData {
    #[serde(default)]
    pub combat_zone_info: Option<CombatZoneInfo>,
    #[serde(default)]
    pub buffs: Option<Vec<RawBuff>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonsterAbilityData {
    pub ability_hrid: String,
    #[serde(default = "nan")]
    pub level: f64,
    #[serde(default = "nan")]
    pub min_difficulty_tier: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonsterCombatDetails {
    #[serde(default = "nan")]
    pub stamina_level: f64,
    #[serde(default = "nan")]
    pub intelligence_level: f64,
    #[serde(default = "nan")]
    pub attack_level: f64,
    #[serde(default = "nan")]
    pub melee_level: f64,
    #[serde(default = "nan")]
    pub defense_level: f64,
    #[serde(default = "nan")]
    pub ranged_level: f64,
    #[serde(default = "nan")]
    pub magic_level: f64,
    #[serde(default = "nan")]
    pub attack_interval: f64,
    pub combat_stats: Map<String, Value>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonsterData {
    #[serde(default = "nan")]
    pub enrage_time: f64,
    #[serde(default = "nan")]
    pub experience: f64,
    #[serde(default)]
    pub abilities: Vec<MonsterAbilityData>,
    pub combat_details: MonsterCombatDetails,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CombatStyleData {
    #[serde(default)]
    pub skill_exp_map: Option<OrderedMap<Value>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DependencyData {
    #[serde(default)]
    pub is_single_target: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GuildTrialData {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub monster_hrids: Option<Vec<String>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HouseRoomData {
    #[serde(default)]
    pub action_buffs: Option<Vec<RawBuff>>,
    #[serde(default)]
    pub global_buffs: Option<Vec<RawBuff>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EquipmentDetail {
    #[serde(default)]
    pub combat_stats: Map<String, Value>,
    #[serde(default)]
    pub combat_enhancement_bonuses: Map<String, Value>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConsumableDetail {
    #[serde(default = "nan")]
    pub cooldown_duration: f64,
    #[serde(default = "nan")]
    pub hitpoint_restore: f64,
    #[serde(default = "nan")]
    pub manapoint_restore: f64,
    #[serde(default = "nan")]
    pub recovery_duration: f64,
    #[serde(default)]
    pub buffs: Option<Vec<RawBuff>>,
    #[serde(default)]
    pub default_combat_triggers: Option<Vec<TriggerDto>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ItemData {
    #[serde(default)]
    pub category_hrid: String,
    #[serde(default)]
    pub equipment_detail: Option<EquipmentDetail>,
    #[serde(default)]
    pub consumable_detail: Option<ConsumableDetail>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGameData {
    ability_detail_map: HashMap<String, AbilityData>,
    ability_slots_level_requirement_list: Vec<f64>,
    achievement_detail_map: OrderedMap<AchievementData>,
    achievement_tier_detail_map: OrderedMap<AchievementTierData>,
    action_detail_map: HashMap<String, ActionData>,
    combat_monster_detail_map: HashMap<String, MonsterData>,
    combat_style_detail_map: HashMap<String, CombatStyleData>,
    combat_trigger_dependency_detail_map: HashMap<String, DependencyData>,
    enhancement_level_total_bonus_multiplier_table: Vec<f64>,
    guild_trial_detail_map: HashMap<String, GuildTrialData>,
    house_room_detail_map: HashMap<String, HouseRoomData>,
    item_detail_map: HashMap<String, ItemData>,
    #[serde(default)]
    labyrinth_crate_detail_map: HashMap<String, Value>,
}

/// generated/statSchema.js's per-block source, built once per monster (H15).
#[derive(Debug)]
pub struct MonsterStatic {
    pub hrid: S,
    pub data: MonsterData,
    /// The 63 zero-filled stats: (stat index, value or 0).
    pub zeroed: Vec<(usize, f64)>,
    pub attack_interval: Option<f64>,
    pub combat_style_hrids: Option<Vec<S>>,
    pub damage_type: Option<S>,
    pub max_hitpoints_ratio: Option<f64>,
    pub max_manapoints_ratio: Option<f64>,
    pub style0: S,
}

pub struct GameData {
    pub abilities: HashMap<String, AbilityData>,
    pub ability_slots: Vec<f64>,
    pub achievements: OrderedMap<AchievementData>,
    pub achievement_tiers: OrderedMap<AchievementTierData>,
    pub actions: HashMap<String, ActionData>,
    pub monsters: HashMap<String, Rc<MonsterStatic>>,
    pub combat_styles: HashMap<String, CombatStyleData>,
    pub dependencies: HashMap<String, DependencyData>,
    pub enhancement_table: Vec<f64>,
    pub guild_trials: HashMap<String, GuildTrialData>,
    pub house_rooms: HashMap<String, HouseRoomData>,
    pub items: HashMap<String, ItemData>,
    pub labyrinth_crates: HashMap<String, Value>,
}

/// `value != null` as a number: absent, null and non-numbers are None.
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64())
}

impl GameData {
    pub fn from_json(text: &str) -> Result<GameData, String> {
        let raw: RawGameData = serde_json::from_str(text).map_err(|e| format!("game data: {e}"))?;
        // An unknown name here would make unit::equipment_stat_idx write the wrong stat.
        for name in generated::EQUIPMENT_COMBAT_STATS {
            stat_index(name).ok_or_else(|| format!("unknown equipment stat {name}"))?;
        }
        let zeroed_idx: Vec<(usize, &str)> = generated::MONSTER_ZEROED_COMBAT_STATS
            .iter()
            .map(|n| stat_index(n).map(|i| (i, *n)).ok_or_else(|| format!("unknown monster stat {n}")))
            .collect::<Result<_, _>>()?;
        for r in generated::MONSTER_RESIDUAL_STATS {
            if !matches!(*r, "attackInterval" | "combatStyleHrids" | "damageType" | "maxHitpointsRatio" | "maxManapointsRatio") {
                return Err(format!("monster residual stat {r} is not handled by the twin"));
            }
        }
        let mut monsters = HashMap::new();
        for (hrid, m) in raw.combat_monster_detail_map {
            let cs = &m.combat_details.combat_stats;
            let zeroed = zeroed_idx.iter().map(|(i, n)| (*i, num(cs.get(*n)).unwrap_or(0.0))).collect();
            let strs = |k: &str| -> Option<Vec<S>> {
                cs.get(k).and_then(|v| v.as_array()).map(|a| a.iter().map(|x| s(x.as_str().unwrap_or(""))).collect())
            };
            let combat_style_hrids = strs("combatStyleHrids");
            let style0 = combat_style_hrids.as_ref().and_then(|v| v.first().cloned()).unwrap_or_else(|| s(""));
            let st = MonsterStatic {
                hrid: s(&hrid),
                zeroed,
                attack_interval: if cs.contains_key("attackInterval") { Some(num(cs.get("attackInterval")).unwrap_or(f64::NAN)) } else { None },
                combat_style_hrids,
                damage_type: cs.get("damageType").map(|v| s(v.as_str().unwrap_or(""))),
                max_hitpoints_ratio: if cs.contains_key("maxHitpointsRatio") { Some(num(cs.get("maxHitpointsRatio")).unwrap_or(f64::NAN)) } else { None },
                max_manapoints_ratio: if cs.contains_key("maxManapointsRatio") { Some(num(cs.get("maxManapointsRatio")).unwrap_or(f64::NAN)) } else { None },
                style0,
                data: m,
            };
            monsters.insert(hrid, Rc::new(st));
        }
        Ok(GameData {
            abilities: raw.ability_detail_map,
            ability_slots: raw.ability_slots_level_requirement_list,
            achievements: raw.achievement_detail_map,
            achievement_tiers: raw.achievement_tier_detail_map,
            actions: raw.action_detail_map,
            monsters,
            combat_styles: raw.combat_style_detail_map,
            dependencies: raw.combat_trigger_dependency_detail_map,
            enhancement_table: raw.enhancement_level_total_bonus_multiplier_table,
            guild_trials: raw.guild_trial_detail_map,
            house_rooms: raw.house_room_detail_map,
            items: raw.item_detail_map,
            labyrinth_crates: raw.labyrinth_crate_detail_map,
        })
    }
}
