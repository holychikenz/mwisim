//! csim-native: the native twin.
//!   csim-native serve --data <dir>            line-framed stdio server: "<id> <json>\n" in, "<id> <json>\n" out,
//!                                             with "<id> ~progress <x>\n" heartbeats while a request runs
//!   csim-native run --data <dir> <request>    one request from a file ("-" for stdin)
//!   csim-native selftest                      one selftest request on stdin

use csim_twin::data::GameData;
use std::io::{BufRead, Read, Write};
use std::time::{Duration, Instant};

const HEARTBEAT: Duration = Duration::from_secs(1);

fn load(dir: &str) -> Result<GameData, String> {
    let mut text = String::from("{");
    for (i, name) in csim_twin::generated::TWIN_DATA_NAMES.iter().enumerate() {
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
                    // A malformed envelope reaches selftest() as "" and answers ok:false.
                    csim_twin::selftest(body.strip_prefix("{\"selftest\":").and_then(|b| b.strip_suffix('}')).unwrap_or(""))
                } else {
                    // Liveness for Node (api/lib/twin/native.mjs): "<id> ~progress <x>" at most once
                    // a second, plus every new whole number (a batch's completed iterations).
                    let (mut last_at, mut last_x) = (Instant::now(), f64::NEG_INFINITY);
                    let mut beat = |x: f64| {
                        if last_at.elapsed() >= HEARTBEAT || (x == x.trunc() && x > last_x) {
                            last_at = Instant::now();
                            last_x = x;
                            let mut o = stdout.lock();
                            let _ = writeln!(o, "{id} ~progress {x}").and_then(|_| o.flush());
                        }
                    };
                    csim_twin::run(&data, body, Some(&mut beat))
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
