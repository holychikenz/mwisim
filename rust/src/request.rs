//! The JSON boundary: request and player DTOs (shared/twinEngine.js builds them).

use crate::data::{num_or_nan, RawBuff, TriggerDto};
use crate::js::OrderedMap;
use serde::Deserialize;
use serde_json::{Map, Value};

fn nan() -> f64 {
    f64::NAN
}

fn opt_num_or_nan<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    num_or_nan(d)
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EquipmentDto {
    pub hrid: String,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub enhancement_level: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConsumableDto {
    pub hrid: String,
    pub triggers: Vec<TriggerDto>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AbilityDto {
    pub hrid: String,
    /// Absent -> the constructor's default of 1.
    #[serde(default)]
    pub level: Option<f64>,
    pub triggers: Vec<TriggerDto>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayerDto {
    pub hrid: String,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub stamina_level: f64,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub intelligence_level: f64,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub attack_level: f64,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub melee_level: f64,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub defense_level: f64,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub ranged_level: f64,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub magic_level: f64,
    pub equipment: OrderedMap<Option<EquipmentDto>>,
    pub food: Vec<Option<ConsumableDto>>,
    pub drinks: Vec<Option<ConsumableDto>>,
    pub abilities: Vec<Option<AbilityDto>>,
    pub house_rooms: OrderedMap<Value>,
    pub achievements: Map<String, Value>,
    /// Absent -> undefined; kept raw to tell undefined from null.
    #[serde(default)]
    pub debuff_on_level_gap: Option<Value>,
    #[serde(default)]
    pub extra_buffs: Option<Vec<RawBuff>>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoneReq {
    pub zone_hrid: String,
    #[serde(default, deserialize_with = "opt_num_or_nan")]
    pub difficulty_tier: f64,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrialOptions {
    #[serde(default)]
    pub bonus_hp_regen_ratio: Option<f64>,
    #[serde(default)]
    pub bonus_mp_regen_ratio: Option<f64>,
    #[serde(default)]
    pub enemy_scale: Option<Value>,
    #[serde(default)]
    pub duration_seconds: Option<Value>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrialReq {
    pub trial_hrid: String,
    pub start_tier: Value,
    pub participant_count: f64,
    #[serde(default)]
    pub trial_options: Option<TrialOptions>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunLimits {
    pub max_runs: Value,
    #[serde(default = "nan", deserialize_with = "opt_num_or_nan")]
    pub max_run_duration_ns: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub monster_start_cooldown: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct TraceReq {
    #[serde(default)]
    pub from: u64,
    #[serde(default = "u64_max")]
    pub to: u64,
    #[serde(default)]
    pub deep: bool,
}

fn u64_max() -> u64 {
    u64::MAX
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub kind: String,
    pub players: Vec<PlayerDto>,
    #[serde(default)]
    pub party_buffs: Vec<RawBuff>,
    #[serde(default)]
    pub zone: Option<ZoneReq>,
    #[serde(default)]
    pub guild_trial: Option<TrialReq>,
    #[serde(default)]
    pub simulation_time_limit: Option<f64>,
    #[serde(default)]
    pub run_limits: Option<RunLimits>,
    pub settings: Settings,
    pub rng_state: u32,
    #[serde(default)]
    pub trace: Option<TraceReq>,
}
