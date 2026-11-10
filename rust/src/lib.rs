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

/// An error, and the random stream it leaves: `Some(state)` when the JS engine throws at
/// the same point after the same draws, `None` when agreement is not proven (a refusal
/// only the twin makes), which shared/twinEngine.js turns into a dead seeded stream.
type Fail = (String, bool, Option<u32>);

/// `range` makes a RangeError; an engine message spelled "TypeError: …" (as JS would
/// throw it natively) a TypeError; anything else an Error.
fn err_json(msg: &str, range: bool, rng_state: Option<u32>) -> String {
    let (kind, msg) = match msg.strip_prefix("TypeError: ") {
        _ if range => ("RangeError", msg),
        Some(m) => ("TypeError", m),
        None => ("Error", msg),
    };
    format!(
        "{{\"ok\":false,\"error\":{},\"errorKind\":\"{kind}\"{}}}",
        serde_json::to_string(msg).unwrap_or_else(|_| "\"error\"".into()),
        rng_state.map(|s| format!(",\"rngState\":{s}")).unwrap_or_default()
    )
}

/// Run one request. Never panics on bad input: errors come back as `ok: false`.
/// `progress` gets the JS "progress" event's fraction every 1000 ticks; for a batch
/// (`iterations`) it gets the number of iterations completed instead.
pub fn run(data: &GameData, request: &str, progress: Option<&mut dyn FnMut(f64)>) -> String {
    match run_inner(data, request, progress) {
        Ok(s) => s,
        Err((msg, range, rng)) => err_json(&msg, range, rng),
    }
}

