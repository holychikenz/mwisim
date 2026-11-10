//! player.js createFromDTO, houseRoom.js, achievement.js (H13, H16).

use crate::ability::Ability;
use crate::buff::Buff;
use crate::consumable::Consumable;
use crate::data::GameData;
use crate::equipment::Equipment;
use crate::js::{s, truthy, S};
use crate::request::{AbilityDto, ConsumableDto, PlayerDto};
use serde::Deserialize;
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
        Value::Number(_) | Value::String(_) => crate::js::number(v) == 0.0,
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
    let cons = |list: &[Value], slots: f64, what: &str| -> Result<Vec<Option<Consumable>>, String> {
        list.iter()
            .enumerate()
            .map(|(i, v)| {
                if !(value_truthy(v) && (i as f64) < slots) {
                    return Ok(None);
                }
                let c = ConsumableDto::deserialize(v).map_err(|e| format!("{what}[{i}]: {e}"))?;
                Consumable::new(data, &c.hrid, Some(&c.triggers)).map(Some)
            })
            .collect()
    };
    u.food = cons(&dto.food, food_slots, "food")?;
    u.drinks = cons(&dto.drinks, drink_slots, "drinks")?;
    let slots = &data.ability_slots;
    let int_level = dto.intelligence_level;
    u.abilities = dto
        .abilities
        .iter()
        .enumerate()
        .map(|(i, v)| {
            if !(value_truthy(v) && (slots.is_empty() || int_level >= slots.get(i + 1).copied().unwrap_or(f64::INFINITY))) {
                return Ok(None);
            }
            let a = AbilityDto::deserialize(v).map_err(|e| format!("abilities[{i}]: {e}"))?;
            Ability::new(data, &a.hrid, a.level, Some(&a.triggers)).map(Some)
        })
        .collect::<Result<_, _>>()?;
    for (hrid, level) in dto.house_rooms.iter() {
        let level = crate::js::number(level);
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
    u.achievement_buffs = Some(match &dto.achievements {
        Value::Object(m) => achievement_buffs(data, m)?,
        Value::Null => return Err("TypeError: Cannot read properties of null (achievements)".into()),
        // An array, string, number or boolean has no hrid keys in JS: nothing is held.
        _ => achievement_buffs(data, &serde_json::Map::new())?,
    });
    u.debuff_on_level_gap = match &dto.debuff_on_level_gap {
        None => Gap::Undef,
        Some(Value::Null) => Gap::Null,
        Some(v) => Gap::Num(crate::js::number(v)),
    };
    u.zone_buffs = zone_buffs;
    u.extra_buffs = extra_buffs;
    Ok(u)
}
