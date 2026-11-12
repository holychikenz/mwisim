//! `cow/item_value.py`: recursive time-to-acquire valuation (WP1).

use crate::character_stats::CharacterStats;
use crate::Gdc;
use crate::util::{child, from_hrid, py_round, py_title, to_hrid};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub const MINIMUM_ACTION_TIMER: f64 = 3.0;

/// A recipe cycle was reached (Python: RecursionError).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cycle;

const RECIPE_SKILLS: [&str; 5] = ["brewing", "cooking", "crafting", "tailoring", "cheesesmithing"];

pub struct ItemValueCalculator<'a> {
    pub gdc: &'a Gdc,
    pub bootstraps: IndexMap<String, f64>,
    /// `calculate_item_value`'s lru_cache, keyed by the raw argument.
    pub memo: HashMap<String, f64>,
    pub stats: CharacterStats<'a>,
    action_cache: HashMap<String, f64>,
    complete_memo: HashMap<String, bool>,
    /// Items on the current recursion path (value / completeness walks).
    on_stack: HashSet<String>,
}

fn norm(item_hrid: &str) -> String {
    if item_hrid.contains("/items/") { item_hrid.to_string() } else { to_hrid(item_hrid) }
}

fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn s<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// `action_hrid.split('/')[-1].replace('_', ' ').title()`.
fn action_title(action_hrid: &str) -> String {
    py_title(&action_hrid.rsplit('/').next().unwrap_or("").replace('_', " "))
}

impl<'a> ItemValueCalculator<'a> {
    pub fn new(gdc: &'a Gdc, bootstraps: Option<&IndexMap<String, f64>>) -> Self {
        let bootstraps = bootstraps.map(|b| b.iter().map(|(k, v)| (to_hrid(k), *v)).collect()).unwrap_or_default();
        ItemValueCalculator {
            gdc,
            bootstraps,
            memo: HashMap::new(),
            stats: CharacterStats::new(gdc),
            action_cache: HashMap::new(),
            complete_memo: HashMap::new(),
            on_stack: HashSet::new(),
        }
    }

    /// `calculate_item_value`; a recipe cycle yields 0.0 (every Flask caller catches RecursionError).
    pub fn value(&mut self, item_hrid: &str) -> f64 {
        self.calculate_item_value(item_hrid).unwrap_or(0.0)
    }

