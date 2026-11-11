//! combatSimulator.js: the event loop and every event handler, ported in the
//! JS statement order. Draw rules (plan H5) are noted where a tidier form would
//! change the number of Math.random() calls.

use crate::ability::{Ability, AbilityEffect};
use crate::buff::Buff;
use crate::data::GameData;
use crate::events::{Event, Kind, Ty, UnitRef};
use crate::guild_trial::{GuildTrial, MAX_TIER};
use crate::heap::MinHeap;
use crate::js::{self, S};
use crate::monster::{create_monster, AbilityCache};
use crate::rng::Mulberry32;
use crate::sim_result::{Hit, SimResult};
use crate::trigger::all_active;
use crate::unit::{Unit, UnitKind, LEVEL_NAMES};
use crate::utilities::{self, calculate_tick_value, heal_roll, process_attack, AttackResult};
use crate::zone::{Spawned, Zone};
use std::rc::Rc;

pub type R<T = ()> = Result<T, String>;

const ONE_SECOND: f64 = 1e9;
const HOT_TICK_INTERVAL: f64 = 5.0 * ONE_SECOND;
const DOT_TICK_INTERVAL: f64 = 3.0 * ONE_SECOND;
const REGEN_TICK_INTERVAL: f64 = 10.0 * ONE_SECOND;
const ENEMY_RESPAWN_INTERVAL: f64 = 3.0 * ONE_SECOND;
const PLAYER_RESPAWN_INTERVAL: f64 = 150.0 * ONE_SECOND;
const RESTART_INTERVAL: f64 = 3.0 * ONE_SECOND;
const ENRAGE_TICK_INTERVAL: f64 = 60.0 * ONE_SECOND;
const RUN_GUARD_SLACK_NS: f64 = 60.0 * ONE_SECOND;
const MAX_PARRY_ATTEMPTS: f64 = 5.0;
const MIN_MAX_TICKS: u64 = 5_000_000;
const MAX_TICKS_PER_SIM_HOUR: f64 = 100_000.0;
const EXPIRE_15S: f64 = 15000000000.0;

/// A side of the fight: `this.players` or `this.enemies`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Players,
    Enemies,
}

/// labyrinth.js: one room, fought until the time limit; each attempt ends in a win,
/// a wipe or the 120 s room timer.
pub struct Lab {
    pub monster_hrid: S,
    pub room_level: f64,
    pub attempt_count: f64,
    /// `enconterStartTime`: undefined (None) until the first room starts.
    pub encounter_start_time: Option<f64>,
}

impl Lab {
    pub const ROOM_DURATION_NS: f64 = 120.0 * 1e9;

    pub fn new(monster_hrid: &str, room_level: f64) -> Lab {
        Lab { monster_hrid: js::s(monster_hrid), room_level, attempt_count: 0.0, encounter_start_time: None }
    }
}

pub struct TraceCfg {
    pub from: u64,
    pub to: u64,
    pub deep: bool,
}

pub struct Sim<'a> {
    pub data: &'a GameData,
    pub rng: Mulberry32,
    pub units: Vec<Unit>,
    pub n: usize,
    /// `this.enemies !== null`; the enemies are `units[n..]`.
    pub enemies_on: bool,
    next_uid: u32,
    heap: MinHeap,
    next_eid: u64,
    pub zone: Option<Zone<'a>>,
    pub trial: Option<GuildTrial>,
    pub lab: Option<Lab>,
    pub sim_result: SimResult,
    pub simulation_time: f64,
    all_players_dead: bool,
    trial_ended: bool,
    temp_dungeon_count: f64,
    trial_tier_start_time: f64,
    counted_dead_players: Vec<S>,
    wiped_in_gap: bool,
    enrage_begin_time: f64,
    run_limits: Option<(f64, f64)>,
    dungeon_run_start_time: f64,
    dungeons_timed_out: f64,
    fresh_run_pending: bool,
    random_start: bool,
    pub trace: Option<TraceCfg>,
    pub trace_out: Vec<String>,
    events_processed: u64,
    ability_cache: AbilityCache,
    /// check_triggers' alive snapshot, kept to avoid an allocation per event.
    alive_scratch: Vec<(usize, bool)>,
}

