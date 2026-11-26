//! Behavioural regressions once pinned by the JS engine's api/tests/*.test.mjs (deleted in 8377e42
//! when the JS engine was retired), re-asserted against the twin. Each test names its JS original.

use super::*;
use crate::data::TriggerDto;
use crate::request::TrialReq;
use crate::test_support::{data, dto_json, player, player_from, zone_buffs};
use crate::unit::{PlayerPart, SMASH};

const HOUR: f64 = 3600e9;

fn new_sim<'a>(players: Vec<Unit>, zone: Option<Zone<'a>>, trial: Option<GuildTrial>, seed: u32) -> Sim<'a> {
    Sim::new(data(), players, zone, trial, None, Mulberry32::new(seed), true)
}

fn zone(hrid: &str) -> Zone<'static> {
    Zone::new(data(), hrid, 0.0).expect("zone")
}

/// `sim.reset(); p.generatePermanentBuffs(); p.reset()` for every player.
fn ready(sim: &mut Sim) {
    let mut rng = Mulberry32::new(0); // a player's reset(0) draws nothing
    for i in 0..sim.n {
        sim.units[i].generate_permanent_buffs();
        sim.units[i].reset(0.0, true, &mut rng);
    }
}

/// `sim.enemies = [new Monster(h, 0, room)...]`, each reset(0).
fn put_enemies(sim: &mut Sim, monsters: &[(&str, f64)]) {
    sim.units.truncate(sim.n);
    for (h, room) in monsters {
        let uid = sim.next_uid;
        sim.next_uid += 1;
        let mut m = create_monster(sim.data, &mut sim.ability_cache, h, 0.0, *room, uid).expect("monster");
        m.reset(0.0, false, &mut sim.rng);
        sim.units.push(m);
    }
    sim.enemies_on = true;
}

fn blank_player(uid: u32, name: &str) -> Unit {
    Unit::blank(uid, true, js::s(name), UnitKind::Player(PlayerPart { equipment: Vec::new(), totals: Vec::new() }))
}

/// `new DamageOverTimeEvent(t, {hrid: '/monsters/x'}, target, 30, 3, 2, slash)`: a 10 HP tick.
fn dot(sim: &Sim, time: f64, target: usize) -> Event {
    let kind = Kind::DamageOverTime {
        src_hrid: js::s("/monsters/x"),
        target: sim.uref(target),
        damage: 30.0,
        total: 3.0,
        cur: 2.0,
        style: js::s("/combat_styles/slash"),
    };
    Event { time, id: u64::MAX, kind }
}

fn step(sim: &mut Sim) -> Event {
    let ev = sim.pop().expect("an event");
    sim.process_event(ev.clone()).expect("process_event");
    ev
}

fn trial(level: f64) -> Sim<'static> {
    let req: TrialReq = serde_json::from_value(serde_json::json!({"trialHrid": "/guild_combat/badger", "startTier": 100, "participantCount": 1})).unwrap();
    let gt = GuildTrial::new(data(), &req).expect("trial");
    let mut sim = new_sim(vec![player("melee", level, 1, vec![])], None, Some(gt), 1);
    ready(&mut sim);
    sim
}

fn trigger(dep: &str, cond: &str, cmp: &str, value: f64) -> TriggerDto {
    serde_json::from_value(serde_json::json!({
        "dependencyHrid": format!("/combat_trigger_dependencies/{dep}"),
        "conditionHrid": format!("/combat_trigger_conditions/{cond}"),
        "comparatorHrid": format!("/combat_trigger_comparators/{cmp}"),
        "value": value,
    }))
    .unwrap()
}

fn has_event(sim: &Sim, ty: Ty, i: usize) -> bool {
    sim.get_matching_type_and_source(ty, i).is_some()
}

fn death_count(sim: &Sim, hrid: &str) -> Option<f64> {
    sim.sim_result.deaths.get(hrid).copied()
}

// ---- promote (audit-4) ----

// promote.test.mjs, audit-4: a promoted monster is reset, replaces the pawn and is tracked.
#[test]
fn promote_replaces_the_pawn_with_a_reset_tracked_monster() {
    let z = zone("/actions/combat/enchanted_fortress");
    let zb = zone_buffs(&z);
    let mut sim = new_sim(vec![player("melee", 90.0, 1, zb)], Some(z), None, 1);
    ready(&mut sim);
    put_enemies(&mut sim, &[("/monsters/enchanted_pawn", 0.0), ("/monsters/enchanted_pawn", 0.0)]);
    let (other_uid, pawn_uid) = (sim.units[1].uid, sim.units[2].uid);
    sim.simulation_time = 10e9;
    let i = sim.ability_promote(2).expect("promote");
    assert_eq!(i, 2, "the promoted monster takes the pawn's place");
    let m = &sim.units[2];
    assert_ne!(&*m.hrid, "/monsters/enchanted_pawn");
    assert_ne!(m.uid, pawn_uid);
    assert!(m.cd.max_hitpoints > 110.0, "max HP {} (never reset?)", m.cd.max_hitpoints);
    assert_eq!(m.cd.current_hitpoints, m.cd.max_hitpoints);
    assert_eq!(sim.units.len(), 3, "enemies are [other, promoted]");
    assert_eq!(sim.units[1].uid, other_uid);
    let h = m.hrid.to_string();
    assert!(sim.sim_result.time_spent_alive.iter().any(|t| t.name == h && t.alive && t.spawned_at == 10e9));
}

// promote.test.mjs, audit-4: the promoted monster keeps the pawn's room level.
#[test]
fn promote_keeps_the_pawn_room_level() {
    let mut sim = new_sim(vec![player("melee", 90.0, 1, vec![])], Some(zone("/actions/combat/enchanted_fortress")), None, 1);
    ready(&mut sim);
    put_enemies(&mut sim, &[("/monsters/enchanted_pawn", 260.0)]);
    let i = sim.ability_promote(1).expect("promote");
    assert_eq!(sim.units[i].monster().unwrap().room_level, 260.0);
}

