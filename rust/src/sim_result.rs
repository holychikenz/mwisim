//! simResult.js. Every constructor field is emitted, even when unused: key
//! presence is part of the digest. Objects keep JS insertion order (H25), and
//! `undefined` / NaN / ±Infinity are written as the canonical() sentinels.

use crate::js::{num_key, truthy, S};
use crate::unit::{Unit, LEVEL_NAMES};

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
    pub attacks: OMap<OMap<OMap<OMap<f64>>>>,
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
        let a = self.attacks.entry(source, OMap::default).entry(target, OMap::default).entry(ability, OMap::default);
        let key = match hit {
            Hit::Miss => "miss".to_string(),
            Hit::Dmg(x) => num_key(x),
        };
        bump(a, &key, 1.0);
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
            ("attacks".into(), self.attacks.to_j(|a| a.to_j(|b| b.to_j(|c| n(c))))),
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
            ("playerStats".into(), J::Arr(Vec::new())),
            ("monsterStats".into(), J::Arr(Vec::new())),
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
