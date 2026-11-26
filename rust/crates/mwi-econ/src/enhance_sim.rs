//! `cow/enhance_sim.py`: Enhancelator Markov model, pricing, Monte Carlo (WP2).
//! Moved from cowstuff's webapp-rs server; csim's wasm and the server share it.
//!
//! Mirrors the Python one-to-one, including float operation order, so the
//! seeded Monte Carlo matches bit for bit. The legacy stub API
//! (enhance_sim.py:1081+) is not ported.

use crate::item_value::ItemValueCalculator;
use crate::mt19937::Mt19937;
use crate::Gdc;
use crate::util::{child, from_hrid, get_or, py_float, py_int, py_round_int, truthy};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

/// Multiplier on enhancement-bonus stats per level (main.js 6-29).
pub const ENHANCE_BONUS: [f64; 21] = [
    1.000, 1.020, 1.042, 1.066, 1.092, 1.120, 1.150, 1.182, 1.216, 1.252, 1.290, 1.334, 1.384, 1.440, 1.502, 1.570,
    1.644, 1.724, 1.810, 1.902, 2.000,
];

/// Base success rate (%) for the +1..+20 attempt (index 0 = +1).
pub const SUCCESS_RATE_PCT: [f64; 20] =
    [50.0, 45.0, 45.0, 40.0, 40.0, 40.0, 35.0, 35.0, 35.0, 35.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0];

pub const HRID_GUZZLING_POUCH: &str = "/items/guzzling_pouch";
pub const HRID_ENCHANTED_GLOVES: &str = "/items/enchanted_gloves";
pub const HRID_ENHANCERS_TOP: &str = "/items/enhancers_top";
pub const HRID_ENHANCERS_BOTTOMS: &str = "/items/enhancers_bottoms";
pub const HRID_PHILOSOPHERS_NECKLACE: &str = "/items/philosophers_necklace";
pub const HRID_PHILOSOPHERS_MIRROR: &str = "/items/philosophers_mirror";
pub const HRID_MIRROR_OF_PROTECTION: &str = "/items/mirror_of_protection";
pub const HRID_ENHANCING_ESSENCE: &str = "/items/enhancing_essence";
pub const HRID_COIN: &str = "/items/coin";
pub const CHARM_TIERS: [&str; 6] = ["trainee", "basic", "advanced", "expert", "master", "grandmaster"];
const ENHANCING_TOOL_TYPE: &str = "/equipment_types/enhancing_tool";

/// `DECOMP_CATALYSTS`: (key, multiplier, hrid, label).
const DECOMP_CATALYSTS: [(&str, f64, Option<&str>, &str); 3] = [
    ("none", 1.0, None, "No catalyst"),
    ("decomposition", 1.15, Some("/items/catalyst_of_decomposition"), "Catalyst of Decomposition"),
    ("prime", 1.25, Some("/items/prime_catalyst"), "Prime Catalyst"),
];
/// Deliberately 1.05 and 0.5 here (the alchemy page uses 0.6); kept as Python has them.
pub const CATALYTIC_TEA_MULTIPLIER: f64 = 1.05;
pub const BASE_DECOMP_SUCCESS_RATE: f64 = 0.5;

/// `EnhancementConfig`. Unknown keys are ignored, missing keys take the defaults.
/// The seven table-index levels are `usize` (validated <= 20); the other
/// numeric knobs are `f64` because Python accepts fractional values there.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct EnhancementConfig {
    pub enhancing_level: f64,
    pub observatory_level: f64,
    pub enhancer_hrid: String,
    pub enhancer_level: usize,
    pub use_enchanted: bool,
    pub enchanted_level: usize,
    pub use_guzzling: bool,
    pub guzzling_level: usize,
    pub use_enhancer_top: bool,
    pub enhancer_top_level: usize,
    pub use_enhancer_bot: bool,
    pub enhancer_bot_level: usize,
    pub use_philo_neck: bool,
    pub philo_neck_level: usize,
    pub use_charm: bool,
    pub charm_tier: String,
    pub charm_level: usize,
    pub use_enhancing_buff: bool,
    pub enhancing_buff_level: f64,
    pub use_experience_buff: bool,
    pub experience_buff_level: f64,
    pub use_achievement_success: bool,
    pub tea_enhancing: bool,
    pub tea_super_enhancing: bool,
    pub tea_ultra_enhancing: bool,
    pub tea_blessed: bool,
    pub tea_wisdom: bool,
    pub hourly_rate: f64,
    pub percent_rate: f64,
}

impl Default for EnhancementConfig {
    fn default() -> Self {
        EnhancementConfig {
            enhancing_level: 100.0,
            observatory_level: 0.0,
            enhancer_hrid: "/items/cheese_enhancer".into(),
            enhancer_level: 0,
            use_enchanted: false,
            enchanted_level: 0,
            use_guzzling: false,
            guzzling_level: 0,
            use_enhancer_top: false,
            enhancer_top_level: 0,
            use_enhancer_bot: false,
            enhancer_bot_level: 0,
            use_philo_neck: false,
            philo_neck_level: 0,
            use_charm: false,
            charm_tier: "trainee".into(),
            charm_level: 0,
            use_enhancing_buff: false,
            enhancing_buff_level: 1.0,
            use_experience_buff: false,
            experience_buff_level: 1.0,
            use_achievement_success: false,
            tea_enhancing: false,
            tea_super_enhancing: false,
            tea_ultra_enhancing: false,
            tea_blessed: false,
            tea_wisdom: false,
            hourly_rate: 5_000_000.0,
            percent_rate: 2.0,
        }
    }
}

