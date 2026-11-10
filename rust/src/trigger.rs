//! trigger.js (H18, H19).

use crate::data::{GameData, TriggerDto};
use crate::generated::TRIGGER_CONDITION_KINDS;
use crate::js::{s, truthy, S};
use crate::unit::Unit;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CondKind {
    Unknown,
    ExactBuff,
    PrefixBuff,
    CurrentHp,
    CurrentMp,
    MissingHp,
    MissingMp,
    StunStatus,
    BlindStatus,
    SilenceStatus,
}

fn cond_kind(hrid: &str) -> CondKind {
    let k = TRIGGER_CONDITION_KINDS.iter().find(|(h, _)| *h == hrid).map(|(_, k)| *k);
    match k {
        Some("EXACT_BUFF") => CondKind::ExactBuff,
        Some("PREFIX_BUFF") => CondKind::PrefixBuff,
        Some("CURRENT_HP") => CondKind::CurrentHp,
        Some("CURRENT_MP") => CondKind::CurrentMp,
        Some("MISSING_HP") => CondKind::MissingHp,
        Some("MISSING_MP") => CondKind::MissingMp,
        Some("STUN_STATUS") => CondKind::StunStatus,
        Some("BLIND_STATUS") => CondKind::BlindStatus,
        Some("SILENCE_STATUS") => CondKind::SilenceStatus,
        _ => CondKind::Unknown,
    }
}

/// A dependency value: a number, a boolean, or a buff lookup (present or `undefined`).
#[derive(Clone, Copy, Debug)]
enum TrigVal {
    Num(f64),
    Bool(bool),
    Buff(bool),
}

#[derive(Clone, Debug)]
pub struct Trigger {
    pub dependency_hrid: S,
    pub condition_hrid: S,
    pub comparator_hrid: S,
    pub value: f64,
    /// `dependencyDetail.isSingleTarget`; None when the dependency is unknown (TypeError at isActive).
    is_single: Option<bool>,
    buff_unique: S,
    kind: CondKind,
}

impl Trigger {
    pub fn new(data: &GameData, t: &TriggerDto) -> Trigger {
        let c = &t.condition_hrid;
        let tail: &str = match c.rfind('/') {
            Some(i) => &c[i..],
            None => c.get(c.len().saturating_sub(1)..).unwrap_or(""),
        };
        Trigger {
            dependency_hrid: s(&t.dependency_hrid),
            condition_hrid: s(c),
            comparator_hrid: s(&t.comparator_hrid),
            value: t.value,
            is_single: data.dependencies.get(&t.dependency_hrid).map(|d| d.is_single_target),
            buff_unique: s(&format!("/buff_uniques{tail}")),
            kind: cond_kind(c),
        }
    }

    pub fn is_active(
        &self,
        source: &Unit,
        target: Option<&Unit>,
        friendlies: Option<&[Unit]>,
        enemies: Option<&[Unit]>,
        now: f64,
    ) -> Result<bool, String> {
        let single = self
            .is_single
            .ok_or_else(|| format!("TypeError: Cannot read properties of undefined (reading 'isSingleTarget') for {}", self.dependency_hrid))?;
        if single {
            let v = match &*self.dependency_hrid {
                "/combat_trigger_dependencies/self" => self.dependency_value(source, now)?,
                "/combat_trigger_dependencies/targeted_enemy" => match target {
                    None => return Ok(false),
                    Some(t) => self.dependency_value(t, now)?,
                },
                _ => return Err(format!("Unknown dependencyHrid in trigger: {}", self.dependency_hrid)),
            };
            self.compare(v)
        } else {
            let dep = match &*self.dependency_hrid {
                "/combat_trigger_dependencies/all_allies" => friendlies.unwrap_or(&[]),
                "/combat_trigger_dependencies/all_enemies" => match enemies {
                    None => return Ok(false),
                    Some(e) => e,
                },
                _ => return Err(format!("Unknown dependencyHrid in trigger: {}", self.dependency_hrid)),
            };
            let v = match &*self.condition_hrid {
                "/combat_trigger_conditions/number_of_active_units" => TrigVal::Num(dep.iter().filter(|u| u.alive()).count() as f64),
                "/combat_trigger_conditions/number_of_dead_units" => TrigVal::Num(dep.iter().filter(|u| !u.alive()).count() as f64),
                "/combat_trigger_conditions/lowest_hp_percentage" => {
                    let mut prev = 2.0;
                    for u in dep.iter().filter(|u| u.alive()) {
                        let p = u.cd.current_hitpoints / u.cd.max_hitpoints;
                        prev = if p < prev { p } else { prev };
                    }
                    TrigVal::Num(prev * 100.0)
                }
                _ => {
                    // reduce((p, c) => p + c, 0) over the alive units' values
                    let mut num = 0.0;
                    let mut buff_seen = false;
                    let mut any_buff_present = false;
                    for u in dep.iter().filter(|u| u.alive()) {
                        match self.dependency_value(u, now)? {
                            TrigVal::Num(x) => num += x,
                            TrigVal::Bool(b) => num += if b { 1.0 } else { 0.0 },
                            TrigVal::Buff(p) => {
                                buff_seen = true;
                                any_buff_present |= p;
                            }
                        }
                    }
                    if buff_seen {
                        // 0 + undefined -> NaN; 0 + object -> a non-empty string.
                        // Either way never comparable; truthy iff some unit has the buff.
                        TrigVal::Buff(any_buff_present)
                    } else {
                        TrigVal::Num(num)
                    }
                }
            };
            self.compare(v)
        }
    }

