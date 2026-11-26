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

// A unit test, not tests/: an integration test rebuilds this cdylib with panic=unwind onto the same filename.
#[cfg(test)]
mod item_values_tests;
#[cfg(test)]
mod test_support;

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

/// Every item's seconds-to-acquire for one character, as cowstuff's `/api/value/market`
/// answers it: refined essence bootstraps, the full value pass, then coin 0.
/// `client`: actionDetailMap, itemDetailMap, enhancementLevelTotalBonusMultiplierTable;
/// `character`: the raw init_character_data; `overrides`: `{hrid: seconds}` essence overrides, or "".
pub fn item_values(client: &str, character: &str, overrides: &str) -> String {
    use mwi_econ::alchemy::{refined_essence_bootstraps, ALCHEMY_ESSENCE_BOOTSTRAP_SECONDS};
    use mwi_econ::{item_value::ItemValueCalculator, util::parse_essence_overrides, Gdc};
    use serde_json::{json, Map, Value};
    let (data, character) = match (serde_json::from_str::<Value>(client), serde_json::from_str::<Value>(character)) {
        (Ok(d), Ok(c)) => (d, c),
        (Err(e), _) | (_, Err(e)) => return err_json(&format!("item_values: {e}"), false, None),
    };
    let gdc = Gdc::new(std::sync::Arc::new(data), std::sync::Arc::new(character));
    let ov = parse_essence_overrides(Some(overrides));
    let (bootstraps, _) = refined_essence_bootstraps(&gdc, "default", ALCHEMY_ESSENCE_BOOTSTRAP_SECONDS, &ov);
    let mut values = Map::new();
    let mut calc = ItemValueCalculator::new(&gdc, Some(&bootstraps));
    // An input with no source counts 0 in the sum; leave such an item out (the UI's "unknown") rather than undervalue it.
    for row in calc.calculate_all_item_values() {
        let h = row["hrid"].as_str().unwrap_or("");
        if calc.recipe_is_complete(h) {
            values.insert(h.to_string(), row["value_seconds"].clone());
        }
    }
    values.insert("/items/coin".into(), json!(0.0));
    let name = gdc.character.get("character").and_then(|c| c.get("name")).cloned().unwrap_or_else(|| json!("Unknown"));
    json!({"character": name, "unit": "seconds", "values": values}).to_string()
}

/// cowstuff's `GET /api/enhance/character`: the EnhancementConfig read off the raw init_character_data.
/// `client` as `item_values`: the enhancing loadout's pieces are summed from their item stats.
pub fn enhance_config(client: &str, character: &str) -> String {
    use mwi_econ::{enhance_sim::EnhanceSim, Gdc};
    use serde_json::Value;
    let (data, character) = match (serde_json::from_str::<Value>(client), serde_json::from_str::<Value>(character)) {
        (Ok(d), Ok(c)) => (d, c),
        (Err(e), _) | (_, Err(e)) => return err_json(&format!("enhance_config: {e}"), false, None),
    };
    let gdc = Gdc::new(std::sync::Arc::new(data), std::sync::Arc::new(character));
    let market = std::collections::HashMap::new();
    serde_json::to_string(&EnhanceSim::new(&gdc, &market, false, None).config_from_character()).unwrap_or_default()
}