// promote.test.mjs, audit-4: closing an untracked unit is a no-op, not a throw.
#[test]
fn closing_an_untracked_unit_is_a_no_op() {
    let mut r = SimResult::new(None, None, 1);
    r.update_time_spent_alive("/monsters/nobody", false, 5e9);
    assert!(r.time_spent_alive.is_empty());
}

// ---- dungeonGapWipe (audit-1) ----

/// A seeded pirate_cove run; Some((wipe time, first spawn after it as (time, wave))) for the first gap wipe.
fn gap_wipe_restart(seed: u32) -> Option<(f64, (f64, f64))> {
    let z = zone("/actions/combat/pirate_cove");
    let zb = zone_buffs(&z);
    let mut sim = new_sim(vec![player("magic", 150.0, 1, zb)], Some(z), None, seed);
    sim.add(0.0, Kind::CombatStart);
    let (mut wipe_at, mut spawns) = (None, Vec::new());
    while sim.simulation_time < 2.0 * HOUR {
        let (gap, dead) = (!sim.enemies_on, sim.all_players_dead);
        let ev = step(&mut sim);
        if matches!(ev.kind, Kind::CombatStart | Kind::EnemyRespawn) && sim.enemies_on {
            spawns.push((sim.simulation_time, sim.zone.as_ref().unwrap().encounters_killed - 1.0));
        }
        if wipe_at.is_none() && gap && !dead && sim.all_players_dead {
            wipe_at = Some(sim.simulation_time);
        }
        if let Some(w) = wipe_at {
            if let Some(&next) = spawns.iter().find(|(t, _)| *t > w) {
                return Some((w, next));
            }
        }
    }
    None
}

// dungeonGapWipe.test.mjs, audit-1: a gap wipe in a dungeon neither throws nor skips wave 1.
#[test]
fn dungeon_gap_wipe_restarts_at_wave_1() {
    // Seed 5 is the JS repro (pirate_cove T0, L150 magic, 2 h); the twin replays the same stream.
    let (w, next) = gap_wipe_restart(5).expect("the seeded run must still hit a gap wipe");
    assert_eq!(next, (w + 3e9, 1.0), "the restart is wave 1, 3 s after the wipe");
}

// dungeonGapWipe.test.mjs, audit-1: a planet encounter after a gap wipe is not a failed dungeon run.
#[test]
fn planet_encounter_after_a_wipe_is_not_a_failed_dungeon_run() {
    let z = zone("/actions/combat/fly");
    let zb = zone_buffs(&z);
    let mut sim = new_sim(vec![player("magic", 150.0, 1, zb)], Some(z), None, 1);
    ready(&mut sim);
    for _ in 0..9 {
        sim.start_new_encounter().unwrap();
    }
    let before = sim.zone.as_ref().unwrap().encounters_killed;
    sim.all_players_dead = true;
    sim.start_new_encounter().unwrap();
    let z = sim.zone.as_ref().unwrap();
    assert_eq!(z.dungeons_failed, 0.0);
    assert!(!sim.all_players_dead);
    assert_eq!(z.encounters_killed, before + 1.0, "the boss counter is not reset");
}

/// A wipe on the final wave, during the boss fight or in the gap after it; (failed, completed).
fn wipe_on_final_wave(in_gap: bool) -> (f64, f64) {
    let z = zone("/actions/combat/pirate_cove");
    let zb = zone_buffs(&z);
    let mut sim = new_sim(vec![player("magic", 150.0, 1, zb)], Some(z), None, 1);
    ready(&mut sim);
    let max_waves = sim.zone.as_ref().unwrap().max_waves();
    for _ in 0..max_waves as usize {
        sim.start_new_encounter().unwrap();
    }
    assert!(sim.zone.as_ref().unwrap().encounters_killed > max_waves, "the final wave is up");
    if in_gap {
        sim.enemies_on = false;
    } else {
        assert!((sim.n..sim.units.len()).any(|i| sim.units[i].alive()), "the boss is alive");
    }
    sim.units[0].cd.current_hitpoints = 0.0;
    sim.check_encounter_end().unwrap();
    assert!(sim.all_players_dead);
    sim.start_new_encounter().unwrap();
    let z = sim.zone.as_ref().unwrap();
    (z.dungeons_failed, z.dungeons_completed)
}

// dungeonGapWipe.test.mjs, audit-1: a wipe during the final boss fight is a failed run.
#[test]
fn wipe_during_final_boss_fails_the_run() {
    assert_eq!(wipe_on_final_wave(false), (1.0, 0.0));
}

// dungeonGapWipe.test.mjs, audit-1: a gap wipe after the final boss died is a completed run.
#[test]
fn gap_wipe_after_final_boss_completes_the_run() {
    assert_eq!(wipe_on_final_wave(true), (0.0, 1.0));
}

// ---- trialGapWipe (audit-3) ----

// trialGapWipe.test.mjs, audit-3: a DoT wipe in the gap after a tier clear scores 0 of the next tier.
#[test]
fn trial_gap_wipe_scores_nothing_of_the_next_tier() {
    let mut sim = trial(400.0);
    sim.trial.as_mut().unwrap().advance_tier(); // tier 100 just cleared
    sim.enemies_on = false;
    sim.simulation_time = 30e9;
    sim.units[0].cd.current_hitpoints = 5.0;
    let ev = dot(&sim, 31e9, 0);
    sim.process_event(ev).unwrap();
    let r = &sim.sim_result;
    assert_eq!(r.trial_end_reason, Some("wipe"));
    assert_eq!(r.trial_current_tier, 110.0, "final tier");
    assert_eq!(r.trial_final_tier_hp_removed_frac, 0.0);
    // 400 guild points: one tier cleared and nothing of the next.
    assert_eq!(sim.trial.as_ref().unwrap().tiers_cleared, 1.0);
}

