//! `cow/transmutation.py`: catalysts, the transmute StateMachine, decompose helpers (WP1).

use crate::Gdc;
use crate::util::{child, from_hrid, py_float, py_round, to_hrid, truthy};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Catalyst {
    Default,
    Transmutation,
    Prime,
}

impl Catalyst {
    pub fn value(self) -> f64 {
        match self {
            Catalyst::Default => 1.0,
            Catalyst::Transmutation => 1.15,
            Catalyst::Prime => 1.25,
        }
    }
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(default)
}

/// `p = min(1, base * (catalyst + bonus - 1))`; `bonus` is `1 + ratio_boost`.
pub fn transmute_success(alc: &Value, catalyst: Catalyst, bonus: f64) -> f64 {
    (num(alc, "transmuteSuccessRate", 0.5) * (catalyst.value() + bonus - 1.0)).min(1.0)
}

/// Expected items of one drop-table entry per transmuted item at success rate `p`.
fn drop_yield(p: f64, v: &Value) -> f64 {
    p * (num(v, "dropRate", 0.0) * (num(v, "minCount", 1.0) + num(v, "maxCount", 1.0)) / 2.0)
}

pub struct StateMachine<'a> {
    pub gdc: &'a Gdc,
    pub state: IndexMap<String, f64>,
    pub keep: Vec<String>,
    /// Some(set): only these are transmuted (Python's truthy `retry`, or `{None}` = nothing).
    pub retry: Option<BTreeSet<String>>,
    pub cats: HashMap<String, Catalyst>,
    pub default_cat: Catalyst,
    pub depth: f64,
    pub cat_counts: IndexMap<Catalyst, f64>,
    pub transmuted: IndexMap<(String, Catalyst), f64>,
    pub bonus: f64,
    pub warnings: Vec<String>,
}

impl<'a> StateMachine<'a> {
    pub fn new(
        gdc: &'a Gdc,
        state: IndexMap<String, f64>,
        bonus: f64,
        keep: &[String],
        retry: &[String],
        cats: &[(String, Catalyst)],
        default_cat: Catalyst,
    ) -> Self {
        let retry: BTreeSet<String> = retry.iter().map(|k| to_hrid(k)).collect();
        StateMachine {
            gdc,
            state,
            keep: keep.iter().map(|k| to_hrid(k)).collect(),
            retry: (!retry.is_empty()).then_some(retry),
            cats: cats.iter().map(|(k, c)| (to_hrid(k), *c)).collect(),
            default_cat,
            depth: 0.0,
            cat_counts: IndexMap::new(),
            transmuted: IndexMap::new(),
            bonus,
            warnings: Vec::new(),
        }
    }

    fn should_transmute(&self, item: &str, has_table: bool) -> bool {
        if !has_table {
            return false;
        }
        match &self.retry {
            Some(r) => r.contains(item),
            None => !self.keep.iter().any(|k| k == item),
        }
    }

    pub fn step(&mut self) {
        let mut new_state: IndexMap<String, f64> = IndexMap::new();
        let state = std::mem::take(&mut self.state);
        for (item, count) in state {
            let Some(info) = self.gdc.get_item(&item) else {
                *new_state.entry(item.clone()).or_insert(0.0) += count;
                self.warnings.push(format!("Unknown item in game data: {item}"));
                continue;
            };
            let alc = child(info, "alchemyDetail");
            let ttable = alc.get("transmuteDropTable").filter(|t| !t.is_null());
            let cat = self.cats.get(&item).copied().unwrap_or(self.default_cat);
            let p = transmute_success(alc, cat, self.bonus);
            if !self.should_transmute(&item, ttable.is_some()) {
                *new_state.entry(item).or_insert(0.0) += count;
                continue;
            }
            for v in arr(ttable.unwrap_or(&Value::Null)) {
                let k = v["itemHrid"].as_str().unwrap_or("").to_string();
                *new_state.entry(k).or_insert(0.0) += drop_yield(p, v) * count;
            }
            self.depth += count;
            *self.cat_counts.entry(cat).or_insert(0.0) += count * p;
            *self.transmuted.entry((item, cat)).or_insert(0.0) += count;
        }
        self.state = new_state;
    }