    fn actions(&self) -> &'a Value {
        child(&self.gdc.data, "actionDetailMap")
    }

    fn item_name(&self, item_hrid: &str) -> String {
        match self.gdc.get_item(item_hrid) {
            Some(info) => info.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| from_hrid(item_hrid)),
            None => from_hrid(item_hrid),
        }
    }

    pub fn get_action_time(&mut self, action_hrid: &str) -> f64 {
        if let Some(t) = self.action_cache.get(action_hrid) {
            return *t;
        }
        let details = child(self.actions(), action_hrid);
        if !crate::util::truthy(details) {
            return 0.0;
        }
        let base_time = num(details, "baseTimeCost", 0.0) / 1e9;
        let req = child(details, "levelRequirement");
        let required = num(req, "level", 0.0);
        let skill = s(req, "skillHrid");
        let (speed, efficiency, effective) = match self.stats.get_skill_stats(skill) {
            Some(st) => (st.speed, st.efficiency, self.stats.get_effective_level(skill, required)),
            None => (1.0, 0.0, self.gdc.skill_level(skill) as f64),
        };
        let level_efficiency = (effective - required).max(0.0) * 0.01;
        let total_efficiency = 1.0 + level_efficiency + efficiency;
        let t = (base_time / speed).max(MINIMUM_ACTION_TIMER) / total_efficiency;
        self.action_cache.insert(action_hrid.to_string(), t);
        t
    }

    fn action_type(&self, action_hrid: &str) -> &'a str {
        s(child(self.actions(), action_hrid), "type")
    }

    fn action_skill(&self, action_hrid: &str) -> &'a str {
        s(child(child(self.actions(), action_hrid), "levelRequirement"), "skillHrid")
    }

    pub fn get_artisan_multiplier(&self, action_hrid: &str) -> f64 {
        self.stats.get_ingredient_multiplier(self.action_type(action_hrid))
    }

    pub fn get_gourmet_multiplier(&self, action_hrid: &str) -> f64 {
        self.stats.get_output_multiplier(self.action_type(action_hrid))
    }

    pub fn get_item_recipe(&self, item_hrid: &str) -> Option<&'a Value> {
        let name = item_hrid.rsplit('/').next().unwrap_or("");
        RECIPE_SKILLS.iter().find_map(|a| self.actions().get(format!("/actions/{a}/{name}")))
    }

    /// `get_gathering_action`: the FIRST action (file order) with the strictly highest yield.
    pub fn get_gathering_action(&self, item_hrid: &str) -> Option<(&'a str, f64)> {
        let mut best: Option<&'a str> = None;
        let mut best_yield = 0.0;
        for (action_hrid, detail) in self.actions().as_object()? {
            let drops = arr(child(detail, "dropTable"));
            let rare = arr(child(detail, "rareDropTable"));
            if drops.is_empty() && rare.is_empty() {
                continue;
            }
            for (table, is_rare) in [(drops, false), (rare, true)] {
                for drop in table {
                    if drop.get("itemHrid").and_then(Value::as_str) != Some(item_hrid) {
                        continue;
                    }
                    let skill = self.action_skill(action_hrid);
                    let mult = if is_rare {
                        self.stats.get_rare_find_multiplier(skill)
                    } else {
                        self.stats.get_gathering_multiplier(skill)
                    };
                    let avg = num(drop, "dropRate", 0.0) * (num(drop, "minCount", 1.0) + num(drop, "maxCount", 1.0)) / 2.0 * mult;
                    if avg > best_yield {
                        best_yield = avg;
                        best = Some(action_hrid.as_str());
                    }
                }
            }
        }
        best.map(|a| (a, best_yield))
    }

    /// The recipe's output count for this item, times gourmet.
    fn output_count(&self, recipe: &Value, action_hrid: &str, item_hrid: &str) -> f64 {
        let count = arr(child(recipe, "outputItems"))
            .iter()
            .find(|o| o.get("itemHrid").and_then(Value::as_str) == Some(item_hrid))
            .map_or(1.0, |o| num(o, "count", 1.0));
        count * self.get_gourmet_multiplier(action_hrid)
    }

    /// `recipe_is_complete`: every ingredient is gatherable, bootstrapped or itself complete.
    /// Python has no cycle guard (it would raise); a cycle here counts as incomplete.
    pub fn recipe_is_complete(&mut self, item_hrid: &str) -> bool {
        if let Some(v) = self.complete_memo.get(item_hrid) {
            return *v;
        }
        let hrid = norm(item_hrid);
        if !self.on_stack.insert(format!("c:{hrid}")) {
            return false;
        }
        let v = self.complete_uncached(&hrid);
        self.on_stack.remove(&format!("c:{hrid}"));
        self.complete_memo.insert(item_hrid.to_string(), v);
        v
    }

    fn complete_uncached(&mut self, hrid: &str) -> bool {
        if self.bootstraps.contains_key(hrid) || self.get_gathering_action(hrid).is_some() {
            return true;
        }
        let Some(recipe) = self.get_item_recipe(hrid) else { return false };
        for inp in arr(child(recipe, "inputItems")) {
            let h = s(inp, "itemHrid");
            if !h.is_empty() && !self.recipe_is_complete(h) {
                return false;
            }
        }
        match recipe.get("upgradeItemHrid").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            Some(u) => self.recipe_is_complete(u),
            None => true,
        }
    }

    /// `calculate_item_value`: seconds to acquire one item from scratch; Err on a recipe cycle.
    /// Nothing on a cyclic path is memoised, exactly as an lru_cache unwound by RecursionError.
    pub fn calculate_item_value(&mut self, item_hrid: &str) -> Result<f64, Cycle> {
        if let Some(v) = self.memo.get(item_hrid) {
            return Ok(*v);
        }
        let hrid = norm(item_hrid);
        if !self.on_stack.insert(hrid.clone()) {
            return Err(Cycle);
        }
        let v = self.value_uncached(&hrid);
        self.on_stack.remove(&hrid);
        let v = v?;
        self.memo.insert(item_hrid.to_string(), v);
        Ok(v)
    }

    fn value_uncached(&mut self, hrid: &str) -> Result<f64, Cycle> {
        if let Some(v) = self.bootstraps.get(hrid) {
            return Ok(*v);
        }
        if let Some((action, avg)) = self.get_gathering_action(hrid) {
            if avg > 0.0 {
                return Ok(self.get_action_time(action) / avg);
            }
        }
        let Some(recipe) = self.get_item_recipe(hrid) else { return Ok(0.0) };
        let action = s(recipe, "hrid");
        let action_time = self.get_action_time(action);
        let artisan = self.get_artisan_multiplier(action);
        let mut ingredient_time = 0.0;
        for inp in arr(child(recipe, "inputItems")) {
            let count = num(inp, "count", 1.0) * artisan;
            ingredient_time += self.calculate_item_value(s(inp, "itemHrid"))? * count;
        }
        // Artisan never reduces the upgrade item: one per action.
        if let Some(u) = recipe.get("upgradeItemHrid").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            ingredient_time += self.calculate_item_value(u)?;
        }
        Ok((action_time + ingredient_time) / self.output_count(recipe, action, hrid))
    }

    /// `calculate_all_item_values`: every item worth > 0, value descending.
    pub fn calculate_all_item_values(&mut self) -> Vec<Value> {
        let gdc: &'a Gdc = self.gdc;
        let mut out = Vec::new();
        for (hrid, info) in child(&gdc.data, "itemDetailMap").as_object().into_iter().flatten() {
            let name = info.get("name").cloned().unwrap_or_else(|| json!(from_hrid(hrid)));
            let v = self.value(hrid);
            if v > 0.0 {
                out.push(json!({"hrid": hrid, "name": name, "value_seconds": py_round(v, 2), "value_display": format_time(v)}));
            }
        }
        sort_desc(&mut out, "value_seconds");
        out
    }

    /// `calculate_inventory_values`: one row per inventory entry, total descending.
    pub fn calculate_inventory_values(&mut self) -> Vec<Value> {
        let character = self.gdc.character.clone();
        let mut out = Vec::new();
        for item in arr(child(&character, "characterItems")) {
            let hrid = s(item, "itemHrid");
            let count = item["count"].clone();
            let each = self.value(hrid);
            let total = each * count.as_f64().unwrap_or(0.0);
            out.push(json!({
                "hrid": hrid,
                "name": self.item_name(hrid),
                "count": count,
                "value_each": py_round(each, 2),
                "value_each_display": if each > 0.0 { format_time(each) } else { "-".into() },
                "total_value": py_round(total, 2),
                "total_value_display": if total > 0.0 { format_time(total) } else { "-".into() },
            }));
        }
        sort_desc(&mut out, "total_value");
        out
    }

    /// `get_item_breakdown`; Err on a recipe cycle (Python would raise -> 500).
    pub fn get_item_breakdown(&mut self, item_hrid: &str, count: f64) -> Result<Vec<Value>, Cycle> {
        let mut steps = Vec::new();
        let mut path = HashSet::new();
        self.build_breakdown(&norm(item_hrid), count, &mut steps, 0, &mut path)?;
        Ok(steps)
    }

    fn build_breakdown(&mut self, hrid: &str, count: f64, steps: &mut Vec<Value>, depth: usize, path: &mut HashSet<String>) -> Result<(), Cycle> {
        let item = self.item_name(hrid);
        let step = |kind: &str, action: String, action_hrid: &str, actions_needed: Value, time: f64| {
            json!({
                "depth": depth, "type": kind, "action": action, "action_hrid": action_hrid,
                "item": item, "item_hrid": hrid, "count": py_round(count, 2),
                "actions_needed": actions_needed, "time_seconds": py_round(time, 2), "time_display": format_time(time),
            })
        };
        if let Some(unit) = self.bootstraps.get(hrid) {
            steps.push(step("bootstrap", "Refined / overridden value".into(), "", json!(0), unit * count));
            return Ok(());
        }
        if let Some((action, avg)) = self.get_gathering_action(hrid) {
            if avg > 0.0 {
                let needed = count / avg;
                let total = self.get_action_time(action) * needed;
                steps.push(step("gather", action_title(action), action, json!(py_round(needed, 2)), total));
            }
            return Ok(());
        }
        if let Some(recipe) = self.get_item_recipe(hrid) {
            if !path.insert(hrid.to_string()) {
                return Err(Cycle);
            }
            let action = s(recipe, "hrid");
            let action_time = self.get_action_time(action);
            let artisan = self.get_artisan_multiplier(action);
            let needed = count / self.output_count(recipe, action, hrid);
            steps.push(step("craft", action_title(action), action, json!(py_round(needed, 2)), action_time * needed));
            for inp in arr(child(recipe, "inputItems")) {
                let c = num(inp, "count", 1.0) * needed * artisan;
                self.build_breakdown(s(inp, "itemHrid"), c, steps, depth + 1, path)?;
            }
            if let Some(u) = recipe.get("upgradeItemHrid").and_then(Value::as_str).filter(|u| !u.is_empty()) {
                self.build_breakdown(u, needed, steps, depth + 1, path)?;
            }
            path.remove(hrid);
            return Ok(());
        }
        steps.push(json!({
            "depth": depth, "type": "unknown", "action": "Unknown Source", "action_hrid": "",
            "item": item, "item_hrid": hrid, "count": py_round(count, 2),
            "actions_needed": 0, "time_seconds": 0, "time_display": "0s",
        }));
        Ok(())
    }
}