fn run_inner(data: &GameData, request: &str, mut progress: Option<&mut dyn FnMut(f64)>) -> Result<String, Fail> {
    // Request shape, kind and buff strictness are the twin's own refusals: JS would have run.
    let twin_only = |m: String| (m, false, None);
    let req: Request = serde_json::from_str(request).map_err(|e| twin_only(format!("twin request: {e}")))?;
    // Zone and GuildTrial constructors throw in JS too, and draw nothing first.
    let at_start = |(m, r): (String, bool)| (m, r, Some(req.rng_state));
    let kind = req.kind.as_str();
    if kind == "labyrinth" {
        return Err(twin_only("twin: labyrinth is not ported (Phase 3)".into()));
    }

    let zone = match (kind, &req.zone) {
        ("zone", Some(z)) => Some(Zone::new(data, &z.zone_hrid, z.difficulty_tier).map_err(|m| at_start((m, false)))?),
        ("zone", None) => return Err(twin_only("twin: a zone request needs `zone`".into())),
        _ => None,
    };
    let trial_req = match (kind, &req.guild_trial) {
        ("trial", Some(t)) => Some(t),
        ("trial", None) => return Err(twin_only("twin: a trial request needs `guildTrial`".into())),
        _ => None,
    };
    if zone.is_none() && trial_req.is_none() {
        return Err(twin_only(format!("twin: unknown request kind {kind:?}")));
    }
    if trial_req.is_none() && req.iterations.is_some() {
        return Err(twin_only("twin: `iterations` batches trial requests only".into()));
    }

    let zone_buffs: Vec<Buff> = match &zone {
        Some(z) => z.buffs.map(|b| b.iter().map(Buff::raw).collect::<Result<_, _>>()).transpose().map_err(twin_only)?.unwrap_or_default(),
        None => Vec::new(),
    };
    let party: Vec<Buff> = req.party_buffs.iter().map(Buff::raw).collect::<Result<_, _>>().map_err(twin_only)?;
    let random_start = match req.settings.monster_start_cooldown.as_str() {
        "half" => false,
        "random" => true,
        _ => true, // "auto": zone, dungeon and trial context
    };
    let limit = if trial_req.is_some() { TRIAL_DURATION_NS } else { req.simulation_time_limit.unwrap_or(f64::NAN) };
    let run_limits = match &req.run_limits {
        None => None,
        Some(r) => Some((r.max_runs.as_f64().unwrap_or(f64::NAN), r.max_run_duration_ns)),
    };

    // A batch runs the trial `iterations` times on one stream, rebuilding everything per
    // iteration as shared/guildTrialRuns.js does; a single request is one pass.
    let batch = req.iterations.is_some();
    let mut zone = zone;
    let mut state = req.rng_state;
    let mut results = Vec::new();
    let mut trace_out = None;
    for it in 0..req.iterations.unwrap_or(1) {
        let trial = match trial_req {
            Some(t) => Some(GuildTrial::new(data, t).map_err(|(m, r)| (m, r, Some(state)))?),
            None => None,
        };
        let mut players = Vec::new();
        for (i, dto) in req.players.iter().enumerate() {
            let mut extra = party.clone();
            for b in dto.extra_buffs.iter().flatten() {
                extra.push(Buff::raw(b).map_err(twin_only)?);
            }
            // Not proven: createFromDTO throws on the same bad hrids before any draw, but a slot
            // DTO the twin cannot deserialize is a twin-only refusal; the two share this path.
            players.push(player::create_player(data, dto, (i + 1) as u32, zone_buffs.clone(), extra).map_err(twin_only)?);
        }
        let mut sim = Sim::new(data, players, zone.take(), trial, Mulberry32::new(state), random_start);
        sim.trace = req.trace.as_ref().map(|t| TraceCfg { from: t.from, to: t.to, deep: t.deep });
        let has_progress = progress.is_some();
        let mut beat = |f: f64| {
            if let Some(p) = progress.as_mut() {
                p(if batch { it as f64 } else { f });
            }
        };
        // Mid-run errors keep the draws made so far, as the JS throw does.
        if let Err((m, r)) = sim.simulate(limit, run_limits, if has_progress { Some(&mut beat) } else { None }) {
            return Err((m, r, Some(sim.rng.a)));
        }
        state = sim.rng.a;
        results.push(sim.sim_result.to_json());
        if sim.trace.is_some() {
            trace_out = Some(sim.trace_out.join(","));
        }
        if batch {
            if let Some(p) = progress.as_mut() {
                p((it + 1) as f64);
            }
        }
    }

    let mut out = String::with_capacity(4096);
    out.push_str("{\"ok\":true,\"rngState\":");
    out.push_str(&state.to_string());
    if let Some(t) = trace_out {
        out.push_str(",\"trace\":[");
        out.push_str(&t);
        out.push(']');
    }
    if batch {
        out.push_str(",\"simResults\":[");
        out.push_str(&results.join(","));
        out.push(']');
    } else {
        out.push_str(",\"simResult\":");
        out.push_str(&results[0]);
    }
    out.push('}');
    Ok(out)
}

/// Parity probes for `twin:check selftest`. Input:
/// `{"seed":u32,"draws":n,"pow":[x...],"numbers":["literal"...],"toNumber":[v...]}`; output is the
/// draws, `pow(x, 1.4)` per x, each literal as serde_json parses it (H1), and `js::number(v)`
/// per JSON value as f64 bits in a decimal string (NaN, Infinity and -0 survive).
pub fn selftest(input: &str) -> String {
    #[derive(serde::Deserialize)]
    struct In {
        seed: u32,
        draws: usize,
        pow: Vec<f64>,
        /// Numeric literals exactly as they appear in the data files.
        numbers: Vec<String>,
        #[serde(default, rename = "toNumber")]
        to_number: Vec<serde_json::Value>,
    }
    let inp: In = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(er) => return err_json(&format!("selftest input: {er}"), false, None),
    };
    let mut r = Mulberry32::new(inp.seed);
    let draws: Vec<f64> = (0..inp.draws).map(|_| r.next_f64()).collect();
    let pows: Vec<f64> = inp.pow.iter().map(|x| js::pow(*x, 1.4)).collect();
    let numbers: Vec<Option<f64>> = inp.numbers.iter().map(|lit| serde_json::from_str::<f64>(lit).ok()).collect();
    let to_number: Vec<String> = inp.to_number.iter().map(|v| js::number(v).to_bits().to_string()).collect();
    serde_json::json!({ "ok": true, "rng": draws, "pow": pows, "numbers": numbers, "toNumber": to_number }).to_string()
}