/// cowstuff's `POST /api/enhance/calculate` for one character, with no market (asks fall back
/// to vendor prices). `client` as `item_values`; `body` the request body as JSON text.
pub fn enhance_calculate(client: &str, character: &str, body: &str) -> String {
    use mwi_econ::{enhance_request, Gdc};
    use serde_json::{json, Value};
    let parsed = (serde_json::from_str::<Value>(client), serde_json::from_str::<Value>(character), serde_json::from_str::<Value>(body));
    let (data, character, body) = match parsed {
        (Ok(d), Ok(c), Ok(Value::Null)) => (d, c, json!({})),
        (Ok(d), Ok(c), Ok(b @ Value::Object(_))) => (d, c, b),
        (Err(e), _, _) | (_, Err(e), _) => return err_json(&format!("enhance_calculate: {e}"), false, None),
        _ => return err_json("invalid JSON body", false, None),
    };
    let gdc = Gdc::new(std::sync::Arc::new(data), std::sync::Arc::new(character));
    let market = std::collections::HashMap::new();
    match enhance_request::prepare(&gdc, &market, body, None).and_then(|p| enhance_request::calculate(&p)) {
        Ok(v) => v.to_string(),
        Err((_, msg)) => err_json(&msg, false, None),
    }
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
    #[derive(serde::Deserialize)]
    struct KindOnly {
        kind: String,
    }
    // A byte scan first, so a simulation request is not parsed twice.
    if let Some(k) = request.contains("_details\"").then(|| serde_json::from_str::<KindOnly>(request).ok()).flatten() {
        if k.kind == "player_details" || k.kind == "monster_details" {
            return details(data, &k.kind, request).map_err(twin_only);
        }
    }
    let req: Request = serde_json::from_str(request).map_err(|e| twin_only(format!("twin request: {e}")))?;
    // Zone and GuildTrial constructors throw in JS too, and draw nothing first.
    let at_start = |(m, r): (String, bool)| (m, r, Some(req.rng_state));
    let kind = req.kind.as_str();
    let lab = match (kind, &req.labyrinth) {
        ("labyrinth", Some(l)) => Some(l),
        ("labyrinth", None) => return Err(twin_only("twin: a labyrinth request needs `labyrinth`".into())),
        _ => None,
    };

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
    if zone.is_none() && trial_req.is_none() && lab.is_none() {
        return Err(twin_only(format!("twin: unknown request kind {kind:?}")));
    }
    if trial_req.is_none() && req.iterations.is_some() {
        return Err(twin_only("twin: `iterations` batches trial requests only".into()));
    }

    // `zone?.buffs || labyrinth?.buffs || []`; a Labyrinth's buffs are its crates' entries concatenated.
    let zone_buffs: Vec<Buff> = match (&zone, lab) {
        (Some(z), _) => z.buffs.map(|b| b.iter().map(Buff::raw).collect::<Result<_, _>>()).transpose().map_err(twin_only)?.unwrap_or_default(),
        (None, Some(l)) => {
            let mut v = Vec::new();
            for c in l.crates.iter().flatten() {
                let entry = data.labyrinth_crates.get(c).ok_or_else(|| twin_only(format!("twin: unknown labyrinth crate {c:?}")))?;
                let raws: Vec<data::RawBuff> = match entry {
                    serde_json::Value::Array(_) => serde_json::from_value(entry.clone()),
                    _ => serde_json::from_value(entry.clone()).map(|b| vec![b]),
                }
                .map_err(|e| twin_only(format!("twin: labyrinth crate {c:?}: {e}")))?;
                for b in &raws {
                    v.push(Buff::raw(b).map_err(twin_only)?);
                }
            }
            v
        }
        (None, None) => Vec::new(),
    };
    let party: Vec<Buff> = req.party_buffs.iter().map(Buff::raw).collect::<Result<_, _>>().map_err(twin_only)?;
    let random_start = match req.settings.monster_start_cooldown.as_str() {
        "half" => false,
        "random" => true,
        _ => lab.is_none(), // "auto": half in the labyrinth context, random in zone, dungeon and trial
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
        let lab_state = lab.map(|l| simulator::Lab::new(&l.labyrinth_hrid, l.room_level));
        let mut sim = Sim::new(data, players, zone.take(), trial, lab_state, Mulberry32::new(state), random_start);
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

/// `player_details`: each player as a zone run builds it at combat start (create_player with
/// the zone buffs and partyBuffs + its own extraBuffs, generatePermanentBuffs, reset(0)); with
/// `bare`, `createFromDTO(dto); updateCombatDetails()` only.
/// `monster_details`: `new Monster(hrid, tier, roomLevel); updateCombatDetails()`, plus its abilities.
/// Each entry is `{ok:true, hrid, <base>Level..., combatDetails[, abilities]}` or `{ok:false, error}`.
fn details(data: &GameData, kind: &str, request: &str) -> Result<String, String> {
    use sim_result::{combat_details_j, J};
    let req: request::DetailsReq = serde_json::from_str(request).map_err(|e| format!("twin request: {e}"))?;
    let raws = |v: &[data::RawBuff]| v.iter().map(Buff::raw).collect::<Result<Vec<_>, _>>();
    let (zone_buffs, party) = (raws(&req.zone_buffs)?, raws(&req.party_buffs)?);
    let unit_j = |u: &unit::Unit, extra: Vec<(String, J)>| {
        let mut o = vec![("ok".into(), J::Bool(true)), ("hrid".into(), J::Str(u.hrid.to_string()))];
        o.extend(unit::LEVEL_NAMES.iter().zip(u.base.iter()).map(|(k, x)| (format!("{k}Level"), J::Num(*x))));
        o.push(("combatDetails".into(), combat_details_j(&u.cd)));
        o.extend(extra);
        J::Obj(o)
    };
    let fail = |e: String| J::Obj(vec![("ok".into(), J::Bool(false)), ("error".into(), J::Str(e))]);
    let mut rng = Mulberry32::new(0); // reset(0) of a player draws nothing
    let out: Vec<J> = if kind == "player_details" {
        req.players
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let built = (|| {
                    let dto = <request::PlayerDto as serde::Deserialize>::deserialize(v).map_err(|e| format!("players[{i}]: {e}"))?;
                    let mut extra = party.clone();
                    // createFromDTO never read extraBuffs, so bare mode must not refuse on them.
                    if !req.bare {
                        for b in dto.extra_buffs.iter().flatten() {
                            extra.push(Buff::raw(b)?);
                        }
                    }
                    let mut u = player::create_player(data, &dto, (i + 1) as u32, zone_buffs.clone(), extra)?;
                    if req.bare {
                        u.update_combat_details();
                    } else {
                        u.generate_permanent_buffs();
                        u.reset(0.0, false, &mut rng);
                    }
                    Ok::<_, String>(u)
                })();
                built.map(|u| unit_j(&u, vec![])).unwrap_or_else(fail)
            })
            .collect()
    } else {
        let mut cache = monster::AbilityCache::default();
        req.monsters
            .iter()
            .map(|m| match monster::create_monster(data, &mut cache, &m.hrid, m.difficulty_tier, m.room_level, 1) {
                Ok(mut u) => {
                    u.update_combat_details();
                    let abilities = u.abilities.iter().flatten().map(|a| J::Obj(vec![("hrid".into(), J::Str(a.hrid.to_string())), ("level".into(), J::Num(a.level))])).collect();
                    unit_j(&u, vec![("abilities".into(), J::Arr(abilities))])
                }
                Err(e) => fail(e),
            })
            .collect()
    };
    let mut s = String::from("{\"ok\":true,\"units\":");
    J::Arr(out).write(&mut s);
    s.push('}');
    Ok(s)
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
