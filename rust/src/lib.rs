//! csim-twin: a Rust port of src/combatsimulator/ that returns the same
//! `digest(canonical(SimResult))` as the JS engine for the same random stream.
//! One JSON request in, one JSON response out; see shared/twinEngine.js.

pub mod ability;
pub mod buff;
pub mod consumable;
pub mod data;
pub mod equipment;
pub mod events;
pub mod generated;
pub mod guild_trial;
pub mod heap;
pub mod js;
pub mod monster;
pub mod player;
pub mod request;
pub mod rng;
pub mod sim_result;
pub mod simulator;
pub mod trigger;
pub mod unit;
pub mod utilities;
pub mod zone;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

use buff::Buff;
use data::GameData;
use guild_trial::{GuildTrial, TRIAL_DURATION_NS};
use request::Request;
use rng::Mulberry32;
use simulator::{Sim, TraceCfg};
use zone::Zone;

fn err_json(msg: &str, range: bool) -> String {
    format!(
        "{{\"ok\":false,\"error\":{},\"errorKind\":\"{}\"}}",
        serde_json::to_string(msg).unwrap_or_else(|_| "\"error\"".into()),
        if range { "RangeError" } else { "Error" }
    )
}

/// Run one request. Never panics on bad input: errors come back as `ok: false`.
pub fn run(data: &GameData, request: &str) -> String {
    match run_inner(data, request) {
        Ok(s) => s,
        Err((msg, range)) => err_json(&msg, range),
    }
}

fn run_inner(data: &GameData, request: &str) -> Result<String, (String, bool)> {
    let req: Request = serde_json::from_str(request).map_err(|e| (format!("twin request: {e}"), false))?;
    let e = |m: String| (m, false);
    let kind = req.kind.as_str();
    if kind == "labyrinth" {
        return Err(e("twin: labyrinth is not ported (Phase 3)".into()));
    }

    let zone = match (kind, &req.zone) {
        ("zone", Some(z)) => Some(Zone::new(data, &z.zone_hrid, z.difficulty_tier).map_err(e)?),
        ("zone", None) => return Err(e("twin: a zone request needs `zone`".into())),
        _ => None,
    };
    let trial = match (kind, &req.guild_trial) {
        ("trial", Some(t)) => Some(GuildTrial::new(data, t)?),
        ("trial", None) => return Err(e("twin: a trial request needs `guildTrial`".into())),
        _ => None,
    };
    if zone.is_none() && trial.is_none() {
        return Err(e(format!("twin: unknown request kind {kind:?}")));
    }

    let zone_buffs: Vec<Buff> = match &zone {
        Some(z) => z.buffs.map(|b| b.iter().map(Buff::raw).collect::<Result<_, _>>()).transpose().map_err(e)?.unwrap_or_default(),
        None => Vec::new(),
    };
    let party: Vec<Buff> = req.party_buffs.iter().map(Buff::raw).collect::<Result<_, _>>().map_err(e)?;
    let mut players = Vec::new();
    for (i, dto) in req.players.iter().enumerate() {
        let mut extra = party.clone();
        for b in dto.extra_buffs.iter().flatten() {
            extra.push(Buff::raw(b).map_err(e)?);
        }
        players.push(player::create_player(data, dto, (i + 1) as u32, zone_buffs.clone(), extra).map_err(e)?);
    }

    let random_start = match req.settings.monster_start_cooldown.as_str() {
        "half" => false,
        "random" => true,
        _ => true, // "auto": zone, dungeon and trial context
    };
    let limit = if trial.is_some() { TRIAL_DURATION_NS } else { req.simulation_time_limit.unwrap_or(f64::NAN) };
    let run_limits = match &req.run_limits {
        None => None,
        Some(r) => Some((r.max_runs.as_f64().unwrap_or(f64::NAN), r.max_run_duration_ns)),
    };

    let mut sim = Sim::new(data, players, zone, trial, Mulberry32::new(req.rng_state), random_start);
    sim.trace = req.trace.as_ref().map(|t| TraceCfg { from: t.from, to: t.to, deep: t.deep });
    sim.simulate(limit, run_limits)?;

    let mut out = String::with_capacity(4096);
    out.push_str("{\"ok\":true,\"rngState\":");
    out.push_str(&sim.rng.a.to_string());
    if sim.trace.is_some() {
        out.push_str(",\"trace\":[");
        out.push_str(&sim.trace_out.join(","));
        out.push(']');
    }
    out.push_str(",\"simResult\":");
    out.push_str(&sim.sim_result.to_json());
    out.push('}');
    Ok(out)
}

/// Parity probes for `twin:check selftest`. Input:
/// `{"seed":u32,"draws":n,"pow":[x...],"numbers":["literal"...]}`; output is the
/// draws, `pow(x, 1.4)` per x, and each literal as serde_json parses it (H1).
pub fn selftest(input: &str) -> String {
    #[derive(serde::Deserialize)]
    struct In {
        seed: u32,
        draws: usize,
        pow: Vec<f64>,
        /// Numeric literals exactly as they appear in the data files.
        numbers: Vec<String>,
    }
    let inp: In = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(er) => return err_json(&format!("selftest input: {er}"), false),
    };
    let mut r = Mulberry32::new(inp.seed);
    let draws: Vec<f64> = (0..inp.draws).map(|_| r.next_f64()).collect();
    let pows: Vec<f64> = inp.pow.iter().map(|x| js::pow(*x, 1.4)).collect();
    let numbers: Vec<Option<f64>> = inp.numbers.iter().map(|lit| serde_json::from_str::<f64>(lit).ok()).collect();
    serde_json::json!({ "ok": true, "rng": draws, "pow": pows, "numbers": numbers }).to_string()
}