/// Python's stable `sort(key=..., reverse=True)`: ties keep their order.
fn sort_desc(rows: &mut [Value], key: &str) {
    rows.sort_by(|a, b| {
        let (x, y) = (a[key].as_f64().unwrap_or(0.0), b[key].as_f64().unwrap_or(0.0));
        y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// `ItemValueCalculator.format_time`.
pub fn format_time(seconds: f64) -> String {
    if seconds <= 0.0 {
        "0s".into()
    } else if seconds < 0.001 {
        "<1ms".into()
    } else if seconds < 0.1 {
        format!("{:.0}ms", seconds * 1000.0)
    } else if seconds < 60.0 {
        format!("{seconds:.1}s")
    } else if seconds < 3600.0 {
        format!("{:.1}m", seconds / 60.0)
    } else if seconds < 86400.0 {
        format!("{:.1}h", seconds / 3600.0)
    } else {
        format!("{:.1}d", seconds / 86400.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn format_time_bands() {
        assert_eq!(format_time(0.0), "0s");
        assert_eq!(format_time(-1.0), "0s");
        assert_eq!(format_time(0.0009), "<1ms");
        assert_eq!(format_time(0.001), "1ms");
        assert_eq!(format_time(0.0995), "100ms"); // Python: f"{99.5:.0f}" rounds the binary value up
        assert_eq!(format_time(0.1), "0.1s");
        assert_eq!(format_time(59.99), "60.0s");
        assert_eq!(format_time(60.0), "1.0m");
        assert_eq!(format_time(3600.0), "1.0h");
        assert_eq!(format_time(86400.0), "1.0d");
    }

    /// Two items whose recipes consume each other, plus a sound one.
    fn cyclic_gdc() -> Gdc {
        let data = json!({
            "itemDetailMap": {
                "/items/a": {"name": "A"}, "/items/b": {"name": "B"}, "/items/c": {"name": "C"},
            },
            "actionDetailMap": {
                "/actions/crafting/a": {"hrid": "/actions/crafting/a", "type": "/action_types/crafting", "baseTimeCost": 10e9,
                    "levelRequirement": {"skillHrid": "/skills/crafting", "level": 1},
                    "inputItems": [{"itemHrid": "/items/b", "count": 1}], "outputItems": [{"itemHrid": "/items/a", "count": 1}]},
                "/actions/crafting/b": {"hrid": "/actions/crafting/b", "type": "/action_types/crafting", "baseTimeCost": 10e9,
                    "levelRequirement": {"skillHrid": "/skills/crafting", "level": 1},
                    "inputItems": [{"itemHrid": "/items/a", "count": 1}], "outputItems": [{"itemHrid": "/items/b", "count": 1}]},
                "/actions/crafting/c": {"hrid": "/actions/crafting/c", "type": "/action_types/crafting", "baseTimeCost": 10e9,
                    "levelRequirement": {"skillHrid": "/skills/crafting", "level": 1},
                    "inputItems": [], "outputItems": [{"itemHrid": "/items/c", "count": 2}]},
            },
            "enhancementLevelTotalBonusMultiplierTable": [0.0],
        });
        Gdc::new(Arc::new(data), Arc::new(json!({"characterItems": []})))
    }

    #[test]
    fn recipe_cycle_values_zero_and_breakdown_errs() {
        let g = cyclic_gdc();
        let mut calc = ItemValueCalculator::new(&g, None);
        assert_eq!(calc.value("/items/a"), 0.0);
        assert_eq!(calc.value("/items/b"), 0.0);
        assert!(!calc.memo.contains_key("/items/a"), "a cyclic value must not be memoised");
        assert_eq!(calc.get_item_breakdown("/items/a", 1.0), Err(Cycle));
        assert!(!calc.recipe_is_complete("/items/a"));
        // The calculator stays usable: a sound item still values (10 s / 2 outputs).
        assert_eq!(calc.value("/items/c"), 5.0);
        assert_eq!(calc.value("C"), 5.0);
        // A bootstrap breaks the cycle.
        let boot: IndexMap<String, f64> = [("/items/b".to_string(), 4.0)].into_iter().collect();
        let mut calc = ItemValueCalculator::new(&g, Some(&boot));
        assert_eq!(calc.value("/items/a"), 14.0);
        assert_eq!(calc.get_item_breakdown("/items/a", 1.0).unwrap().len(), 2);
    }

    /// A cycle guard that memoises is still order-independent: a hit on the stack means the item
    /// sits on a cycle of non-base items, which no query order can complete.
    #[test]
    fn recipe_completeness_does_not_depend_on_query_order() {
        let g = cyclic_gdc();
        let boot: IndexMap<String, f64> = [("/items/b".to_string(), 4.0)].into_iter().collect();
        let items = ["/items/a", "/items/b", "/items/c"];
        for (bootstraps, want) in [(None, [false, false, true]), (Some(&boot), [true, true, true])] {
            for order in [[0, 1, 2], [1, 0, 2], [2, 1, 0]] {
                let mut calc = ItemValueCalculator::new(&g, bootstraps);
                for i in order {
                    assert_eq!(calc.recipe_is_complete(items[i]), want[i], "{} in order {order:?}", items[i]);
                }
            }
        }
    }
}
