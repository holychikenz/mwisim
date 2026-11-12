//! `cow/character_stats.py`: per-skill speed/efficiency/level stats and their sources (WP1).

use crate::Gdc;
use crate::util::{child, py_round, py_title, truthy};
use indexmap::IndexMap;
use serde_json::{Value, json};

/// One contribution to a bonus.
#[derive(Clone, Debug, PartialEq)]
pub struct BonusSource {
    pub source: String,
    pub name: String,
    pub value: f64,
}

fn src(source: &str, name: &str, value: f64) -> BonusSource {
    BonusSource { source: source.into(), name: name.into(), value }
}

#[derive(Clone, Debug, Default)]
pub struct SkillStats {
    pub skill_name: String,
    pub skill_hrid: String,
    /// The raw `level` value (kept as JSON so ints stay ints in output).
    pub level: Value,
    pub speed: f64,
    pub speed_sources: Vec<BonusSource>,
    pub efficiency: f64,
    pub efficiency_sources: Vec<BonusSource>,
    pub artisan: f64,
    pub artisan_sources: Vec<BonusSource>,
    pub gourmet: f64,
    pub gourmet_sources: Vec<BonusSource>,
    pub gathering_quantity: f64,
    pub gathering_sources: Vec<BonusSource>,
    pub rare_find: f64,
    pub rare_find_sources: Vec<BonusSource>,
    pub processing: f64,
    pub processing_sources: Vec<BonusSource>,
    pub level_bonus: f64,
    pub level_sources: Vec<BonusSource>,
}

impl SkillStats {
    pub fn level_f64(&self) -> f64 {
        self.level.as_f64().unwrap_or(0.0)
    }
}

const POUCH_EQUIPMENT_TYPE: &str = "/equipment_types/pouch";

pub const SKILL_TO_ACTION_TYPE: [(&str, &str); 10] = [
    ("/skills/milking", "/action_types/milking"),
    ("/skills/foraging", "/action_types/foraging"),
    ("/skills/woodcutting", "/action_types/woodcutting"),
    ("/skills/cheesesmithing", "/action_types/cheesesmithing"),
    ("/skills/crafting", "/action_types/crafting"),
    ("/skills/tailoring", "/action_types/tailoring"),
    ("/skills/cooking", "/action_types/cooking"),
    ("/skills/brewing", "/action_types/brewing"),
    ("/skills/alchemy", "/action_types/alchemy"),
    ("/skills/enhancing", "/action_types/enhancing"),
];

const GATHERING_SKILLS: [&str; 3] = ["/skills/milking", "/skills/foraging", "/skills/woodcutting"];

const GLOBAL_BUFF_MAPS: [(&str, &str); 6] = [
    ("communityActionTypeBuffsMap", "community"),
    ("houseActionTypeBuffsMap", "house"),
    ("achievementActionTypeBuffsMap", "achievement"),
    ("mooPassActionTypeBuffsMap", "moo_pass"),
    ("guildActionTypeBuffsMap", "guild"),
    ("personalActionTypeBuffsMap", "personal"),
];

const SKILLS_WITHOUT_GENERIC_BONUS: [&str; 1] = ["/skills/enhancing"];

