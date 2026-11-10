//! zone.js. `battlesPerBoss` is the constant 10 the JS writes into shared data.

use crate::data::{CombatZoneInfo, GameData, RandomSpawnInfo, RawBuff, Spawn};
use crate::js::{num_key, s, S};
use crate::rng::Mulberry32;

const BATTLES_PER_BOSS: f64 = 10.0;

pub struct Zone<'a> {
    pub hrid: S,
    pub difficulty_tier: f64,
    pub info: &'a CombatZoneInfo,
    pub buffs: Option<&'a Vec<RawBuff>>,
    pub encounters_killed: f64,
    pub is_dungeon: bool,
    pub dungeons_completed: f64,
    pub dungeons_failed: f64,
}

/// (monster hrid, difficulty tier) to spawn, in order.
pub type Spawned = Vec<(String, f64)>;

impl<'a> Zone<'a> {
    pub fn new(data: &'a GameData, hrid: &str, difficulty_tier: f64) -> Result<Zone<'a>, String> {
        let action = data.actions.get(hrid).ok_or_else(|| format!("TypeError: no zone {hrid}"))?;
        let info = action.combat_zone_info.as_ref().ok_or_else(|| format!("TypeError: {hrid} has no combatZoneInfo"))?;
        Ok(Zone {
            hrid: s(hrid),
            difficulty_tier,
            info,
            buffs: action.buffs.as_ref(),
            encounters_killed: 1.0,
            is_dungeon: info.is_dungeon,
            dungeons_completed: 0.0,
            dungeons_failed: 0.0,
        })
    }

    pub fn max_waves(&self) -> f64 {
        self.info.dungeon_info.max_waves
    }

    fn roll(&self, rng: &mut Mulberry32, info: &RandomSpawnInfo) -> Result<Spawned, String> {
        let spawns: &[Spawn] = info.spawns.as_deref().ok_or("TypeError: Cannot read properties of null (reading 'reduce')")?;
        let mut total_weight = 0.0;
        for sp in spawns {
            total_weight = total_weight + sp.rate;
        }
        let mut out = Vec::new();
        let mut total_strength = 0.0;
        let mut i = 0.0;
        'outer: while i < info.max_spawn_count {
            let random_weight = total_weight * rng.next_f64();
            let mut cumulative = 0.0;
            for sp in spawns {
                cumulative += sp.rate;
                if random_weight <= cumulative {
                    total_strength += sp.strength;
                    if total_strength <= info.max_total_strength {
                        out.push((sp.combat_monster_hrid.clone(), sp.difficulty_tier + self.difficulty_tier));
                    } else {
                        break 'outer;
                    }
                    break;
                }
            }
            i += 1.0;
        }
        Ok(out)
    }

    pub fn get_random_encounter(&mut self, rng: &mut Mulberry32) -> Result<Spawned, String> {
        if let Some(bosses) = &self.info.fight_info.boss_spawns {
            if self.encounters_killed == BATTLES_PER_BOSS {
                self.encounters_killed = 1.0;
                return Ok(bosses.iter().map(|b| (b.combat_monster_hrid.clone(), b.difficulty_tier + self.difficulty_tier)).collect());
            }
        }
        let out = self.roll(rng, &self.info.fight_info.random_spawn_info)?;
        self.encounters_killed += 1.0;
        Ok(out)
    }

    pub fn fail_wave(&mut self) {
        self.dungeons_failed += 1.0;
        self.encounters_killed = 1.0;
    }

    pub fn get_next_wave(&mut self, rng: &mut Mulberry32) -> Result<Spawned, String> {
        let di = &self.info.dungeon_info;
        if self.encounters_killed > di.max_waves {
            self.dungeons_completed += 1.0;
            self.encounters_killed = 1.0;
        }
        let key = num_key(self.encounters_killed);
        if let Some(fixed) = di.fixed_spawns_map.as_ref().and_then(|m| m.get(&key)) {
            self.encounters_killed += 1.0;
            return Ok(fixed.iter().map(|m| (m.combat_monster_hrid.clone(), m.difficulty_tier + self.difficulty_tier)).collect());
        }
        let map = di.random_spawn_info_map.as_ref().ok_or("TypeError: Cannot convert undefined or null to object")?;
        let mut keys: Vec<f64> = map.0.iter().map(|(k, _)| k.trim().parse::<f64>().unwrap_or(f64::NAN)).collect();
        keys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let ek = self.encounters_killed;
        let mut chosen: Option<&RandomSpawnInfo> = None;
        if let Some(last) = keys.last() {
            if ek > *last {
                chosen = map.get(&num_key(*last));
            } else {
                for i in 0..keys.len().saturating_sub(1) {
                    if ek >= keys[i] && ek <= keys[i + 1] {
                        chosen = map.get(&num_key(keys[i]));
                        break;
                    }
                }
            }
        }
        let info = chosen.ok_or("TypeError: Cannot read properties of undefined (reading 'reduce')")?;
        let out = self.roll(rng, info)?;
        self.encounters_killed += 1.0;
        Ok(out)
    }
}