// trialGapWipe.test.mjs, audit-3: a mutual kill that clears a tier ends the run on the next tier, at 0.
#[test]
fn trial_mutual_kill_ends_on_the_next_tier_at_zero() {
    let mut sim = trial(400.0);
    sim.start_new_encounter().unwrap();
    for i in sim.n..sim.units.len() {
        sim.units[i].cd.current_hitpoints = 0.0;
    }
    sim.units[0].cd.current_hitpoints = 0.0; // thorns killed the player on the killing blow
    sim.simulation_time = 30e9;
    sim.check_encounter_end().unwrap();
    let r = &sim.sim_result;
    assert_eq!(r.trial_end_reason, Some("wipe"));
    assert_eq!(sim.trial.as_ref().unwrap().tiers_cleared, 1.0);
    assert_eq!(r.trial_current_tier, 110.0);
    assert_eq!(r.trial_final_tier_hp_removed_frac, 0.0);
}

// ---- maxTicks ----

// maxTicks.test.mjs: the tick budget grows with elapsed simulated time.
#[test]
fn tick_budget_grows_with_simulated_time() {
    assert_eq!(Sim::max_ticks_at(0.0), 5_000_000.0);
    assert_eq!(Sim::max_ticks_at(1000.0 * HOUR), 105_000_000.0);
    // The reported run: ~7.7 M events by 1500 h is well inside its budget.
    assert!(!Sim::over_budget(7_700_000, 0, 1500.0 * HOUR));
}

// maxTicks.test.mjs: a frozen clock throws at 5 M events, however long the limit or the budget it earned first.
#[test]
fn a_frozen_clock_trips_the_stall_guard_at_5m() {
    assert!(!Sim::over_budget(4_999_999, 4_999_999, 0.0));
    assert!(Sim::over_budget(5_000_000, 5_000_000, 0.0));
    // Frozen at 100 h: the budget there is 15 M, but the stall alone stops it at 5 M stalled events.
    assert!(!Sim::over_budget(10_000_000, 4_999_999, 100.0 * HOUR));
    assert!(Sim::over_budget(10_000_000, 5_000_000, 100.0 * HOUR));
}

// ---- deadTargetReflect ----

/// The JS test's hand-built unit: a sure smash hit for up to `max_damage`, no armor.
fn duel_unit(uid: u32, hp: f64, thorns: f64, retaliation: f64, max_damage: f64) -> Unit {
    let st = data().monsters.get("/monsters/fly").unwrap().clone();
    let part = crate::unit::MonsterPart {
        st,
        difficulty_tier: 0.0,
        room_level: 100.0,
        trial_hp_scale_factor: 1.0,
        trial_attack_speed_bonus: 0.0,
        trial_cast_speed_bonus: 0.0,
        trial_ability_haste_bonus: 0.0,
    };
    let mut u = Unit::blank(uid, false, js::s("/monsters/fly"), UnitKind::Monster(part));
    let cd = &mut u.cd;
    cd.current_hitpoints = hp;
    cd.max_hitpoints = hp;
    cd.accuracy_rating[SMASH] = 1e9;
    cd.max_damage[SMASH] = max_damage;
    cd.evasion_rating[SMASH] = 1.0;
    cd.defensive_max_damage = 1000.0;
    cd.total_armor = 0.0;
    cd.cs.combat_style_hrid = js::s("/combat_styles/smash");
    cd.cs.damage_type = js::s("/damage_types/physical");
    cd.cs.physical_thorns = thorns;
    cd.cs.retaliation = retaliation;
    u
}

// deadTargetReflect.test.mjs R1: a killing blow draws no thorns or retaliation.
#[test]
fn killing_blow_draws_no_reflect() {
    let mut rng = Mulberry32::new(1);
    for _ in 0..50 {
        let mut attacker = duel_unit(1, 1.0, 0.0, 0.0, 100.0);
        let mut target = duel_unit(2, 1.0, 5.0, 5.0, 100.0);
        let r = process_attack(&mut rng, &mut attacker, &mut target, None).unwrap();
        assert_eq!(target.cd.current_hitpoints, 0.0, "target dies");
        assert_eq!(r.thorn_damage_done, 0.0);
        assert_eq!(r.retaliation_damage_done, 0.0);
        assert_eq!(attacker.cd.current_hitpoints, 1.0, "attacker survives");
    }
}

// deadTargetReflect.test.mjs R2: a target that survives still reflects.
#[test]
fn surviving_target_still_reflects() {
    let mut rng = Mulberry32::new(1);
    let mut attacker = duel_unit(1, 1e9, 0.0, 0.0, 1.0);
    let mut target = duel_unit(2, 1e9, 5.0, 5.0, 100.0);
    let (mut thorns, mut retaliation) = (0.0, 0.0);
    for _ in 0..50 {
        let r = process_attack(&mut rng, &mut attacker, &mut target, None).unwrap();
        thorns += r.thorn_damage_done;
        retaliation += r.retaliation_damage_done;
    }
    assert!(thorns > 0.0, "thorns still fire on a surviving target");
    assert!(retaliation > 0.0, "retaliation still fires on a surviving target");
}

// ---- deadAttacker (audit-5) ----

