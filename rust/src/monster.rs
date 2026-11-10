//! monster.js construction (stat recompute lives in unit.rs).

use crate::ability::Ability;
use crate::data::GameData;
use crate::unit::{MonsterPart, Unit, UnitKind};
use std::collections::HashMap;

/// A monster's abilities are a pure function of (hrid, tier, room level); the
/// simulator keeps them here instead of rebuilding them on every spawn.
pub type AbilityCache = HashMap<(String, u64, u64), Vec<Option<Ability>>>;

/// `new Monster(hrid, difficultyTier = 0, roomLevel = 0)`.
pub fn create_monster(
    data: &GameData,
    cache: &mut AbilityCache,
    hrid: &str,
    difficulty_tier: f64,
    room_level: f64,
    uid: u32,
) -> Result<Unit, String> {
    let st = data.monsters.get(hrid).ok_or_else(|| format!("No monster found for hrid: {hrid}"))?.clone();
    let room_level = if room_level <= 0.0 { 100.0 } else { room_level };
    let lsf = room_level / 100.0;
    let key = (hrid.to_string(), difficulty_tier.to_bits(), room_level.to_bits());
    let abilities = match cache.get(&key) {
        Some(a) => a.clone(),
        None => {
            let mut abilities: Vec<Option<Ability>> = vec![None, None, None, None];
            for (i, a) in st.data.abilities.iter().enumerate() {
                if a.min_difficulty_tier > difficulty_tier {
                    continue;
                }
                while abilities.len() <= i {
                    abilities.push(None);
                }
                abilities[i] = Some(Ability::new(data, &a.ability_hrid, (a.level * lsf).floor(), None)?);
            }
            cache.insert(key, abilities.clone());
            abilities
        }
    };
    let enrage_time = st.data.enrage_time;
    let hrid_s = st.hrid.clone();
    let mut u = Unit::blank(
        uid,
        false,
        hrid_s,
        UnitKind::Monster(MonsterPart {
            st,
            difficulty_tier,
            room_level,
            trial_hp_scale_factor: 1.0,
            trial_attack_speed_bonus: 0.0,
            trial_cast_speed_bonus: 0.0,
            trial_ability_haste_bonus: 0.0,
        }),
    );
    u.enrage_time = enrage_time;
    u.abilities = abilities;
    Ok(u)
}