fn is_gathering(skill_hrid: &str) -> bool {
    GATHERING_SKILLS.contains(&skill_hrid)
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn num(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `hrid.split('/')[-1].replace('_', ' ').title()`.
fn hrid_title(hrid: &str) -> String {
    py_title(&hrid.rsplit('/').next().unwrap_or(hrid).replace('_', " "))
}

/// Python's left-to-right `x += s.value` over the sources.
fn sum_into(start: f64, v: &[BonusSource]) -> f64 {
    v.iter().fold(start, |acc, s| acc + s.value)
}

fn piece_display_name(info: &Value, lvl: i64) -> String {
    let name = info.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("?");
    if lvl > 0 { format!("{name} +{lvl}") } else { name.to_string() }
}

pub struct CharacterStats<'a> {
    pub gdc: &'a Gdc,
    skill_stats: IndexMap<String, SkillStats>,
    drink_concentration: (f64, Option<String>),
}

impl<'a> CharacterStats<'a> {
    pub fn new(gdc: &'a Gdc) -> Self {
        let mut cs = CharacterStats { gdc, skill_stats: IndexMap::new(), drink_concentration: (0.0, None) };
        cs.drink_concentration = cs.calc_drink_concentration();
        cs.calculate_all_stats();
        cs
    }

    fn char(&self) -> &'a Value {
        &self.gdc.character
    }

    fn calc_drink_concentration(&self) -> (f64, Option<String>) {
        for item in arr(child(self.char(), "characterItems")) {
            let hrid = item.get("itemHrid").and_then(Value::as_str).unwrap_or("");
            let Some(info) = self.gdc.get_item(hrid) else { continue };
            let equip = child(info, "equipmentDetail");
            if equip.get("type").and_then(Value::as_str) != Some(POUCH_EQUIPMENT_TYPE) {
                continue;
            }
            let base = num(child(equip, "noncombatStats"), "drinkConcentration");
            if base <= 0.0 {
                continue;
            }
            let enh = item.get("enhancementLevel").and_then(Value::as_i64).unwrap_or(0);
            let mult = self.gdc.get_enhancement_bonus(enh.max(0) as usize);
            let total = base + num(child(equip, "noncombatEnhancementBonuses"), "drinkConcentration") * mult;
            let mut name = info.get("name").and_then(Value::as_str).unwrap_or("Pouch").to_string();
            if enh > 0 {
                name = format!("{name} +{enh}");
            }
            return (total, Some(name));
        }
        (0.0, None)
    }

    pub fn get_drink_concentration(&self) -> (f64, Option<&str>) {
        (self.drink_concentration.0, self.drink_concentration.1.as_deref())
    }

    fn calculate_all_stats(&mut self) {
        for skill in arr(child(self.char(), "characterSkills")) {
            let hrid = skill["skillHrid"].as_str().unwrap_or("");
            let Some(&(_, action_type)) = SKILL_TO_ACTION_TYPE.iter().find(|(s, _)| *s == hrid) else { continue };
            let mut st = SkillStats {
                skill_name: py_title(hrid.rsplit('/').next().unwrap_or(hrid)),
                skill_hrid: hrid.to_string(),
                level: skill["level"].clone(),
                speed: 1.0,
                ..Default::default()
            };
            self.calc_speed(&mut st, action_type);
            self.calc_efficiency(&mut st, action_type);
            if !is_gathering(hrid) {
                st.artisan_sources = self.global_and_tea(action_type, "/buff_types/artisan", "Artisan Tea");
                st.artisan = sum_into(0.0, &st.artisan_sources);
                st.gourmet_sources = self.global_and_tea(action_type, "/buff_types/gourmet", "Gourmet Tea");
                st.gourmet = sum_into(0.0, &st.gourmet_sources);
            }
            self.calc_rare_find(&mut st, action_type);
            st.processing_sources = self.global_and_tea(action_type, "/buff_types/processing", "Processing Tea");
            st.processing = sum_into(0.0, &st.processing_sources);
            self.calc_level_bonus(&mut st, action_type);
            if is_gathering(hrid) {
                self.calc_gathering(&mut st, action_type);
            }
            self.skill_stats.insert(hrid.to_string(), st);
        }
    }

    /// `_get_all_buff_values`: every positive match, in order.
    fn all_buff_values(buffs: &[Value], buff_type: &str) -> Vec<(f64, String)> {
        buffs
            .iter()
            .filter(|b| b.get("typeHrid").and_then(Value::as_str) == Some(buff_type))
            .filter_map(|b| {
                let value = num(b, "flatBoost") + num(b, "ratioBoost");
                let hrid = b.get("uniqueHrid").and_then(Value::as_str).unwrap_or("").to_string();
                (value > 0.0).then_some((value, hrid))
            })
            .collect()
    }

    fn global_buff_sources(&self, action_type: &str, buff_type: &str) -> Vec<BonusSource> {
        let mut out = Vec::new();
        for (map_name, label) in GLOBAL_BUFF_MAPS {
            let buffs = arr(child(child(self.char(), map_name), action_type));
            for (value, hrid) in Self::all_buff_values(buffs, buff_type) {
                let name = if hrid.is_empty() { format!("{} Bonus", py_title(&label.replace('_', " "))) } else { hrid_title(&hrid) };
                out.push(src(label, &name, value));
            }
        }
        out
    }

    fn tea_sources(&self, action_type: &str, buff_type: &str, fallback: &str) -> Vec<BonusSource> {
        let buffs = arr(child(child(self.char(), "consumableActionTypeBuffsMap"), action_type));
        let (dc, pouch) = self.get_drink_concentration();
        let mut out = Vec::new();
        for (value, hrid) in Self::all_buff_values(buffs, buff_type) {
            let tea = if hrid.is_empty() { fallback.to_string() } else { hrid_title(&hrid) };
            if dc > 0.0 {
                let base = value / (1.0 + dc);
                out.push(src("tea", &tea, base));
                out.push(src("pouch", pouch.unwrap_or(""), value - base));
            } else {
                out.push(src("tea", &tea, value));
            }
        }
        out
    }

    fn global_and_tea(&self, action_type: &str, buff_type: &str, fallback: &str) -> Vec<BonusSource> {
        let mut v = self.global_buff_sources(action_type, buff_type);
        v.extend(self.tea_sources(action_type, buff_type, fallback));
        v
    }

    /// The skill's own stat key, plus the neck's generic one except for enhancing.
    fn stat_keys(lower: &str, own: String, generic: &str) -> Vec<String> {
        if SKILLS_WITHOUT_GENERIC_BONUS.contains(&format!("/skills/{lower}").as_str()) {
            vec![own]
        } else {
            vec![own, generic.to_string()]
        }
    }

    fn calc_speed(&self, st: &mut SkillStats, action_type: &str) {
        let lower = st.skill_name.to_lowercase();
        let keys = Self::stat_keys(&lower, format!("{lower}Speed"), "skillingSpeed");
        for (info, lvl) in self.iter_loadout_pieces(action_type) {
            let total = self.piece_contribution(info, lvl, &keys);
            if total > 0.0 {
                st.speed += total;
                st.speed_sources.push(src("equipment", &piece_display_name(info, lvl), total));
            }
        }
        for s in self.global_buff_sources(action_type, "/buff_types/action_speed") {
            st.speed += s.value;
            st.speed_sources.push(s);
        }
    }

    fn calc_efficiency(&self, st: &mut SkillStats, action_type: &str) {
        let mut all = self.global_and_tea(action_type, "/buff_types/efficiency", "Tea");
        let lower = st.skill_name.to_lowercase();
        let keys = Self::stat_keys(&lower, format!("{lower}Efficiency"), "skillingEfficiency");
        for (info, lvl) in self.iter_loadout_pieces(action_type) {
            let total = self.piece_contribution(info, lvl, &keys);
            if total > 0.0 {
                all.push(src("equipment", &piece_display_name(info, lvl), total));
            }
        }
        st.efficiency = sum_into(0.0, &all);
        st.efficiency_sources = all;
    }

    /// `_get_loadout_for_action`: the default loadout for this action type, else the first.
    fn loadout_for_action(&self, action_type: &str) -> Option<&'a Value> {
        let candidates: Vec<&'a Value> = child(self.char(), "characterLoadoutMap")
            .as_object()
            .map(|m| m.values().filter(|lo| lo.get("actionTypeHrid").and_then(Value::as_str) == Some(action_type)).collect())
            .unwrap_or_default();
        candidates.iter().find(|lo| truthy(child(lo, "isDefault"))).or(candidates.first()).copied()
    }

    fn highest_owned_enhancement(&self, item_hrid: &str) -> Option<i64> {
        arr(child(self.char(), "characterItems"))
            .iter()
            .filter(|it| it.get("itemHrid").and_then(Value::as_str) == Some(item_hrid))
            .map(|it| it.get("enhancementLevel").and_then(Value::as_i64).unwrap_or(0))
            .max()
    }

    /// `_resolve_loadout_items`: slot order, `(item_hrid, effective level)`.
    fn resolve_loadout_items(&self, loadout: &Value) -> Vec<(String, i64)> {
        let use_exact = truthy(child(loadout, "useExactEnhancement"));
        let mut out = Vec::new();
        let Some(map) = child(loadout, "wearableMap").as_object() else { return out };
        for item_str in map.values() {
            let Some(s) = item_str.as_str().filter(|s| !s.is_empty()) else { continue };
            // <charID>::<source>::<itemHrid>::<enhanceLevel>
            let parts: Vec<&str> = s.split("::").collect();
            if parts.len() < 4 || parts[2].is_empty() {
                continue;
            }
            let encoded = crate::util::py_int_str(parts[3]).unwrap_or(0);
            let lvl = if use_exact { encoded } else { self.highest_owned_enhancement(parts[2]).unwrap_or(encoded) };
            out.push((parts[2].to_string(), lvl));
        }
        out
    }

    /// The skill's loadout pieces, else the currently equipped items.
    fn iter_loadout_pieces(&self, action_type: &str) -> Vec<(&'a Value, i64)> {
        if let Some(lo) = self.loadout_for_action(action_type) {
            return self
                .resolve_loadout_items(lo)
                .into_iter()
                .filter_map(|(h, l)| self.gdc.get_item(&h).map(|i| (i, l)))
                .collect();
        }
        arr(child(self.char(), "characterItems"))
            .iter()
            .filter(|it| {
                let loc = it.get("itemLocationHrid").and_then(Value::as_str).unwrap_or("");
                !loc.is_empty() && loc != "/item_locations/inventory"
            })
            .filter_map(|it| {
                let info = self.gdc.get_item(it.get("itemHrid").and_then(Value::as_str).unwrap_or(""))?;
                Some((info, it.get("enhancementLevel").and_then(Value::as_i64).unwrap_or(0)))
            })
            .collect()
    }

    fn piece_contribution(&self, info: &Value, lvl: i64, keys: &[String]) -> f64 {
        let equip = child(info, "equipmentDetail");
        let nc = child(equip, "noncombatStats");
        let nce = child(equip, "noncombatEnhancementBonuses");
        let mult = if lvl > 0 { self.gdc.get_enhancement_bonus(lvl as usize) } else { 0.0 };
        let mut total = 0.0;
        for k in keys {
            let (base, per) = (num(nc, k), num(nce, k));
            if base == 0.0 && per == 0.0 {
                continue;
            }
            total += base + per * mult;
        }
        total
    }

    fn calc_gathering(&self, st: &mut SkillStats, action_type: &str) {
        let g = num(child(self.char(), "noncombatStats"), "gatheringQuantity");
        if g > 0.0 {
            st.gathering_quantity += g;
            st.gathering_sources.push(src("equipment", "Earrings/Ring", g));
        }
        for s in self.global_and_tea(action_type, "/buff_types/gathering", "Gathering Tea") {
            st.gathering_quantity += s.value;
            st.gathering_sources.push(s);
        }
    }

    fn calc_rare_find(&self, st: &mut SkillStats, action_type: &str) {
        let lower = st.skill_name.to_lowercase();
        let keys = vec![format!("{lower}RareFind"), "skillingRareFind".to_string()];
        for (info, lvl) in self.iter_loadout_pieces(action_type) {
            let total = self.piece_contribution(info, lvl, &keys);
            if total > 0.0 {
                st.rare_find += total;
                st.rare_find_sources.push(src("equipment", &piece_display_name(info, lvl), total));
            }
        }
        for s in self.global_and_tea(action_type, "/buff_types/rare_find", "Rare Find Tea") {
            st.rare_find += s.value;
            st.rare_find_sources.push(s);
        }
    }

    /// Skill-level buffs raise the effective level; action-level buffs lower it.
    fn calc_level_bonus(&self, st: &mut SkillStats, action_type: &str) {
        let skill_level_buff = format!("/buff_types/{}_level", st.skill_name.to_lowercase());
        for s in self.global_and_tea(action_type, &skill_level_buff, "Skill Tea") {
            st.level_bonus += s.value;
            st.level_sources.push(s);
        }
        for s in self.global_and_tea(action_type, "/buff_types/action_level", "Action Level") {
            st.level_bonus -= s.value;
            st.level_sources.push(BonusSource { value: -s.value, ..s });
        }
    }

    pub fn get_skill_stats(&self, skill_hrid: &str) -> Option<&SkillStats> {
        self.skill_stats.get(skill_hrid)
    }

    pub fn get_all_stats(&self) -> &IndexMap<String, SkillStats> {
        &self.skill_stats
    }

    /// `get_stats_summary`: one row per modelled skill, level descending.
    pub fn get_stats_summary(&self) -> Vec<Value> {
        fn srcs(v: &[BonusSource]) -> Value {
            Value::Array(v.iter().map(|s| json!({"source": s.source, "name": s.name, "value": s.value})).collect())
        }
        fn pct(x: f64) -> String {
            if x > 0.0 { format!("+{:.1}%", x * 100.0) } else { "-".into() }
        }
        let mut rows: Vec<Value> = self
            .skill_stats
            .iter()
            .map(|(hrid, s)| {
                json!({
                    "skill_hrid": hrid,
                    "skill_name": s.skill_name,
                    "level": s.level,
                    "speed": py_round(s.speed, 4),
                    "speed_pct": format!("+{:.1}%", (s.speed - 1.0) * 100.0),
                    "speed_sources": srcs(&s.speed_sources),
                    "efficiency": py_round(s.efficiency, 4),
                    "efficiency_pct": format!("+{:.1}%", s.efficiency * 100.0),
                    "efficiency_sources": srcs(&s.efficiency_sources),
                    "artisan": py_round(s.artisan, 4),
                    "artisan_pct": pct(s.artisan),
                    "artisan_sources": srcs(&s.artisan_sources),
                    "gourmet": py_round(s.gourmet, 4),
                    "gourmet_pct": pct(s.gourmet),
                    "gourmet_sources": srcs(&s.gourmet_sources),
                    "gathering": py_round(s.gathering_quantity, 4),
                    "gathering_pct": pct(s.gathering_quantity),
                    "gathering_sources": srcs(&s.gathering_sources),
                    "rare_find": py_round(s.rare_find, 4),
                    "rare_find_pct": pct(s.rare_find),
                    "rare_find_sources": srcs(&s.rare_find_sources),
                    "processing": py_round(s.processing, 4),
                    "processing_pct": pct(s.processing),
                    "processing_sources": srcs(&s.processing_sources),
                    "level_bonus": py_round(s.level_bonus, 2),
                    "level_sources": srcs(&s.level_sources),
                    "is_gathering": is_gathering(hrid),
                })
            })
            .collect();
        rows.sort_by(|a, b| {
            let (x, y) = (a["level"].as_f64().unwrap_or(0.0), b["level"].as_f64().unwrap_or(0.0));
            y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
        });
        rows
    }

    fn stats_for_action_type(&self, action_type: &str) -> Option<&SkillStats> {
        let (skill, _) = SKILL_TO_ACTION_TYPE.iter().find(|(_, a)| *a == action_type)?;
        self.skill_stats.get(*skill)
    }

    /// `1 / speed / (1 + efficiency)`; 1.0 for unmodelled action types.
    pub fn get_action_time_multiplier(&self, action_type: &str) -> f64 {
        let Some(s) = self.stats_for_action_type(action_type) else { return 1.0 };
        let speed_mult = if s.speed > 0.0 { 1.0 / s.speed } else { 1.0 };
        speed_mult * (1.0 / (1.0 + s.efficiency))
    }

    pub fn get_ingredient_multiplier(&self, action_type: &str) -> f64 {
        self.stats_for_action_type(action_type).map_or(1.0, |s| 1.0 - s.artisan)
    }

    pub fn get_output_multiplier(&self, action_type: &str) -> f64 {
        self.stats_for_action_type(action_type).map_or(1.0, |s| 1.0 + s.gourmet)
    }

    pub fn get_gathering_multiplier(&self, skill_hrid: &str) -> f64 {
        self.skill_stats.get(skill_hrid).map_or(1.0, |s| 1.0 + s.gathering_quantity)
    }

    pub fn get_rare_find_multiplier(&self, skill_hrid: &str) -> f64 {
        self.skill_stats.get(skill_hrid).map_or(1.0, |s| 1.0 + s.rare_find)
    }

    pub fn get_processing_fraction(&self, skill_hrid: &str) -> f64 {
        self.skill_stats.get(skill_hrid).map_or(0.0, |s| s.processing)
    }

    /// `max(level, required) + level_bonus`; just `required` for unmodelled skills.
    pub fn get_effective_level(&self, skill_hrid: &str, required_level: f64) -> f64 {
        match self.skill_stats.get(skill_hrid) {
            None => required_level,
            Some(s) => s.level_f64().max(required_level) + s.level_bonus,
        }
    }

    /// Catalytic tea (+ pouch share): additive to the catalyst multiplier.
    pub fn get_alchemy_success_bonus(&self) -> (f64, Vec<BonusSource>) {
        let mut total = 0.0;
        let mut sources = Vec::new();
        let buffs = arr(child(child(self.char(), "consumableActionTypeBuffsMap"), "/action_types/alchemy"));
        for b in buffs {
            if b.get("typeHrid").and_then(Value::as_str) != Some("/buff_types/alchemy_success") {
                continue;
            }
            let bonus = num(b, "ratioBoost");
            if bonus <= 0.0 {
                continue;
            }
            let hrid = b.get("uniqueHrid").and_then(Value::as_str).unwrap_or("");
            let tea = if hrid.is_empty() { "Catalytic Tea".to_string() } else { hrid_title(hrid) };
            let (dc, pouch) = self.get_drink_concentration();
            total += bonus;
            if dc > 0.0 {
                let base = bonus / (1.0 + dc);
                sources.push(src("tea", &tea, base));
                sources.push(src("pouch", pouch.unwrap_or(""), bonus - base));
            } else {
                sources.push(src("tea", &tea, bonus));
            }
        }
        (total, sources)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Arc;

    /// A tiny catalogue + character: a Guzzling Pouch +5 and catalytic tea on alchemy.
    pub(crate) fn sample_gdc(with_alchemy_buffs: bool) -> Gdc {
        let mut table = vec![0.0; 21];
        table[5] = 6.0;
        let data = json!({
            "itemDetailMap": {
                "/items/guzzling_pouch": {"name": "Guzzling Pouch", "equipmentDetail": {
                    "type": "/equipment_types/pouch",
                    "noncombatStats": {"drinkConcentration": 0.1},
                    "noncombatEnhancementBonuses": {"drinkConcentration": 0.002}}},
            },
            "actionDetailMap": {},
            "enhancementLevelTotalBonusMultiplierTable": table,
        });
        let mut ch = json!({
            "characterSkills": [{"skillHrid": "/skills/alchemy", "level": 50, "experience": 1}],
            "characterItems": [{"itemHrid": "/items/guzzling_pouch", "enhancementLevel": 5, "count": 1,
                                "itemLocationHrid": "/item_locations/pouch"}],
            "consumableActionTypeBuffsMap": {"/action_types/alchemy": [
                {"typeHrid": "/buff_types/alchemy_success", "uniqueHrid": "/buff_uniques/catalytic_tea",
                 "ratioBoost": 0.0556, "flatBoost": 0}]},
        });
        if !with_alchemy_buffs {
            ch["consumableActionTypeBuffsMap"] = json!({});
        }
        Gdc::new(Arc::new(data), Arc::new(ch))
    }

    #[test]
    fn alchemy_bonus_from_catalytic_tea() {
        let g = sample_gdc(true);
        let (bonus, sources) = CharacterStats::new(&g).get_alchemy_success_bonus();
        assert!((bonus - 0.0556).abs() < 1e-12);
        let tea: Vec<_> = sources.iter().filter(|s| s.source == "tea").collect();
        assert_eq!(tea.len(), 1);
        assert!(tea[0].name.contains("Catalytic Tea"));
    }

    #[test]
    fn alchemy_bonus_includes_pouch() {
        let g = sample_gdc(true);
        let (bonus, sources) = CharacterStats::new(&g).get_alchemy_success_bonus();
        let pouch: Vec<_> = sources.iter().filter(|s| s.source == "pouch").collect();
        assert_eq!(pouch.len(), 1);
        assert!(pouch[0].name.contains("Guzzling Pouch"));
        let total: f64 = sources.iter().map(|s| s.value).sum();
        assert!((total - bonus).abs() < 1e-12);
    }

    #[test]
    fn drink_concentration_with_guzzling_pouch() {
        let g = sample_gdc(true);
        let cs = CharacterStats::new(&g);
        let (dc, name) = cs.get_drink_concentration();
        assert!((dc - (0.1 + 0.002 * 6.0)).abs() < 1e-12);
        assert_eq!(name, Some("Guzzling Pouch +5"));
    }

    #[test]
    fn alchemy_bonus_zero_without_buff() {
        let g = sample_gdc(false);
        let (bonus, sources) = CharacterStats::new(&g).get_alchemy_success_bonus();
        assert_eq!(bonus, 0.0);
        assert!(sources.is_empty());
    }

    #[test]
    fn effective_level_and_unmodelled_defaults() {
        let g = sample_gdc(true);
        let cs = CharacterStats::new(&g);
        assert_eq!(cs.get_effective_level("/skills/alchemy", 60.0), 60.0);
        assert_eq!(cs.get_effective_level("/skills/alchemy", 0.0), 50.0);
        assert_eq!(cs.get_effective_level("/skills/attack", 7.0), 7.0);
        assert_eq!(cs.get_action_time_multiplier("/action_types/combat"), 1.0);
        let rows = cs.get_stats_summary();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["speed_pct"], "+0.0%");
        assert_eq!(rows[0]["artisan_pct"], "-");
    }
}