impl<'a> Sim<'a> {
    pub fn new(
        data: &'a GameData,
        players: Vec<Unit>,
        zone: Option<Zone<'a>>,
        trial: Option<GuildTrial>,
        lab: Option<Lab>,
        rng: Mulberry32,
        random_start: bool,
    ) -> Sim<'a> {
        let n = players.len();
        let next_uid = players.iter().map(|p| p.uid).max().unwrap_or(0) + 1;
        let zr = zone.as_ref().map(|z| (z.hrid.clone(), z.difficulty_tier));
        let lr = lab.as_ref().map(|l| (l.monster_hrid.clone(), l.room_level));
        Sim {
            data,
            rng,
            units: players,
            n,
            enemies_on: false,
            next_uid,
            heap: MinHeap::default(),
            next_eid: 0,
            sim_result: SimResult::new(zr, lr, n),
            zone,
            trial,
            lab,
            simulation_time: 0.0,
            all_players_dead: false,
            trial_ended: false,
            temp_dungeon_count: 0.0,
            trial_tier_start_time: 0.0,
            counted_dead_players: Vec::new(),
            wiped_in_gap: false,
            enrage_begin_time: 0.0,
            run_limits: None,
            dungeon_run_start_time: -1.0,
            dungeons_timed_out: 0.0,
            fresh_run_pending: false,
            random_start,
            trace: None,
            trace_out: Vec::new(),
            events_processed: 0,
            ability_cache: AbilityCache::default(),
            alive_scratch: Vec::new(),
        }
    }

    // ---- unit arena ----

    fn uref(&self, i: usize) -> UnitRef {
        UnitRef { idx: i as u16, uid: self.units[i].uid }
    }

    fn resolve(&self, r: UnitRef) -> Option<usize> {
        let i = r.idx as usize;
        (i < self.units.len() && self.units[i].uid == r.uid).then_some(i)
    }

    fn must(&self, r: UnitRef, what: &str) -> R<usize> {
        self.resolve(r).ok_or_else(|| format!("twin: {what} event references a unit that is no longer in the fight"))
    }

    fn pair(&mut self, i: usize, j: usize) -> (&mut Unit, &mut Unit) {
        assert!(i != j, "a unit cannot act on itself here");
        if i < j {
            let (a, b) = self.units.split_at_mut(j);
            (&mut a[i], &mut b[0])
        } else {
            let (a, b) = self.units.split_at_mut(i);
            (&mut b[0], &mut a[j])
        }
    }

    fn side_of(&self, i: usize) -> Side {
        if self.units[i].is_player {
            Side::Players
        } else {
            Side::Enemies
        }
    }

    fn other(side: Side) -> Side {
        match side {
            Side::Players => Side::Enemies,
            Side::Enemies => Side::Players,
        }
    }

    /// The unit indices of a side, or None for `this.enemies === null`.
    fn list(&self, side: Side) -> Option<std::ops::Range<usize>> {
        match side {
            Side::Players => Some(0..self.n),
            Side::Enemies => self.enemies_on.then_some(self.n..self.units.len()),
        }
    }

    fn slice(&self, side: Side) -> Option<&[Unit]> {
        self.list(side).map(|r| &self.units[r])
    }

    /// CombatUtilities.getTarget: the first alive unit.
    fn get_target(&self, side: Side) -> Option<usize> {
        self.list(side)?.find(|&i| self.units[i].alive())
    }

    fn hrid(&self, i: usize) -> S {
        self.units[i].hrid.clone()
    }

    // ---- event queue (events/eventQueue.js) ----

    fn add(&mut self, time: f64, kind: Kind) {
        let e = Event { time, id: self.next_eid, kind };
        self.next_eid += 1;
        self.track(&e, true);
        self.heap.push(e);
    }

    fn track(&mut self, e: &Event, added: bool) {
        let src = match &e.kind {
            Kind::AutoAttack { src } | Kind::AbilityCastEnd { src, .. } => *src,
            _ => return,
        };
        if let Some(i) = self.resolve(src) {
            let u = &mut self.units[i];
            if added {
                u.pending_action_count += 1;
            } else if u.pending_action_count > 0 {
                u.pending_action_count -= 1;
            }
        }
    }

    fn pop(&mut self) -> Option<Event> {
        let e = self.heap.pop()?;
        self.track(&e, false);
        Some(e)
    }

    fn clear_queue(&mut self) {
        let evs = std::mem::take(&mut self.heap.arr);
        for e in &evs {
            self.track(e, false);
        }
    }

    fn remove_from_heap(&mut self, id: u64) -> Option<Event> {
        let len = self.heap.arr.len();
        let idx = self.heap.arr.iter().position(|e| e.id == id)?;
        if idx == 0 {
            self.heap.pop()
        } else if idx == len - 1 {
            self.heap.arr.pop()
        } else {
            let last = self.heap.arr.pop().expect("non-empty");
            let removed = std::mem::replace(&mut self.heap.arr[idx], last);
            self.heap.sift_up(idx);
            self.heap.sift_down(idx);
            Some(removed)
        }
    }

    /// `_removeCollected`: true iff anything matched.
    fn remove_collected(&mut self, ids: Vec<u64>) -> bool {
        if ids.is_empty() {
            return false;
        }
        for id in ids {
            if let Some(e) = self.remove_from_heap(id) {
                self.track(&e, false);
            }
        }
        true
    }

    fn collect(&self, pred: impl Fn(&Event) -> bool) -> Vec<u64> {
        self.heap.arr.iter().filter(|e| pred(e)).map(|e| e.id).collect()
    }

    fn clear_events_for_unit(&mut self, i: usize) -> bool {
        let uid = self.units[i].uid;
        let ids = self.collect(|e| e.source().map(|r| r.uid) == Some(uid) || e.target().map(|r| r.uid) == Some(uid));
        self.remove_collected(ids)
    }

    fn clear_events_of_type(&mut self, ty: Ty) -> bool {
        let ids = self.collect(|e| e.ty() == ty);
        self.remove_collected(ids)
    }

    fn get_matching_type_and_source(&self, ty: Ty, i: usize) -> Option<&Event> {
        let uid = self.units[i].uid;
        self.heap.arr.iter().find(|e| e.ty() == ty && e.source().map(|r| r.uid) == Some(uid))
    }

    fn clear_matching_type_and_source(&mut self, ty: Ty, i: usize) -> bool {
        let uid = self.units[i].uid;
        let ids = self.collect(|e| e.ty() == ty && e.source().map(|r| r.uid) == Some(uid));
        self.remove_collected(ids)
    }

    // ---- simulate ----

    fn max_ticks_at(elapsed: f64) -> f64 {
        MIN_MAX_TICKS as f64 + (elapsed / 3600e9 * MAX_TICKS_PER_SIM_HOUR).ceil()
    }

    /// Err((message, is_range_error)).
    /// `progress` gets the JS "progress" event's fraction every 1000 ticks.
    pub fn simulate(&mut self, limit: f64, run_limits: Option<(f64, f64)>, mut progress: Option<&mut dyn FnMut(f64)>) -> Result<(), (String, bool)> {
        self.temp_dungeon_count = 0.0;
        self.simulation_time = 0.0;
        self.clear_queue();
        let zr = self.zone.as_ref().map(|z| (z.hrid.clone(), z.difficulty_tier));
        let lr = self.lab.as_ref().map(|l| (l.monster_hrid.clone(), l.room_level));
        self.sim_result = SimResult::new(zr, lr, self.n);
        self.trial_ended = false;
        self.trial_tier_start_time = 0.0;
        self.counted_dead_players.clear();

        let mut limit = self.begin_run_mode(run_limits, limit).map_err(|e| (e, true))?;
        if let Some(t) = &self.trial {
            let cap = t.duration_ns;
            limit = if js::truthy(limit) { js::min(limit, cap) } else { cap };
        }

        let mut ticks: u32 = 0;
        let mut total_ticks: u64 = 0;
        let mut stalled: u64 = 0;
        let mut last_time = self.simulation_time;
        self.add(0.0, Kind::CombatStart);

        while self.simulation_time < limit && !self.trial_ended {
            let ev = self.pop().ok_or_else(|| ("TypeError: Cannot read properties of undefined (reading 'time')".to_string(), false))?;
            self.process_event(ev).map_err(|e| (e, false))?;
            total_ticks += 1;
            if self.simulation_time != last_time {
                last_time = self.simulation_time;
                stalled = 0;
            } else {
                stalled += 1;
            }
            if stalled >= MIN_MAX_TICKS || (total_ticks >= MIN_MAX_TICKS && total_ticks as f64 >= Self::max_ticks_at(self.simulation_time)) {
                return Err((
                    format!(
                        "csim simulate(): exceeded MAX_TICKS={} at simTime={:.2}s (limit={:.0}s) — pathological event rate, likely a wiring bug",
                        total_ticks,
                        self.simulation_time / 1e9,
                        limit / 1e9
                    ),
                    false,
                ));
            }
            ticks += 1;
            if ticks == 1000 {
                ticks = 0;
                if let Some(cb) = progress.as_mut() {
                    let frac = match (self.run_limits, &self.zone) {
                        (Some((max_runs, _)), Some(z)) => js::min((z.dungeons_completed + z.dungeons_failed) / max_runs, 1.0),
                        _ => js::min(self.simulation_time / limit, 1.0),
                    };
                    cb(frac);
                }
            }
        }

        self.sim_result.is_dungeon = self.zone.as_ref().map(|z| z.is_dungeon).unwrap_or(false);
        if let Some(z) = &self.zone {
            if self.sim_result.is_dungeon {
                self.sim_result.dungeons_completed = z.dungeons_completed;
                self.sim_result.dungeons_failed = z.dungeons_failed;
                if self.sim_result.dungeons_completed < 1.0 {
                    self.sim_result.max_wave_reached = 0.0;
                    let mut i = 1.0;
                    while i <= z.max_waves() {
                        let name = format!("#{}", js::num_key(i));
                        match self.sim_result.time_spent_alive.iter().find(|e| e.name == name) {
                            Some(e) if e.count != 0.0 => {}
                            _ => break,
                        }
                        self.sim_result.max_wave_reached = i;
                        i += 1.0;
                    }
                } else {
                    self.sim_result.max_wave_reached = z.max_waves();
                }
            }
        }
        self.sim_result.simulated_time = Some(self.simulation_time);
        if self.run_limits.is_some() {
            self.sim_result.dungeons_timed_out = Some(self.dungeons_timed_out);
            self.sim_result.dungeon_run_gap_ns = Some((ENEMY_RESPAWN_INTERVAL, RESTART_INTERVAL));
        }
        for i in 0..self.n {
            if self.trial.is_none() {
                self.sim_result.set_drop_rate_multipliers(&self.units[i]);
            }
            self.sim_result.set_mana_used(&self.units[i]);
        }
        if self.trial.is_some() {
            let frac = if self.enemies_on { self.trial_hp_removed_frac() } else { 0.0 };
            let t = self.trial.as_ref().expect("trial");
            let r = &mut self.sim_result;
            r.trial_tiers_cleared = t.tiers_cleared;
            r.trial_max_tier_cleared = t.max_tier_cleared();
            if !js::truthy(r.trial_current_tier) {
                r.trial_current_tier = t.current_tier;
            }
            if r.trial_end_reason.is_none() {
                r.trial_end_reason = Some("timeout");
                let end = self.simulation_time;
                r.trial_end_time = if js::truthy(end) { end } else { r.simulated_time.unwrap_or(f64::NAN) };
                r.trial_final_tier_hp_removed_frac = js::min(1.0, js::max(0.0, frac));
            }
        }
        if let Some(z) = &self.zone {
            if z.is_dungeon {
                if let Some(fixed) = &z.info.dungeon_info.fixed_spawns_map {
                    for (wave, monsters) in fixed.iter() {
                        let mut name = format!("#{wave}");
                        for m in monsters {
                            name.push(',');
                            name.push_str(&m.combat_monster_hrid);
                        }
                        self.sim_result.boss_spawns.push(name);
                    }
                }
                if let Some(bosses) = &z.info.fight_info.boss_spawns {
                    for b in bosses {
                        self.sim_result.boss_spawns.push(b.combat_monster_hrid.clone());
                    }
                }
            }
        }
        if let Some(l) = &self.lab {
            self.sim_result.laby_attempt_count = l.attempt_count;
        }
        Ok(())
    }

    fn begin_run_mode(&mut self, run_limits: Option<(f64, f64)>, limit: f64) -> R<f64> {
        self.run_limits = None;
        self.dungeon_run_start_time = -1.0;
        self.dungeons_timed_out = 0.0;
        self.fresh_run_pending = false;
        let Some((max_runs, dur)) = run_limits else { return Ok(limit) };
        if !self.zone.as_ref().map(|z| z.is_dungeon).unwrap_or(false) || self.trial.is_some() {
            return Err("csim simulate(): run limits apply to dungeons only".into());
        }
        if !(max_runs == max_runs.trunc() && max_runs.is_finite()) || max_runs < 1.0 {
            return Err(format!("csim simulate(): maxRuns must be a positive integer (got {})", js::num_key(max_runs)));
        }
        if !dur.is_finite() || dur <= 0.0 {
            return Err(format!("csim simulate(): maxRunDurationNs must be > 0 (got {})", js::num_key(dur)));
        }
        self.run_limits = Some((max_runs, dur));
        Ok(max_runs * (dur + RUN_GUARD_SLACK_NS))
    }

    // ---- trace ----

    fn trace_record(&mut self, ev: &Event) {
        let Some(cfg) = &self.trace else { return };
        let n = self.events_processed;
        if n < cfg.from || n >= cfg.to {
            return;
        }
        let deep = cfg.deep;
        let who = ev
            .source()
            .or(ev.target())
            .map(|r| match self.resolve(r) {
                Some(i) => format!("\"{}\"", self.units[i].hrid),
                None => "\"?stale\"".to_string(),
            })
            .or_else(|| match &ev.kind {
                Kind::PlayerRespawn { hrid } => Some(format!("\"{hrid}\"")),
                _ => None,
            })
            .unwrap_or_else(|| "null".into());
        let num = |x: f64| serde_json::to_string(&x).unwrap_or_else(|_| "null".into());
        let hp = |r: std::ops::Range<usize>| -> String {
            let v: Vec<String> = r.map(|i| num(self.units[i].cd.current_hitpoints)).collect();
            format!("[{}]", v.join(","))
        };
        let enemies = match self.list(Side::Enemies) {
            Some(r) => hp(r),
            None => "null".into(),
        };
        let mut rec = format!(
            "[{},{},\"{}\",{},{},{},{},{}",
            n,
            num(ev.time),
            ev.ty().name(),
            who,
            self.rng.a,
            self.heap.arr.len(),
            hp(0..self.n),
            enemies
        );
        if deep {
            let h: Vec<String> = self.heap.arr.iter().map(|e| format!("[\"{}\",{}]", e.ty().name(), num(e.time))).collect();
            rec.push_str(&format!(",[{}]", h.join(",")));
        }
        rec.push(']');
        self.trace_out.push(rec);
    }

    // ---- processEvent ----

    fn process_event(&mut self, ev: Event) -> R {
        self.simulation_time = ev.time;
        self.trace_record(&ev);
        self.events_processed += 1;
        match ev.kind {
            Kind::CombatStart => self.process_combat_start(ev.time)?,
            Kind::PlayerRespawn { hrid } => self.process_player_respawn(&hrid)?,
            Kind::EnemyRespawn => self.start_new_encounter()?,
            Kind::LabyrinthTimeout { start } => self.process_labyrinth_timeout(start),
            Kind::AutoAttack { src } => {
                let i = self.must(src, "autoAttack")?;
                self.process_auto_attack(i)?
            }
            Kind::ConsumableTick { src, hrid, hp, mp, total, cur } => {
                let i = self.must(src, "consumableTick")?;
                self.process_consumable_tick(i, &hrid, hp, mp, total, cur)?
            }
            Kind::DamageOverTime { src_hrid, target, damage, total, cur, style } => {
                let t = self.must(target, "damageOverTime")?;
                self.process_dot(&src_hrid, t, damage, total, cur, style)?
            }
            Kind::CheckBuffExpiration { src }
            | Kind::CurseExpiration { src, .. }
            | Kind::WeakenExpiration { src, .. }
            | Kind::FuryExpiration { src, .. } => {
                // H10: a unit of a dropped encounter is unreachable; its expiry has no effect.
                if let Some(i) = self.resolve(src) {
                    let now = self.simulation_time;
                    self.units[i].remove_expired_buffs(now);
                }
            }
            Kind::RegenTick => self.process_regen_tick(),
            Kind::StunExpiration { src } => {
                let i = self.must(src, "stunExpiration")?;
                self.units[i].is_stunned = false;
                self.add_next_attack_event(i)?;
            }
            Kind::BlindExpiration { src } => {
                let i = self.must(src, "blindExpiration")?;
                self.units[i].is_blinded = false;
                self.add_next_attack_event(i)?;
            }
            Kind::SilenceExpiration { src } => {
                let i = self.must(src, "silenceExpiration")?;
                self.units[i].is_silenced = false;
            }
            Kind::EnrageTick { encounter_time } => self.process_enrage_tick(encounter_time),
            Kind::AbilityCastEnd { src, slot } => {
                let i = self.must(src, "abilityCastEndEvent")?;
                self.try_use_ability(i, slot)?;
            }
            Kind::AwaitCooldown { src } => {
                let i = self.must(src, "awaitCooldownEvent")?;
                self.add_next_attack_event(i)?;
            }
            Kind::CooldownReady => {}
            Kind::DungeonRunTimeout { run_start } => self.process_dungeon_run_timeout(run_start),
        }
        self.check_triggers()
    }

    fn process_combat_start(&mut self, event_time: f64) -> R {
        if self.fresh_run_pending {
            self.start_fresh_run();
        }
        self.counted_dead_players.clear();
        let now = self.simulation_time;
        for i in 0..self.n {
            if event_time == 0.0 {
                self.units[i].generate_permanent_buffs();
            }
            let rs = self.random_start;
            let t = if self.lab.is_some() { 0.0 } else { now };
            self.units[i].reset(t, rs, &mut self.rng);
        }
        self.add(now + REGEN_TICK_INTERVAL, Kind::RegenTick);
        self.start_new_encounter()
    }

    fn process_player_respawn(&mut self, hrid: &str) -> R {
        let i = (0..self.n).find(|&i| &*self.units[i].hrid == hrid).ok_or("TypeError: respawning player not found")?;
        self.counted_dead_players.retain(|h| &**h != hrid);
        self.refill_player(i);
        if self.all_players_dead {
            self.all_players_dead = false;
            self.start_attacks()
        } else {
            self.add_next_attack_event(i)
        }
    }

    fn process_labyrinth_timeout(&mut self, start: f64) {
        let Some(l) = &self.lab else { return };
        if !self.enemies_on {
            return;
        }
        if l.encounter_start_time != Some(start) {
            return;
        }
        if self.units.len() > self.n {
            let pct = self.mob_hp_pct();
            self.sim_result.add_lab_room_outcome("timeout", js::max(0.0, pct), self.simulation_time, start);
        }
        self.enemies_on = false;
        self.clear_queue();
        self.add(self.simulation_time, Kind::CombatStart);
    }

    /// `enemies[0]`'s remaining HP in percent, as the labyrinth outcome log records it.
    fn mob_hp_pct(&self) -> f64 {
        let cd = &self.units[self.n].cd;
        if cd.max_hitpoints > 0.0 {
            (cd.current_hitpoints / cd.max_hitpoints) * 100.0
        } else {
            0.0
        }
    }

    fn refill_player(&mut self, i: usize) {
        let u = &mut self.units[i];
        if u.cd.current_hitpoints <= 0.0 {
            u.clear_buffs();
            u.clear_ccs();
        }
        u.cd.current_hitpoints = u.cd.max_hitpoints;
        u.cd.current_manapoints = u.cd.max_manapoints;
    }

    // ---- dungeon run mode ----

    fn end_dungeon_run(&mut self, completed: bool) {
        let max_runs = self.run_limits.map(|r| r.0).unwrap_or(f64::INFINITY);
        let z = self.zone.as_mut().expect("run mode requires a zone");
        if completed {
            z.dungeons_completed += 1.0;
            z.encounters_killed = 1.0;
            self.temp_dungeon_count = z.dungeons_completed;
        } else {
            z.fail_wave();
        }
        let done = z.dungeons_completed + z.dungeons_failed >= max_runs;
        self.all_players_dead = false;
        self.enemies_on = false;
        self.clear_queue();
        if done {
            self.trial_ended = true;
            return;
        }
        self.fresh_run_pending = true;
        self.add(self.simulation_time, Kind::CombatStart);
    }

    fn start_fresh_run(&mut self) {
        self.fresh_run_pending = false;
        self.clear_queue();
        let rs = self.random_start;
        for i in 0..self.n {
            self.units[i].reset(0.0, rs, &mut self.rng);
            self.units[i].is_out_of_mana = false;
        }
    }

    fn on_dungeon_wave_spawned(&mut self) {
        let ek = self.zone.as_ref().map(|z| z.encounters_killed).unwrap_or(0.0);
        if ek - 1.0 != 1.0 {
            return;
        }
        let now = self.simulation_time;
        self.dungeon_run_start_time = now;
        self.clear_events_of_type(Ty::DungeonRunTimeout);
        let dur = self.run_limits.map(|r| r.1).unwrap_or(f64::NAN);
        self.add(now + dur, Kind::DungeonRunTimeout { run_start: now });
    }

    fn process_dungeon_run_timeout(&mut self, run_start: f64) {
        if self.run_limits.is_none() {
            return;
        }
        if run_start != self.dungeon_run_start_time {
            return;
        }
        if self.all_players_dead {
            return;
        }
        let z = self.zone.as_ref().expect("zone");
        if !self.enemies_on && z.encounters_killed > z.max_waves() {
            return;
        }
        self.dungeons_timed_out += 1.0;
        self.end_dungeon_run(false);
    }

    // ---- encounters ----

    fn spawn(&mut self, list: Spawned) -> R {
        self.units.truncate(self.n);
        for (hrid, tier) in list {
            let uid = self.next_uid;
            self.next_uid += 1;
            let m = create_monster(self.data, &mut self.ability_cache, &hrid, tier, 0.0, uid)?;
            self.units.push(m);
        }
        self.enemies_on = true;
        Ok(())
    }

    fn start_new_encounter(&mut self) -> R {
        let now = self.simulation_time;
        if self.all_players_dead {
            self.all_players_dead = false;
            if let Some(z) = &mut self.zone {
                if z.is_dungeon && !(self.wiped_in_gap && z.encounters_killed > z.max_waves()) {
                    z.fail_wave();
                }
            }
        }

        if self.zone.is_some() {
            let is_dungeon = self.zone.as_ref().map(|z| z.is_dungeon).unwrap_or(false);
            if !is_dungeon {
                let list = self.zone.as_mut().expect("zone").get_random_encounter(&mut self.rng)?;
                self.spawn(list)?;
            } else {
                let list = self.zone.as_mut().expect("zone").get_next_wave(&mut self.rng)?;
                self.spawn(list)?;
                let (ek, completed) = {
                    let z = self.zone.as_ref().expect("zone");
                    (z.encounters_killed, z.dungeons_completed)
                };
                self.sim_result.update_time_spent_alive(&format!("#{}", js::num_key(ek - 1.0)), true, now);
                if completed > self.temp_dungeon_count {
                    self.temp_dungeon_count = completed;
                    self.counted_dead_players.clear();
                    for i in 0..self.n {
                        self.refill_player(i);
                    }
                }
                if self.run_limits.is_some() {
                    self.on_dungeon_wave_spawned();
                }
            }
        }

        if let Some(t) = &mut self.trial {
            t.encounter_count += 1.0;
            let room = t.effective_room_level();
            let hrids = t.monster_hrids.clone();
            let (hp, sp, ah) = (t.hp_scale_factor, t.speed_bonus, t.ability_haste_bonus);
            self.units.truncate(self.n);
            for h in hrids {
                let uid = self.next_uid;
                self.next_uid += 1;
                let mut m = create_monster(self.data, &mut self.ability_cache, &h, 0.0, room, uid)?;
                if let UnitKind::Monster(mp) = &mut m.kind {
                    mp.trial_hp_scale_factor = hp;
                    mp.trial_attack_speed_bonus = sp;
                    mp.trial_cast_speed_bonus = sp;
                    mp.trial_ability_haste_bonus = ah;
                }
                self.units.push(m);
            }
            self.enemies_on = true;
            self.trial_tier_start_time = now;
        }

        if let Some(l) = &mut self.lab {
            l.attempt_count += 1.0;
            l.encounter_start_time = Some(now);
            let (hrid, room) = (l.monster_hrid.clone(), l.room_level);
            self.units.truncate(self.n);
            let uid = self.next_uid;
            self.next_uid += 1;
            let m = create_monster(self.data, &mut self.ability_cache, &hrid, 0.0, room, uid)?;
            self.units.push(m);
            self.enemies_on = true;
            self.add(now + Lab::ROOM_DURATION_NS, Kind::LabyrinthTimeout { start: now });
        }

        if !self.enemies_on {
            return Err("TypeError: Cannot read properties of null (reading 'forEach')".into());
        }
        let rs = self.random_start;
        for i in self.n..self.units.len() {
            self.units[i].reset(now, rs, &mut self.rng);
            let h = self.hrid(i);
            self.sim_result.update_time_spent_alive(&h, true, now);
        }
        if self.lab.is_some() {
            let (players, enemies) = self.units.split_at(self.n);
            self.sim_result.capture_stat_snapshot(self.data, players, enemies);
        }

        self.clear_events_of_type(Ty::EnrageTick);
        if self.trial.is_none() {
            self.add(now + ENRAGE_TICK_INTERVAL, Kind::EnrageTick { encounter_time: ENRAGE_TICK_INTERVAL });
        }
        self.enrage_begin_time = now;
        self.clear_events_of_type(Ty::AbilityCastEnd);
        self.check_triggers()?;
        self.start_attacks()
    }

    fn start_attacks(&mut self) -> R {
        let mut units: Vec<UnitRef> = (0..self.n).map(|i| self.uref(i)).collect();
        if let Some(r) = self.list(Side::Enemies) {
            units.extend(r.map(|i| self.uref(i)));
        }
        for r in units {
            // A promote during this loop can replace a unit; JS walks its own copy.
            let Some(i) = self.resolve(r) else { continue };
            if self.units[i].cd.current_hitpoints <= 0.0 {
                continue;
            }
            self.add_next_attack_event(i)?;
        }
        Ok(())
    }

    // ---- parry ----

    fn check_parry(&mut self, side: Side) -> Option<usize> {
        let units: Vec<usize> = self
            .list(side)
            .map(|r| r.filter(|&i| self.units[i].alive() && self.units[i].cd.cs.parry > 0.0).collect())
            .unwrap_or_default();
        if units.is_empty() {
            return None;
        }
        let k = (self.rng.next_f64() * units.len() as f64).floor() as usize;
        if self.units[units[k]].cd.cs.parry > self.rng.next_f64() {
            Some(units[k])
        } else {
            None
        }
    }

    fn check_parry_official(&mut self, t: usize, attempts: &mut f64) -> bool {
        let u = &self.units[t];
        if u.cd.current_hitpoints <= 0.0 {
            return false;
        }
        if !(u.cd.cs.parry > 0.0) {
            return false;
        }
        if *attempts >= MAX_PARRY_ATTEMPTS {
            return false;
        }
        *attempts += 1.0;
        let p = u.cd.cs.parry;
        p > self.rng.next_f64()
    }

    /// pickByThreat: one draw in either branch.
    fn pick_by_threat(&mut self, units: &[usize]) -> usize {
        let mut cumulative = 0.0;
        for &i in units {
            cumulative += self.units[i].cd.cs.threat;
        }
        if !(cumulative > 0.0) {
            let k = (self.rng.next_f64() * units.len() as f64).floor() as usize;
            return units[k];
        }
        let r = self.rng.next_f64() * cumulative;
        let mut range_end = 0.0;
        for &i in units {
            let threat = self.units[i].cd.cs.threat;
            range_end += threat;
            if r >= range_end - threat && r < range_end {
                return i;
            }
        }
        units[units.len() - 1]
    }

    // ---- shared hit side effects ----

    fn attack(&mut self, source: usize, target: usize, effect: Option<&AbilityEffect>) -> R<AttackResult> {
        let mut rng = std::mem::replace(&mut self.rng, Mulberry32::new(0));
        let (s, t) = self.pair(source, target);
        let r = process_attack(&mut rng, s, t, effect);
        self.rng = rng;
        r
    }

    fn apply_curse(&mut self, source: usize, target: usize) {
        let now = self.simulation_time;
        let current = self.get_matching_type_and_source(Ty::CurseExpiration, target).map(|e| match e.kind {
            Kind::CurseExpiration { amount, .. } => amount,
            _ => 0.0,
        });
        let current_amount = current.unwrap_or(0.0);
        self.clear_matching_type_and_source(Ty::CurseExpiration, target);
        let amount = js::min(current_amount + 1.0, 5.0);
        let buff = Buff::synth("/buff_uniques/curse", "/buff_types/damage_taken", 0.0, self.units[source].cd.cs.curse * amount, EXPIRE_15S);
        self.units[target].add_buff(&buff, Some(now), None);
        let r = self.uref(target);
        self.add(now + EXPIRE_15S, Kind::CurseExpiration { src: r, amount });
    }

    fn apply_fury(&mut self, source: usize, did_hit: bool) {
        let now = self.simulation_time;
        let current = self.get_matching_type_and_source(Ty::FuryExpiration, source).map(|e| match e.kind {
            Kind::FuryExpiration { amount, .. } => amount,
            _ => 0.0,
        });
        self.clear_matching_type_and_source(Ty::FuryExpiration, source);
        let mut fury_amount = current.unwrap_or(0.0);
        if did_hit {
            fury_amount = js::min(fury_amount + 1.0, 5.0);
        } else {
            fury_amount = fury_amount / 2.0;
        }
        let fury = self.units[source].cd.cs.fury;
        let acc = Buff::synth("/buff_uniques/fury_accuracy", "/buff_types/fury_accuracy", fury_amount * fury, 0.0, EXPIRE_15S);
        let dmg = Buff::synth("/buff_uniques/fury_damage", "/buff_types/fury_damage", fury_amount * fury, 0.0, EXPIRE_15S);
        if fury_amount > 0.0 {
            let r = self.uref(source);
            self.add(now + EXPIRE_15S, Kind::FuryExpiration { src: r, amount: fury_amount });
            self.units[source].add_buffs(&[acc, dmg], Some(now), None);
        } else {
            self.units[source].remove_buffs(&[acc, dmg]);
        }
    }

    fn apply_weaken(&mut self, source: usize, target: usize) {
        let now = self.simulation_time;
        let current = self.get_matching_type_and_source(Ty::WeakenExpiration, source).map(|e| match e.kind {
            Kind::WeakenExpiration { amount, .. } => amount,
            _ => 0.0,
        });
        let weaken_amount = current.unwrap_or(0.0);
        self.clear_matching_type_and_source(Ty::WeakenExpiration, source);
        let amount = js::min(weaken_amount + 1.0, 5.0);
        let buff = Buff::synth(
            "/buff_uniques/weaken",
            "/buff_types/damage",
            -1.0 * self.units[target].cd.cs.weaken * amount,
            0.0,
            EXPIRE_15S,
        );
        self.units[source].add_buff(&buff, Some(now), None);
        let r = self.uref(source);
        self.add(now + EXPIRE_15S, Kind::WeakenExpiration { src: r, amount });
    }

    fn hit_of(r: &AttackResult) -> Hit {
        if r.did_hit {
            Hit::Dmg(r.damage_done)
        } else {
            Hit::Miss
        }
    }

    /// The "X died" block: clear its events, count it, close its alive span.
    fn on_death(&mut self, i: usize) {
        self.clear_events_for_unit(i);
        let now = self.simulation_time;
        let u = &self.units[i];
        self.sim_result.add_death(u);
        if !u.is_player {
            let h = u.hrid.clone();
            self.sim_result.update_time_spent_alive(&h, false, now);
        }
    }

    // ---- auto attack ----

    fn process_auto_attack(&mut self, src0: usize) -> R {
        let src_ref = self.uref(src0);
        let target_side = Self::other(self.side_of(src0));
        let Some(range) = self.list(target_side) else { return Ok(()) };
        let alive_targets: Vec<usize> = range.filter(|&i| self.units[i].alive()).collect();
        let official = self.trial.is_some();
        let mut attempts = 0.0;

        let n_alive = alive_targets.len();
        for k in 0..n_alive {
            let mut target = alive_targets[k];
            if !self.units[src0].is_player && n_alive > 1 {
                target = self.pick_by_threat(&alive_targets);
            }
            let mut source = src0;

            let mut parry_target = None;
            if official {
                if self.check_parry_official(target, &mut attempts) {
                    parry_target = Some(target);
                }
            } else {
                parry_target = self.check_parry(target_side);
            }
            if let Some(p) = parry_target {
                target = source;
                source = p;
            }

            let r = self.attack(source, target, None)?;
            let mayhem = self.units[source].cd.cs.mayhem > self.rng.next_f64();

            if r.did_hit && self.units[source].cd.cs.curse > 0.0 {
                self.apply_curse(source, target);
            }
            if self.units[source].cd.cs.fury > 0.0 {
                self.apply_fury(source, r.did_hit);
            }
            if self.units[target].cd.cs.weaken > 0.0 {
                self.apply_weaken(source, target);
            }

            if !mayhem || r.did_hit || k == n_alive - 1 {
                let ty = if parry_target.is_some() { "parry" } else { "autoAttack" };
                let (sh, th) = (self.hrid(source), self.hrid(target));
                self.sim_result.add_attack(&sh, &th, ty, Self::hit_of(&r));
            }
            if r.life_steal_heal > 0.0 {
                let sh = self.hrid(source);
                self.sim_result.add_hitpoints_gained(&sh, "lifesteal", r.life_steal_heal, Some(&sh));
            }
            if r.mana_leech_mana > 0.0 {
                let sh = self.hrid(source);
                self.sim_result.add_manapoints_gained(&sh, "manaLeech", r.mana_leech_mana);
            }
            if r.thorn_damage_done > 0.0 {
                let (sh, th) = (self.hrid(source), self.hrid(target));
                self.sim_result.add_attack(&th, &sh, r.thorn_type, Hit::Dmg(r.thorn_damage_done));
            }
            if self.units[target].cd.cs.retaliation > 0.0 && self.units[target].cd.current_hitpoints > 0.0 {
                let (sh, th) = (self.hrid(source), self.hrid(target));
                let hit = if r.retaliation_damage_done > 0.0 { Hit::Dmg(r.retaliation_damage_done) } else { Hit::Miss };
                self.sim_result.add_attack(&th, &sh, "retaliation", hit);
            }
            if self.units[target].cd.current_hitpoints == 0.0 {
                self.on_death(target);
            }
            if self.units[source].cd.current_hitpoints == 0.0 && (r.thorn_damage_done != 0.0 || r.retaliation_damage_done != 0.0) {
                self.on_death(source);
                break;
            }
            if mayhem && !r.did_hit {
                continue;
            }
            // Pierce: short-circuits, so no draw on a miss or a parry.
            if !r.did_hit || parry_target.is_some() || self.units[source].cd.cs.pierce <= self.rng.next_f64() {
                break;
            }
        }

        if !self.check_encounter_end()? {
            let i = self.must(src_ref, "autoAttack source")?;
            self.add_next_attack_event(i)?;
        }
        Ok(())
    }

    fn trial_hp_removed_frac(&self) -> f64 {
        let Some(r) = self.list(Side::Enemies) else { return 0.0 };
        if r.is_empty() {
            return 0.0;
        }
        let mut total_max = 0.0;
        let mut total_current = 0.0;
        for i in r {
            total_max += self.units[i].cd.max_hitpoints;
            total_current += js::max(0.0, self.units[i].cd.current_hitpoints);
        }
        if total_max <= 0.0 {
            return 0.0;
        }
        js::min(1.0, js::max(0.0, (total_max - total_current) / total_max))
    }

    fn check_encounter_end(&mut self) -> R<bool> {
        let now = self.simulation_time;
        if let Some(r) = self.list(Side::Enemies) {
            let ebt = self.enrage_begin_time;
            for i in r {
                let e = &mut self.units[i];
                if e.cd.current_hitpoints <= 0.0 && e.experience_rate == 0.0 {
                    let mut alive_duration = now - ebt;
                    if alive_duration > e.enrage_time {
                        alive_duration = e.enrage_time;
                    }
                    e.experience_rate = 1.0 + alive_duration / e.enrage_time;
                }
            }
        }

        let mut encounter_ended = false;
        let tier_at_check = self.trial.as_ref().map(|t| t.current_tier).unwrap_or(0.0);

        let all_enemies_dead = self.list(Side::Enemies).map(|r| !r.clone().any(|i| self.units[i].alive()));
        if all_enemies_dead == Some(true) {
            self.clear_events_of_type(Ty::AutoAttack);
            self.add(now + ENEMY_RESPAWN_INTERVAL, Kind::EnemyRespawn);
            if self.trial.is_none() {
                let mut total_exp = 0.0;
                for i in self.n..self.units.len() {
                    total_exp = total_exp + self.units[i].experience * self.units[i].experience_rate;
                }
                let per = total_exp / self.n as f64;
                for i in 0..self.n {
                    let keys = self.skill_exp_keys(i)?;
                    let u = &self.units[i];
                    self.sim_result.add_experience_gain(u, per, &keys)?;
                }
            }
            self.enemies_on = false;

            if let Some(z) = &self.zone {
                if z.is_dungeon {
                    let (ek, mw) = (z.encounters_killed, z.max_waves());
                    self.sim_result.update_time_spent_alive(&format!("#{}", js::num_key(ek - 1.0)), false, now);
                    if ek > mw {
                        self.sim_result.update_dungenon_finish("#1", now);
                        self.sim_result.last_dungeon_finish_time = now;
                        if self.run_limits.is_some() {
                            self.end_dungeon_run(true);
                        }
                    }
                }
            }
            self.sim_result.encounters += 1.0;
            if let Some(l) = &self.lab {
                let start = l.encounter_start_time.unwrap_or(f64::NAN);
                self.sim_result.add_lab_room_outcome("win", 0.0, now, start);
            }
            if let Some(t) = &mut self.trial {
                let time_spent = now - self.trial_tier_start_time;
                let cleared_cap = t.current_tier >= MAX_TIER;
                let tier = t.current_tier;
                t.advance_tier();
                self.sim_result.record_trial_tier_clear(tier, time_spent);
                if cleared_cap {
                    self.sim_result.record_trial_completed(now);
                    self.trial_ended = true;
                    self.clear_queue();
                } else {
                    self.clear_queue();
                    self.fresh_run_pending = true;
                    self.add(now + ENEMY_RESPAWN_INTERVAL, Kind::CombatStart);
                }
            }
            self.sim_result.last_encounter_finish_time = now;
            if self.sim_result.first_encounter_finish_time == 0.0 {
                self.sim_result.first_encounter_finish_time = now;
            }
            encounter_ended = true;
        }

        for i in 0..self.n {
            let h = self.hrid(i);
            if self.units[i].alive() || self.counted_dead_players.iter().any(|c| *c == h) {
                continue;
            }
            self.counted_dead_players.push(h.clone());
            self.sim_result.add_player_death(&h);
            self.sim_result.add_ran_out_of_mana_count(&h, false, now);
            if self.trial.is_some() {
                self.sim_result.record_trial_player_death(&h, tier_at_check);
            } else if self.zone.as_ref().map(|z| !z.is_dungeon).unwrap_or(false) {
                self.add(now + PLAYER_RESPAWN_INTERVAL, Kind::PlayerRespawn { hrid: h });
            }
        }

        if !(0..self.n).any(|i| self.units[i].alive()) {
            if let Some(z) = &self.zone {
                if z.is_dungeon {
                    for ty in [
                        Ty::AutoAttack,
                        Ty::AbilityCastEnd,
                        Ty::DamageOverTime,
                        Ty::ConsumableTick,
                        Ty::RegenTick,
                        Ty::EnrageTick,
                        Ty::StunExpiration,
                        Ty::BlindExpiration,
                        Ty::SilenceExpiration,
                        Ty::AwaitCooldown,
                        Ty::EnemyRespawn,
                    ] {
                        self.clear_events_of_type(ty);
                    }
                    self.wiped_in_gap = !self.enemies_on;
                    self.enemies_on = false;
                    self.add(now + RESTART_INTERVAL, Kind::CombatStart);
                } else {
                    self.clear_events_of_type(Ty::AutoAttack);
                    self.clear_events_of_type(Ty::AbilityCastEnd);
                }
            }
            encounter_ended = true;
            self.all_players_dead = true;
            if self.run_limits.is_some() {
                self.end_dungeon_run(false);
            }
            if self.trial.is_some() {
                let frac = if self.enemies_on { self.trial_hp_removed_frac() } else { 0.0 };
                let tier = if self.enemies_on { tier_at_check } else { self.trial.as_ref().expect("trial").current_tier };
                self.sim_result.record_trial_wipe(tier, now, frac);
                self.trial_ended = true;
                self.clear_queue();
                return Ok(encounter_ended);
            }
            if self.lab.is_some() && self.enemies_on && self.units.len() > self.n {
                let pct = self.mob_hp_pct();
                let start = self.lab.as_ref().and_then(|l| l.encounter_start_time).unwrap_or(f64::NAN);
                self.sim_result.add_lab_room_outcome("death", js::max(0.0, pct), now, start);
            }
        }
        if self.lab.is_some() && encounter_ended {
            self.enemies_on = false;
            self.clear_queue();
            self.add(now, Kind::CombatStart);
        }
        Ok(encounter_ended)
    }

    fn skill_exp_keys(&self, i: usize) -> R<Vec<String>> {
        let style = &self.units[i].cd.cs.combat_style_hrid;
        let st = self
            .data
            .combat_styles
            .get(&**style)
            .ok_or_else(|| format!("TypeError: Cannot read properties of undefined (reading 'skillExpMap') for {style}"))?;
        let m = st.skill_exp_map.as_ref().ok_or("TypeError: Cannot convert undefined or null to object")?;
        Ok(m.0.iter().map(|(k, _)| k.clone()).collect())
    }

    // ---- next action ----

    fn add_next_attack_event(&mut self, i: usize) -> R {
        if self.units[i].cd.current_hitpoints <= 0.0 {
            return Ok(());
        }
        if self.units[i].is_stunned {
            return Ok(());
        }
        if self.units[i].pending_action_count > 0 {
            return Ok(());
        }
        let own = self.side_of(i);
        let opp = Self::other(own);
        let now = self.simulation_time;
        let target = self.get_target(opp);

        let mut used = false;
        let mut skip = false;
        for slot in 0..self.units[i].abilities.len() {
            if self.units[i].abilities[slot].is_none() {
                continue;
            }
            if used || skip {
                continue;
            }
            let should = {
                let u = &self.units[i];
                let a = u.abilities[slot].as_ref().expect("slot");
                a.ready(now, u)
                    && all_active(&a.triggers, u, target.map(|t| &self.units[t]), self.slice(own), self.slice(opp), now)?
            };
            if should {
                if !self.can_use_ability(i, slot, true) {
                    skip = true;
                }
                if !skip {
                    let u = &self.units[i];
                    let mut cast = u.abilities[slot].as_ref().expect("slot").cast_duration;
                    cast /= 1.0 + u.cd.cs.cast_speed;
                    let r = self.uref(i);
                    self.add(now + cast, Kind::AbilityCastEnd { src: r, slot });
                    used = true;
                }
            }
        }
        if used {
            self.units[i].is_out_of_mana = false;
            return Ok(());
        }
        if self.list(opp).is_none() {
            return Ok(());
        }
        if !self.units[i].is_blinded {
            let t = now + self.units[i].cd.cs.attack_interval;
            let r = self.uref(i);
            self.add(t, Kind::AutoAttack { src: r });
        } else {
            self.units[i].is_out_of_mana = true;
        }
        Ok(())
    }

    fn can_use_ability_mana(&mut self, i: usize, mana_cost: f64, oom_check: bool) -> bool {
        let now = self.simulation_time;
        let u = &self.units[i];
        if u.cd.current_hitpoints <= 0.0 {
            return false;
        }
        if u.cd.current_manapoints < mana_cost {
            if u.is_player && oom_check {
                let h = u.hrid.clone();
                self.sim_result.add_ran_out_of_mana_count(&h, true, now);
            }
            return false;
        }
        if u.is_player && oom_check {
            let h = u.hrid.clone();
            self.sim_result.add_ran_out_of_mana_count(&h, false, now);
        }
        true
    }

    fn can_use_ability(&mut self, i: usize, slot: usize, oom_check: bool) -> bool {
        let cost = self.units[i].abilities[slot].as_ref().map(|a| a.mana_cost).unwrap_or(f64::NAN);
        self.can_use_ability_mana(i, cost, oom_check)
    }

    // ---- consumables, DoT, regen ----

    fn process_consumable_tick(&mut self, i: usize, hrid: &S, hp: f64, mp: f64, total: f64, cur: f64) -> R {
        let now = self.simulation_time;
        let uh = self.hrid(i);
        if hp > 0.0 {
            let tick = calculate_tick_value(hp, total, cur);
            let added = self.units[i].add_hitpoints(tick);
            self.sim_result.add_hitpoints_gained(&uh, hrid, added, Some(&uh));
        }
        if mp > 0.0 {
            let tick = calculate_tick_value(mp, total, cur);
            let added = self.units[i].add_manapoints(tick);
            self.sim_result.add_manapoints_gained(&uh, hrid, added);
            if self.units[i].is_out_of_mana {
                let r = self.uref(i);
                self.add(now, Kind::AwaitCooldown { src: r });
            }
        }
        if cur < total {
            let r = self.uref(i);
            self.add(now + HOT_TICK_INTERVAL, Kind::ConsumableTick { src: r, hrid: hrid.clone(), hp, mp, total, cur: cur + 1.0 });
        }
        Ok(())
    }

    fn process_dot(&mut self, src_hrid: &S, t: usize, damage: f64, total: f64, cur: f64, style: S) -> R {
        let now = self.simulation_time;
        let tick = calculate_tick_value(damage, total, cur);
        let d = js::min(tick, self.units[t].cd.current_hitpoints);
        self.units[t].cd.current_hitpoints -= d;
        let th = self.hrid(t);
        self.sim_result.add_attack(src_hrid, &th, "damageOverTime", Hit::Dmg(d));
        if cur < total {
            let r = self.uref(t);
            self.add(
                now + DOT_TICK_INTERVAL,
                Kind::DamageOverTime { src_hrid: src_hrid.clone(), target: r, damage, total, cur: cur + 1.0, style },
            );
        }
        if self.units[t].cd.current_hitpoints == 0.0 {
            self.on_death(t);
        }
        self.check_encounter_end()?;
        Ok(())
    }

    fn process_regen_tick(&mut self) {
        let now = self.simulation_time;
        let (bh, bm) = match &self.trial {
            Some(t) => (t.bonus_hp_regen_ratio, t.bonus_mp_regen_ratio),
            None => (0.0, 0.0),
        };
        for i in 0..self.n {
            if self.units[i].cd.current_hitpoints <= 0.0 {
                continue;
            }
            let h = self.hrid(i);
            let u = &mut self.units[i];
            let hp_regen = (u.cd.max_hitpoints * (u.cd.cs.hp_regen_per10 + bh)).floor();
            let hp_added = u.add_hitpoints(hp_regen);
            let mp_regen = (u.cd.max_manapoints * (u.cd.cs.mp_regen_per10 + bm)).floor();
            let oom = u.is_out_of_mana;
            self.sim_result.add_hitpoints_gained(&h, "regen", hp_added, Some(&h));
            let mp_added = self.units[i].add_manapoints(mp_regen);
            self.sim_result.add_manapoints_gained(&h, "regen", mp_added);
            if oom {
                let r = self.uref(i);
                self.add(now, Kind::AwaitCooldown { src: r });
            }
        }
        self.add(now + REGEN_TICK_INTERVAL, Kind::RegenTick);
    }

    fn process_enrage_tick(&mut self, encounter_time: f64) {
        let Some(r) = self.list(Side::Enemies) else { return };
        let now = self.simulation_time;
        let alive: Vec<usize> = r.filter(|&i| self.units[i].alive()).collect();
        for i in alive {
            let e = &mut self.units[i];
            let now_stack = js::min(10.0, (encounter_time / e.enrage_time).floor());
            if now_stack <= 0.0 {
                continue;
            }
            let dmg = Buff::synth("/buff_uniques/enrage_damage", "/buff_types/damage", now_stack * 0.1, 0.0, ENRAGE_TICK_INTERVAL);
            let acc = Buff::synth("/buff_uniques/enrage_accuracy", "/buff_types/accuracy", now_stack * 0.1, 0.0, ENRAGE_TICK_INTERVAL);
            e.add_buffs(&[dmg, acc], None, None);
            self.sim_result.max_enrage_stack = js::max(self.sim_result.max_enrage_stack, now_stack);
        }
        self.add(now + ENRAGE_TICK_INTERVAL, Kind::EnrageTick { encounter_time: encounter_time + ENRAGE_TICK_INTERVAL });
    }

    // ---- triggers and consumables ----

    fn check_triggers(&mut self) -> R {
        loop {
            let mut triggered = false;
            let mut alive = std::mem::take(&mut self.alive_scratch);
            for side in [Side::Players, Side::Enemies] {
                // Each side's range and snapshot are taken after the previous side's triggers ran, as before.
                let Some(r) = self.list(side) else { continue };
                alive.clear();
                alive.extend(r.map(|i| (i, self.units[i].alive())));
                for &(i, a) in &alive {
                    if a && self.check_triggers_for_unit(i)? {
                        triggered = true;
                    }
                }
            }
            self.alive_scratch = alive;
            if !triggered {
                return Ok(());
            }
        }
    }

    fn check_triggers_for_unit(&mut self, i: usize) -> R<bool> {
        if self.units[i].cd.current_hitpoints <= 0.0 {
            return Err("Checking triggers for a dead unit".into());
        }
        let own = self.side_of(i);
        let opp = Self::other(own);
        let target = self.get_target(opp);
        if self.trial.is_some() {
            return Ok(false);
        }
        let now = self.simulation_time;
        let mut triggered = false;
        for drink in [false, true] {
            let len = if drink { self.units[i].drinks.len() } else { self.units[i].food.len() };
            for k in 0..len {
                let should = {
                    let u = &self.units[i];
                    let c = if drink { u.drinks[k].as_ref() } else { u.food[k].as_ref() };
                    match c {
                        None => false,
                        Some(c) => {
                            c.ready(now, u)
                                && all_active(&c.triggers, u, target.map(|t| &self.units[t]), self.slice(own), self.slice(opp), now)?
                        }
                    }
                };
                if should && self.try_use_consumable(i, drink, k) {
                    triggered = true;
                }
            }
        }
        Ok(triggered)
    }

    fn try_use_consumable(&mut self, i: usize, drink: bool, k: usize) -> bool {
        if self.units[i].cd.current_hitpoints <= 0.0 {
            return false;
        }
        let now = self.simulation_time;
        let c = {
            let u = &mut self.units[i];
            let slot = if drink { &mut u.drinks[k] } else { &mut u.food[k] };
            let c = slot.as_mut().expect("consumable");
            c.last_used = now;
            c.clone()
        };
        let cs = &self.units[i].cd.cs;
        let mut cooldown = c.cooldown_duration;
        if cs.drink_concentration > 0.0 && c.category_hrid.contains("drink") {
            cooldown = cooldown / (1.0 + cs.drink_concentration);
        } else if cs.food_haste > 0.0 && c.category_hrid.contains("food") {
            cooldown = cooldown / (1.0 + cs.food_haste);
        }
        self.add(now + cooldown, Kind::CooldownReady);
        let uh = self.hrid(i);
        self.sim_result.add_consumable_use(&uh, &c.hrid);

        if c.recovery_duration == 0.0 {
            if c.hitpoint_restore > 0.0 {
                let added = self.units[i].add_hitpoints(c.hitpoint_restore);
                self.sim_result.add_hitpoints_gained(&uh, &c.hrid, added, Some(&uh));
            }
            if c.manapoint_restore > 0.0 {
                let added = self.units[i].add_manapoints(c.manapoint_restore);
                self.sim_result.add_manapoints_gained(&uh, &c.hrid, added);
                if self.units[i].is_out_of_mana {
                    let r = self.uref(i);
                    self.add(now, Kind::AwaitCooldown { src: r });
                }
            }
        } else {
            let r = self.uref(i);
            self.add(
                now + HOT_TICK_INTERVAL,
                Kind::ConsumableTick {
                    src: r,
                    hrid: c.hrid.clone(),
                    hp: c.hitpoint_restore,
                    mp: c.manapoint_restore,
                    total: c.recovery_duration / HOT_TICK_INTERVAL,
                    cur: 1.0,
                },
            );
        }

        for b in &c.buffs {
            let mut cur = b.clone();
            let dc = self.units[i].cd.cs.drink_concentration;
            if dc > 0.0 && c.category_hrid.contains("drink") {
                cur.ratio_boost *= 1.0 + dc;
                cur.flat_boost *= 1.0 + dc;
                cur.duration = cur.duration / (1.0 + dc);
            }
            self.units[i].add_buff(&cur, Some(now), None);
            let r = self.uref(i);
            self.add(now + cur.duration, Kind::CheckBuffExpiration { src: r });
        }
        true
    }

    // ---- abilities ----

    fn try_use_ability(&mut self, src0: usize, slot: usize) -> R<bool> {
        if !self.can_use_ability(src0, slot, true) {
            return Ok(false);
        }
        let now = self.simulation_time;
        let (hrid, mana_cost, effects, is_special) = {
            let a = self.units[src0].abilities[slot].as_ref().ok_or("twin: cast of an empty ability slot")?;
            (a.hrid.clone(), a.mana_cost, a.effects.clone(), a.is_special_ability)
        };
        {
            let u = &mut self.units[src0];
            if u.is_player {
                match u.ability_mana_costs.iter_mut().find(|(k, _)| *k == hrid) {
                    Some((_, v)) => *v = *v + mana_cost,
                    None => u.ability_mana_costs.push((hrid.clone(), mana_cost)),
                }
            }
            u.cd.current_manapoints -= mana_cost;
            u.abilities[slot].as_mut().expect("slot").last_used = now;
        }

        // The cast, then Blaze and Bloom procs: at most three, so no heap Vec per cast.
        let mut todo: [Option<(S, Rc<Vec<AbilityEffect>>, bool)>; 3] = [Some((hrid, effects, is_special)), None, None];
        // Blaze/Bloom: guarded by `> 0 &&`, so no draw when the stat is 0.
        if self.units[src0].cd.cs.blaze > 0.0 && self.rng.next_f64() < self.units[src0].cd.cs.blaze {
            let a = Ability::new(self.data, "blaze", 1.0, None)?;
            todo[1] = Some((a.hrid, a.effects, a.is_special_ability));
        }
        if self.units[src0].cd.cs.bloom > 0.0 && self.rng.next_f64() < self.units[src0].cd.cs.bloom {
            let a = Ability::new(self.data, "bloom", 1.0, None)?;
            todo[2] = Some((a.hrid, a.effects, a.is_special_ability));
        }

        let mut src = self.uref(src0);
        for (ahrid, effects, special) in todo.iter().flatten() {
            for e in effects.iter() {
                let si = self.must(src, "ability caster")?;
                if self.units[si].cd.current_hitpoints <= 0.0 {
                    break;
                }
                match &*e.effect_type {
                    "/ability_effect_types/buff" => self.ability_buff(si, *special, e)?,
                    "/ability_effect_types/damage" => self.ability_damage(si, ahrid, e)?,
                    "/ability_effect_types/heal" => self.ability_heal(si, ahrid, e)?,
                    "/ability_effect_types/spend_hp" => {
                        if &*e.target_type != "self" {
                            return Err(format!("Unsupported target type for spend hp ability effect: {ahrid}"));
                        }
                        let spent = utilities::process_spend_hp(&mut self.units[si], e);
                        let h = self.hrid(si);
                        self.sim_result.add_hitpoints_spent(&h, ahrid, spent);
                    }
                    "/ability_effect_types/revive" => self.ability_revive(si, ahrid, e)?,
                    "/ability_effect_types/promote" => {
                        self.clear_events_for_unit(si);
                        let ni = self.ability_promote(si)?;
                        src = self.uref(ni);
                        self.add_next_attack_event(ni)?;
                    }
                    other => {
                        return Err(format!("Unsupported effect type for ability: {ahrid} effectType: {other}"));
                    }
                }
            }
        }

        let si = self.must(src, "ability caster")?;
        let u = &self.units[si];
        if u.cd.current_hitpoints > 0.0 && u.cd.cs.ripple > 0.0 && self.rng.next_f64() < self.units[si].cd.cs.ripple {
            let added = self.units[si].add_manapoints(10.0);
            let h = self.hrid(si);
            self.sim_result.add_manapoints_gained(&h, "ripple", added);
            for a in self.units[si].abilities.iter_mut().flatten() {
                // H20: lastUsed 0 is falsy.
                if a.last_used != 0.0 && !a.last_used.is_nan() {
                    let remaining = a.last_used + a.cooldown_duration - now;
                    if remaining > 0.0 {
                        a.last_used = js::max(a.last_used - ONE_SECOND * 2.0, now - a.cooldown_duration);
                    }
                }
            }
        }

        self.add_next_attack_event(si)?;
        if self.units[si].cd.current_hitpoints == 0.0 {
            self.on_death(si);
        }
        self.check_encounter_end()?;
        Ok(true)
    }

    fn alive_of(&self, side: Side) -> Vec<usize> {
        self.list(side).map(|r| r.filter(|&i| self.units[i].alive()).collect()).unwrap_or_default()
    }

    fn ability_buff(&mut self, si: usize, is_special: bool, e: &AbilityEffect) -> R {
        let now = self.simulation_time;
        let buffs = e.buffs.as_ref().ok_or("TypeError: abilityEffect.buffs is not iterable")?;
        if &*e.target_type == "allAllies" {
            let own = self.side_of(si);
            let src_uid = self.units[si].uid;
            for t in self.alive_of(own) {
                for b in buffs {
                    if is_special && !b.multiplier_for_skill_hrid.is_empty() && b.multiplier_per_skill_level > 0.0 {
                        let skill = b.multiplier_for_skill_hrid.split('/').nth(2).unwrap_or("");
                        let level = match LEVEL_NAMES.iter().position(|n| *n == skill) {
                            Some(k) => self.units[si].cd.levels[k],
                            None => f64::NAN,
                        };
                        let multiplier = 1.0 + level * b.multiplier_per_skill_level;
                        let mut cur = b.clone();
                        cur.flat_boost *= multiplier;
                        cur.ratio_boost *= multiplier;
                        self.units[t].add_buff(&cur, Some(now), Some(src_uid));
                    } else {
                        self.units[t].add_buff(b, Some(now), Some(src_uid));
                    }
                    let r = self.uref(t);
                    self.add(now + b.duration, Kind::CheckBuffExpiration { src: r });
                }
            }
            return Ok(());
        }
        if &*e.target_type != "self" {
            return Err(format!("Unsupported target type for buff ability effect: {}", e.target_type));
        }
        self.units[si].add_buffs(buffs, Some(now), None);
        let r = self.uref(si);
        for b in buffs {
            self.add(now + b.duration, Kind::CheckBuffExpiration { src: r });
        }
        Ok(())
    }

    fn record_reflects(&mut self, source: usize, target: usize, r: &AttackResult) {
        let (sh, th) = (self.hrid(source), self.hrid(target));
        if r.thorn_damage_done > 0.0 {
            self.sim_result.add_attack(&th, &sh, r.thorn_type, Hit::Dmg(r.thorn_damage_done));
        }
        if self.units[target].cd.cs.retaliation > 0.0 && self.units[target].cd.current_hitpoints > 0.0 {
            let hit = if r.retaliation_damage_done > 0.0 { Hit::Dmg(r.retaliation_damage_done) } else { Hit::Miss };
            self.sim_result.add_attack(&th, &sh, "retaliation", hit);
        }
    }

    fn ability_damage(&mut self, si0: usize, ahrid: &S, e: &AbilityEffect) -> R {
        let now = self.simulation_time;
        let src_ref = self.uref(si0);
        let target_side = match &*e.target_type {
            "enemy" | "allEnemies" => Self::other(self.side_of(si0)),
            _ => return Err(format!("Unsupported target type for damage ability effect: {ahrid}")),
        };
        let Some(range) = self.list(target_side) else { return Ok(()) };
        let mut targets: Vec<usize> = range.collect();
        let snapshot: Vec<usize> = targets.iter().copied().filter(|&i| self.units[i].alive()).collect();
        let mut avoid: Vec<S> = Vec::new();
        let official = self.trial.is_some();
        let mut attempts = 0.0;
        let mut is_skip_parry = false;
        let single = &*e.target_type == "enemy";

        for &t0 in &snapshot {
            let si = self.must(src_ref, "ability caster")?;
            if self.units[si].cd.current_hitpoints <= 0.0 {
                break;
            }
            let mut target = t0;
            let mut parry_target = None;
            let mut prepicked = false;

            if official {
                targets.retain(|&i| !avoid.contains(&self.units[i].hrid) && self.units[i].alive());
                if targets.is_empty() {
                    break;
                }
                if !self.units[si].is_player && single {
                    target = self.pick_by_threat(&targets.clone());
                    avoid.push(self.hrid(target));
                    prepicked = true;
                }
                if self.check_parry_official(target, &mut attempts) {
                    parry_target = Some(target);
                }
            } else if !is_skip_parry {
                parry_target = self.check_parry(target_side);
                is_skip_parry = true;
            }

            if let Some(p) = parry_target {
                let (temp_source, temp_target) = (p, si);
                let r = self.attack(temp_source, temp_target, None)?;
                let (sh, th) = (self.hrid(temp_source), self.hrid(temp_target));
                self.sim_result.add_attack(&sh, &th, "parry", Self::hit_of(&r));
                if r.life_steal_heal > 0.0 {
                    self.sim_result.add_hitpoints_gained(&sh, "lifesteal", r.life_steal_heal, Some(&sh));
                }
                if r.mana_leech_mana > 0.0 {
                    self.sim_result.add_manapoints_gained(&sh, "manaLeech", r.mana_leech_mana);
                }
                self.record_reflects(temp_source, temp_target, &r);
                if self.units[temp_target].cd.current_hitpoints == 0.0 {
                    self.on_death(temp_target);
                }
                if self.units[temp_source].cd.current_hitpoints == 0.0 && (r.thorn_damage_done != 0.0 || r.retaliation_damage_done != 0.0) {
                    self.on_death(temp_source);
                }
            } else {
                if !prepicked {
                    targets.retain(|&i| !avoid.contains(&self.units[i].hrid) && self.units[i].alive());
                    if !self.units[si].is_player && !targets.is_empty() && single {
                        target = self.pick_by_threat(&targets.clone());
                        avoid.push(self.hrid(target));
                    }
                    if targets.is_empty() {
                        break;
                    }
                }

                let r = self.attack(si, target, Some(e))?;
                let sh = self.hrid(si);
                if r.hp_drain > 0.0 {
                    self.sim_result.add_hitpoints_gained(&sh, ahrid, r.hp_drain, Some(&sh));
                }
                if r.did_hit {
                    if let Some(buffs) = &e.buffs {
                        let su = self.units[si].uid;
                        self.units[target].add_buffs(buffs, Some(now), Some(su));
                        let tr = self.uref(target);
                        for b in buffs {
                            self.add(now + b.duration, Kind::CheckBuffExpiration { src: tr });
                        }
                    }
                }
                if e.damage_over_time_ratio > 0.0 && r.damage_done > 0.0 {
                    let tr = self.uref(target);
                    self.add(
                        now + DOT_TICK_INTERVAL,
                        Kind::DamageOverTime {
                            src_hrid: sh.clone(),
                            target: tr,
                            damage: r.damage_done * e.damage_over_time_ratio,
                            total: e.damage_over_time_duration / DOT_TICK_INTERVAL,
                            cur: 1.0,
                            style: e.combat_style_hrid.clone(),
                        },
                    );
                }
                // Stun/blind/silence: guarded by `didHit && chance > 0 &&`, so no draw otherwise.
                if r.did_hit && e.stun_chance > 0.0 && self.rng.next_f64() < (e.stun_chance * 100.0 / (100.0 + self.units[target].cd.cs.tenacity)) {
                    self.units[target].is_stunned = true;
                    let exp = now + e.stun_duration;
                    self.units[target].stun_expire_time = Some(exp);
                    let uid = self.units[target].uid;
                    let ids = self.collect(|ev| {
                        matches!(ev.ty(), Ty::AutoAttack | Ty::AbilityCastEnd | Ty::StunExpiration) && ev.source().map(|r| r.uid) == Some(uid)
                    });
                    self.remove_collected(ids);
                    let tr = self.uref(target);
                    self.add(exp, Kind::StunExpiration { src: tr });
                }
                if r.did_hit && e.blind_chance > 0.0 && self.rng.next_f64() < (e.blind_chance * 100.0 / (100.0 + self.units[target].cd.cs.tenacity)) {
                    self.units[target].is_blinded = true;
                    let exp = now + e.blind_duration;
                    self.units[target].blind_expire_time = Some(exp);
                    self.clear_matching_type_and_source(Ty::BlindExpiration, target);
                    if self.clear_matching_type_and_source(Ty::AutoAttack, target) {
                        self.add_next_attack_event(target)?;
                    }
                    let tr = self.uref(target);
                    self.add(exp, Kind::BlindExpiration { src: tr });
                }
                if r.did_hit && e.silence_chance > 0.0 && self.rng.next_f64() < (e.silence_chance * 100.0 / (100.0 + self.units[target].cd.cs.tenacity)) {
                    self.units[target].is_silenced = true;
                    let exp = now + e.silence_duration;
                    self.units[target].silence_expire_time = Some(exp);
                    self.clear_matching_type_and_source(Ty::SilenceExpiration, target);
                    if self.clear_matching_type_and_source(Ty::AbilityCastEnd, target) {
                        self.add_next_attack_event(target)?;
                    }
                    let tr = self.uref(target);
                    self.add(exp, Kind::SilenceExpiration { src: tr });
                }
                if r.did_hit && self.units[si].cd.cs.curse > 0.0 {
                    self.apply_curse(si, target);
                }
                if self.units[si].cd.cs.fury > 0.0 {
                    self.apply_fury(si, r.did_hit);
                }
                if self.units[target].cd.cs.weaken > 0.0 {
                    self.apply_weaken(si, target);
                }
                let th = self.hrid(target);
                self.sim_result.add_attack(&sh, &th, ahrid, Self::hit_of(&r));
                self.record_reflects(si, target, &r);
                if self.units[target].cd.current_hitpoints == 0.0 {
                    self.on_death(target);
                }
                // Ability pierce: drawn on every hit, even at pierceChance 0.
                if r.did_hit && e.pierce_chance > self.rng.next_f64() {
                    continue;
                }
            }

            if parry_target.is_some() && !official {
                break;
            }
            if single {
                break;
            }
        }
        Ok(())
    }

    fn ability_heal(&mut self, si: usize, ahrid: &S, e: &AbilityEffect) -> R {
        let own = self.side_of(si);
        let sh = self.hrid(si);
        match &*e.target_type {
            "allAllies" => {
                for t in self.alive_of(own) {
                    let heal = heal_roll(&mut self.rng, &self.units[si], e)?;
                    let healed = self.units[t].add_hitpoints(heal);
                    let th = self.hrid(t);
                    self.sim_result.add_hitpoints_gained(&th, ahrid, healed, Some(&sh));
                }
                Ok(())
            }
            "lowestHpAlly" => {
                let mut heal_target: Option<usize> = None;
                for t in self.alive_of(own) {
                    let Some(h) = heal_target else {
                        heal_target = Some(t);
                        continue;
                    };
                    let tp = self.units[t].cd.current_hitpoints / self.units[t].cd.max_hitpoints;
                    let hp = self.units[h].cd.current_hitpoints / self.units[h].cd.max_hitpoints;
                    if tp < hp {
                        heal_target = Some(t);
                    }
                }
                if let Some(t) = heal_target {
                    let heal = heal_roll(&mut self.rng, &self.units[si], e)?;
                    let healed = self.units[t].add_hitpoints(heal);
                    let th = self.hrid(t);
                    self.sim_result.add_hitpoints_gained(&th, ahrid, healed, Some(&sh));
                }
                Ok(())
            }
            "self" => {
                let heal = heal_roll(&mut self.rng, &self.units[si], e)?;
                let healed = self.units[si].add_hitpoints(heal);
                self.sim_result.add_hitpoints_gained(&sh, ahrid, healed, Some(&sh));
                Ok(())
            }
            _ => Err(format!("Unsupported target type for heal ability effect: {ahrid}")),
        }
    }

    fn ability_revive(&mut self, si: usize, ahrid: &S, e: &AbilityEffect) -> R {
        if &*e.target_type != "deadAlly" {
            return Err(format!("Unsupported target type for revive ability effect: {ahrid}"));
        }
        let now = self.simulation_time;
        let own = self.side_of(si);
        let Some(t) = self.list(own).and_then(|mut r| r.find(|&i| self.units[i].cd.current_hitpoints <= 0.0)) else {
            return Ok(());
        };
        let th = self.hrid(t);
        let ids = self.collect(|ev| matches!(&ev.kind, Kind::PlayerRespawn { hrid } if *hrid == th));
        self.remove_collected(ids);
        self.counted_dead_players.retain(|h| *h != th);
        self.units[t].remove_expired_buffs(now);
        let heal = heal_roll(&mut self.rng, &self.units[si], e)?;
        let healed = {
            let u = &mut self.units[t];
            let h = u.add_hitpoints(heal);
            u.cd.current_manapoints = u.cd.max_manapoints;
            u.clear_ccs();
            h
        };
        let sh = self.hrid(si);
        self.sim_result.add_hitpoints_gained(&th, ahrid, healed, Some(&sh));
        self.add_next_attack_event(t)?;
        if !self.units[si].is_player {
            self.sim_result.update_time_spent_alive(&th, true, now);
        }
        Ok(())
    }

    fn ability_promote(&mut self, si: usize) -> R<usize> {
        const PROMOTIONS: [&str; 3] = ["/monsters/enchanted_rook", "/monsters/enchanted_knight", "/monsters/enchanted_bishop"];
        let now = self.simulation_time;
        let k = (self.rng.next_f64() * 3.0).floor() as usize;
        let (tier, room) = match self.units[si].monster() {
            Some(m) => (m.difficulty_tier, m.room_level),
            None => return Err("twin: promote cast by a player".into()),
        };
        let uid = self.next_uid;
        self.next_uid += 1;
        let mut promoted = create_monster(self.data, &mut self.ability_cache, PROMOTIONS[k], tier, room, uid)?;
        let rs = self.random_start;
        promoted.reset(now, rs, &mut self.rng);
        if !(self.enemies_on && si >= self.n) {
            return Err("twin: promote of a unit outside this.enemies is not modelled".into());
        }
        let h = promoted.hrid.clone();
        self.units[si] = promoted;
        self.sim_result.update_time_spent_alive(&h, true, now);
        Ok(si)
    }
}