impl EnhancementConfig {
    /// Flask's `EnhancementConfig(**known_keys)`; Err is the 400 message.
    pub fn from_json(v: &Value) -> Result<Self, String> {
        let cfg: Self = serde_json::from_value(v.clone()).map_err(|e| format!("invalid config: {e}"))?;
        let levels = [
            cfg.enhancer_level,
            cfg.enchanted_level,
            cfg.guzzling_level,
            cfg.enhancer_top_level,
            cfg.enhancer_bot_level,
            cfg.philo_neck_level,
            cfg.charm_level,
        ];
        if levels.iter().any(|&l| l > 20) {
            return Err("invalid config: enhancement level above 20".into());
        }
        Ok(cfg)
    }
}

/// One (target, protect_at) cell of the Markov solver.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ExpectedOutcome {
    pub actions: f64,
    pub protects: f64,
    pub xp: f64,
    pub attempt_time: f64,
    pub mat_cost: f64,
    pub total_cost: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MirrorPlan {
    pub triggered: bool,
    pub mirror_at: usize,
    pub num_lower_fodder: u64,
    pub num_upper_fodder: u64,
    pub num_mirrors: u64,
    pub cost_lower_fodder: f64,
    pub cost_upper_fodder: f64,
    pub cost_mirror_each: f64,
    pub grand_total: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SimulationResult {
    pub n_samples: usize,
    /// Keys `"25".."99"` (Flask's jsonify stringifies the int keys).
    pub percentiles: Map<String, Value>,
    pub attempt_time: f64,
    pub success_rate_with_coins: Option<f64>,
    pub money_i_have: f64,
}

/// Python list indexing: negative indices wrap; None where Python raises IndexError.
fn py_index(len: usize, i: i64) -> Option<usize> {
    let j = if i < 0 { i + len as i64 } else { i };
    (0..len as i64).contains(&j).then_some(j as usize)
}

fn fib(k: usize) -> u64 {
    if k <= 1 {
        return 1;
    }
    let (mut a, mut b) = (1u64, 1u64);
    for _ in 0..k - 1 {
        (a, b) = (b, a + b);
    }
    b
}

fn mirror_fib(k: usize) -> u64 {
    match k {
        0 => 1,
        1 => 2,
        _ => {
            let (mut a, mut b) = (1u64, 2u64);
            for _ in 0..k - 1 {
                (a, b) = (b, a + b + 1);
            }
            b
        }
    }
}

/// Solve `a x = b` by Gaussian elimination with partial pivoting; None if exactly singular.
#[allow(clippy::needless_range_loop)]
pub fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        let piv = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col] == 0.0 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        for r in col + 1..n {
            let f = a[r][col] / a[col][col];
            if f != 0.0 {
                for c in col..n {
                    a[r][c] -= f * a[col][c];
                }
                b[r] -= f * b[col];
            }
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let s: f64 = (r + 1..n).map(|c| a[r][c] * x[c]).sum();
        x[r] = (b[r] - s) / a[r][r];
    }
    Some(x)
}

fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// `d.get(key) or []`.
fn list_or_empty(v: &Value, key: &str) -> Value {
    let x = child(v, key);
    if truthy(x) { x.clone() } else { json!([]) }
}

/// `float(d.get(key) or 0.0)`.
fn float_or_zero(v: &Value, key: &str) -> f64 {
    let x = child(v, key);
    if truthy(x) { py_float(x).unwrap_or(0.0) } else { 0.0 }
}

fn str_of<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `int(item.get('itemLevel') or 1)`.
pub fn item_level(item: &Value) -> i64 {
    let v = child(item, "itemLevel");
    if truthy(v) { py_int(v) } else { 1 }
}

pub struct EnhanceSim<'a> {
    pub gdc: &'a Gdc,
    /// Title-Case item name -> market ask (the server's market; empty in the browser).
    pub market: &'a HashMap<String, f64>,
    pub iron_cow: bool,
    price_cache: HashMap<String, f64>,
    bootstraps: IndexMap<String, f64>,
    iv_calc: Option<ItemValueCalculator<'a>>,
}

impl<'a> EnhanceSim<'a> {
    pub fn new(gdc: &'a Gdc, market: &'a HashMap<String, f64>, iron_cow: bool, bootstraps: Option<IndexMap<String, f64>>) -> Self {
        EnhanceSim { gdc, market, iron_cow, price_cache: HashMap::new(), bootstraps: bootstraps.unwrap_or_default(), iv_calc: None }
    }

