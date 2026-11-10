//! buff.js, and the buff-instance records of combatUnit.js (H11-H14).

use crate::data::RawBuff;
use crate::generated::BUFF_TYPE_NAMES;
use crate::js::{s, S};

/// Index into BUFF_TYPE_NAMES; an unknown type is an error, as in buffTypeOrdinal.
pub fn buff_type_ord(type_hrid: &str) -> Result<u16, String> {
    BUFF_TYPE_NAMES
        .binary_search(&type_hrid)
        .map(|i| i as u16)
        .map_err(|_| format!("Unknown buff type: {type_hrid} — regenerate src/combatsimulator/generated/buffTypes.js with `node tools/genBuffTypes.mjs`"))
}

pub fn ord_of(type_hrid: &str) -> u16 {
    buff_type_ord(type_hrid).expect("engine buff type constant missing from BUFF_TYPE_NAMES")
}

/// A buff definition as the engine passes it around: a `Buff` instance, or a
/// raw buff object (zone, crate, community, guild, synthesised combat effect).
#[derive(Clone, Debug)]
pub struct Buff {
    pub unique_hrid: S,
    pub type_hrid: S,
    pub type_ord: u16,
    pub ratio_boost: f64,
    pub flat_boost: f64,
    pub duration: f64,
    pub multiplier_for_skill_hrid: S,
    pub multiplier_per_skill_level: f64,
}

impl Buff {
    /// `new Buff(buff, level)`.
    pub fn leveled(b: &RawBuff, level: f64) -> Result<Buff, String> {
        Ok(Buff {
            unique_hrid: s(&b.unique_hrid),
            type_hrid: s(&b.type_hrid),
            type_ord: buff_type_ord(&b.type_hrid)?,
            ratio_boost: b.ratio_boost + (level - 1.0) * b.ratio_boost_level_bonus,
            flat_boost: b.flat_boost + (level - 1.0) * b.flat_boost_level_bonus,
            duration: b.duration,
            multiplier_for_skill_hrid: s(b.multiplier_for_skill_hrid.as_deref().unwrap_or("")),
            multiplier_per_skill_level: b.multiplier_per_skill_level.unwrap_or(0.0),
        })
    }

    /// A raw buff object used as-is (no level arithmetic).
    pub fn raw(b: &RawBuff) -> Result<Buff, String> {
        Ok(Buff {
            unique_hrid: s(&b.unique_hrid),
            type_hrid: s(&b.type_hrid),
            type_ord: buff_type_ord(&b.type_hrid)?,
            ratio_boost: b.ratio_boost,
            flat_boost: b.flat_boost,
            duration: b.duration,
            multiplier_for_skill_hrid: s(b.multiplier_for_skill_hrid.as_deref().unwrap_or("")),
            multiplier_per_skill_level: b.multiplier_per_skill_level.unwrap_or(f64::NAN),
        })
    }

    /// The buff literals combatSimulator.js builds for curse, fury, weaken, enrage.
    pub fn synth(unique: &str, ty: &str, ratio: f64, flat: f64, duration: f64) -> Buff {
        Buff {
            unique_hrid: s(unique),
            type_hrid: s(ty),
            type_ord: ord_of(ty),
            ratio_boost: ratio,
            flat_boost: flat,
            duration,
            multiplier_for_skill_hrid: s(""),
            multiplier_per_skill_level: f64::NAN,
        }
    }
}

/// A value in `combatBuffs` / `buffInstances`: a buff instance, or (after
/// clearBuffs) a permanent-buff entry, which has no start or expiry.
#[derive(Clone, Debug)]
pub struct BuffEntry {
    pub type_ord: u16,
    pub ratio_boost: f64,
    pub flat_boost: f64,
    /// NaN for an instance applied with no current time (enrage): never expires (H14).
    pub expire_time: f64,
    /// uid of the applying unit (`sourceKey`); 0 for permanent entries.
    pub source: u32,
}

/// A `permanentBuffs` entry, keyed by typeHrid (H13).
#[derive(Clone, Debug)]
pub struct PermBuff {
    pub type_ord: u16,
    pub ratio_boost: f64,
    pub flat_boost: f64,
}