// deadAttacker.test.mjs, audit-5: no auto-attack or cast comes from a dead unit (seeded dungeon run).
#[test]
fn no_action_from_a_dead_unit_in_a_seeded_dungeon() {
    let z = zone("/actions/combat/chimerical_den");
    let zb = zone_buffs(&z);
    let party = ["tank", "healer", "melee", "ranged", "magic"];
    let players = party.iter().enumerate().map(|(i, b)| player(b, 600.0, i as u32 + 1, zb.clone())).collect();
    let mut sim = new_sim(players, Some(z), None, 3);
    sim.add(0.0, Kind::CombatStart);
    let (mut acted, mut dead_acts) = (0, 0);
    while sim.simulation_time < 2.0 * HOUR {
        let ev = sim.pop().expect("an event");
        if let Kind::AutoAttack { src } | Kind::AbilityCastEnd { src, .. } = ev.kind {
            acted += 1;
            if sim.resolve(src).map(|i| !sim.units[i].alive()).unwrap_or(false) {
                dead_acts += 1;
            }
        }
        sim.process_event(ev).unwrap();
    }
    assert!(acted > 1000, "the run must actually fight ({acted} actions)");
    assert_eq!(dead_acts, 0);
}

/// A magic L100 caster at 1 HP facing three flies whose thorns always kill it.
fn doomed_caster() -> Sim<'static> {
    let mut sim = new_sim(vec![player("magic", 100.0, 1, vec![])], None, None, 1);
    ready(&mut sim);
    put_enemies(&mut sim, &[("/monsters/fly", 0.0), ("/monsters/fly", 0.0), ("/monsters/fly", 0.0)]);
    for i in 1..4 {
        let cd = &mut sim.units[i].cd;
        cd.current_hitpoints = 1e9;
        cd.max_hitpoints = 1e9;
        cd.defensive_max_damage = 1e6;
        cd.cs.elemental_thorns = 5.0;
        cd.cs.physical_thorns = 5.0;
    }
    sim.units[0].cd.current_hitpoints = 1.0;
    sim
}

fn hits_by(sim: &Sim, source: &str, ability: &str) -> f64 {
    let Some(by_target) = sim.sim_result.attacks.get(source) else { return 0.0 };
    by_target.0.iter().filter_map(|(_, m)| m.get(ability)).flat_map(|h| h.m.0.iter().map(|(_, n)| *n)).sum()
}

// deadAttacker.test.mjs, audit-5: an area cast stops at the target whose reflect kills the caster.
#[test]
fn area_cast_stops_when_a_reflect_kills_the_caster() {
    let mut sim = doomed_caster();
    let a = Ability::new(sim.data, "/abilities/firestorm", 10.0, None).unwrap();
    let e = a.effects[0].clone();
    assert_eq!(&*e.target_type, "allEnemies");
    sim.ability_damage(0, &a.hrid, &e).unwrap();
    assert_eq!(sim.units[0].cd.current_hitpoints, 0.0, "the first reflect killed the caster");
    assert_eq!(hits_by(&sim, "player1", "/abilities/firestorm"), 1.0, "only the first target was struck");
}

// deadAttacker.test.mjs, audit-5: a caster killed mid-cast applies none of the cast's later effects.
#[test]
fn caster_killed_mid_cast_applies_no_later_effects() {
    let mut sim = doomed_caster();
    let d = sim.data;
    let dmg = Ability::new(d, "/abilities/firestorm", 10.0, None).unwrap();
    let heal = Ability::new(d, "/abilities/heal", 10.0, None).unwrap();
    let buff = Ability::new(d, "/abilities/berserk", 10.0, None).unwrap();
    let buff_hrid = buff.effects[0].buffs.as_ref().unwrap()[0].unique_hrid.clone();
    let mut a = dmg.clone();
    a.mana_cost = 0.0;
    a.effects = Rc::new(vec![dmg.effects[0].clone(), heal.effects[0].clone(), buff.effects[0].clone()]);
    sim.units[0].abilities = vec![Some(a), None, None, None, None];
    sim.units[0].cd.cs.ripple = 1.0;
    sim.units[0].cd.current_manapoints = 0.0;
    sim.try_use_ability(0, 0).unwrap();
    let u = &sim.units[0];
    assert_eq!(u.cd.current_hitpoints, 0.0);
    assert!(sim.sim_result.hitpoints_gained.get("player1").and_then(|m| m.get("/abilities/firestorm")).is_none(), "no heal");
    assert!(!u.combat_buffs.iter().any(|(k, _)| *k == buff_hrid), "no buff");
    assert_eq!(u.cd.current_manapoints, 0.0, "no ripple mana for the dead");
}

// ---- pickByThreat (audit-20) ----

fn threat_sim(threats: &[f64]) -> Sim<'static> {
    let units = threats
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mut u = blank_player(i as u32 + 1, &format!("u{i}"));
            u.cd.cs.threat = *t;
            u
        })
        .collect();
    new_sim(units, None, None, 0)
}

// pickByThreat.test.mjs, audit-20: threat-weighted pick, one draw, zero-threat units never chosen.
#[test]
fn pick_by_threat_is_weighted_by_threat_with_one_draw() {
    let mut sim = threat_sim(&[100.0, 0.0, 300.0]);
    let mut picked = [0; 3];
    for seed in 0..2000 {
        sim.rng = Mulberry32::new(seed);
        let mut expect = Mulberry32::new(seed);
        let r = expect.next_f64() * 400.0; // a <-> [0,100), b <-> [100,100), c <-> [100,400)
        let i = sim.pick_by_threat(&[0, 1, 2]);
        assert_eq!(sim.rng.a, expect.a, "exactly one draw");
        assert_eq!(i, if r < 100.0 { 0 } else { 2 }, "seed {seed}");
        picked[i] += 1;
    }
    assert_eq!(picked[1], 0, "a zero-threat unit is never picked");
    assert!(picked[0] > 300 && picked[2] > 1200, "{picked:?}");
}

// pickByThreat.test.mjs, audit-20: all-zero threat picks uniformly instead of throwing.
#[test]
fn pick_by_threat_with_no_threat_picks_uniformly() {
    let mut sim = threat_sim(&[0.0, 0.0, 0.0]);
    for seed in 0..300 {
        sim.rng = Mulberry32::new(seed);
        let mut expect = Mulberry32::new(seed);
        let k = (expect.next_f64() * 3.0).floor() as usize;
        assert_eq!(sim.pick_by_threat(&[0, 1, 2]), k);
        assert_eq!(sim.rng.a, expect.a, "exactly one draw");
    }
}