    fn item_map(&self) -> impl Iterator<Item = (&'a String, &'a Value)> + use<'a> {
        let gdc: &'a Gdc = self.gdc;
        gdc.data.get("itemDetailMap").and_then(Value::as_object).into_iter().flatten()
    }

    /// `enhancable_items`: every item with `enhancementCosts`, stable-sorted by sortIndex.
    pub fn enhancable_items(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self
            .item_map()
            .filter(|(_, info)| !info.get("enhancementCosts").is_none_or(Value::is_null))
            .map(|(hrid, info)| {
                json!({
                    "hrid": hrid,
                    "name": get_or(info, "name", json!(from_hrid(hrid))),
                    "itemLevel": get_or(info, "itemLevel", json!(1)),
                    "sortIndex": get_or(info, "sortIndex", json!(0)),
                    "categoryHrid": get_or(info, "categoryHrid", json!("")),
                    "enhancementCosts": info["enhancementCosts"],
                    "protectionItemHrids": list_or_empty(info, "protectionItemHrids"),
                })
            })
            .collect();
        sort_by_index(&mut out);
        out
    }

    /// `enhancing_tools`: items whose equipment type is the enhancing tool.
    pub fn enhancing_tools(&self) -> Vec<Value> {
        let mut tools: Vec<Value> = self
            .item_map()
            .filter_map(|(hrid, info)| {
                let equip = child(info, "equipmentDetail");
                if equip.get("type").and_then(Value::as_str) != Some(ENHANCING_TOOL_TYPE) {
                    return None;
                }
                let stats = get_or(equip, "noncombatStats", json!({}));
                Some(json!({
                    "hrid": hrid,
                    "name": get_or(info, "name", json!(from_hrid(hrid))),
                    "enhancingSuccess": get_or(&stats, "enhancingSuccess", json!(0.0)),
                    "enhancingSpeed": get_or(&stats, "enhancingSpeed", json!(0.0)),
                    "enhancingExperience": get_or(&stats, "enhancingExperience", json!(0.0)),
                    "sortIndex": get_or(info, "sortIndex", json!(0)),
                }))
            })
            .collect();
        sort_by_index(&mut tools);
        tools
    }

    // ------------------------------------------------------------ bonus formulas

    fn stat(&self, hrid: &str, stat: &str) -> f64 {
        let Some(item) = self.gdc.get_item(hrid).filter(|i| truthy(i)) else { return 0.0 };
        float_or_zero(child(child(item, "equipmentDetail"), "noncombatStats"), stat)
    }

    pub fn compute_guzzling_bonus(&self, cfg: &EnhancementConfig) -> f64 {
        if !cfg.use_guzzling {
            return 1.0;
        }
        let base = self.stat(HRID_GUZZLING_POUCH, "drinkConcentration");
        let temp = base * 100.0 * ENHANCE_BONUS[cfg.guzzling_level];
        1.0 + temp / 100.0
    }

    pub fn compute_enhancer_bonus(&self, cfg: &EnhancementConfig) -> f64 {
        self.stat(&cfg.enhancer_hrid, "enhancingSuccess") * 100.0 * ENHANCE_BONUS[cfg.enhancer_level]
    }

    /// Sum of the character's achievement `enhancing_success` buffs, in percentage points.
    pub fn compute_achievement_success_bonus(&self, cfg: &EnhancementConfig) -> f64 {
        if !cfg.use_achievement_success {
            return 0.0;
        }
        let mut pct = 0.0;
        for b in achievement_buffs(&self.gdc.character) {
            if str_of(b, "typeHrid") == "/buff_types/enhancing_success" {
                pct += float_or_zero(b, "ratioBoost") * 100.0;
            }
        }
        pct
    }

    fn effective_level(cfg: &EnhancementConfig, g: f64) -> f64 {
        let boost = if cfg.tea_enhancing {
            3.0 * g
        } else if cfg.tea_super_enhancing {
            6.0 * g
        } else if cfg.tea_ultra_enhancing {
            8.0 * g
        } else {
            0.0
        };
        cfg.enhancing_level + boost
    }

    pub fn compute_total_bonus(&self, cfg: &EnhancementConfig, item_level: i64) -> f64 {
        let il = item_level as f64;
        let g = self.compute_guzzling_bonus(cfg);
        let eff = Self::effective_level(cfg, g);
        let enh_pct = self.compute_enhancer_bonus(cfg);
        let ach_pct = self.compute_achievement_success_bonus(cfg);
        if eff >= il {
            1.0 + (0.05 * (eff + cfg.observatory_level - il) + enh_pct + ach_pct) / 100.0
        } else {
            (1.0 - 0.5 * (1.0 - eff / il)) + (0.05 * cfg.observatory_level + enh_pct + ach_pct) / 100.0
        }
    }

    pub fn compute_attempt_time(&self, cfg: &EnhancementConfig, item_level: i64) -> f64 {
        let il = item_level as f64;
        let g = self.compute_guzzling_bonus(cfg);
        let eff = Self::effective_level(cfg, g);
        let speed = |hrid: &str, level: usize, philo: bool| -> f64 {
            if philo {
                // philosopher's necklace gets 5x scaling on the enhancement bonus
                self.stat(hrid, "skillingSpeed") * 100.0 * (((ENHANCE_BONUS[level] - 1.0) * 5.0) + 1.0)
            } else {
                self.stat(hrid, "enhancingSpeed") * 100.0 * ENHANCE_BONUS[level]
            }
        };
        let mut item_bonus = 0.0;
        if cfg.use_enchanted {
            item_bonus += speed(HRID_ENCHANTED_GLOVES, cfg.enchanted_level, false);
        }
        if cfg.use_enhancer_top {
            item_bonus += speed(HRID_ENHANCERS_TOP, cfg.enhancer_top_level, false);
        }
        if cfg.use_enhancer_bot {
            item_bonus += speed(HRID_ENHANCERS_BOTTOMS, cfg.enhancer_bot_level, false);
        }
        if cfg.use_philo_neck {
            item_bonus += speed(HRID_PHILOSOPHERS_NECKLACE, cfg.philo_neck_level, true);
        }
        if cfg.use_enhancing_buff {
            item_bonus += 19.5 + cfg.enhancing_buff_level * 0.5;
        }
        let tea_speed = if cfg.tea_enhancing {
            2.0 * g
        } else if cfg.tea_super_enhancing {
            4.0 * g
        } else if cfg.tea_ultra_enhancing {
            6.0 * g
        } else {
            0.0
        };
        let term = if cfg.enhancing_level > il {
            (eff + cfg.observatory_level - il + item_bonus + tea_speed) / 100.0
        } else {
            (cfg.observatory_level + item_bonus + tea_speed) / 100.0
        };
        12.0 / (1.0 + term)
    }

    pub fn compute_xp_bonus(&self, cfg: &EnhancementConfig) -> f64 {
        let g = self.compute_guzzling_bonus(cfg);
        let mut bonus = 0.0;
        if cfg.tea_wisdom {
            bonus += 0.12 * g;
        }
        bonus += self.stat(&cfg.enhancer_hrid, "enhancingExperience") * ENHANCE_BONUS[cfg.enhancer_level];
        if cfg.use_enhancer_bot {
            bonus += self.stat(HRID_ENHANCERS_BOTTOMS, "enhancingExperience") * ENHANCE_BONUS[cfg.enhancer_bot_level];
        }
        if cfg.use_philo_neck {
            bonus += self.stat(HRID_PHILOSOPHERS_NECKLACE, "skillingExperience")
                * (((ENHANCE_BONUS[cfg.philo_neck_level] - 1.0) * 5.0) + 1.0);
        }
        if cfg.use_charm {
            let charm = format!("/items/{}_enhancing_charm", cfg.charm_tier);
            bonus += self.stat(&charm, "enhancingExperience") * (((ENHANCE_BONUS[cfg.charm_level] - 1.0) * 5.0) + 1.0);
        }
        if cfg.use_experience_buff {
            bonus += 0.195 + cfg.experience_buff_level * 0.005;
        }
        bonus
    }

    /// XP per attempt at a given pre-attempt level.
    pub fn cal_exp(item_level: i64, enhance_level: usize) -> f64 {
        1.4 * (1 + enhance_level) as f64 * (10 + item_level) as f64
    }

    // ------------------------------------------------------------ Markov solver

    fn success_chances(total_bonus: f64, target: usize) -> Vec<f64> {
        (0..target).map(|i| SUCCESS_RATE_PCT[i] / 100.0 * total_bonus).collect()
    }

    /// (target+1)^2 transition matrix and the per-level success chances; index -1 wraps like numpy.
    pub fn build_markov(&self, cfg: &EnhancementConfig, total_bonus: f64, target: usize, protect_at: i64) -> (Vec<Vec<f64>>, Vec<f64>) {
        let g = self.compute_guzzling_bonus(cfg);
        let n = target + 1;
        let mut p = vec![vec![0.0; n]; n];
        let sc = Self::success_chances(total_bonus, target);
        for (i, &s) in sc.iter().enumerate() {
            let mut rs = s;
            let rf = 1.0 - s;
            let dest = if i as i64 >= protect_at { py_index(n, i as i64 - 1).unwrap_or(0) } else { 0 };
            if cfg.tea_blessed && i + 2 < n {
                p[i][i + 2] = s * 0.01 * g;
                rs = s * (1.0 - 0.01 * g);
            }
            p[i][i + 1] = rs;
            p[i][dest] += rf;
        }
        p[target][target] = 1.0;
        (p, sc)
    }

    /// Closed-form expectation. Only row 0 of `(I-Q)^-1` is used, so solve `(I-Q)^T x = e0`.
    /// Err when `I-Q` is singular (Python falls back to `pinv`; the twin answers 500).
    pub fn expected_outcome(&self, cfg: &EnhancementConfig, item: &Value, target: usize, protect_at: i64) -> Result<ExpectedOutcome, String> {
        let il = item_level(item);
        let total_bonus = self.compute_total_bonus(cfg, il);
        let attempt_time = self.compute_attempt_time(cfg, il);
        let xp_bonus = self.compute_xp_bonus(cfg);
        let (p, sc) = self.build_markov(cfg, total_bonus, target, protect_at);
        let a: Vec<Vec<f64>> =
            (0..target).map(|r| (0..target).map(|c| if r == c { 1.0 } else { 0.0 } - p[c][r]).collect()).collect();
        let mut e0 = vec![0.0; target];
        if target > 0 {
            e0[0] = 1.0;
        }
        let visits = solve(a, e0).ok_or("singular Markov matrix")?;
        let actions: f64 = visits.iter().sum();
        let mut protects = 0.0;
        for i in protect_at.max(0) as usize..target {
            protects += visits[i] * p[i][py_index(target + 1, i as i64 - 1).unwrap_or(0)];
        }
        let mut xp = 0.0;
        for (i, &s) in sc.iter().enumerate() {
            xp += visits[i] * (s + 0.1 * (1.0 - s)) * (1.0 + xp_bonus) * Self::cal_exp(il, i);
        }
        Ok(ExpectedOutcome { actions, protects, xp, attempt_time, mat_cost: 0.0, total_cost: 0.0 })
    }

    // ------------------------------------------------------------ cost layer

    /// Per-step material (counts, unit prices) and coin count; `material_unit_costs` wins positionally.
    fn step_materials(&mut self, item: &Value, material_unit_costs: Option<&[f64]>) -> (Vec<f64>, Vec<f64>, f64) {
        let mut coin_per_step = 0.0;
        let mut counts = Vec::new();
        let mut units: Vec<f64> = Vec::new();
        for c in list(child(item, "enhancementCosts")) {
            let count = c.get("count").and_then(Value::as_f64).unwrap_or(0.0);
            let hrid = str_of(c, "itemHrid");
            if hrid == HRID_COIN {
                coin_per_step += count;
            } else {
                counts.push(count);
                match material_unit_costs {
                    Some(m) if units.len() < m.len() => units.push(m[units.len()]),
                    _ => units.push(self.full_item_price(hrid)),
                }
            }
        }
        (counts, units, coin_per_step)
    }

    pub fn attach_costs(
        &mut self,
        outcome: &mut ExpectedOutcome,
        item: &Value,
        cfg: &EnhancementConfig,
        protect_price: f64,
        base_price: f64,
        material_unit_costs: Option<&[f64]>,
    ) {
        let (counts, units, coin_per_step) = self.step_materials(item, material_unit_costs);
        let actions = outcome.actions;
        let coin_unit_value = self.full_item_price(HRID_COIN);
        let mut mat = 0.0;
        for (cnt, pr) in counts.iter().zip(&units) {
            mat += cnt * actions * pr;
        }
        mat += protect_price * outcome.protects;
        mat += coin_per_step * actions * coin_unit_value;
        outcome.mat_cost = mat;
        outcome.total_cost = if self.iron_cow {
            // Iron Cow: the unit is time, so the enhancing seconds themselves are cost.
            base_price + mat + outcome.attempt_time * actions
        } else {
            (base_price + mat + cfg.hourly_rate * outcome.attempt_time * actions / 3600.0) * (cfg.percent_rate / 100.0 + 1.0)
        };
    }

    /// Philosopher's-Mirror Fibonacci plan. Flask always resolves the mirror price first.
    #[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
    pub fn mirror_plan(
        &mut self,
        cfg: &EnhancementConfig,
        item: &Value,
        target_max: usize,
        protect_price: f64,
        base_price: f64,
        material_unit_costs: Option<&[f64]>,
        mirror_cost: f64,
    ) -> Result<MirrorPlan, String> {
        if target_max < 3 {
            return Ok(MirrorPlan::default());
        }
        let mut target_costs = vec![0.0; target_max + 1];
        for n in 2..=target_max {
            let mut best = f64::INFINITY;
            for prot in 2..=n {
                let mut o = self.expected_outcome(cfg, item, n, prot as i64)?;
                self.attach_costs(&mut o, item, cfg, protect_price, base_price, material_unit_costs);
                if o.total_cost < best {
                    best = o.total_cost;
                }
            }
            target_costs[n] = best;
        }
        // Cheaper rungs feed later ones, exactly as the JS updates in place.
        let mut mirror_at: Option<usize> = None;
        for n in 4..=target_max {
            let mirrored = target_costs[n - 2] + target_costs[n - 1] + mirror_cost;
            if mirrored < target_costs[n] {
                if mirror_at.is_none_or(|m| n < m) {
                    mirror_at = Some(n);
                }
                target_costs[n] = mirrored;
            }
        }
        let Some(m) = mirror_at else { return Ok(MirrorPlan::default()) };
        let depth = target_max - m;
        let (lower, upper, mirrors) = (fib(depth), fib(depth + 1), mirror_fib(depth));
        Ok(MirrorPlan {
            triggered: true,
            mirror_at: m,
            num_lower_fodder: lower,
            num_upper_fodder: upper,
            num_mirrors: mirrors,
            cost_lower_fodder: target_costs[m - 2],
            cost_upper_fodder: target_costs[m - 1],
            cost_mirror_each: mirror_cost,
            grand_total: target_costs[m - 2] * lower as f64 + target_costs[m - 1] * upper as f64 + mirror_cost * mirrors as f64,
        })
    }

    /// Essence yield when decomposing a +target item (an unknown catalyst means `none`).
    pub fn decomposition_value(&mut self, item_level: i64, target: usize, catalyst: &str) -> Value {
        let (key, mult, hrid, label) = DECOMP_CATALYSTS.iter().copied().find(|c| c.0 == catalyst).unwrap_or(DECOMP_CATALYSTS[0]);
        let idealised = py_round_int(2.0 * (0.5 + 0.1 * 1.05f64.powf(item_level as f64)) * 2f64.powi(target as i32));
        let raw_rate = BASE_DECOMP_SUCCESS_RATE * CATALYTIC_TEA_MULTIPLIER * mult;
        let effective = raw_rate.min(1.0);
        let realised = (idealised as f64 * effective).floor() as i64;
        let essence_price = self.full_item_price(HRID_ENHANCING_ESSENCE);
        let catalyst_price = hrid.map_or(0.0, |h| self.full_item_price(h));
        json!({
            "essence_count_idealised": idealised,
            "essence_count": realised,
            "base_success_rate": BASE_DECOMP_SUCCESS_RATE,
            "tea_multiplier": CATALYTIC_TEA_MULTIPLIER,
            "catalyst_multiplier": mult,
            "effective_success_rate": effective,
            "cap_hit": raw_rate > 1.0,
            "catalyst": key,
            "catalyst_label": label,
            "catalyst_hrid": hrid,
            "catalyst_price": catalyst_price,
            "essence_price": essence_price,
        })
    }

    /// Recursive item cost: coin price in market mode, seconds in Iron Cow (coin = 0).
    pub fn full_item_price(&mut self, hrid: &str) -> f64 {
        if hrid.is_empty() {
            return 0.0;
        }
        if self.iron_cow {
            if hrid == HRID_COIN {
                return 0.0;
            }
            if let Some(&v) = self.price_cache.get(hrid) {
                return v;
            }
            let gdc = self.gdc;
            let boots = &self.bootstraps;
            let calc = self.iv_calc.get_or_insert_with(|| ItemValueCalculator::new(gdc, Some(boots).filter(|b| !b.is_empty())));
            let value = calc.value(hrid);
            self.price_cache.insert(hrid.to_string(), value);
            return value;
        }
        if hrid == HRID_COIN {
            return 1.0;
        }
        if let Some(&v) = self.price_cache.get(hrid) {
            return v;
        }
        let gdc: &'a Gdc = self.gdc;
        let Some(item) = gdc.get_item(hrid) else { return 0.0 };
        // Python would hit RecursionError (500) on a recipe cycle; this placeholder makes a cycle finite.
        self.price_cache.insert(hrid.to_string(), 0.0);
        let is_equipment = str_of(item, "categoryHrid") == "/item_categories/equipment";
        let mut final_cost = 0.0;
        let mut is_base = true;
        if is_equipment || hrid == HRID_PHILOSOPHERS_MIRROR {
            let actions = gdc.data.get("actionDetailMap").and_then(Value::as_object).into_iter().flatten();
            for (_, action) in actions {
                if str_of(action, "function") != "/action_functions/production" || !truthy(child(action, "outputItems")) {
                    continue;
                }
                if list(&action["outputItems"]).first().map(|o| str_of(o, "itemHrid")) != Some(hrid) {
                    continue;
                }
                is_base = false;
                for input in list(child(action, "inputItems")) {
                    let count = input.get("count").and_then(Value::as_f64).unwrap_or(0.0);
                    let mut sub_cost = count * self.full_item_price(str_of(input, "itemHrid"));
                    if hrid.contains("charm") {
                        sub_cost *= 0.90; // cheaper for charms (main.js 222)
                    }
                    final_cost += sub_cost;
                }
                let up = str_of(action, "upgradeItemHrid");
                if !up.is_empty() {
                    final_cost += self.full_item_price(up);
                }
                break;
            }
        }
        if is_base {
            if hrid.contains("trainee") && hrid.contains("charm") {
                self.price_cache.insert(hrid.to_string(), 250000.0);
                return 250000.0;
            }
            let vendor = float_or_zero(item, "sellPrice");
            // Market ask by Title-Case name, else -1.0 (as Flask).
            let ask = self.market.get(&from_hrid(hrid)).copied().unwrap_or(-1.0);
            final_cost = if ask <= 0.0 { vendor } else { ask };
        }
        self.price_cache.insert(hrid.to_string(), final_cost);
        final_cost
    }

    /// Default protection price: the mirror of protection, or a cheaper non-refined
    /// `protectionItemHrids` entry (a zero price never wins).
    pub fn cheapest_protection(&mut self, item: &Value) -> f64 {
        let mut min_cost = self.full_item_price(HRID_MIRROR_OF_PROTECTION);
        for ph in list(child(item, "protectionItemHrids")) {
            let ph = ph.as_str().unwrap_or("");
            if ph.contains("_refined") {
                continue;
            }
            let pc = self.full_item_price(ph);
            if pc != 0.0 && pc < min_cost {
                min_cost = pc;
            }
        }
        min_cost
    }

    // ------------------------------------------------------------ Monte Carlo

    /// Independently sorted per-metric percentiles over `n` sampled runs. Err only
    /// where Python raises IndexError (`protect_at` 0 lets the level go negative).
    #[allow(clippy::too_many_arguments)]
    pub fn monte_carlo(
        &mut self,
        cfg: &EnhancementConfig,
        item: &Value,
        target: usize,
        protect_at: i64,
        n: usize,
        material_unit_costs: Option<&[f64]>,
        protect_price: Option<f64>,
        base_price: Option<f64>,
        money_i_have: f64,
        rng: &mut Mt19937,
    ) -> Result<SimulationResult, String> {
        let il = item_level(item);
        let total_bonus = self.compute_total_bonus(cfg, il);
        let attempt_time = self.compute_attempt_time(cfg, il);
        let g = self.compute_guzzling_bonus(cfg);
        let xp_bonus = self.compute_xp_bonus(cfg);
        let sc = Self::success_chances(total_bonus, target);
        let xp_per_attempt: Vec<f64> = (0..target).map(|i| (1.0 + xp_bonus) * Self::cal_exp(il, i)).collect();

        let (counts, units, coin_per_step) = self.step_materials(item, material_unit_costs);
        let coin_unit_value = self.full_item_price(HRID_COIN);
        let mut step_price = 0.0;
        for (cnt, pr) in counts.iter().zip(&units) {
            step_price += cnt * pr;
        }
        step_price += coin_per_step * coin_unit_value;

        let protect_price = match protect_price {
            Some(p) => p,
            None => self.cheapest_protection(item),
        };
        let base_price = match base_price {
            Some(b) => b,
            None => self.full_item_price(str_of(item, "hrid")),
        };

        let mut s_cost = Vec::with_capacity(n);
        let mut s_actions = Vec::with_capacity(n);
        let mut s_protects = Vec::with_capacity(n);
        let mut s_xp = Vec::with_capacity(n);
        let target_i = target as i64;
        for _ in 0..n {
            let (mut level, mut actions, mut protects, mut cost, mut xp) = (0i64, 0i64, 0i64, 0.0f64, 0.0f64);
            while level < target_i {
                let idx = py_index(target, level).ok_or("list index out of range")?;
                cost += step_price;
                let step_xp = xp_per_attempt[idx];
                if rng.random() < sc[idx] {
                    xp += step_xp;
                    if cfg.tea_blessed && rng.random() < 0.01 * g && level + 2 <= target_i {
                        level += 2;
                    } else {
                        level += 1;
                    }
                } else {
                    xp += 0.1 * step_xp;
                    if level >= protect_at {
                        cost += protect_price;
                        level -= 1;
                        protects += 1;
                    } else {
                        level = 0;
                    }
                }
                actions += 1;
            }
            s_cost.push(cost);
            s_actions.push(actions);
            s_protects.push(protects);
            s_xp.push(xp);
        }
        s_cost.sort_by(f64::total_cmp);
        s_actions.sort_unstable();
        s_protects.sort_unstable();
        s_xp.sort_by(f64::total_cmp);

        let at = |p: f64| ((n as f64 * p).floor() as usize).min(n.saturating_sub(1));
        let mut percentiles = Map::new();
        for pct in [25, 50, 75, 90, 95, 99] {
            let i = at(pct as f64 / 100.0);
            let (cost_p, actions_p, protects_p, xp_p) = (s_cost[i], s_actions[i], s_protects[i], s_xp[i]);
            let time_seconds = attempt_time * actions_p as f64;
            let ttl = if self.iron_cow {
                base_price + cost_p + time_seconds
            } else {
                (base_price + cost_p + cfg.hourly_rate * time_seconds / 3600.0) * (cfg.percent_rate / 100.0 + 1.0)
            };
            percentiles.insert(
                pct.to_string(),
                json!({
                    "cost": cost_p,
                    "mat_cost": cost_p,
                    "actions": actions_p,
                    "protects": protects_p,
                    "xp": xp_p,
                    "time_seconds": time_seconds,
                    "exp_per_hour": if time_seconds > 0.0 { xp_p / (time_seconds / 3600.0) } else { 0.0 },
                    "total_cost": ttl,
                }),
            );
        }

        // np.searchsorted(side='right'): the first index whose cost exceeds the budget.
        let success_rate_with_coins = (money_i_have > 0.0).then(|| {
            let mat_coins = money_i_have - base_price;
            let idx = s_cost.partition_point(|c| *c <= mat_coins);
            if idx >= s_cost.len() { 100.0 } else { idx as f64 / s_cost.len() as f64 * 100.0 }
        });

        Ok(SimulationResult { n_samples: n, percentiles, attempt_time, success_rate_with_coins, money_i_have })
    }

    // ------------------------------------------------------------ from character

    /// `config_from_character`: skill, observatory, equipped buff gear, teas, community and achievement buffs.
    pub fn config_from_character(&self) -> EnhancementConfig {
        let mut cfg = EnhancementConfig::default();
        let ch: &Value = &self.gdc.character;
        let int_of = |v: Option<&Value>, d: i64| v.map_or(d, py_int);

        if let Some(s) = list(child(ch, "characterSkills")).iter().find(|s| str_of(s, "skillHrid") == "/skills/enhancing") {
            cfg.enhancing_level = int_of(s.get("level"), 1) as f64;
        }
        let room = child(child(ch, "characterHouseRoomMap"), "/house_rooms/observatory");
        cfg.observatory_level = int_of(room.get("level"), 0).clamp(0, 8) as f64;

        // Python's dict comprehension: the last item per hrid wins, at the first one's position.
        let mut detected: IndexMap<&str, &Value> = IndexMap::new();
        for it in list(child(ch, "characterItems")) {
            if !str_of(it, "itemLocationHrid").starts_with("/item_locations/inventory") {
                detected.insert(str_of(it, "itemHrid"), it);
            }
        }
        // shortcut: levels clamp to the 0..20 table; Python would index (or IndexError) past it.
        let enh_level = |it: &Value| int_of(it.get("enhancementLevel"), 0).clamp(0, 20) as usize;

        if let Some(it) = detected.values().find(|it| str_of(it, "itemLocationHrid") == "/item_locations/enhancing_tool") {
            cfg.enhancer_hrid = str_of(it, "itemHrid").to_string();
            cfg.enhancer_level = enh_level(it);
        }
        let check = |hrid: &str| detected.get(hrid).map(|it| enh_level(it));
        if let Some(l) = check(HRID_GUZZLING_POUCH) {
            (cfg.use_guzzling, cfg.guzzling_level) = (true, l);
        }
        if let Some(l) = check(HRID_ENCHANTED_GLOVES) {
            (cfg.use_enchanted, cfg.enchanted_level) = (true, l);
        }
        if let Some(l) = check(HRID_ENHANCERS_TOP) {
            (cfg.use_enhancer_top, cfg.enhancer_top_level) = (true, l);
        }
        if let Some(l) = check(HRID_ENHANCERS_BOTTOMS) {
            (cfg.use_enhancer_bot, cfg.enhancer_bot_level) = (true, l);
        }
        if let Some(l) = check(HRID_PHILOSOPHERS_NECKLACE) {
            (cfg.use_philo_neck, cfg.philo_neck_level) = (true, l);
        }

        for it in detected.values().filter(|it| str_of(it, "itemLocationHrid") == "/item_locations/charm") {
            let ih = str_of(it, "itemHrid");
            if let Some(tier) = CHARM_TIERS.iter().find(|t| ih == format!("/items/{t}_enhancing_charm")) {
                cfg.use_charm = true;
                cfg.charm_tier = tier.to_string();
                cfg.charm_level = enh_level(it);
            }
        }

        for slot in list(child(child(ch, "actionTypeDrinkSlotsMap"), "/action_types/enhancing")) {
            if !truthy(slot) || !truthy(child(slot, "isActive")) {
                continue;
            }
            match str_of(slot, "itemHrid") {
                "/items/enhancing_tea" => cfg.tea_enhancing = true,
                "/items/super_enhancing_tea" => cfg.tea_super_enhancing = true,
                "/items/ultra_enhancing_tea" => cfg.tea_ultra_enhancing = true,
                "/items/blessed_tea" => cfg.tea_blessed = true,
                "/items/wisdom_tea" => cfg.tea_wisdom = true,
                _ => {}
            }
        }

        for b in list(child(child(ch, "communityActionTypeBuffsMap"), "/action_types/enhancing")) {
            let uniq = str_of(b, "uniqueHrid");
            let flat = b.get("flatBoost").and_then(py_float).unwrap_or(0.0);
            if uniq == "/buff_uniques/enhancing_community_buff" && flat > 0.0 {
                cfg.use_enhancing_buff = true;
                cfg.enhancing_buff_level = py_round_int((flat * 100.0 - 19.5) / 0.5).clamp(1, 20) as f64;
            } else if uniq == "/buff_uniques/experience_community_buff" && flat > 0.0 {
                cfg.use_experience_buff = true;
                cfg.experience_buff_level = py_round_int((flat - 0.195) / 0.005).clamp(1, 20) as f64;
            }
        }

        if achievement_buffs(ch).iter().any(|b| str_of(b, "typeHrid") == "/buff_types/enhancing_success") {
            cfg.use_achievement_success = true;
        }
        cfg
    }
}

