//! Alchemy glue from app.py:354-611 (`_essence_hrids`, `_run_decompose_pass`,
//! `_refine_skilling_bootstraps`, `_refined_essence_bootstraps`, `_decompose_params`) (WP1).

use crate::character_stats::BonusSource;
use crate::item_value::{ItemValueCalculator, MINIMUM_ACTION_TIMER, format_time};
use crate::Gdc;
use crate::transmutation::{
    DECOMPOSE_BASE_SUCCESS_RATE, DECOMPOSE_BASE_TIME_SECONDS, ESSENCE_CATEGORIES, decompose_catalyst_multiplier,
    decompose_outcome_for_input, format_decompose_outcome,
};
use crate::util::{child, from_hrid, py_round};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

/// Flask's `ALCHEMY_ESSENCE_BOOTSTRAP_SECONDS`.
pub const ALCHEMY_ESSENCE_BOOTSTRAP_SECONDS: f64 = 30.0;

/// Essence -> its decompose source rows, in discovery order.
pub type SourcesByEssence = IndexMap<String, Vec<Map<String, Value>>>;

/// `_essence_hrids`: items whose hrid and name both say "essence", minus `*_find`.
pub fn essence_hrids(gdc: &Gdc) -> Vec<String> {
    child(&gdc.data, "itemDetailMap")
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(hrid, info)| {
            let name = info.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            hrid.contains("essence") && name.contains("essence") && !hrid.contains("_find")
        })
        .map(|(h, _)| h.clone())
        .collect()
}

/// `_skilling_essence_hrids`, in `ESSENCE_CATEGORIES` order (Python iterates a set).
pub fn skilling_essence_hrids() -> &'static [&'static str] {
    ESSENCE_CATEGORIES[0].2
}

/// `_decompose_params`: the per-request decompose quantities.
pub struct DecomposeParams<'a> {
    pub catalyst: String,
    pub catalyst_mult: f64,
    pub calculator: ItemValueCalculator<'a>,
    pub alchemy_bonus: f64,
    pub alchemy_sources: Vec<BonusSource>,
    pub pvalue: f64,
    pub action_time: f64,
    /// Highest item level the character can alchemise (None: not modelled).
    pub alchemy_level: Option<f64>,
}

impl<'a> DecomposeParams<'a> {
    pub fn new(gdc: &'a Gdc, catalyst: &str, bootstraps: Option<&IndexMap<String, f64>>) -> Self {
        let catalyst_mult = decompose_catalyst_multiplier(catalyst);
        let calculator = ItemValueCalculator::new(gdc, bootstraps);
        let stats = &calculator.stats;
        let (alchemy_bonus, alchemy_sources) = stats.get_alchemy_success_bonus();
        let pvalue = (DECOMPOSE_BASE_SUCCESS_RATE * (catalyst_mult + alchemy_bonus)).min(1.0);
        let action_time = DECOMPOSE_BASE_TIME_SECONDS * stats.get_action_time_multiplier("/action_types/alchemy");
        let alchemy_level = stats.get_skill_stats("/skills/alchemy").map(|_| stats.get_effective_level("/skills/alchemy", 0.0));
        DecomposeParams {
            catalyst: catalyst.to_string(),
            catalyst_mult,
            calculator,
            alchemy_bonus,
            alchemy_sources,
            pvalue,
            action_time,
            alchemy_level,
        }
    }

    /// One alchemy action on an item of this level (its level is the requirement).
    pub fn action_time_at(&self, item_level: f64) -> f64 {
        let stats = &self.calculator.stats;
        let Some(alchemy) = stats.get_skill_stats("/skills/alchemy") else { return self.action_time };
        let over = (stats.get_effective_level("/skills/alchemy", item_level) - item_level).max(0.0);
        (DECOMPOSE_BASE_TIME_SECONDS / alchemy.speed).max(MINIMUM_ACTION_TIMER) / (1.0 + 0.01 * over + alchemy.efficiency)
    }

    /// `[{source, name, value: round(v*100, 2)}]`.
    pub fn alchemy_sources_json(&self) -> Value {
        Value::Array(
            self.alchemy_sources
                .iter()
                .map(|s| json!({"source": s.source, "name": s.name, "value": py_round(s.value * 100.0, 2)}))
                .collect(),
        )
    }
}

