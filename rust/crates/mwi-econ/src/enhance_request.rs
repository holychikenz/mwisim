//! The `/api/enhance/calculate` and `/simulate` request handling (app.py:1560-1828), moved
//! from cowstuff's webapp-rs `routes_enhance` so the server and csim's wasm answer alike.
//! Errors are `(HTTP status, message)`; the server wraps them as `{"error": message}`.

use crate::Gdc;
use crate::alchemy::{ALCHEMY_ESSENCE_BOOTSTRAP_SECONDS, refined_essence_bootstraps};
use crate::enhance_sim::{EnhanceSim, EnhancementConfig, HRID_PHILOSOPHERS_MIRROR, item_level};
use crate::mt19937::Mt19937;
use crate::util::{os_seed, parse_essence_overrides, py_float, py_int, py_int_str, truthy};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::collections::HashMap;

pub type Error = (u16, String);

fn bad(msg: impl Into<String>) -> Error {
    (400, msg.into())
}

fn internal(msg: String) -> Error {
    (500, msg)
}

/// What calculate and simulate share: the parsed body, mode, Iron Cow bootstraps,
/// config and the item hrid, checked in Flask's order.
pub struct Prepared<'a> {
    pub gdc: &'a Gdc,
    pub market: &'a HashMap<String, f64>,
    pub body: Value,
    pub iron_cow: bool,
    pub bootstraps: Option<IndexMap<String, f64>>,
    pub cfg: EnhancementConfig,
    pub item_hrid: String,
}

/// `body` is the parsed JSON object (the caller maps a null body to `{}` and rejects
/// anything else); `query_overrides` is the `essence_overrides` query parameter, if any.
pub fn prepare<'a>(
    gdc: &'a Gdc,
    market: &'a HashMap<String, f64>,
    body: Value,
    query_overrides: Option<&str>,
) -> Result<Prepared<'a>, Error> {
    let iron_cow = truthy(body.get("iron_cow").unwrap_or(&Value::Bool(false)));
    // Iron Cow prices are seconds: hand the simulator the refined essence bootstraps plus
    // the client's overrides (query string first, then the JSON body, as Flask).
    let bootstraps = iron_cow.then(|| {
        let raw = query_overrides.map(str::to_string).or_else(|| match body.get("essence_overrides") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(v @ Value::Object(_)) => Some(v.to_string()),
            _ => None,
        });
        let overrides = parse_essence_overrides(raw.as_deref());
        refined_essence_bootstraps(gdc, "default", ALCHEMY_ESSENCE_BOOTSTRAP_SECONDS, &overrides).0
    });
    let cfg = EnhancementConfig::from_json(body.get("config").unwrap_or(&json!({}))).map_err(bad)?;
    let item_hrid = match body.get("item_hrid") {
        Some(Value::String(h)) if !h.is_empty() && gdc.get_item(h).is_some() => h.clone(),
        _ => return Err(bad("unknown item_hrid")),
    };
    Ok(Prepared { gdc, market, body, iron_cow, bootstraps, cfg, item_hrid })
}

/// Python `int(body.get(key, default))`; Err (400) where Python would raise.
fn body_int(body: &Value, key: &str, default: i64) -> Result<i64, Error> {
    match body.get(key) {
        None => Ok(default),
        Some(v @ (Value::Number(_) | Value::Bool(_))) => Ok(py_int(v)),
        Some(Value::String(s)) => py_int_str(s).ok_or_else(|| bad(format!("invalid {key}"))),
        Some(_) => Err(bad(format!("invalid {key}"))),
    }
}

/// `body.get(key)`, where None or `''` means "derive it", else `float(...)`.
fn body_price(body: &Value, key: &str) -> Result<Option<f64>, Error> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(v) => py_float(v).map(Some).ok_or_else(|| bad(format!("invalid {key}"))),
    }
}

/// `[float(x) for x in body['material_unit_costs']]`, None when absent or null.
fn body_unit_costs(body: &Value) -> Result<Option<Vec<f64>>, Error> {
    match body.get("material_unit_costs") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) => a.iter().map(py_float).collect::<Option<Vec<_>>>().map(Some).ok_or_else(|| bad("invalid material_unit_costs")),
        Some(_) => Err(bad("invalid material_unit_costs")),
    }
}

fn decomp_catalyst(body: &Value) -> &str {
    body.get("decomp_catalyst").and_then(Value::as_str).unwrap_or("none")
}