    pub fn run(&mut self, steps: usize) -> &IndexMap<String, f64> {
        for _ in 0..steps {
            self.step();
        }
        self.state.retain(|_, v| *v > 1e-6);
        let mut seen = BTreeSet::new();
        self.warnings.retain(|w| seen.insert(w.clone()));
        &self.state
    }
}

/// Has a transmute table, a non-zero success rate, and is within the alchemy level.
fn can_transmute(info: &Value, max_item_level: Option<f64>) -> bool {
    let alc = child(info, "alchemyDetail");
    truthy(child(alc, "transmuteDropTable"))
        && num(alc, "transmuteSuccessRate", 0.0) > 0.0
        && max_item_level.is_none_or(|m| num(info, "itemLevel", 0.0) <= m)
}

/// `_transmute_reachable`: transmutable items whose cascade can reach the target.
fn transmute_reachable(target: &str, items: &Map<String, Value>, max_item_level: Option<f64>) -> BTreeSet<String> {
    let mut feeds: HashMap<&str, Vec<&str>> = HashMap::new();
    for (k, info) in items {
        if can_transmute(info, max_item_level) {
            for v in arr(&info["alchemyDetail"]["transmuteDropTable"]) {
                feeds.entry(v["itemHrid"].as_str().unwrap_or("")).or_default().push(k);
            }
        }
    }
    let mut reachable = BTreeSet::new();
    let mut frontier = vec![target.to_string()];
    while let Some(h) = frontier.pop() {
        for k in feeds.get(h.as_str()).into_iter().flatten() {
            if *k != target && reachable.insert(k.to_string()) {
                frontier.push(k.to_string());
            }
        }
    }
    reachable
}

/// One reverse-transmute route (a `transmute_sources` dict plus the pricing fields).
#[derive(Clone, Debug)]
pub struct Route {
    pub hrid: String,
    pub target_per_input: f64,
    pub settled: bool,
    pub actions: f64,
    pub cat_counts: IndexMap<Catalyst, f64>,
    pub transmuted: IndexMap<(String, Catalyst), f64>,
    pub input_seconds: f64,
    pub process_seconds: f64,
    pub seconds_per_target: f64,
}

fn items_map(gdc: &Gdc) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    gdc.data.get("itemDetailMap").and_then(Value::as_object).unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

fn bulk_of(items: &Map<String, Value>, h: &str) -> f64 {
    decompose_bulk_multiplier(items.get(h).unwrap_or(&Value::Null))
}

/// `transmute_sources`: every item whose cascade yields the target (sorted by hrid).
#[allow(clippy::too_many_arguments)]
pub fn transmute_sources(
    gdc: &Gdc,
    target: &str,
    bonus: f64,
    catalyst: Catalyst,
    retry_catalyst: Catalyst,
    max_steps: usize,
    retry: Option<&BTreeSet<String>>,
    max_item_level: Option<f64>,
) -> Vec<Route> {
    let items = items_map(gdc);
    let reachable = transmute_reachable(target, items, max_item_level);
    let retry: BTreeSet<String> = match retry {
        None => reachable.clone(),
        Some(r) => r.intersection(&reachable).cloned().collect(),
    };
    let mut out = Vec::new();
    for k in &reachable {
        let mut first_retry: Vec<String> = retry.iter().cloned().collect();
        first_retry.push(k.clone());
        let mut sm = StateMachine::new(
            gdc,
            IndexMap::from([(k.clone(), 1.0)]),
            bonus,
            &[],
            &first_retry,
            &[(k.clone(), catalyst)],
            retry_catalyst,
        );
        sm.step();
        sm.cats.clear(); // opening batch done: self-drops of k are re-transmutes too
        sm.retry = Some(retry.clone()); // empty = transmute nothing (Python's `{None}`)
        let pending = |sm: &StateMachine| sm.state.iter().filter(|(h, _)| retry.contains(*h)).fold(0.0, |a, (_, v)| a + v);
        for _ in 0..max_steps.saturating_sub(1) {
            if pending(&sm) < 1e-6 {
                break;
            }
            sm.step();
        }
        let y = sm.state.get(target).copied().unwrap_or(0.0);
        if y > 1e-6 {
            let mut cat_counts: IndexMap<Catalyst, f64> = IndexMap::new();
            for ((h, cat), n) in &sm.transmuted {
                let p = transmute_success(&items[h.as_str()]["alchemyDetail"], *cat, bonus);
                *cat_counts.entry(*cat).or_insert(0.0) += n * p / bulk_of(items, h);
            }
            let actions = sm.transmuted.iter().fold(0.0, |a, ((h, _), n)| a + n / bulk_of(items, h));
            out.push(Route {
                hrid: k.clone(),
                target_per_input: y,
                settled: pending(&sm) < 1e-6,
                actions,
                cat_counts,
                transmuted: sm.transmuted,
                input_seconds: 0.0,
                process_seconds: 0.0,
                seconds_per_target: 0.0,
            });
        }
    }
    out
}