// ---- stunRearm (audit3-15) ----

// stunRearm.test.mjs, audit3-15: a stunned unit queues no action until its stun expires.
#[test]
fn stunned_unit_queues_no_action_until_the_stun_expires() {
    let mut sim = new_sim(vec![player("melee", 100.0, 1, vec![])], None, None, 1);
    ready(&mut sim);
    put_enemies(&mut sim, &[("/monsters/fly", 0.0)]);
    sim.units[0].is_stunned = true;
    sim.add_next_attack_event(0).unwrap();
    assert_eq!(sim.units[0].pending_action_count, 0, "stunned unit re-armed");
    let src = sim.uref(0);
    sim.process_event(Event { time: 0.0, id: u64::MAX, kind: Kind::StunExpiration { src } }).unwrap();
    assert!(sim.units[0].pending_action_count > 0, "stun expiry did not re-arm");
}

// ---- playerDeaths (audit2-1) ----

// playerDeaths.test.mjs, audit2-1: a weak solo player dies at most once per 150 s respawn.
#[test]
fn weak_solo_player_dies_at_most_once_per_respawn() {
    let z = zone("/actions/combat/infernal_abyss");
    let zb = zone_buffs(&z);
    let mut sim = new_sim(vec![player("melee", 20.0, 1, zb)], Some(z), None, 1);
    let hours = 10.0;
    sim.simulate(hours * HOUR, None, None).unwrap();
    let deaths = death_count(&sim, "player1").unwrap_or(0.0);
    assert!(deaths > 100.0, "the L20 player must keep dying (got {deaths})");
    assert!(deaths / hours <= 3600.0 / 150.0, "{} deaths/h exceeds the respawn cap", deaths / hours);
}

// playerDeaths.test.mjs, audit2-1: a trial death counts once.
#[test]
fn a_trial_death_counts_once() {
    let mut sim = trial(400.0);
    sim.start_new_encounter().unwrap();
    sim.units[0].cd.current_hitpoints = 5.0;
    let ev = dot(&sim, 1e9, 0);
    sim.process_event(ev).unwrap();
    sim.check_encounter_end().unwrap();
    assert_eq!(death_count(&sim, "player1"), Some(1.0));
}

fn dungeon_pair() -> Sim<'static> {
    let z = zone("/actions/combat/chimerical_den");
    let zb = zone_buffs(&z);
    let players = vec![player("melee", 150.0, 1, zb.clone()), player("melee", 150.0, 2, zb)];
    let mut sim = new_sim(players, Some(z), None, 1);
    ready(&mut sim);
    sim.start_new_encounter().unwrap();
    sim
}

// playerDeaths.test.mjs, audit2-1: a dead dungeon party member is not re-counted by later checks.
#[test]
fn a_dead_dungeon_member_is_not_recounted() {
    let mut sim = dungeon_pair();
    sim.units[0].cd.current_hitpoints = 5.0;
    let ev = dot(&sim, 1e9, 0);
    sim.process_event(ev).unwrap();
    sim.check_encounter_end().unwrap();
    sim.check_encounter_end().unwrap();
    assert_eq!(death_count(&sim, "player1"), Some(1.0));
    assert_eq!(death_count(&sim, "player2"), None);
}

// playerDeaths.test.mjs, audit2-1: a player dead at the end of a completed dungeon run counts again next run.
#[test]
fn a_death_after_a_completed_run_counts_again() {
    let mut sim = dungeon_pair();
    sim.units[0].cd.current_hitpoints = 5.0;
    let ev = dot(&sim, 1e9, 0);
    sim.process_event(ev).unwrap();
    sim.zone.as_mut().unwrap().dungeons_completed += 1.0; // player2 finished the run
    sim.start_new_encounter().unwrap();
    assert!(sim.units[0].alive(), "the completed run refilled player1");
    sim.units[0].cd.current_hitpoints = 5.0;
    let ev = dot(&sim, 2e9, 0);
    sim.process_event(ev).unwrap();
    assert_eq!(death_count(&sim, "player1"), Some(2.0));
}

// ---- playerRefill (audit3-1) ----

/// A L100 melee player wearing a +500 max-HP buff, stunned.
fn refill_setup() -> (Sim<'static>, f64) {
    let mut sim = new_sim(vec![player("melee", 100.0, 1, vec![])], None, None, 1);
    ready(&mut sim);
    let base = sim.units[0].cd.max_hitpoints;
    let b = Buff::synth("/buff_uniques/test_hp", "/buff_types/max_hitpoints", 0.0, 500.0, 300e9);
    sim.units[0].add_buff(&b, Some(0.0), None);
    assert_eq!(sim.units[0].cd.max_hitpoints, base + 500.0, "buff applied");
    sim.units[0].is_stunned = true;
    sim.units[0].stun_expire_time = Some(1e9);
    (sim, base)
}

// playerRefill.test.mjs, audit3-1: a respawned player is at max HP and not stunned.
#[test]
fn respawned_player_is_at_max_hp_and_not_stunned() {
    let (mut sim, base) = refill_setup();
    sim.units[0].cd.current_hitpoints = 0.0;
    sim.process_player_respawn("player1").unwrap();
    let u = &sim.units[0];
    assert_eq!(u.cd.max_hitpoints, base);
    assert_eq!(u.cd.current_hitpoints, base, "HP above max after respawn");
    assert!(!u.is_stunned);
}

