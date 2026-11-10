//! player.js createFromDTO, houseRoom.js, achievement.js (H13, H16).

use crate::ability::Ability;
use crate::buff::Buff;
use crate::consumable::Consumable;
use crate::data::GameData;
use crate::equipment::Equipment;
use crate::js::{s, truthy, S};
use crate::request::PlayerDto;
use crate::sim_result::Gap;
use crate::unit::{PlayerPart, Unit, UnitKind};
use serde_json::Value;

const DEFAULT_SLOTS: [&str; 10] = [
    "/equipment_types/head",
    "/equipment_types/body",
    "/equipment_types/legs",
    "/equipment_types/feet",
    "/equipment_types/hands",
    "/equipment_types/main_hand",
    "/equipment_types/two_hand",
    "/equipment_types/off_hand",
    "/equipment_types/pouch",
    "/equipment_types/back",
];

fn value_num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::String(st) => {
            let t = st.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// JS truthiness of a DTO value.
fn value_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => truthy(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(st) => !st.is_empty(),
        _ => true,
    }
}

/// `v == false` (loose equality): numbers and strings compare as numbers.
fn value_loose_false(v: &Value) -> bool {
    match v {
        Value::Bool(b) => !*b,
        Value::Number(_) | Value::String(_) => value_num(v) == 0.0,
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

pub fn achievement_buffs(data: &GameData, achieved: &serde_json::Map<String, Value>) -> Result<Vec<Buff>, String> {
    let mut buffs = Vec::new();
    for tier in data.achievement_tiers.values() {
        let mut all = true;
        for a in data.achievements.values().filter(|d| d.tier_hrid == tier.hrid) {
            match achieved.get(&a.hrid) {
                Some(v) if value_truthy(v) && !value_loose_false(v) => {}
                _ => {
                    all = false;
                    break;
                }
            }
        }
        if all {
            buffs.push(Buff::leveled(&tier.buff, 1.0)?);
        }
    }
    Ok(buffs)
}

pub fn create_player(data: &GameData, dto: &PlayerDto, uid: u32, zone_buffs: Vec<Buff>, extra_buffs: Vec<Buff>) -> Result<Unit, String> {
    let mut equipment: Vec<(S, Option<Equipment>)> = DEFAULT_SLOTS.iter().map(|k| (s(k), None)).collect();
    for (k, v) in dto.equipment.iter() {
        let e = match v {
            Some(e) => Some(Equipment::new(data, &e.hrid, e.enhancement_level)?),
            None => None,
        };
        match equipment.iter_mut().find(|(kk, _)| &**kk == k.as_str()) {
            Some(slot) => slot.1 = e,
            None => equipment.push((s(k), e)),
        }
    }
    let totals = {
        let worn: Vec<&Equipment> = equipment.iter().filter_map(|(_, e)| e.as_ref()).collect();
        crate::generated::EQUIPMENT_COMBAT_STATS
            .iter()
            .map(|stat| {
                let mut sum = 0.0;
                for w in &worn {
                    sum += w.get_combat_stat(stat);
                }
                sum
            })
            .collect()
    };
    let part = PlayerPart { equipment, totals };

    let pouch = part.slot("/equipment_types/pouch");
    let food_slots = 1.0 + pouch.map(|p| p.get_combat_stat("foodSlots")).unwrap_or(0.0);
    let drink_slots = 1.0 + pouch.map(|p| p.get_combat_stat("drinkSlots")).unwrap_or(0.0);

    let mut u = Unit::blank(uid, true, s(&dto.hrid), UnitKind::Player(part));
    u.base = [
        dto.stamina_level,
        dto.intelligence_level,
        dto.attack_level,
        dto.melee_level,
        dto.defense_level,
        dto.ranged_level,
        dto.magic_level,
    ];
    let cons = |list: &[Option<crate::request::ConsumableDto>], slots: f64| -> Result<Vec<Option<Consumable>>, String> {
        list.iter()
            .enumerate()
            .map(|(i, c)| match c {
                Some(c) if (i as f64) < slots => Consumable::new(data, &c.hrid, Some(&c.triggers)).map(Some),
                _ => Ok(None),
            })
            .collect()
    };
    u.food = cons(&dto.food, food_slots)?;
    u.drinks = cons(&dto.drinks, drink_slots)?;
    let slots = &data.ability_slots;
    let int_level = dto.intelligence_level;
    u.abilities = dto
        .abilities
        .iter()
        .enumerate()
        .map(|(i, a)| match a {
            Some(a) if slots.is_empty() || int_level >= slots.get(i + 1).copied().unwrap_or(f64::INFINITY) => {
                Ability::new(data, &a.hrid, a.level.unwrap_or(1.0), Some(&a.triggers)).map(Some)
            }
            _ => Ok(None),
        })
        .collect::<Result<_, _>>()?;
    for (hrid, level) in dto.house_rooms.iter() {
        let level = value_num(level);
        if level > 0.0 {
            let room = data.house_rooms.get(hrid).ok_or_else(|| format!("No house room found for hrid: {hrid}"))?;
            let mut buffs = Vec::new();
            for b in room.action_buffs.iter().flatten() {
                buffs.push(Buff::leveled(b, level)?);
            }
            for b in room.global_buffs.iter().flatten() {
                buffs.push(Buff::leveled(b, level)?);
            }
            u.house_rooms.push((s(hrid), buffs));
        }
    }
    u.achievement_buffs = Some(achievement_buffs(data, &dto.achievements)?);
    u.debuff_on_level_gap = match &dto.debuff_on_level_gap {
        None => Gap::Undef,
        Some(Value::Null) => Gap::Null,
        Some(v) => Gap::Num(value_num(v)),
    };
    u.zone_buffs = zone_buffs;
    u.extra_buffs = extra_buffs;
    Ok(u)
}