/// `profitable_retries`: by-products worth re-transmuting when a target is worth
/// `target_seconds` (value iteration). Iterates in sorted hrid order (Python: set order).
#[allow(clippy::too_many_arguments)]
pub fn profitable_retries(
    gdc: &Gdc,
    target: &str,
    target_seconds: f64,
    bonus: f64,
    retry_catalyst: Catalyst,
    action_seconds: &dyn Fn(&str) -> f64,
    catalyst_seconds: &dyn Fn(Catalyst) -> f64,
    max_item_level: Option<f64>,
) -> BTreeSet<String> {
    let items = items_map(gdc);
    let usable = transmute_reachable(target, items, max_item_level);
    let mut gain: HashMap<&str, Vec<(&str, f64)>> = HashMap::new();
    let mut cost: HashMap<&str, f64> = HashMap::new();
    for b in &usable {
        let alc = &items[b.as_str()]["alchemyDetail"];
        let p = transmute_success(alc, retry_catalyst, bonus);
        // Python: `p * dropRate * (min + max) / 2` (a different association from `drop_yield`).
        let w = |v: &Value| p * num(v, "dropRate", 0.0) * (num(v, "minCount", 1.0) + num(v, "maxCount", 1.0)) / 2.0;
        gain.insert(b, arr(&alc["transmuteDropTable"]).iter().map(|v| (v["itemHrid"].as_str().unwrap_or(""), w(v))).collect());
        cost.insert(b, (action_seconds(b) + p * catalyst_seconds(retry_catalyst)) / bulk_of(items, b));
    }
    let mut values: HashMap<&str, f64> = HashMap::from([(target, target_seconds)]);
    for _ in 0..1000 {
        let mut delta: f64 = 0.0;
        for b in &usable {
            let total = gain[b.as_str()].iter().fold(0.0, |a, (o, w)| a + w * values.get(o).copied().unwrap_or(0.0));
            let v = (total - cost[b.as_str()]).max(0.0);
            delta = delta.max((v - values.get(b.as_str()).copied().unwrap_or(0.0)).abs());
            values.insert(b, v);
        }
        if delta <= 1e-9 * target_seconds {
            break;
        }
    }
    usable.iter().filter(|b| values[b.as_str()] > 0.0).cloned().collect()
}

/// `price_transmute_routes`: `transmute_sources`, timed, iterating the profitable
/// re-transmute set to a fixed point (at most `max_rounds`).
#[allow(clippy::too_many_arguments)]
pub fn price_transmute_routes(
    gdc: &Gdc,
    target: &str,
    bonus: f64,
    catalyst: Catalyst,
    retry_catalyst: Catalyst,
    input_seconds: &mut dyn FnMut(&str) -> f64,
    action_seconds: &dyn Fn(&str) -> f64,
    catalyst_seconds: &dyn Fn(Catalyst) -> f64,
    max_item_level: Option<f64>,
    max_rounds: usize,
) -> Vec<Route> {
    let items = items_map(gdc);
    let mut retry: Option<BTreeSet<String>> = None;
    let mut routes = Vec::new();
    for _ in 0..max_rounds {
        routes = transmute_sources(gdc, target, bonus, catalyst, retry_catalyst, 1000, retry.as_ref(), max_item_level);
        for r in &mut routes {
            r.input_seconds = input_seconds(&r.hrid);
            let actions = r.transmuted.iter().fold(0.0, |a, ((h, _), n)| a + n * action_seconds(h) / bulk_of(items, h));
            let cats = r.cat_counts.iter().fold(0.0, |a, (c, n)| a + n * catalyst_seconds(*c));
            r.process_seconds = actions + cats;
            r.seconds_per_target = (r.input_seconds + r.process_seconds) / r.target_per_input;
        }
        let best = routes.iter().filter(|r| r.input_seconds > 0.0).map(|r| r.seconds_per_target).fold(f64::INFINITY, f64::min);
        if !best.is_finite() {
            break;
        }
        let new_retry =
            profitable_retries(gdc, target, best, bonus, retry_catalyst, action_seconds, catalyst_seconds, max_item_level);
        if retry.as_ref() == Some(&new_retry) {
            break;
        }
        retry = Some(new_retry);
    }
    routes
}