// playerRefill.test.mjs, audit3-1: a dungeon refill clears a dead player's CCs and buffs, a live player keeps its buffs.
#[test]
fn dungeon_refill_clears_the_dead_and_keeps_the_living() {
    let (mut dead, base) = refill_setup();
    dead.units[0].cd.current_hitpoints = 0.0;
    dead.refill_player(0);
    assert!(!dead.units[0].is_stunned, "dead player revived still stunned");
    assert_eq!(dead.units[0].cd.current_hitpoints, base);

    let (mut live, base) = refill_setup();
    live.units[0].cd.current_hitpoints = 1.0;
    live.refill_player(0);
    assert_eq!(live.units[0].cd.max_hitpoints, base + 500.0, "live player lost its buff");
    assert_eq!(live.units[0].cd.current_hitpoints, base + 500.0);
}

// ---- playerSlots (audit3-6) ----

fn slots_dto(intelligence: f64, pouch: Option<&str>) -> serde_json::Value {
    let mut d = dto_json("melee", 100.0, 1);
    d["intelligenceLevel"] = intelligence.into();
    d["equipment"]["/equipment_types/pouch"] = match pouch {
        Some(h) => serde_json::json!({"hrid": h, "enhancementLevel": 0}),
        None => serde_json::Value::Null,
    };
    for (k, n) in [("abilities", 5), ("food", 3), ("drinks", 3)] {
        let first = d[k][0].clone();
        d[k] = serde_json::Value::Array(vec![first; n]);
    }
    d
}

fn filled<T>(xs: &[Option<T>]) -> String {
    xs.iter().map(|x| if x.is_some() { '1' } else { '0' }).collect()
}

// playerSlots.test.mjs, audit3-6: food and drink slots are 1 + pouch.
#[test]
fn food_and_drink_slots_are_one_plus_pouch() {
    let p = |pouch| player_from(data(), &slots_dto(100.0, pouch), 1, vec![]);
    let bare = p(None);
    assert_eq!((filled(&bare.food), filled(&bare.drinks)), ("100".into(), "100".into()));
    let small = p(Some("/items/small_pouch")); // +1 food, no drink slot
    assert_eq!((filled(&small.food), filled(&small.drinks)), ("110".into(), "100".into()));
    let giant = p(Some("/items/giant_pouch"));
    assert_eq!((filled(&giant.food), filled(&giant.drinks)), ("111".into(), "111".into()));
}

// playerSlots.test.mjs, audit3-6: ability slots unlock at intelligence 1/1/20/50/90.
#[test]
fn ability_slots_unlock_by_intelligence() {
    let abilities = |int| filled(&player_from(data(), &slots_dto(int, None), 1, vec![]).abilities);
    assert_eq!(abilities(1.0), "11000");
    assert_eq!(abilities(19.0), "11000");
    assert_eq!(abilities(20.0), "11100");
    assert_eq!(abilities(50.0), "11110");
    assert_eq!(abilities(89.0), "11110");
    assert_eq!(abilities(90.0), "11111");
}

// playerSlots.test.mjs, audit3-6: with no unlock table (MWIX vendor stubs it) no ability slot is locked.
#[test]
fn no_unlock_table_locks_no_ability_slot() {
    let mut d = crate::test_support::load_data();
    d.ability_slots.clear();
    assert_eq!(filled(&player_from(&d, &slots_dto(1.0, None), 1, vec![]).abilities), "11111");
}

// ---- pendingAction ----

fn queue_sim() -> Sim<'static> {
    new_sim((1..=4).map(|i| blank_player(i, &format!("u{i}"))).collect(), None, None, 0)
}

/// The scan the counter replaced: an AutoAttack or AbilityCastEnd sourced by unit `i`.
fn scan_says_pending(sim: &Sim, i: usize) -> bool {
    has_event(sim, Ty::AutoAttack, i) || has_event(sim, Ty::AbilityCastEnd, i)
}

// pendingAction.test.mjs: the counter is per unit, counts (not flags), and ignores non-action events.
#[test]
fn pending_action_counter_basics() {
    let mut sim = queue_sim();
    let (a, b) = (sim.uref(0), sim.uref(1));
    sim.add(10.0, Kind::AutoAttack { src: a });
    sim.add(20.0, Kind::AbilityCastEnd { src: a, slot: 0 });
    sim.add(30.0, Kind::CheckBuffExpiration { src: b });
    sim.add(40.0, Kind::CombatStart);
    assert_eq!((sim.units[0].pending_action_count, sim.units[1].pending_action_count), (2, 0));
    sim.pop();
    assert_eq!(sim.units[0].pending_action_count, 1, "one action left: still mid-action");
    sim.clear_events_of_type(Ty::AbilityCastEnd);
    assert_eq!(sim.units[0].pending_action_count, 0);
    sim.add(50.0, Kind::AutoAttack { src: b });
    sim.clear_queue();
    assert_eq!(sim.units[1].pending_action_count, 0, "clear resets every unit");
}

