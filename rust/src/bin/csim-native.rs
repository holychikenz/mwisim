//! csim-native: the native twin.
//!   csim-native serve --data <dir>            line-framed stdio server: "<id> <json>\n" in, "<id> <json>\n" out
//!   csim-native run --data <dir> <request>    one request from a file ("-" for stdin)
//!   csim-native selftest                      one selftest request on stdin

use csim_twin::data::GameData;
use std::io::{BufRead, Read, Write};

/// The data files the engine reads, keyed by base name (shared/twinEngine.js TWIN_DATA_NAMES).
const DATA_NAMES: &[&str] = &[
    "abilityDetailMap",
    "abilitySlotsLevelRequirementList",
    "achievementDetailMap",
    "achievementTierDetailMap",
    "actionDetailMap",
    "combatMonsterDetailMap",
    "combatStyleDetailMap",
    "combatTriggerDependencyDetailMap",
    "enhancementLevelTotalBonusMultiplierTable",
    "guildTrialDetailMap",
    "houseRoomDetailMap",
    "itemDetailMap",
    "labyrinthCrateDetailMap",
];

fn load(dir: &str) -> Result<GameData, String> {
    let mut text = String::from("{");
    for (i, name) in DATA_NAMES.iter().enumerate() {
        let path = format!("{dir}/{name}.json");
        let body = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
        if i > 0 {
            text.push(',');
        }
        text.push_str(&format!("\"{name}\":"));
        text.push_str(&body);
    }
    text.push('}');
    GameData::from_json(&text)
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    match cmd {
        "selftest" => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).ok();
            println!("{}", csim_twin::selftest(&s));
        }
        "run" | "serve" => {
            let dir = arg(&args, "--data").unwrap_or_else(|| "src/combatsimulator/data".into());
            let data = match load(&dir) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("csim-native: {e}");
                    std::process::exit(2);
                }
            };
            if cmd == "run" {
                let file = args.last().cloned().unwrap_or_else(|| "-".into());
                let mut s = String::new();
                if file == "-" {
                    std::io::stdin().read_to_string(&mut s).ok();
                } else {
                    s = std::fs::read_to_string(&file).unwrap_or_default();
                }
                println!("{}", csim_twin::run(&data, &s, None));
                return;
            }
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if line.is_empty() {
                    continue;
                }
                let (id, body) = line.split_once(' ').unwrap_or((line.as_str(), ""));
                let out = if body.starts_with("{\"selftest\"") {
                    csim_twin::selftest(&body[12..body.len() - 1])
                } else {
                    csim_twin::run(&data, body, None)
                };
                let mut o = stdout.lock();
                if writeln!(o, "{id} {out}").and_then(|_| o.flush()).is_err() {
                    break;
                }
            }
        }
        _ => {
            eprintln!("usage: csim-native serve --data <dir> | run --data <dir> <request.json> | selftest");
            std::process::exit(2);
        }
    }
}