// Decomposition constants & helpers ------------------------------------------

pub const DECOMPOSE_BASE_SUCCESS_RATE: f64 = 0.6;
pub const DECOMPOSE_BASE_TIME_SECONDS: f64 = 20.0;

/// `DECOMPOSE_CATALYST_MULTIPLIERS.get(name, 1.0)`.
pub fn decompose_catalyst_multiplier(name: &str) -> f64 {
    match name {
        "decomposition" => 1.15,
        "prime" => 1.25,
        _ => 1.0,
    }
}

/// `alchemyDetail.bulkMultiplier`, coerced as Python's `float(x or 1)`, default 1.
pub fn decompose_bulk_multiplier(item_info: &Value) -> f64 {
    let raw = child(child(item_info, "alchemyDetail"), "bulkMultiplier");
    let bulk = if truthy(raw) { py_float(raw).unwrap_or(1.0) } else { 1.0 };
    if bulk > 0.0 { bulk } else { 1.0 }
}

/// One decompose output for one input item (`decompose_outcome_for_input`).
#[derive(Clone, Debug, PartialEq)]
pub struct DecomposeOutcome {
    pub output_hrid: String,
    pub per_action_count: f64,
    /// The listed count as the data has it (int stays int).
    pub per_action_count_listed: Value,
    pub bulk_multiplier: f64,
    pub time_per_unit_seconds: f64,
    pub total_time_per_unit_seconds: f64,
    pub rate_per_second: Option<f64>,
}

pub fn decompose_outcome_for_input(item_info: &Value, pvalue: f64, action_time: f64, craft_time: f64) -> Vec<DecomposeOutcome> {
    let items = arr(child(child(item_info, "alchemyDetail"), "decomposeItems"));
    let bulk = decompose_bulk_multiplier(item_info);
    let mut out = Vec::new();
    for di in items {
        let hrid = di.get("itemHrid").and_then(Value::as_str).unwrap_or("");
        let count = num(di, "count", 0.0);
        if hrid.is_empty() || count <= 0.0 {
            continue;
        }
        let denom = pvalue * count;
        if denom <= 0.0 {
            continue;
        }
        let total = (craft_time + action_time / bulk) / denom;
        out.push(DecomposeOutcome {
            output_hrid: hrid.to_string(),
            per_action_count: count * bulk,
            per_action_count_listed: di.get("count").cloned().unwrap_or(json!(0)),
            bulk_multiplier: bulk,
            time_per_unit_seconds: action_time / (bulk * denom),
            total_time_per_unit_seconds: total,
            rate_per_second: (total > 0.0).then(|| 1.0 / total),
        });
    }
    out
}

/// `ESSENCE_CATEGORIES`: (key, label, ordered essence hrids).
pub const ESSENCE_CATEGORIES: [(&str, &str, &[&str]); 4] = [
    ("skilling", "Skilling", &[
        "/items/milking_essence",
        "/items/foraging_essence",
        "/items/woodcutting_essence",
        "/items/cheesesmithing_essence",
        "/items/crafting_essence",
        "/items/tailoring_essence",
        "/items/cooking_essence",
        "/items/brewing_essence",
        "/items/alchemy_essence",
        "/items/enhancing_essence",
    ]),
    ("combat", "Combat Zones", &[
        "/items/aqua_essence",
        "/items/bear_essence",
        "/items/jungle_essence",
        "/items/swamp_essence",
        "/items/golem_essence",
        "/items/twilight_essence",
        "/items/eyessence",
        "/items/sorcerer_essence",
        "/items/gobo_essence",
        "/items/abyssal_essence",
    ]),
    ("dungeon", "Dungeons", &[
        "/items/chimerical_essence",
        "/items/sinister_essence",
        "/items/enchanted_essence",
        "/items/pirate_essence",
    ]),
    ("labyrinth", "Labyrinth", &["/items/labyrinth_essence"]),
];