/// `_run_decompose_pass`: every item that decomposes into an essence, as source rows.
pub fn run_decompose_pass<'a>(
    gdc: &'a Gdc,
    catalyst: &str,
    bootstraps: Option<&IndexMap<String, f64>>,
    include_no_craft: bool,
) -> (DecomposeParams<'a>, SourcesByEssence) {
    let essence_set: HashSet<String> = essence_hrids(gdc).into_iter().collect();
    let mut p = DecomposeParams::new(gdc, catalyst, bootstraps);
    let mut sources = SourcesByEssence::new();
    for (input_hrid, info) in child(&gdc.data, "itemDetailMap").as_object().into_iter().flatten() {
        let di_list = child(child(info, "alchemyDetail"), "decomposeItems").as_array().map(Vec::as_slice).unwrap_or(&[]);
        if !di_list.iter().any(|di| di.get("itemHrid").and_then(Value::as_str).is_some_and(|h| essence_set.contains(h))) {
            continue;
        }
        let craft_time = p.calculator.value(input_hrid);
        let has_craft_cost = craft_time > 0.0 && !essence_set.contains(input_hrid);
        if !include_no_craft && !has_craft_cost {
            continue;
        }
        let input_name = info.get("name").cloned().unwrap_or_else(|| json!(from_hrid(input_hrid)));
        let item_level = info.get("itemLevel").cloned().unwrap_or(json!(0));
        let craft_display = if has_craft_cost { format_time(craft_time) } else { "-".into() };
        for o in decompose_outcome_for_input(info, p.pvalue, p.action_time, craft_time) {
            if !essence_set.contains(&o.output_hrid) {
                continue;
            }
            let mut row = format_decompose_outcome(&o, gdc);
            row.insert("input_hrid".into(), json!(input_hrid));
            row.insert("input_name".into(), input_name.clone());
            row.insert("item_level".into(), item_level.clone());
            row.insert("has_craft_cost".into(), json!(has_craft_cost));
            row.insert("craft_time_seconds".into(), json!(py_round(craft_time, 2)));
            row.insert("craft_time_display".into(), json!(craft_display));
            sources.entry(o.output_hrid).or_default().push(row);
        }
    }
    (p, sources)
}

fn total_per_unit(row: &Map<String, Value>) -> f64 {
    row.get("total_time_per_unit_seconds").and_then(Value::as_f64).unwrap_or(0.0)
}

/// `_refine_skilling_bootstraps`: each skilling essence takes its best complete-recipe
/// source's time. Returns (refined, log).
pub fn refine_skilling_bootstraps(
    sources_pass1: &SourcesByEssence,
    calculator_pass1: &mut ItemValueCalculator,
    flat_bootstraps: &IndexMap<String, f64>,
    flat_seconds: f64,
) -> (IndexMap<String, f64>, Vec<Value>) {
    let mut refined = flat_bootstraps.clone();
    let mut log = Vec::new();
    for ess in skilling_essence_hrids() {
        if !refined.contains_key(*ess) {
            continue;
        }
        let mut candidates: Vec<&Map<String, Value>> = Vec::new();
        let mut rejected: Vec<Value> = Vec::new();
        for s in sources_pass1.get(*ess).into_iter().flatten() {
            if s.get("has_craft_cost") != Some(&Value::Bool(true)) {
                continue;
            }
            if !calculator_pass1.recipe_is_complete(s["input_hrid"].as_str().unwrap_or("")) {
                rejected.push(s["input_name"].clone());
                continue;
            }
            candidates.push(s);
        }
        rejected.truncate(5);
        let essence_name = match calculator_pass1.gdc.get_item(ess) {
            Some(info) => info.get("name").cloned().unwrap_or_else(|| json!(from_hrid(ess))),
            None => json!(from_hrid(ess)),
        };
        // First minimum, as Python's min().
        let best = candidates.iter().fold(None::<&&Map<String, Value>>, |b, c| match b {
            Some(b) if total_per_unit(b) <= total_per_unit(c) => Some(b),
            _ => Some(c),
        });
        match best {
            None => log.push(json!({
                "essence_hrid": ess, "essence_name": essence_name, "pass1_seconds": flat_seconds,
                "pass1_source": "(no complete-recipe source \u{2014} kept flat)", "flat_seconds": flat_seconds,
                "rejected_incomplete": rejected,
            })),
            Some(best) => {
                let t = total_per_unit(best);
                refined.insert(ess.to_string(), t);
                log.push(json!({
                    "essence_hrid": ess, "essence_name": essence_name, "pass1_seconds": py_round(t, 4),
                    "pass1_source": best["input_name"], "flat_seconds": flat_seconds,
                    "rejected_incomplete": rejected,
                }));
            }
        }
    }
    (refined, log)
}

/// `_refined_essence_bootstraps` (app.py:506-555): (refined bootstraps, refinement log).
pub fn refined_essence_bootstraps(
    gdc: &Gdc,
    catalyst: &str,
    flat_seconds: f64,
    user_overrides: &IndexMap<String, f64>,
) -> (IndexMap<String, f64>, Vec<Value>) {
    let mut flat: IndexMap<String, f64> = essence_hrids(gdc).into_iter().map(|h| (h, flat_seconds)).collect();
    flat.extend(user_overrides.iter().map(|(k, v)| (k.clone(), *v)));
    let (mut p1, sources) = run_decompose_pass(gdc, catalyst, Some(&flat), true);
    let (refined_full, log) = refine_skilling_bootstraps(&sources, &mut p1.calculator, &flat, flat_seconds);
    let skilling = skilling_essence_hrids();
    let mut refined: IndexMap<String, f64> =
        refined_full.into_iter().filter(|(h, _)| skilling.contains(&h.as_str())).collect();
    refined.extend(user_overrides.iter().map(|(k, v)| (k.clone(), *v)));
    (refined, log)
}