// pendingAction.test.mjs: differential, the counter agrees with the scan (and the heap with a model) after every mutation.
#[test]
fn pending_action_counter_agrees_with_the_scan() {
    let mut sim = queue_sim();
    let mut seed: u32 = 0x2f6e2b1;
    let mut rnd = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed as f64 / 4294967296.0
    };
    let mut t = 0.0;
    let mut live: Vec<(u64, Ty, usize)> = Vec::new();
    for step in 0..4000 {
        let roll = rnd();
        let u = (rnd() * 4.0) as usize;
        let src = sim.uref(u);
        if roll < 0.45 {
            let kind = rnd();
            t += 1.0 + rnd() * 10.0;
            let (k, ty) = if kind < 0.35 {
                (Kind::AutoAttack { src }, Ty::AutoAttack)
            } else if kind < 0.7 {
                (Kind::AbilityCastEnd { src, slot: 0 }, Ty::AbilityCastEnd)
            } else {
                (Kind::CheckBuffExpiration { src }, Ty::CheckBuffExpiration)
            };
            live.push((sim.next_eid, ty, u));
            sim.add(t, k);
        } else if roll < 0.7 {
            if let Some(e) = sim.pop() {
                live.retain(|x| x.0 != e.id);
            }
        } else if roll < 0.8 {
            sim.clear_events_for_unit(u);
            live.retain(|x| x.2 != u);
        } else if roll < 0.9 {
            let ty = [Ty::AutoAttack, Ty::AbilityCastEnd, Ty::CheckBuffExpiration][(rnd() * 3.0) as usize];
            sim.clear_events_of_type(ty);
            live.retain(|x| x.1 != ty);
        } else if roll < 0.97 {
            sim.clear_matching_type_and_source(Ty::AutoAttack, u);
            live.retain(|x| !(x.1 == Ty::AutoAttack && x.2 == u));
        } else {
            sim.clear_queue();
            live.clear();
        }
        for i in 0..4 {
            assert_eq!(sim.units[i].pending_action_count > 0, scan_says_pending(&sim, i), "unit {i} at step {step}");
        }
        let mut ids: Vec<u64> = sim.heap.arr.iter().map(|e| e.id).collect();
        ids.sort_unstable();
        let mut want: Vec<u64> = live.iter().map(|x| x.0).collect();
        want.sort_unstable();
        assert_eq!(ids, want, "the heap holds exactly the live events at step {step}");
    }
    assert!(!live.is_empty(), "the fuzz left the queue empty: it proved nothing");
    assert!((0..4).any(|i| sim.units[i].pending_action_count > 0), "the fuzz never left a unit mid-action");
}

// ---- heapRemove ----

/// A heap of CooldownReady events; event `i` has id `i` and time `times[i]`.
fn heap_sim(times: &[f64]) -> Sim<'static> {
    let mut sim = new_sim(Vec::new(), None, None, 0);
    for &t in times {
        sim.add(t, Kind::CooldownReady);
    }
    sim
}

fn heap_ids(sim: &Sim) -> Vec<u64> {
    sim.heap.arr.iter().map(|e| e.id).collect()
}

// heapRemove.test.mjs: removal leaves exactly the array heap-js 2.7.1's remove() leaves (root, middle and last arms).
#[test]
fn heap_removal_matches_heap_js() {
    // Pinned from heap-js 2.7.1 (`new Heap((a, b) => a.time - b.time)`, push each, then remove()).
    let mut sim = heap_sim(&[2.0, 0.0, 1.0, 2.0, 1.0, 0.0, 2.0, 1.0, 0.0, 1.0, 2.0, 0.0]);
    assert_eq!(heap_ids(&sim), [1, 8, 5, 4, 9, 11, 6, 3, 7, 0, 10, 2]);
    let steps: [(u64, &[u64]); 5] = [
        (1, &[5, 8, 11, 4, 9, 2, 6, 3, 7, 0, 10]),
        (2, &[5, 8, 11, 4, 9, 10, 6, 3, 7, 0]),
        (7, &[5, 8, 11, 4, 9, 10, 6, 3, 0]),
        (3, &[5, 8, 11, 4, 9, 10, 6, 0]),
        (10, &[5, 8, 11, 4, 9, 0, 6]),
    ];
    for (id, want) in steps {
        assert_eq!(sim.remove_from_heap(id).map(|e| e.id), Some(id));
        assert_eq!(heap_ids(&sim), want, "after removing {id}");
    }
    assert!(sim.remove_from_heap(999).is_none(), "an absent event is not found");
    assert_eq!(heap_ids(&sim), [5, 8, 11, 4, 9, 0, 6], "and the heap is untouched");
    let drain: Vec<u64> = std::iter::from_fn(|| sim.heap.pop().map(|e| e.id)).collect();
    assert_eq!(drain, [5, 11, 8, 9, 4, 6, 0]);
}

// heapRemove.test.mjs: equal-time events pop in a fixed, known order.
#[test]
fn equal_time_events_pop_in_heap_js_order() {
    let mut sim = heap_sim(&[1.0, 1.0, 1.0, 1.0, 1.0, 0.0]);
    let drain: Vec<u64> = std::iter::from_fn(|| sim.heap.pop().map(|e| e.id)).collect();
    assert_eq!(drain, [5, 2, 4, 3, 0, 1]);
}

// heapRemove.test.mjs: edges, an empty heap and a single element.
#[test]
fn heap_removal_edges() {
    let mut sim = heap_sim(&[]);
    assert!(sim.remove_from_heap(0).is_none());
    let mut sim = heap_sim(&[5.0]);
    assert_eq!(sim.remove_from_heap(0).map(|e| e.id), Some(0));
    assert!(sim.heap.arr.is_empty());
}

// ---- triggers: all must hold; consumables every event, abilities at the next action ----

/// A L100 player whose only ability (slot 0) has `triggers`, facing a fly.
fn ability_trigger_sim(triggers: &[TriggerDto]) -> Sim<'static> {
    let mut sim = new_sim(vec![player("magic", 100.0, 1, vec![])], None, None, 1);
    ready(&mut sim);
    put_enemies(&mut sim, &[("/monsters/fly", 0.0)]);
    let a = Ability::new(sim.data, "/abilities/flame_blast", 10.0, Some(triggers)).unwrap();
    sim.units[0].abilities = vec![Some(a), None, None, None, None];
    sim
}

// checkTriggers / trigger semantics (CLAUDE.md): an ability is cast only when ALL its triggers are true.
#[test]
fn an_ability_needs_all_its_triggers() {
    let yes = trigger("self", "current_hp", "greater_than_equal", 1.0);
    let no = trigger("self", "current_hp", "less_than_equal", 0.0);
    let mut sim = ability_trigger_sim(&[yes.clone(), no]);
    sim.add_next_attack_event(0).unwrap();
    assert!(!has_event(&sim, Ty::AbilityCastEnd, 0), "cast with a false trigger");
    assert!(has_event(&sim, Ty::AutoAttack, 0), "fell back to an auto-attack");

    let mut sim = ability_trigger_sim(&[yes.clone(), yes]);
    sim.add_next_attack_event(0).unwrap();
    assert!(has_event(&sim, Ty::AbilityCastEnd, 0), "all triggers true, yet no cast");
}

