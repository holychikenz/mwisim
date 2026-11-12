//! mwi-econ: the item valuation from cowstuff's webapp-rs server (a port of
//! `cow/item_value.py` and friends), shared with csim. Game data stays `serde_json::Value`.

pub mod util;

pub mod alchemy;
pub mod character_stats;
pub mod item_value;
pub mod transmutation;

use serde_json::Value;
use std::sync::Arc;
use util::to_hrid;

/// The data connector core: game catalogue + one character. The server wraps
/// it with market asks, the live flag and the load timestamp.
#[derive(Clone)]
pub struct Gdc {
    pub data: Arc<Value>,
    pub character: Arc<Value>,
}

impl Gdc {
    pub fn new(data: Arc<Value>, character: Arc<Value>) -> Self {
        Gdc { data, character }
    }

    /// `get_item`: `to_hrid` then `itemDetailMap`.
    pub fn get_item(&self, hrid_or_name: &str) -> Option<&Value> {
        self.data.get("itemDetailMap")?.get(to_hrid(hrid_or_name))
    }

    pub fn get_enhancement_bonus(&self, level: usize) -> f64 {
        self.data["enhancementLevelTotalBonusMultiplierTable"][level].as_f64().unwrap_or(0.0)
    }

    /// `Character.get_skill_level`: first matching `characterSkills` entry, else 0.
    pub fn skill_level(&self, skill_hrid: &str) -> i64 {
        self.character
            .get("characterSkills")
            .and_then(Value::as_array)
            .and_then(|skills| skills.iter().find(|s| s.get("skillHrid").and_then(Value::as_str) == Some(skill_hrid)))
            .map(|s| crate::util::py_int(&s["level"]))
            .unwrap_or(0)
    }
}