fn achievement_buffs(ch: &Value) -> &[Value] {
    list(child(child(ch, "achievementActionTypeBuffsMap"), "/action_types/enhancing"))
}

/// Python's stable `sort(key=lambda x: x['sortIndex'])`.
fn sort_by_index(v: &mut [Value]) {
    v.sort_by(|a, b| a["sortIndex"].as_f64().unwrap_or(0.0).total_cmp(&b["sortIndex"].as_f64().unwrap_or(0.0)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, LazyLock};

    static NO_MARKET: LazyLock<HashMap<String, f64>> = LazyLock::new(HashMap::new);

    fn gdc() -> Gdc {
        let data = json!({"itemDetailMap": {
            "/items/enhancing_essence": {"hrid": "/items/enhancing_essence", "sellPrice": 40},
            "/items/milk": {"hrid": "/items/milk", "sellPrice": 3},
        }});
        Gdc::new(Arc::new(data), Arc::new(json!({})))
    }

    fn cfg(level: f64) -> EnhancementConfig {
        EnhancementConfig { enhancing_level: level, ..Default::default() }
    }

    #[test]
    fn total_bonus_above_and_below_item_level() {
        let g = gdc();
        let sim = EnhanceSim::new(&g, &NO_MARKET, false, None);
        assert!((sim.compute_total_bonus(&cfg(50.0), 10) - 1.020).abs() < 1e-12);
        assert!((sim.compute_total_bonus(&cfg(10.0), 20) - 0.75).abs() < 1e-12);
    }

    #[test]
    fn attempt_time_and_xp_bonus() {
        let g = gdc();
        let sim = EnhanceSim::new(&g, &NO_MARKET, false, None);
        assert_eq!(sim.compute_attempt_time(&cfg(10.0), 10), 12.0);
        // 20 levels over the item -> 12 / 1.2
        assert!((sim.compute_attempt_time(&cfg(30.0), 10) - 10.0).abs() < 1e-12);
        let c = EnhancementConfig { tea_wisdom: true, use_experience_buff: true, experience_buff_level: 20.0, ..Default::default() };
        assert!((sim.compute_xp_bonus(&c) - (0.12 + 0.295)).abs() < 1e-12);
    }

    #[test]
    fn cal_exp_formula() {
        assert!((EnhanceSim::cal_exp(90, 0) - 140.0).abs() < 1e-12);
        assert!((EnhanceSim::cal_exp(90, 4) - 700.0).abs() < 1e-9);
    }

    #[test]
    fn mirror_fib_counts() {
        assert_eq!((0..6).map(fib).collect::<Vec<_>>(), [1, 1, 2, 3, 5, 8]);
        assert_eq!((0..5).map(mirror_fib).collect::<Vec<_>>(), [1, 2, 4, 7, 12]);
        // A mirror joins two items, so a plan with lower + upper fodder needs one fewer mirror.
        for d in 0..8 {
            assert_eq!(mirror_fib(d), fib(d) + fib(d + 1) - 1);
        }
    }

    #[test]
    fn decomposition_value_floor_round() {
        let g = gdc();
        let mut sim = EnhanceSim::new(&g, &NO_MARKET, false, None);
        let d = sim.decomposition_value(100, 20, "none");
        let idealised = (2.0 * (0.5 + 0.1 * 1.05f64.powf(100.0)) * 2f64.powi(20)).round_ties_even() as i64;
        assert_eq!(d["essence_count_idealised"], json!(idealised));
        assert_eq!(d["essence_count"], json!((idealised as f64 * 0.525).floor() as i64));
        assert_eq!(d["essence_price"], json!(40.0));
        assert_eq!(d["catalyst_hrid"], Value::Null);
        assert_eq!(sim.decomposition_value(100, 20, "bogus")["catalyst"], "none");
        let prime = sim.decomposition_value(100, 20, "prime");
        assert_eq!(prime["cap_hit"], false);
        assert!((prime["effective_success_rate"].as_f64().unwrap() - 0.65625).abs() < 1e-12);
    }

    #[test]
    fn markov_rows_sum_to_one() {
        let g = gdc();
        let sim = EnhanceSim::new(&g, &NO_MARKET, false, None);
        let c = EnhancementConfig { tea_blessed: true, ..Default::default() };
        for prot in [1, 2, 5] {
            let (p, _) = sim.build_markov(&c, 1.1, 10, prot);
            for row in &p {
                assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn solve_two_by_two() {
        // 2x + y = 5, x + 3y = 10 -> x = 1, y = 3
        let x = solve(vec![vec![2.0, 1.0], vec![1.0, 3.0]], vec![5.0, 10.0]).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-12 && (x[1] - 3.0).abs() < 1e-12);
        assert!(solve(vec![vec![1.0, 2.0], vec![2.0, 4.0]], vec![1.0, 1.0]).is_none());
    }

    #[test]
    fn expected_outcome_single_step() {
        // target 1 at 50% x 1.0: geometric, 2 expected actions, no protects.
        let g = gdc();
        let sim = EnhanceSim::new(&g, &NO_MARKET, false, None);
        let o = sim.expected_outcome(&cfg(100.0), &json!({"itemLevel": 100}), 1, 1).unwrap();
        assert!((o.actions - 2.0).abs() < 1e-12);
        assert_eq!(o.protects, 0.0);
    }

    #[test]
    fn attach_costs_includes_protect_and_coin() {
        let g = gdc();
        let mut sim = EnhanceSim::new(&g, &NO_MARKET, false, None);
        let c = EnhancementConfig { hourly_rate: 0.0, percent_rate: 0.0, ..Default::default() };
        let item = json!({"enhancementCosts": [{"itemHrid": "/items/milk", "count": 2}, {"itemHrid": "/items/coin", "count": 10}]});
        let mut o = ExpectedOutcome { actions: 100.0, protects: 5.0, xp: 50.0, attempt_time: 12.0, ..Default::default() };
        sim.attach_costs(&mut o, &item, &c, 20.0, 0.0, Some(&[3.0]));
        assert_eq!(o.mat_cost, 1700.0);
        assert_eq!(o.total_cost, 1700.0);
    }

    #[test]
    fn coin_price_by_mode() {
        let g = gdc();
        assert_eq!(EnhanceSim::new(&g, &NO_MARKET, false, None).full_item_price(HRID_COIN), 1.0);
        assert_eq!(EnhanceSim::new(&g, &NO_MARKET, true, None).full_item_price(HRID_COIN), 0.0);
    }

    #[test]
    fn config_parsing() {
        assert!(EnhancementConfig::from_json(&json!({"guzzling_level": 21})).is_err());
        let c = EnhancementConfig::from_json(&json!({"enhancing_level": 120.5, "junk": 1})).unwrap();
        assert_eq!(c.enhancing_level, 120.5);
        assert_eq!(c.hourly_rate, 5_000_000.0);
    }
}
