//! equipment.js.

use crate::data::GameData;
use crate::js::{s, truthy, S};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Equipment {
    pub hrid: S,
    pub enhancement_level: f64,
    stats: HashMap<String, f64>,
    bonuses: HashMap<String, f64>,
    multiplier: f64,
    style0: Option<S>,
    damage_type: Option<S>,
    primary_training: Option<S>,
    focus_training: Option<S>,
}

impl Equipment {
    pub fn new(data: &GameData, hrid: &str, enhancement_level: f64) -> Result<Equipment, String> {
        let item = data.items.get(hrid).ok_or_else(|| format!("No equipment found for hrid: {hrid}"))?;
        let det = item
            .equipment_detail
            .as_ref()
            .ok_or_else(|| format!("Cannot read properties of undefined (reading 'combatStats'): {hrid} is not equipment"))?;
        let nums = |m: &serde_json::Map<String, serde_json::Value>| {
            m.iter().filter_map(|(k, v)| v.as_f64().map(|f| (k.clone(), f))).collect::<HashMap<_, _>>()
        };
        let str_of = |k: &str| det.combat_stats.get(k).and_then(|v| v.as_str()).map(s);
        let idx = if enhancement_level >= 0.0 && enhancement_level == enhancement_level.trunc() {
            Some(enhancement_level as usize)
        } else {
            None
        };
        Ok(Equipment {
            hrid: s(hrid),
            enhancement_level,
            stats: nums(&det.combat_stats),
            bonuses: nums(&det.combat_enhancement_bonuses),
            multiplier: idx.and_then(|i| data.enhancement_table.get(i).copied()).unwrap_or(f64::NAN),
            style0: det
                .combat_stats
                .get("combatStyleHrids")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(s),
            damage_type: str_of("damageType"),
            primary_training: str_of("primaryTraining"),
            focus_training: str_of("focusTraining"),
        })
    }

    pub fn get_combat_stat(&self, stat: &str) -> f64 {
        match self.stats.get(stat) {
            Some(v) if truthy(*v) => {
                let bonus = self.bonuses.get(stat).copied().filter(|b| truthy(*b)).unwrap_or(0.0);
                *v + self.multiplier * bonus
            }
            _ => 0.0,
        }
    }

    pub fn combat_style(&self) -> S {
        self.style0.clone().unwrap_or_else(|| s(""))
    }
    pub fn damage_type(&self) -> S {
        self.damage_type.clone().unwrap_or_else(|| s(""))
    }
    pub fn primary_training(&self) -> Option<S> {
        self.primary_training.clone()
    }
    pub fn focus_training(&self) -> Option<S> {
        self.focus_training.clone()
    }
}