/// Markov solution for every protect_at in [min(2,target)..target], plus the mirror plan and decomposition value.
pub fn calculate(p: &Prepared) -> Result<Value, Error> {
    let gdc = p.gdc;
    let (body, cfg) = (&p.body, &p.cfg);
    let item = gdc.get_item(&p.item_hrid).ok_or_else(|| bad("unknown item_hrid"))?;
    let mut sim = EnhanceSim::new(gdc, p.market, p.iron_cow, p.bootstraps.clone());
    let target = body_int(body, "target", 10)?.clamp(1, 20) as usize;

    let protect_price = match body_price(body, "protect_price")? {
        Some(v) => v,
        None => match body.get("protect_hrid").filter(|h| truthy(h)) {
            Some(h) => sim.full_item_price(h.as_str().unwrap_or("")),
            None => sim.cheapest_protection(item),
        },
    };
    let mirror_price = match body_price(body, "mirror_price")? {
        Some(v) => v,
        None => sim.full_item_price(HRID_PHILOSOPHERS_MIRROR),
    };
    let base_price = match body_price(body, "base_price")? {
        Some(v) => v,
        None => sim.full_item_price(item["hrid"].as_str().unwrap_or("")),
    };
    let unit_costs = match body_unit_costs(body)? {
        Some(v) => v,
        None => item["enhancementCosts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(|c| c.get("itemHrid").and_then(Value::as_str).filter(|h| *h != "/items/coin"))
            .map(|h| sim.full_item_price(h))
            .collect(),
    };

    let mut rows = Vec::new();
    let (mut min_mat, mut min_ttl) = (f64::INFINITY, f64::INFINITY);
    // target 1 has nowhere to fall back to, so its single row protects at 1.
    for prot in target.min(2)..=target {
        let mut o = sim.expected_outcome(cfg, item, target, prot as i64).map_err(internal)?;
        sim.attach_costs(&mut o, item, cfg, protect_price, base_price, Some(&unit_costs));
        let mut row = serde_json::to_value(&o).unwrap_or_default();
        let exp_per_hour =
            if o.actions > 0.0 && o.attempt_time > 0.0 { o.xp / (o.attempt_time * o.actions / 3600.0) } else { 0.0 };
        row["protect_at"] = json!(prot);
        row["exp_per_hour"] = json!(exp_per_hour);
        row["gold_per_xp"] = json!(if o.xp > 0.0 { o.mat_cost / o.xp } else { 0.0 });
        row["time_seconds"] = json!(o.attempt_time * o.actions);
        rows.push((row, o.mat_cost, o.total_cost));
        min_mat = if o.mat_cost < min_mat { o.mat_cost } else { min_mat };
        min_ttl = if o.total_cost < min_ttl { o.total_cost } else { min_ttl };
    }
    // Python's min(): the first row wins unless a later one is strictly lower (rows is never empty).
    let mut best = 0;
    for (i, r) in rows.iter().enumerate() {
        if r.2 < rows[best].2 {
            best = i;
        }
    }
    let optimal_prot = rows[best].0["protect_at"].clone();
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|(mut row, mat, ttl)| {
            row["is_min_mat"] = json!(mat == min_mat);
            row["is_min_total"] = json!(ttl == min_ttl);
            row
        })
        .collect();

    let mirror = sim.mirror_plan(cfg, item, target, protect_price, base_price, Some(&unit_costs), mirror_price).map_err(internal)?;
    let il = item_level(item);
    let decomp = sim.decomposition_value(il, target, decomp_catalyst(body));
    let or_empty = |k: &str| if truthy(&item[k]) { item[k].clone() } else { json!([]) };
    Ok(json!({
        "attempt_time": sim.compute_attempt_time(cfg, il),
        "total_bonus": sim.compute_total_bonus(cfg, il),
        "rows": rows,
        "mirror": mirror,
        "decomp": decomp,
        "optimal_prot": optimal_prot,
        "protect_price": protect_price,
        "mirror_price": mirror_price,
        "base_price": base_price,
        "material_unit_costs": unit_costs,
        "enhancement_costs": or_empty("enhancementCosts"),
        "protection_item_hrids": or_empty("protectionItemHrids"),
        "iron_cow": p.iron_cow,
    }))
}

/// Monte Carlo distribution at a fixed (target, protect_at); unseeded unless `seed` is sent.
pub fn simulate(p: &Prepared) -> Result<Value, Error> {
    let gdc = p.gdc;
    let (body, cfg) = (&p.body, &p.cfg);
    let item = gdc.get_item(&p.item_hrid).ok_or_else(|| bad("unknown item_hrid"))?;
    let mut sim = EnhanceSim::new(gdc, p.market, p.iron_cow, p.bootstraps.clone());

    let target = body_int(body, "target", 10)?.clamp(1, 20);
    let protect_at = body_int(body, "protect_at", 2)?.clamp(0, target);
    let n = body_int(body, "n", 32768)?.clamp(1, 200_000) as usize;
    let money = body.get("money_i_have").filter(|v| truthy(v));
    let money_i_have = match money {
        Some(v) => py_float(v).ok_or_else(|| bad("invalid money_i_have"))?,
        None => 0.0,
    };
    let mut rng = match body.get("seed") {
        None | Some(Value::Null) => Mt19937::new(os_seed() as i128),
        Some(Value::String(s)) => Mt19937::from_decimal(s).ok_or_else(|| bad("invalid seed"))?,
        // shortcut: a float truncates as int() only within i64, and a JSON integer above u64 reaches
        // serde_json as a float; send such seeds as strings (exact at any size).
        Some(v @ Value::Number(n)) => Mt19937::new(n.as_i128().unwrap_or_else(|| py_int(v) as i128)),
        Some(_) => return Err(bad("invalid seed")),
    };
    let protect_price = body_price(body, "protect_price")?;
    let base_price = body_price(body, "base_price")?;
    let unit_costs = body_unit_costs(body)?;

    let result = sim
        .monte_carlo(cfg, item, target as usize, protect_at, n, unit_costs.as_deref(), protect_price, base_price, money_i_have, &mut rng)
        .map_err(internal)?;

    let mut payload = serde_json::to_value(&result).unwrap_or_default();
    payload["target"] = json!(target);
    payload["protect_at"] = json!(protect_at);
    payload["enhancement_costs"] = if truthy(&item["enhancementCosts"]) { item["enhancementCosts"].clone() } else { json!([]) };
    payload["decomp"] = sim.decomposition_value(item_level(item), target as usize, decomp_catalyst(body));
    payload["iron_cow"] = json!(p.iron_cow);
    Ok(payload)
}
