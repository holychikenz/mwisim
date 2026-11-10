//! consumable.js.

use crate::buff::Buff;
use crate::data::{GameData, TriggerDto};
use crate::js::{s, S, MIN_SAFE_INTEGER};
use crate::trigger::Trigger;

#[derive(Clone, Debug)]
pub struct Consumable {
    pub hrid: S,
    pub cooldown_duration: f64,
    pub hitpoint_restore: f64,
    pub manapoint_restore: f64,
    pub recovery_duration: f64,
    pub category_hrid: S,
    pub is_food: bool,
    pub buffs: Vec<Buff>,
    pub triggers: Vec<Trigger>,
    pub last_used: f64,
}

impl Consumable {
    pub fn new(data: &GameData, hrid: &str, triggers: Option<&[TriggerDto]>) -> Result<Consumable, String> {
        let item = data.items.get(hrid).ok_or_else(|| format!("No consumable found for hrid: {hrid}"))?;
        let det = item
            .consumable_detail
            .as_ref()
            .ok_or_else(|| format!("TypeError: {hrid} has no consumableDetail"))?;
        let mut buffs = Vec::new();
        for b in det.buffs.iter().flatten() {
            buffs.push(Buff::leveled(b, 1.0)?);
        }
        let triggers = match triggers {
            Some(t) => t.iter().map(|t| Trigger::new(data, t)).collect(),
            None => det.default_combat_triggers.iter().flatten().map(|t| Trigger::new(data, t)).collect(),
        };
        Ok(Consumable {
            hrid: s(hrid),
            cooldown_duration: det.cooldown_duration,
            hitpoint_restore: det.hitpoint_restore,
            manapoint_restore: det.manapoint_restore,
            recovery_duration: det.recovery_duration,
            category_hrid: s(&item.category_hrid),
            is_food: item.category_hrid.contains("food"),
            buffs,
            triggers,
            last_used: MIN_SAFE_INTEGER,
        })
    }

    /// The cooldown/stun part of shouldTrigger; the caller then evaluates triggers.
    pub fn ready(&self, now: f64, source: &crate::unit::Unit) -> bool {
        if source.is_stunned {
            return false;
        }
        let haste = if self.is_food { source.cd.cs.food_haste } else { source.cd.cs.drink_concentration };
        let mut cooldown = self.cooldown_duration;
        if haste > 0.0 {
            cooldown = cooldown / (1.0 + haste);
        }
        !(self.last_used + cooldown > now)
    }
}
