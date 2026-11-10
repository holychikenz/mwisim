//! simResult.js. Every constructor field is emitted, even when unused: key
//! presence is part of the digest. Objects keep JS insertion order (H25), and
//! `undefined` / NaN / ±Infinity are written as the canonical() sentinels.

use crate::js::{num_key, truthy, S};
use crate::buff::Buff;
use crate::data::GameData;
use crate::unit::{CombatDetails, Unit, LEVEL_NAMES, STAT_NAMES};

/// A tiny JSON tree with the JS-only values spelled out.
pub enum J {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn copy(&self) -> J {
        match self {
            J::Undef => J::Undef,
            J::Null => J::Null,
            J::Bool(b) => J::Bool(*b),
            J::Num(x) => J::Num(*x),
            J::Str(s) => J::Str(s.clone()),
            J::Arr(a) => J::Arr(a.iter().map(J::copy).collect()),
            J::Obj(o) => J::Obj(o.iter().map(|(k, v)| (k.clone(), v.copy())).collect()),
        }
    }

    pub fn write(&self, out: &mut String) {
        match self {
            J::Undef => out.push_str("\"@undefined\""),
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(x) => {
                if x.is_nan() {
                    out.push_str("\"@NaN\"")
                } else if *x == f64::INFINITY {
                    out.push_str("\"@Infinity\"")
                } else if *x == f64::NEG_INFINITY {
                    out.push_str("\"@-Infinity\"")
                } else {
                    out.push_str(&serde_json::to_string(x).unwrap_or_else(|_| "null".into()))
                }
            }
            J::Str(st) => out.push_str(&serde_json::to_string(st).unwrap_or_default()),
            J::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            J::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

pub fn opt_num(v: Option<f64>) -> J {
    match v {
        Some(x) => J::Num(x),
        None => J::Undef,
    }
}

pub fn opt_str(v: &Option<S>) -> J {
    match v {
        Some(x) => J::Str(x.to_string()),
        None => J::Undef,
    }
}

/// An insertion-ordered object.
#[derive(Clone, Debug)]
pub struct OMap<V>(pub Vec<(String, V)>);

impl<V> Default for OMap<V> {
    fn default() -> Self {
        OMap(Vec::new())
    }
}

impl<V> OMap<V> {
    pub fn get(&self, k: &str) -> Option<&V> {
        self.0.iter().find(|(kk, _)| kk == k).map(|(_, v)| v)
    }
    pub fn entry(&mut self, k: &str, init: impl FnOnce() -> V) -> &mut V {
        let i = match self.0.iter().position(|(kk, _)| kk == k) {
            Some(i) => i,
            None => {
                self.0.push((k.to_string(), init()));
                self.0.len() - 1
            }
        };
        &mut self.0[i].1
    }
    pub fn to_j(&self, f: impl Fn(&V) -> J) -> J {
        J::Obj(self.0.iter().map(|(k, v)| (k.clone(), f(v))).collect())
    }
}

impl<V> OMap<V> {
    pub fn put(&mut self, k: &str, v: V) {
        match self.0.iter().position(|(kk, _)| kk == k) {
            Some(i) => self.0[i].1 = v,
            None => self.0.push((k.to_string(), v)),
        }
    }
}

/// `if (!obj[k]) obj[k] = 0; obj[k] += amount;`
fn bump(m: &mut OMap<f64>, k: &str, amount: f64) {
    let v = m.entry(k, || 0.0);
    if !truthy(*v) {
        *v = 0.0;
    }
    *v += amount;
}

/// One ability's hit-value tally (`attacks[src][tgt][ability]`). The map is what is
/// emitted; `idx` finds a damage value's slot without building and scanning its key.
#[derive(Clone, Debug, Default)]
pub struct HitCounts {
    pub m: OMap<f64>,
    idx: std::collections::HashMap<u64, usize>,
}

impl HitCounts {
    fn add(&mut self, hit: Hit) {
        // num_key folds -0 into "0" and every NaN into "NaN"; fold the bit keys the same way.
        let k = match hit {
            Hit::Miss => u64::MAX - 1,
            Hit::Dmg(x) if x.is_nan() => u64::MAX,
            Hit::Dmg(x) if x == 0.0 => 0,
            Hit::Dmg(x) => x.to_bits(),
        };
        let m = &mut self.m;
        let i = *self.idx.entry(k).or_insert_with(|| {
            let key = match hit {
                Hit::Miss => "miss".to_string(),
                Hit::Dmg(x) => num_key(x),
            };
            m.0.push((key, 0.0));
            m.0.len() - 1
        });
        let v = &mut m.0[i].1;
        if !truthy(*v) {
            *v = 0.0;
        }
        *v += 1.0;
    }
}

#[derive(Clone, Debug)]
pub enum Hit {
    Miss,
    Dmg(f64),
}

pub struct Tsa {
    pub name: String,
    pub time_spent_alive: f64,
    pub spawned_at: f64,
    pub alive: bool,
    pub count: f64,
}

pub struct OomTime {
    pub is_out_of_mana: bool,
    pub start: f64,
    pub total: f64,
}

pub struct LabOutcome {
    pub outcome: &'static str,
    pub monster_hp_pct: f64,
    pub time: f64,
    pub start_time: f64,
}

/// debuffOnLevelGap as the DTO carried it.
#[derive(Clone, Copy, Debug)]
pub enum Gap {
    Undef,
    Null,
    Num(f64),
}

impl Gap {
    pub fn arith(self) -> f64 {
        match self {
            Gap::Undef => f64::NAN,
            Gap::Null => 0.0,
            Gap::Num(x) => x,
        }
    }
    fn j(self) -> J {
        match self {
            Gap::Undef => J::Undef,
            Gap::Null => J::Null,
            Gap::Num(x) => J::Num(x),
        }
    }
}

pub struct SimResult {
    pub deaths: OMap<f64>,
    pub experience_gained: OMap<[f64; 7]>,
    pub encounters: f64,
    pub attacks: OMap<OMap<OMap<HitCounts>>>,
    pub consumables_used: OMap<OMap<f64>>,
    pub hitpoints_gained: OMap<OMap<f64>>,
    pub healing_done: OMap<OMap<f64>>,
    pub manapoints_gained: OMap<OMap<f64>>,
    pub debuff_on_level_gap: OMap<Gap>,
    pub drop_rate_multiplier: OMap<f64>,
    pub rare_find_multiplier: OMap<f64>,
    pub combat_drop_quantity: OMap<f64>,
    pub player_ran_out_of_mana: OMap<bool>,
    pub player_ran_out_of_mana_time: OMap<OomTime>,
    pub mana_used: OMap<OMap<f64>>,
    pub time_spent_alive: Vec<Tsa>,
    pub boss_spawns: Vec<String>,
    pub hitpoints_spent: OMap<OMap<f64>>,
    pub zone_name: Option<S>,
    pub difficulty_tier: Option<f64>,
    pub labyrinth_name: Option<S>,
    pub room_level: Option<f64>,
    pub is_dungeon: bool,
    pub is_labyrinth: bool,
    pub dungeons_completed: f64,
    pub dungeons_failed: f64,
    pub max_wave_reached: f64,
    pub number_of_players: f64,
    pub max_enrage_stack: f64,
    pub min_dungenon_time: f64,
    pub max_dungenon_time: f64,
    pub last_dungeon_finish_time: f64,
    pub last_encounter_finish_time: f64,
    pub first_encounter_finish_time: f64,
    pub laby_attempt_count: f64,
    pub lab_room_outcomes: Vec<LabOutcome>,
    pub trial_tiers_cleared: f64,
    pub trial_max_tier_cleared: f64,
    pub trial_current_tier: f64,
    pub trial_end_reason: Option<&'static str>,
    pub trial_end_time: f64,
    pub trial_final_tier_hp_removed_frac: f64,
    pub trial_tier_times: OMap<f64>,
    pub trial_player_deaths: OMap<Vec<f64>>,
    pub simulated_time: Option<f64>,
    pub dungeons_timed_out: Option<f64>,
    pub dungeon_run_gap_ns: Option<(f64, f64)>,
    pub player_stats: Vec<J>,
    pub monster_stats: Vec<J>,
}

impl SimResult {
    pub fn new(zone: Option<(S, f64)>, lab: Option<(S, f64)>, n_players: usize) -> SimResult {
        let mut oom = OMap::default();
        for p in ["player1", "player2", "player3", "player4", "player5"] {
            oom.put(p, false);
        }
        SimResult {
            deaths: OMap::default(),
            experience_gained: OMap::default(),
            encounters: 0.0,
            attacks: OMap::default(),
            consumables_used: OMap::default(),
            hitpoints_gained: OMap::default(),
            healing_done: OMap::default(),
            manapoints_gained: OMap::default(),
            debuff_on_level_gap: OMap::default(),
            drop_rate_multiplier: OMap::default(),
            rare_find_multiplier: OMap::default(),
            combat_drop_quantity: OMap::default(),
            player_ran_out_of_mana: oom,
            player_ran_out_of_mana_time: OMap::default(),
            mana_used: OMap::default(),
            time_spent_alive: Vec::new(),
            boss_spawns: Vec::new(),
            hitpoints_spent: OMap::default(),
            zone_name: zone.as_ref().map(|z| z.0.clone()),
            difficulty_tier: zone.as_ref().map(|z| z.1),
            labyrinth_name: lab.as_ref().map(|l| l.0.clone()),
            room_level: lab.as_ref().map(|l| l.1),
            is_dungeon: false,
            is_labyrinth: lab.is_some(),
            dungeons_completed: 0.0,
            dungeons_failed: 0.0,
            max_wave_reached: 0.0,
            number_of_players: n_players as f64,
            max_enrage_stack: 0.0,
            min_dungenon_time: 0.0,
            max_dungenon_time: 0.0,
            last_dungeon_finish_time: 0.0,
            last_encounter_finish_time: 0.0,
            first_encounter_finish_time: 0.0,
            laby_attempt_count: 0.0,
            lab_room_outcomes: Vec::new(),
            trial_tiers_cleared: 0.0,
            trial_max_tier_cleared: 0.0,
            trial_current_tier: 0.0,
            trial_end_reason: None,
            trial_end_time: 0.0,
            trial_final_tier_hp_removed_frac: 0.0,
            trial_tier_times: OMap::default(),
            trial_player_deaths: OMap::default(),
            simulated_time: None,
            dungeons_timed_out: None,
            dungeon_run_gap_ns: None,
            player_stats: Vec::new(),
            monster_stats: Vec::new(),
        }
    }

    pub fn add_death(&mut self, u: &Unit) {
        if u.is_player {
            return;
        }
        bump(&mut self.deaths, &u.hrid, 1.0);
    }

    /// `(this.deaths[h] ?? 0) + 1`: only a missing key reads as 0.
    pub fn add_player_death(&mut self, hrid: &str) {
        *self.deaths.entry(hrid, || 0.0) += 1.0;
    }

    pub fn update_time_spent_alive(&mut self, name: &str, alive: bool, time: f64) {
        let i = self.time_spent_alive.iter().position(|e| e.name == name);
        if alive {
            match i {
                Some(i) => {
                    self.time_spent_alive[i].alive = true;
                    self.time_spent_alive[i].spawned_at = time;
                }
                None => self.time_spent_alive.push(Tsa { name: name.to_string(), time_spent_alive: 0.0, spawned_at: time, alive: true, count: 0.0 }),
            }
        } else {
            let Some(i) = i else { return };
            let e = &mut self.time_spent_alive[i];
            let time_alive = time - e.spawned_at;
            e.alive = false;
            e.time_spent_alive += time_alive;
            e.count += 1.0;
        }
    }

    pub fn update_dungenon_finish(&mut self, begin_flag: &str, finish_time: f64) {
        let Some(i) = self.time_spent_alive.iter().position(|e| e.name == begin_flag) else { return };
        let current = finish_time - self.time_spent_alive[i].spawned_at;
        if self.min_dungenon_time == 0.0 || self.min_dungenon_time > current {
            self.min_dungenon_time = current;
        }
        if self.max_dungenon_time < current {
            self.max_dungenon_time = current;
        }
    }

    /// `skill_exp_keys`: Object.keys(combatStyleDetailMap[style].skillExpMap).
    pub fn add_experience_gain(&mut self, u: &Unit, experience: f64, skill_exp_keys: &[String]) -> Result<(), String> {
        if !u.is_player {
            return Ok(());
        }
        let gained = self.experience_gained.entry(&u.hrid, || [0.0; 7]);
        let mut rate = [0.0f64; 7];
        let idx_of = |hrid: &str| -> Option<usize> {
            let name = hrid.split('/').nth(2)?;
            LEVEL_NAMES.iter().position(|n| *n == name)
        };
        let primary = u
            .cd
            .cs
            .primary_training
            .as_ref()
            .ok_or("TypeError: Cannot read properties of undefined (reading 'split')")?;
        // An unknown skill name would add a key JS iterates too; none exists in the data.
        if let Some(i) = idx_of(primary) {
            rate[i] = 0.3;
        }
        let focus = u.cd.cs.focus_training.as_deref().unwrap_or("");
        if !focus.is_empty() && skill_exp_keys.iter().any(|k| k == focus) {
            if let Some(i) = idx_of(focus) {
                rate[i] += 0.7;
            }
        } else {
            let len = skill_exp_keys.len() as f64;
            for k in skill_exp_keys {
                if let Some(i) = idx_of(k) {
                    rate[i] += 0.7 / len;
                }
            }
        }
        let gap = u.debuff_gap().arith();
        for i in 0..7 {
            if rate[i] <= 0.0 {
                continue;
            }
            let skill_experience = rate[i] * (1.0 + u.skill_experience(i));
            gained[i] += experience * (1.0 + u.cd.cs.combat_experience) * skill_experience * (1.0 + gap);
        }
        Ok(())
    }

    pub fn add_attack(&mut self, source: &str, target: &str, ability: &str, hit: Hit) {
        self.attacks.entry(source, OMap::default).entry(target, OMap::default).entry(ability, HitCounts::default).add(hit);
    }

    pub fn add_consumable_use(&mut self, unit: &str, consumable: &str) {
        bump(self.consumables_used.entry(unit, OMap::default), consumable, 1.0);
    }

    pub fn add_hitpoints_gained(&mut self, unit: &str, source: &str, amount: f64, healer: Option<&str>) {
        bump(self.hitpoints_gained.entry(unit, OMap::default), source, amount);
        if let Some(h) = healer {
            bump(self.healing_done.entry(h, OMap::default), source, amount);
        }
    }

    pub fn add_manapoints_gained(&mut self, unit: &str, source: &str, amount: f64) {
        bump(self.manapoints_gained.entry(unit, OMap::default), source, amount);
    }

    pub fn add_hitpoints_spent(&mut self, unit: &str, source: &str, amount: f64) {
        bump(self.hitpoints_spent.entry(unit, OMap::default), source, amount);
    }

    pub fn set_drop_rate_multipliers(&mut self, u: &Unit) {
        self.drop_rate_multiplier.put(&u.hrid, 1.0 + u.cd.cs.combat_drop_rate);
        self.rare_find_multiplier.put(&u.hrid, 1.0 + u.cd.cs.combat_rare_find);
        self.combat_drop_quantity.put(&u.hrid, u.cd.cs.combat_drop_quantity);
        self.debuff_on_level_gap.put(&u.hrid, u.debuff_gap());
    }

    pub fn set_mana_used(&mut self, u: &Unit) {
        let mut m = OMap::default();
        for (k, v) in &u.ability_mana_costs {
            m.put(k, *v);
        }
        self.mana_used.put(&u.hrid, m);
    }

    pub fn add_ran_out_of_mana_count(&mut self, hrid: &str, is_oom: bool, time: f64) {
        if is_oom {
            self.player_ran_out_of_mana.put(hrid, true);
        }
        let t = self.player_ran_out_of_mana_time.entry(hrid, || OomTime { is_out_of_mana: false, start: 0.0, total: 0.0 });
        if is_oom {
            if !t.is_out_of_mana {
                t.is_out_of_mana = true;
                t.start = time;
            }
        } else if t.is_out_of_mana {
            t.is_out_of_mana = false;
            t.total += time - t.start;
        }
    }

    /// captureStatSnapshot: the first labyrinth encounter's players and monsters, once.
    pub fn capture_stat_snapshot(&mut self, data: &GameData, players: &[Unit], enemies: &[Unit]) {
        if !self.player_stats.is_empty() {
            return;
        }
        self.player_stats = players
            .iter()
            .map(|p| {
                J::Obj(vec![
                    ("hrid".into(), J::Str(p.hrid.to_string())),
                    ("combatStyleHrid".into(), J::Str(p.cd.cs.combat_style_hrid.to_string())),
                    ("combatDetails".into(), combat_details_j(&p.cd)),
                    ("baseLevels".into(), J::Obj(LEVEL_NAMES.iter().zip(p.base.iter()).map(|(k, x)| (k.to_string(), J::Num(*x))).collect())),
                    ("buffSources".into(), buff_sources_j(data, p)),
                ])
            })
            .collect();
        self.monster_stats = enemies
            .iter()
            .map(|m| {
                let (tier, room) = m.monster().map(|mp| (mp.difficulty_tier, mp.room_level)).unwrap_or((f64::NAN, f64::NAN));
                let abilities = m
                    .abilities
                    .iter()
                    .flatten()
                    .map(|a| {
                        J::Obj(vec![
                            ("hrid".into(), J::Str(a.hrid.to_string())),
                            ("name".into(), data.abilities.get(&*a.hrid).and_then(|d| d.name.clone()).map(J::Str).unwrap_or(J::Undef)),
                            ("level".into(), J::Num(a.level)),
                            ("manaCost".into(), J::Num(a.mana_cost)),
                            ("cooldownDuration".into(), J::Num(a.cooldown_duration)),
                            ("castDuration".into(), J::Num(a.cast_duration)),
                        ])
                    })
                    .collect();
                J::Obj(vec![
                    ("hrid".into(), J::Str(m.hrid.to_string())),
                    ("difficultyTier".into(), J::Num(tier)),
                    ("roomLevel".into(), J::Num(room)),
                    ("combatDetails".into(), combat_details_j(&m.cd)),
                    ("abilities".into(), J::Arr(abilities)),
                ])
            })
            .collect();
    }

    pub fn add_lab_room_outcome(&mut self, outcome: &'static str, pct: f64, time: f64, start: f64) {
        self.lab_room_outcomes.push(LabOutcome { outcome, monster_hp_pct: pct, time, start_time: start });
    }

    pub fn record_trial_tier_clear(&mut self, tier: f64, time_spent: f64) {
        let k = num_key(tier);
        if self.trial_tier_times.get(&k).is_none() {
            self.trial_tier_times.put(&k, time_spent);
        }
    }

    pub fn record_trial_player_death(&mut self, hrid: &str, tier: f64) {
        self.trial_player_deaths.entry(hrid, Vec::new).push(tier);
    }

    pub fn record_trial_wipe(&mut self, tier: f64, time: f64, frac: f64) {
        if self.trial_end_reason.is_some() {
            return;
        }
        self.trial_current_tier = tier;
        self.trial_end_reason = Some("wipe");
        self.trial_end_time = time;
        self.trial_final_tier_hp_removed_frac = crate::js::min(1.0, crate::js::max(0.0, frac));
    }

    pub fn record_trial_completed(&mut self, time: f64) {
        if self.trial_end_reason.is_some() {
            return;
        }
        self.trial_end_reason = Some("completed");
        self.trial_end_time = time;
        self.trial_final_tier_hp_removed_frac = 1.0;
    }

    pub fn to_json(&self) -> String {
        let n = |m: &OMap<f64>| m.to_j(|v| J::Num(*v));
        let nn = |m: &OMap<OMap<f64>>| m.to_j(|v| n(v));
        let mut o: Vec<(String, J)> = vec![
            ("deaths".into(), n(&self.deaths)),
            (
                "experienceGained".into(),
                self.experience_gained.to_j(|v| J::Obj(LEVEL_NAMES.iter().zip(v.iter()).map(|(k, x)| (k.to_string(), J::Num(*x))).collect())),
            ),
            ("encounters".into(), J::Num(self.encounters)),
            ("attacks".into(), self.attacks.to_j(|a| a.to_j(|b| b.to_j(|c| n(&c.m))))),
            ("consumablesUsed".into(), nn(&self.consumables_used)),
            ("hitpointsGained".into(), nn(&self.hitpoints_gained)),
            ("healingDone".into(), nn(&self.healing_done)),
            ("manapointsGained".into(), nn(&self.manapoints_gained)),
            ("debuffOnLevelGap".into(), self.debuff_on_level_gap.to_j(|g| g.j())),
            ("dropRateMultiplier".into(), n(&self.drop_rate_multiplier)),
            ("rareFindMultiplier".into(), n(&self.rare_find_multiplier)),
            ("combatDropQuantity".into(), n(&self.combat_drop_quantity)),
            ("playerRanOutOfMana".into(), self.player_ran_out_of_mana.to_j(|b| J::Bool(*b))),
            (
                "playerRanOutOfManaTime".into(),
                self.player_ran_out_of_mana_time.to_j(|t| {
                    J::Obj(vec![
                        ("isOutOfMana".into(), J::Bool(t.is_out_of_mana)),
                        ("startTimeForOutOfMana".into(), J::Num(t.start)),
                        ("totalTimeForOutOfMana".into(), J::Num(t.total)),
                    ])
                }),
            ),
            ("manaUsed".into(), nn(&self.mana_used)),
            (
                "timeSpentAlive".into(),
                J::Arr(
                    self.time_spent_alive
                        .iter()
                        .map(|e| {
                            J::Obj(vec![
                                ("name".into(), J::Str(e.name.clone())),
                                ("timeSpentAlive".into(), J::Num(e.time_spent_alive)),
                                ("spawnedAt".into(), J::Num(e.spawned_at)),
                                ("alive".into(), J::Bool(e.alive)),
                                ("count".into(), J::Num(e.count)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("bossSpawns".into(), J::Arr(self.boss_spawns.iter().map(|b| J::Str(b.clone())).collect())),
            ("hitpointsSpent".into(), nn(&self.hitpoints_spent)),
            ("zoneName".into(), opt_str(&self.zone_name)),
            ("difficultyTier".into(), opt_num(self.difficulty_tier)),
            ("labyrinthName".into(), opt_str(&self.labyrinth_name)),
            ("roomLevel".into(), opt_num(self.room_level)),
            ("isDungeon".into(), J::Bool(self.is_dungeon)),
            ("isLabyrinth".into(), J::Bool(self.is_labyrinth)),
            ("dungeonsCompleted".into(), J::Num(self.dungeons_completed)),
            ("dungeonsFailed".into(), J::Num(self.dungeons_failed)),
            ("maxWaveReached".into(), J::Num(self.max_wave_reached)),
            ("numberOfPlayers".into(), J::Num(self.number_of_players)),
            ("maxEnrageStack".into(), J::Num(self.max_enrage_stack)),
            ("minDungenonTime".into(), J::Num(self.min_dungenon_time)),
            ("maxDungenonTime".into(), J::Num(self.max_dungenon_time)),
            ("lastDungeonFinishTime".into(), J::Num(self.last_dungeon_finish_time)),
            ("lastEncounterFinishTime".into(), J::Num(self.last_encounter_finish_time)),
            ("firstEncounterFinishTime".into(), J::Num(self.first_encounter_finish_time)),
            ("labyAttemptCount".into(), J::Num(self.laby_attempt_count)),
            (
                "labRoomOutcomes".into(),
                J::Arr(
                    self.lab_room_outcomes
                        .iter()
                        .map(|l| {
                            J::Obj(vec![
                                ("outcome".into(), J::Str(l.outcome.into())),
                                ("monsterHpPct".into(), J::Num(l.monster_hp_pct)),
                                ("time".into(), J::Num(l.time)),
                                ("startTime".into(), J::Num(l.start_time)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("trialTiersCleared".into(), J::Num(self.trial_tiers_cleared)),
            ("trialMaxTierCleared".into(), J::Num(self.trial_max_tier_cleared)),
            ("trialCurrentTier".into(), J::Num(self.trial_current_tier)),
            ("trialEndReason".into(), match self.trial_end_reason {
                Some(r) => J::Str(r.into()),
                None => J::Null,
            }),
            ("trialEndTime".into(), J::Num(self.trial_end_time)),
            ("trialFinalTierHpRemovedFrac".into(), J::Num(self.trial_final_tier_hp_removed_frac)),
            ("trialTierTimes".into(), n(&self.trial_tier_times)),
            ("trialPlayerDeaths".into(), self.trial_player_deaths.to_j(|v| J::Arr(v.iter().map(|x| J::Num(*x)).collect()))),
            ("playerStats".into(), J::Arr(self.player_stats.iter().map(J::copy).collect())),
            ("monsterStats".into(), J::Arr(self.monster_stats.iter().map(J::copy).collect())),
        ];
        if let Some(t) = self.simulated_time {
            o.push(("simulatedTime".into(), J::Num(t)));
        }
        if let Some(t) = self.dungeons_timed_out {
            o.push(("dungeonsTimedOut".into(), J::Num(t)));
        }
        if let Some((c, f)) = self.dungeon_run_gap_ns {
            o.push(("dungeonRunGapNs".into(), J::Obj(vec![("completed".into(), J::Num(c)), ("failed".into(), J::Num(f))])));
        }
        let mut out = String::new();
        J::Obj(o).write(&mut out);
        out
    }
}

impl Unit {
    pub fn debuff_gap(&self) -> Gap {
        self.debuff_on_level_gap
    }
}

const STYLE_NAMES: [&str; 5] = ["stab", "slash", "smash", "ranged", "magic"];

/// `structuredClone(unit.combatDetails)` with the JS field names.
fn combat_details_j(cd: &CombatDetails) -> J {
    let mut o: Vec<(String, J)> = LEVEL_NAMES.iter().zip(cd.levels.iter()).map(|(k, x)| (format!("{k}Level"), J::Num(*x))).collect();
    o.push(("maxHitpoints".into(), J::Num(cd.max_hitpoints)));
    o.push(("currentHitpoints".into(), J::Num(cd.current_hitpoints)));
    o.push(("maxManapoints".into(), J::Num(cd.max_manapoints)));
    o.push(("currentManapoints".into(), J::Num(cd.current_manapoints)));
    for (suffix, arr) in [("AccuracyRating", &cd.accuracy_rating), ("MaxDamage", &cd.max_damage), ("EvasionRating", &cd.evasion_rating)] {
        for (st, x) in STYLE_NAMES.iter().zip(arr.iter()) {
            o.push((format!("{st}{suffix}"), J::Num(*x)));
        }
    }
    o.push(("defensiveMaxDamage".into(), J::Num(cd.defensive_max_damage)));
    o.push(("totalArmor".into(), J::Num(cd.total_armor)));
    o.push(("totalWaterResistance".into(), J::Num(cd.total_water_resistance)));
    o.push(("totalNatureResistance".into(), J::Num(cd.total_nature_resistance)));
    o.push(("totalFireResistance".into(), J::Num(cd.total_fire_resistance)));
    o.push(("abilityHaste".into(), J::Num(cd.ability_haste)));
    o.push(("tenacity".into(), J::Num(cd.tenacity)));
    o.push(("totalThreat".into(), J::Num(cd.total_threat)));
    let cs = &cd.cs;
    let mut c: Vec<(String, J)> = vec![
        ("combatStyleHrid".into(), J::Str(cs.combat_style_hrid.to_string())),
        ("damageType".into(), J::Str(cs.damage_type.to_string())),
    ];
    c.extend(STAT_NAMES.iter().enumerate().map(|(i, k)| (k.to_string(), J::Num(cs.by_index(i)))));
    c.push(("primaryTraining".into(), opt_str(&cs.primary_training)));
    c.push(("focusTraining".into(), opt_str(&cs.focus_training)));
    if let Some(v) = &cs.combat_style_hrids {
        c.push(("combatStyleHrids".into(), J::Arr(v.iter().map(|h| J::Str(h.to_string())).collect())));
    }
    o.push(("combatStats".into(), J::Obj(c)));
    J::Obj(o)
}

/// simResult.js `_collectBuffSources`.
fn buff_sources_j(data: &GameData, u: &Unit) -> J {
    let mut sources = Vec::new();
    let mut add = |source: String, buffs: &mut dyn Iterator<Item = &Buff>| {
        let or0 = |x: f64| if truthy(x) { x } else { 0.0 };
        let cleaned: Vec<J> = buffs
            .map(|b| (b, or0(b.flat_boost), or0(b.ratio_boost)))
            .filter(|(_, f, r)| truthy(*f) || truthy(*r))
            .map(|(b, f, r)| J::Obj(vec![("typeHrid".into(), J::Str(b.type_hrid.to_string())), ("flatBoost".into(), J::Num(f)), ("ratioBoost".into(), J::Num(r))]))
            .collect();
        if !cleaned.is_empty() {
            sources.push(J::Obj(vec![("source".into(), J::Str(source)), ("buffs".into(), J::Arr(cleaned))]));
        }
    };
    for (hrid, buffs) in &u.house_rooms {
        let name = data.house_rooms.get(&**hrid).and_then(|r| r.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| hrid.to_string());
        add(name, &mut buffs.iter());
    }
    if let Some(a) = &u.achievement_buffs {
        add("Achievements".into(), &mut a.iter());
    }
    add("Labyrinth crates".into(), &mut u.zone_buffs.iter());
    let is_guild = |b: &&Buff| b.unique_hrid.ends_with("_guild_buff") || b.unique_hrid.contains("guild_building_");
    add("Community / pass / lab-shop".into(), &mut u.extra_buffs.iter().filter(|b| !is_guild(b)));
    add("Guild shrines / buildings".into(), &mut u.extra_buffs.iter().filter(is_guild));
    J::Arr(sources)
}
