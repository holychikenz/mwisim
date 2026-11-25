//! Shared helpers for the engine's unit tests: the bundled game data and the
//! api/bench/builds.mjs player DTOs (fixtures/twin/builds.json, toCsimPlayer at
//! level 1, index 1; regenerate it from builds.mjs if a build there is renamed).

use crate::buff::Buff;
use crate::data::GameData;
use crate::request::PlayerDto;
use crate::unit::Unit;
use crate::zone::Zone;
use serde_json::Value;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

pub fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{ROOT}/{rel}")).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// The game data exactly as csim-native loads it.
pub fn load_data() -> GameData {
    let parts: Vec<String> = crate::generated::TWIN_DATA_NAMES
        .iter()
        .map(|n| format!("\"{n}\":{}", read(&format!("src/combatsimulator/data/{n}.json"))))
        .collect();
    GameData::from_json(&format!("{{{}}}", parts.join(","))).expect("bundled game data")
}

/// One leaked copy per test thread: GameData holds `Rc`s, so it cannot be shared across threads.
pub fn data() -> &'static GameData {
    thread_local!(static D: &'static GameData = Box::leak(Box::new(load_data())));
    D.with(|d| *d)
}

/// A bench build's DTO as JSON, at `level` in every skill, named `player<index>`.
pub fn dto_json(build: &str, level: f64, index: u32) -> Value {
    let all: Value = serde_json::from_str(&read("fixtures/twin/builds.json")).expect("builds.json");
    let mut d = all.get(build).unwrap_or_else(|| panic!("no build {build}")).clone();
    d["hrid"] = format!("player{index}").into();
    for k in ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"] {
        d[format!("{k}Level")] = level.into();
    }
    d
}

pub fn player_from(d: &GameData, dto: &Value, index: u32, zone_buffs: Vec<Buff>) -> Unit {
    let dto: PlayerDto = serde_json::from_value(dto.clone()).expect("player DTO");
    crate::player::create_player(d, &dto, index, zone_buffs, Vec::new()).expect("create_player")
}

pub fn player(build: &str, level: f64, index: u32, zone_buffs: Vec<Buff>) -> Unit {
    player_from(data(), &dto_json(build, level, index), index, zone_buffs)
}

pub fn zone_buffs(z: &Zone) -> Vec<Buff> {
    z.buffs.map(|b| b.iter().map(|r| Buff::raw(r).expect("zone buff")).collect()).unwrap_or_default()
}