    fn dependency_value(&self, u: &Unit, now: f64) -> Result<TrigVal, String> {
        Ok(match self.kind {
            CondKind::ExactBuff => TrigVal::Buff(u.combat_buffs.iter().any(|(k, _)| *k == self.buff_unique)),
            CondKind::PrefixBuff => TrigVal::Buff(u.combat_buffs.iter().any(|(k, _)| k.starts_with(&*self.buff_unique))),
            CondKind::CurrentHp => TrigVal::Num(u.cd.current_hitpoints),
            CondKind::CurrentMp => TrigVal::Num(u.cd.current_manapoints),
            CondKind::MissingHp => TrigVal::Num(u.cd.max_hitpoints - u.cd.current_hitpoints),
            CondKind::MissingMp => TrigVal::Num(u.cd.max_manapoints - u.cd.current_manapoints),
            CondKind::StunStatus => TrigVal::Bool(u.is_stunned || u.stun_expire_time == Some(now)),
            CondKind::BlindStatus => TrigVal::Bool(u.is_blinded || u.blind_expire_time == Some(now)),
            CondKind::SilenceStatus => TrigVal::Bool(u.is_silenced || u.silence_expire_time == Some(now)),
            CondKind::Unknown => return Err(format!("Unknown conditionHrid in trigger: {}", self.condition_hrid)),
        })
    }

    fn compare(&self, v: TrigVal) -> Result<bool, String> {
        let as_num = |v: TrigVal| match v {
            TrigVal::Num(x) => x,
            TrigVal::Bool(b) => {
                if b {
                    1.0
                } else {
                    0.0
                }
            }
            TrigVal::Buff(_) => f64::NAN,
        };
        let truth = |v: TrigVal| match v {
            TrigVal::Num(x) => truthy(x),
            TrigVal::Bool(b) | TrigVal::Buff(b) => b,
        };
        match &*self.comparator_hrid {
            "/combat_trigger_comparators/greater_than_equal" => Ok(as_num(v) >= self.value),
            "/combat_trigger_comparators/less_than_equal" => Ok(as_num(v) <= self.value),
            "/combat_trigger_comparators/is_active" => Ok(truth(v)),
            "/combat_trigger_comparators/is_inactive" => Ok(!truth(v)),
            _ => Err(format!("Unknown comparatorHrid in trigger: {}", self.comparator_hrid)),
        }
    }
}

/// Every trigger is evaluated (no short-circuit), as in shouldTrigger's loop.
pub fn all_active(
    triggers: &[Trigger],
    source: &Unit,
    target: Option<&Unit>,
    friendlies: Option<&[Unit]>,
    enemies: Option<&[Unit]>,
    now: f64,
) -> Result<bool, String> {
    if triggers.is_empty() {
        return Ok(true);
    }
    let mut ok = true;
    for t in triggers {
        if !t.is_active(source, target, friendlies, enemies, now)? {
            ok = false;
        }
    }
    Ok(ok)
}