// checkTriggers / trigger semantics (CLAUDE.md): consumable triggers fire after every event; ability triggers only when the next action is chosen.
#[test]
fn consumables_fire_on_the_event_abilities_wait_for_the_next_action() {
    let hurt = trigger("self", "missing_hp", "greater_than_equal", 1.0);
    let mut sim = ability_trigger_sim(std::slice::from_ref(&hurt));
    let c = crate::consumable::Consumable::new(sim.data, "/items/stamina_coffee", Some(std::slice::from_ref(&hurt))).unwrap();
    sim.units[0].drinks = vec![Some(c), None, None];
    sim.units[0].food = vec![None, None, None];
    sim.add_next_attack_event(0).unwrap();
    assert!(has_event(&sim, Ty::AutoAttack, 0) && !has_event(&sim, Ty::AbilityCastEnd, 0), "unhurt: auto-attack");

    let ev = dot(&sim, 1e9, 0);
    sim.process_event(ev).unwrap();
    let used = sim.sim_result.consumables_used.get("player1").and_then(|m| m.get("/items/stamina_coffee")).copied();
    assert_eq!(used, Some(1.0), "the drink fired on the damaging event itself");
    assert!(!has_event(&sim, Ty::AbilityCastEnd, 0), "the ability does not interrupt the pending auto-attack");

    // The next action pick sees the trigger.
    sim.clear_matching_type_and_source(Ty::AutoAttack, 0);
    sim.add_next_attack_event(0).unwrap();
    assert!(has_event(&sim, Ty::AbilityCastEnd, 0));
}

// checkTriggers.test.mjs: the dead are skipped (no dead-unit error), the living fire, a null enemy list is tolerated.
#[test]
fn check_triggers_skips_the_dead() {
    let always = trigger("self", "current_hp", "greater_than_equal", 0.0);
    let players = (1..=3).map(|i| player("melee", 100.0, i, vec![])).collect();
    let mut sim = new_sim(players, None, None, 1);
    ready(&mut sim);
    for i in 0..3 {
        let c = crate::consumable::Consumable::new(sim.data, "/items/stamina_coffee", Some(std::slice::from_ref(&always))).unwrap();
        sim.units[i].drinks = vec![Some(c), None, None];
        sim.units[i].food = vec![None, None, None];
    }
    sim.units[1].cd.current_hitpoints = 0.0;
    assert!(!sim.enemies_on);
    sim.check_triggers().unwrap();
    let used = |h: &str| sim.sim_result.consumables_used.get(h).and_then(|m| m.get("/items/stamina_coffee")).copied();
    assert_eq!((used("player1"), used("player2"), used("player3")), (Some(1.0), None, Some(1.0)));
}

// ---- audit-7: a consumable with no cooldown is refused (it would re-fire forever) ----

/// Runs `players` on a 60 s fly T0 zone request and returns the parsed reply.
fn run_zone(players: Vec<serde_json::Value>) -> serde_json::Value {
    let req = serde_json::json!({
        "kind": "zone", "players": players,
        "zone": {"zoneHrid": "/actions/combat/fly", "difficultyTier": 0},
        "simulationTimeLimit": 60e9, "settings": {}, "rngState": 1,
    });
    serde_json::from_str(&crate::run(data(), &req.to_string(), None)).unwrap()
}

#[test]
fn a_zero_cooldown_consumable_is_refused() {
    assert!(crate::consumable::Consumable::new(data(), "/items/wisdom_tea", Some(&[])).is_err());
    let mut p = dto_json("melee", 90.0, 1);
    p["drinks"] = serde_json::json!([{"hrid": "/items/wisdom_tea", "triggers": []}]);
    assert_eq!(run_zone(vec![p])["ok"], false);
}

// ---- audit-6: bad numbers are refused, not run as NaN ----

#[test]
fn a_missing_level_is_refused() {
    let mut p = dto_json("melee", 90.0, 1);
    p.as_object_mut().unwrap().remove("meleeLevel");
    let out = run_zone(vec![p]);
    assert_eq!(out["ok"], false, "{out}");
    assert!(out["error"].as_str().unwrap_or("").contains("meleeLevel"), "{out}");
}

#[test]
fn an_enhancement_level_off_the_table_is_refused() {
    for bad in [serde_json::json!(21), serde_json::json!(-1), serde_json::json!(2.5)] {
        let mut p = dto_json("melee", 90.0, 1);
        let slot = p["equipment"].as_object_mut().unwrap().values_mut().find(|v| !v.is_null()).unwrap();
        slot["enhancementLevel"] = bad.clone();
        let out = run_zone(vec![p]);
        assert_eq!(out["ok"], false, "+{bad}: {out}");
    }
}

#[test]
fn a_bad_participant_count_is_a_range_error() {
    let run_trial = |n: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({
            "kind": "trial", "players": [dto_json("melee", 90.0, 1)],
            "guildTrial": {"trialHrid": "/guild_combat/badger", "startTier": 100, "participantCount": n},
            "settings": {}, "rngState": 1,
        });
        serde_json::from_str(&crate::run(data(), &req.to_string(), None)).unwrap()
    };
    for bad in [serde_json::json!(-150), serde_json::json!(0), serde_json::json!(2.5)] {
        let out = run_trial(bad.clone());
        assert_eq!(out["ok"], false, "participantCount {bad}: ok");
        assert_eq!(out["errorKind"], "RangeError", "participantCount {bad}: {}", out["error"]);
    }
    assert_eq!(run_trial(serde_json::json!(3))["ok"], true);
}