/// (category key, label, position); `("other", "Other", 999)` when unmapped.
pub fn essence_category_for(hrid: &str) -> (&'static str, &'static str, usize) {
    for (key, label, hrids) in ESSENCE_CATEGORIES {
        if let Some(i) = hrids.iter().position(|h| *h == hrid) {
            return (key, label, i);
        }
    }
    ("other", "Other", 999)
}

/// `format_decompose_outcome`: the display row for one outcome.
pub fn format_decompose_outcome(o: &DecomposeOutcome, gdc: &Gdc) -> Map<String, Value> {
    let name = match gdc.get_item(&o.output_hrid) {
        Some(info) => info.get("name").cloned().unwrap_or_else(|| json!(from_hrid(&o.output_hrid))),
        None => json!(from_hrid(&o.output_hrid)),
    };
    let fmt = crate::item_value::format_time;
    let row = json!({
        "hrid": o.output_hrid,
        "name": name,
        "per_action_count": o.per_action_count,
        "per_action_count_listed": o.per_action_count_listed,
        "bulk_multiplier": o.bulk_multiplier,
        "time_per_unit_seconds": py_round(o.time_per_unit_seconds, 4),
        "time_per_unit_display": fmt(o.time_per_unit_seconds),
        "total_time_per_unit_seconds": py_round(o.total_time_per_unit_seconds, 4),
        "total_time_per_unit_display": fmt(o.total_time_per_unit_seconds),
        "rate_per_second": o.rate_per_second.map(|r| py_round(r, 6)),
    });
    match row {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn catalyst_values() {
        assert_eq!(Catalyst::Default.value(), 1.0);
        assert_eq!(Catalyst::Transmutation.value(), 1.15);
        assert_eq!(Catalyst::Prime.value(), 1.25);
    }

    #[test]
    fn success_rate_adds_bonus_to_catalyst() {
        let alc = json!({"transmuteSuccessRate": 0.5});
        assert!((transmute_success(&alc, Catalyst::Prime, 1.0556) - 0.6528).abs() < 1e-12);
        assert!((transmute_success(&alc, Catalyst::Default, 1.0556) - 0.5278).abs() < 1e-12);
        assert_eq!(transmute_success(&json!({}), Catalyst::Default, 1.0), 0.5);
        assert_eq!(transmute_success(&json!({"transmuteSuccessRate": 0.9}), Catalyst::Prime, 1.5), 1.0);
    }

    #[test]
    fn decompose_success_matches_game_panel() {
        // 0.6 * (1.00 + 0.0556) = 0.63336 -> 63.34%
        let p = (DECOMPOSE_BASE_SUCCESS_RATE * (decompose_catalyst_multiplier("default") + 0.0556)).min(1.0);
        assert!((p - 0.63336).abs() < 1e-12);
        assert_eq!(decompose_catalyst_multiplier("prime"), 1.25);
        assert_eq!(decompose_catalyst_multiplier("bogus"), 1.0);
    }

    #[test]
    fn bulk_multiplier_coercion() {
        let b = |v: Value| decompose_bulk_multiplier(&json!({"alchemyDetail": {"bulkMultiplier": v}}));
        assert_eq!(b(json!(5)), 5.0);
        assert_eq!(b(json!("3")), 3.0);
        assert_eq!(b(json!("x")), 1.0);
        assert_eq!(b(json!(0)), 1.0);
        assert_eq!(b(json!(-2)), 1.0);
        assert_eq!(b(Value::Null), 1.0);
        assert_eq!(decompose_bulk_multiplier(&json!({"alchemyDetail": null})), 1.0);
        assert_eq!(decompose_bulk_multiplier(&json!({})), 1.0);
    }

    #[test]
    fn decompose_outcome_math() {
        let info = json!({"alchemyDetail": {"bulkMultiplier": 2, "decomposeItems": [
            {"itemHrid": "/items/x_essence", "count": 3},
            {"itemHrid": "/items/skip", "count": 0},
            {"count": 4},
        ]}});
        let out = decompose_outcome_for_input(&info, 0.5, 10.0, 6.0);
        assert_eq!(out.len(), 1);
        let o = &out[0];
        assert_eq!(o.per_action_count, 6.0);
        assert_eq!(o.per_action_count_listed, json!(3));
        assert_eq!(o.bulk_multiplier, 2.0);
        assert!((o.time_per_unit_seconds - 10.0 / (2.0 * 1.5)).abs() < 1e-12);
        assert!((o.total_time_per_unit_seconds - (6.0 + 5.0) / 1.5).abs() < 1e-12);
        assert!((o.rate_per_second.unwrap() - 1.5 / 11.0).abs() < 1e-12);
        assert!(decompose_outcome_for_input(&json!({"alchemyDetail": null}), 0.5, 10.0, 0.0).is_empty());
        assert!(decompose_outcome_for_input(&info, 0.0, 10.0, 0.0).is_empty());
    }

    #[test]
    fn essence_categories() {
        assert_eq!(essence_category_for("/items/milking_essence"), ("skilling", "Skilling", 0));
        assert_eq!(essence_category_for("/items/eyessence"), ("combat", "Combat Zones", 6));
        assert_eq!(essence_category_for("/items/pirate_essence"), ("dungeon", "Dungeons", 3));
        assert_eq!(essence_category_for("/items/labyrinth_essence"), ("labyrinth", "Labyrinth", 0));
        assert_eq!(essence_category_for("/items/nope"), ("other", "Other", 999));
    }

    fn milk_gdc() -> Gdc {
        let data = json!({"itemDetailMap": {
            "/items/milk": {"name": "Milk", "itemLevel": 1, "alchemyDetail": {"transmuteSuccessRate": 0.5,
                "transmuteDropTable": [{"itemHrid": "/items/egg", "dropRate": 1.0, "minCount": 1, "maxCount": 1}]}},
            "/items/egg": {"name": "Egg", "itemLevel": 1, "alchemyDetail": null},
            "/items/rock": {"name": "Rock", "itemLevel": 99, "alchemyDetail": {"transmuteSuccessRate": 0.5,
                "transmuteDropTable": [{"itemHrid": "/items/egg", "dropRate": 1.0}]}},
        }});
        Gdc::new(Arc::new(data), Arc::new(json!({})))
    }

    #[test]
    fn state_machine_keep_retry_and_unknown() {
        let g = milk_gdc();
        let start = IndexMap::from([("/items/milk".to_string(), 100.0)]);
        let mut sm = StateMachine::new(&g, start.clone(), 1.0, &[], &[], &[], Catalyst::Default);
        sm.run(3);
        assert_eq!(sm.state.get("/items/egg"), Some(&50.0));
        assert_eq!(sm.depth, 100.0);
        let mut kept = StateMachine::new(&g, start.clone(), 1.0, &["/items/milk".into()], &[], &[], Catalyst::Default);
        kept.run(3);
        assert_eq!(kept.state.get("/items/milk"), Some(&100.0));
        let mut bad = StateMachine::new(&g, IndexMap::from([("/items/zzz".to_string(), 1.0)]), 1.0, &[], &[], &[], Catalyst::Default);
        bad.run(2);
        assert_eq!(bad.warnings, vec!["Unknown item in game data: /items/zzz".to_string()]);
    }

    #[test]
    fn level_capped_items_are_never_inputs() {
        let g = milk_gdc();
        let routes = transmute_sources(&g, "/items/egg", 1.0, Catalyst::Default, Catalyst::Default, 1000, None, Some(10.0));
        assert_eq!(routes.iter().map(|r| r.hrid.as_str()).collect::<Vec<_>>(), vec!["/items/milk"]);
        assert!((routes[0].target_per_input - 0.5).abs() < 1e-12);
        assert!(routes[0].settled);
    }
}
