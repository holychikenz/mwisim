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
    BossStatus,
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
        Some("BOSS_STATUS") => CondKind::BossStatus,
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

// The hrids below resolved once at construction; the hot path matches on these, not strings.
#[derive(Clone, Copy, Debug)]
enum Cmp { Ge, Le, Active, Inactive, Unknown }
#[derive(Clone, Copy, Debug)]
enum Dep { Own, TargetedEnemy, AllAllies, AllEnemies, Unknown }
#[derive(Clone, Copy, Debug)]
enum Multi { ActiveUnits, DeadUnits, LowestHp, PerUnit }

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
    cmp: Cmp,
    dep: Dep,
    multi: Multi,
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
            cmp: match &*t.comparator_hrid {
                "/combat_trigger_comparators/greater_than_equal" => Cmp::Ge,
                "/combat_trigger_comparators/less_than_equal" => Cmp::Le,
                "/combat_trigger_comparators/is_active" => Cmp::Active,
                "/combat_trigger_comparators/is_inactive" => Cmp::Inactive,
                _ => Cmp::Unknown,
            },
            dep: match &*t.dependency_hrid {
                "/combat_trigger_dependencies/self" => Dep::Own,
                "/combat_trigger_dependencies/targeted_enemy" => Dep::TargetedEnemy,
                "/combat_trigger_dependencies/all_allies" => Dep::AllAllies,
                "/combat_trigger_dependencies/all_enemies" => Dep::AllEnemies,
                _ => Dep::Unknown,
            },
            multi: match c.as_str() {
                "/combat_trigger_conditions/number_of_active_units" => Multi::ActiveUnits,
                "/combat_trigger_conditions/number_of_dead_units" => Multi::DeadUnits,
                "/combat_trigger_conditions/lowest_hp_percentage" => Multi::LowestHp,
                _ => Multi::PerUnit,
            },
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
            let v = match self.dep {
                Dep::Own => self.dependency_value(source, now)?,
                Dep::TargetedEnemy => match target {
                    None => return Ok(false),
                    Some(t) => self.dependency_value(t, now)?,
                },
                _ => return Err(format!("Unknown dependencyHrid in trigger: {}", self.dependency_hrid)),
            };
            self.compare(v)
        } else {
            let dep = match self.dep {
                Dep::AllAllies => friendlies.unwrap_or(&[]),
                Dep::AllEnemies => match enemies {
                    None => return Ok(false),
                    Some(e) => e,
                },
                _ => return Err(format!("Unknown dependencyHrid in trigger: {}", self.dependency_hrid)),
            };
            let v = match self.multi {
                Multi::ActiveUnits => TrigVal::Num(dep.iter().filter(|u| u.alive()).count() as f64),
                Multi::DeadUnits => TrigVal::Num(dep.iter().filter(|u| !u.alive()).count() as f64),
                Multi::LowestHp => {
                    let mut prev = 2.0;
                    for u in dep.iter().filter(|u| u.alive()) {
                        let p = u.cd.current_hitpoints / u.cd.max_hitpoints;
                        prev = if p < prev { p } else { prev };
                    }
                    TrigVal::Num(prev * 100.0)
                }
                Multi::PerUnit => {
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
            // The game data's `isBoss`; players are never bosses.
            CondKind::BossStatus => TrigVal::Bool(u.monster().is_some_and(|m| m.st.data.is_boss)),
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
        match self.cmp {
            Cmp::Ge => Ok(as_num(v) >= self.value),
            Cmp::Le => Ok(as_num(v) <= self.value),
            Cmp::Active => Ok(truth(v)),
            Cmp::Inactive => Ok(!truth(v)),
            Cmp::Unknown => Err(format!("Unknown comparatorHrid in trigger: {}", self.comparator_hrid)),
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

/// The JS triggerKinds / triggerHoist / triggerIndex tests, re-asserted on this port.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::buff::BuffEntry;
    use crate::test_support::data;
    use crate::unit::{PlayerPart, UnitKind};

    const MULTI: [&str; 3] = [
        "/combat_trigger_conditions/lowest_hp_percentage",
        "/combat_trigger_conditions/number_of_active_units",
        "/combat_trigger_conditions/number_of_dead_units",
    ];

    fn trig(dep: &str, cond: &str, cmp: &str, value: f64) -> Trigger {
        let dto: TriggerDto = serde_json::from_value(serde_json::json!({
            "dependencyHrid": dep, "conditionHrid": cond, "comparatorHrid": cmp, "value": value
        }))
        .unwrap();
        Trigger::new(data(), &dto)
    }

    fn own(cond: &str) -> Trigger {
        trig("/combat_trigger_dependencies/self", cond, "/combat_trigger_comparators/is_active", 0.0)
    }

    /// A unit whose combatBuffs hold exactly `keys`.
    fn with_buffs(keys: &[&str]) -> Unit {
        let mut u = Unit::blank(1, true, s("p"), UnitKind::Player(PlayerPart { equipment: Vec::new(), totals: Vec::new() }));
        u.combat_buffs = keys
            .iter()
            .map(|k| (s(k), BuffEntry { type_ord: 0, ratio_boost: 0.0, flat_boost: 0.0, expire_time: f64::NAN, source: 1 }))
            .collect();
        u
    }

    fn present(t: &Trigger, keys: &[&str]) -> bool {
        match t.dependency_value(&with_buffs(keys), 0.0).unwrap() {
            TrigVal::Buff(p) => p,
            v => panic!("{} is not a buff condition: {v:?}", t.condition_hrid),
        }
    }

    // triggerKinds.test.mjs: every condition of the retired 55-arm switch has a kind, in exactly one group; + boss_status.
    #[test]
    fn every_listed_condition_has_a_kind() {
        assert_eq!(TRIGGER_CONDITION_KINDS.len(), 56, "the retired switch's 55 arms plus boss_status");
        let mut names: Vec<_> = TRIGGER_CONDITION_KINDS.iter().map(|(h, _)| *h).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 56, "no condition appears in two groups");
        for (h, _) in TRIGGER_CONDITION_KINDS {
            assert_ne!(cond_kind(h), CondKind::Unknown, "{h}");
        }
    }

    // triggerKinds.test.mjs / triggerHoist.test.mjs: an exact-buff condition reads its own hrid, a prefix one any key it prefixes.
    #[test]
    fn exact_and_prefix_buff_lookups() {
        for (h, _) in TRIGGER_CONDITION_KINDS {
            let t = own(h);
            let me = t.buff_unique.to_string();
            let (suffixed, truncated) = (format!("{me}_1"), me[..me.len() - 1].to_string());
            match t.kind {
                CondKind::ExactBuff => {
                    assert!(!present(&t, &[]), "{h} on no buffs");
                    assert!(present(&t, &["/buff_uniques/unrelated", &me]), "{h}");
                    assert!(!present(&t, &[&suffixed]), "{h} must read its buff by exact hrid, not by prefix");
                }
                CondKind::PrefixBuff => {
                    assert!(!present(&t, &[]), "{h} on no buffs");
                    assert!(present(&t, &[&me]), "{h}");
                    assert!(present(&t, &["/buff_uniques/unrelated", &suffixed]), "{h} must read its buff by prefix");
                    assert!(!present(&t, &[&truncated]), "{h}: a truncated key is not a match");
                }
                _ => {}
            }
        }
        // The near misses of triggerHoist: neither "fur" nor "furious" is a fury buff.
        assert!(!present(&own("/combat_trigger_conditions/fury"), &["/buff_uniques/fur", "/buff_uniques/furious"]));
    }

    // triggerHoist.test.mjs: buffUniqueHrid is "/buff_uniques" + the condition's last path segment.
    #[test]
    fn buff_unique_hrid_is_the_condition_tail() {
        for (cond, want) in [
            ("berserk", "/buff_uniques/berserk"),
            ("attack_coffee", "/buff_uniques/attack_coffee"),
            ("fury", "/buff_uniques/fury"),
            ("invincible_water_resistance", "/buff_uniques/invincible_water_resistance"),
            ("not_a_real_condition_9", "/buff_uniques/not_a_real_condition_9"),
        ] {
            assert_eq!(&*own(&format!("/combat_trigger_conditions/{cond}")).buff_unique, want);
        }
    }

    // triggerKinds.test.mjs / triggerHoist.test.mjs: unknown conditions and dependencies fail at evaluation, not construction.
    #[test]
    fn unknown_names_fail_at_evaluation() {
        let t = own("/combat_trigger_conditions/not_a_real_condition");
        assert_eq!(t.kind, CondKind::Unknown);
        let u = with_buffs(&[]);
        assert!(t.is_active(&u, None, None, None, 0.0).unwrap_err().contains("Unknown conditionHrid in trigger"));
        let t = trig("/combat_trigger_dependencies/nonsense", "/combat_trigger_conditions/fury", "/combat_trigger_comparators/is_active", 0.0);
        assert!(t.is_single.is_none());
        assert!(t.is_active(&u, None, None, None, 0.0).unwrap_err().starts_with("TypeError"));
        assert_eq!(own("/combat_trigger_conditions/fury").is_single, Some(true));
    }

    // triggerKinds.test.mjs: the three multi-target conditions have no kind; isActive resolves them first.
    #[test]
    fn multi_target_conditions_resolve_before_the_kind_table() {
        let allies = [with_buffs(&[])];
        for h in MULTI {
            assert_eq!(cond_kind(h), CondKind::Unknown, "{h}");
            let t = trig("/combat_trigger_dependencies/all_allies", h, "/combat_trigger_comparators/greater_than_equal", 0.0);
            assert!(t.is_active(&allies[0], None, Some(&allies), None, 0.0).is_ok(), "{h}");
        }
    }

    fn game_data_conditions() -> Vec<String> {
        let text = crate::test_support::read("src/combatsimulator/data/combatTriggerConditionDetailMap.json");
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text).unwrap().keys().cloned().collect()
    }

    // triggerIndex.test.mjs: every condition the game data declares has a kind (the multi-target ones resolve first).
    #[test]
    fn every_game_data_condition_is_covered() {
        let missing: Vec<_> = game_data_conditions()
            .into_iter()
            .filter(|c| !MULTI.contains(&c.as_str()) && cond_kind(c) == CondKind::Unknown)
            .collect();
        assert!(missing.is_empty(), "regenerate rust/src/generated.rs: {missing:?}");
    }

    // Boss Status (game data since v1.20260927.0): active exactly when the unit's monster data has isBoss.
    #[test]
    fn boss_status_reads_is_boss() {
        let mut cache = crate::monster::AbilityCache::default();
        let mut mon = |h: &str| crate::monster::create_monster(data(), &mut cache, h, 0.0, 0.0, 2).unwrap();
        let (boss, plain) = (mon("/monsters/acrobat"), mon("/monsters/alligator"));
        let player = with_buffs(&[]);
        let cond = "/combat_trigger_conditions/boss_status";
        let active = |dep: &str| trig(dep, cond, "/combat_trigger_comparators/is_active", 0.0);
        let inactive = |dep: &str| trig(dep, cond, "/combat_trigger_comparators/is_inactive", 0.0);
        let own_dep = "/combat_trigger_dependencies/self";
        let enemy = "/combat_trigger_dependencies/targeted_enemy";
        assert!(active(own_dep).is_active(&boss, None, None, None, 0.0).unwrap());
        assert!(!active(own_dep).is_active(&plain, None, None, None, 0.0).unwrap());
        assert!(inactive(own_dep).is_active(&plain, None, None, None, 0.0).unwrap());
        assert!(!active(own_dep).is_active(&player, None, None, None, 0.0).unwrap(), "players are never bosses");
        assert!(active(enemy).is_active(&player, Some(&boss), None, None, 0.0).unwrap());
        assert!(inactive(enemy).is_active(&player, Some(&plain), None, None, 0.0).unwrap());
    }

    // checkTriggers / CLAUDE.md: a slot fires only when ALL its triggers are true; every trigger is evaluated.
    #[test]
    fn all_triggers_must_hold() {
        let u = with_buffs(&[]); // 110 / 110 HP
        let yes = trig("/combat_trigger_dependencies/self", "/combat_trigger_conditions/current_hp", "/combat_trigger_comparators/greater_than_equal", 1.0);
        let no = trig("/combat_trigger_dependencies/self", "/combat_trigger_conditions/current_hp", "/combat_trigger_comparators/less_than_equal", 0.0);
        let bad = own("/combat_trigger_conditions/not_a_real_condition");
        assert!(all_active(&[], &u, None, None, None, 0.0).unwrap());
        assert!(all_active(&[yes.clone(), yes.clone()], &u, None, None, None, 0.0).unwrap());
        assert!(!all_active(&[yes.clone(), no.clone()], &u, None, None, None, 0.0).unwrap());
        assert!(!all_active(&[no.clone(), yes], &u, None, None, None, 0.0).unwrap());
        assert!(all_active(&[no, bad], &u, None, None, None, 0.0).is_err(), "no short-circuit past a false trigger");
    }
}
