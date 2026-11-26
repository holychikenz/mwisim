//! `item_values` and `enhance_*` against cowstuff's `/api/value/market` and `/api/enhance/*` goldens (webapp-rs/goldens), exactly:
//! the server allows 1e-9, but the twin build reproduces it bit for bit.
//! The character is webapp-rs/fixtures/character.json (scrubbed by make_fixture.py); the client maps are csim's bundled data, identical (order included) to that fixture's.

use serde_json::Value;
use std::fs::read_to_string;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

fn read(rel: &str) -> String {
    read_to_string(format!("{ROOT}/{rel}")).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn client() -> String {
    let maps = ["actionDetailMap", "itemDetailMap", "enhancementLevelTotalBonusMultiplierTable"];
    let parts: Vec<String> =
        maps.iter().map(|m| format!("\"{m}\":{}", read(&format!("src/combatsimulator/data/{m}.json")))).collect();
    format!("{{{}}}", parts.join(","))
}

fn check(golden: &str, overrides: &str) {
    let out: Value = serde_json::from_str(&crate::item_values(&client(), &read("fixtures/econ/character.json"), overrides)).unwrap();
    let want: Value = serde_json::from_str(&read(&format!("fixtures/econ/{golden}"))).unwrap();
    assert_eq!(out["character"], want["character"]);
    assert_eq!(out["unit"], want["unit"]);
    let (got, exp) = (out["values"].as_object().unwrap(), want["values"].as_object().unwrap());
    let mut keys: Vec<_> = got.keys().collect();
    keys.sort();
    let mut want_keys: Vec<_> = exp.keys().collect();
    want_keys.sort();
    assert_eq!(keys, want_keys, "{golden}: item set");
    let bad: Vec<String> = exp
        .iter()
        .filter(|(k, e)| e.as_f64() != got[*k].as_f64())
        .map(|(k, e)| format!("{k}: {e} vs {}", got[k]))
        .take(10)
        .collect();
    assert!(bad.is_empty(), "{golden}: {bad:?}");
}

#[test]
fn matches_market_golden() {
    check("value__market.json", "");
}

#[test]
fn matches_market_golden_with_essence_overrides() {
    check("value__market_named.json", r#"{"/items/milking_essence": 5, "items/star_fragment": 120}"#);
}

/// Equal up to the goldens' own tolerance (manifest `tol`, relative): the server's Markov
/// solve is not Python's numpy, and Python writes some integral floats as ints.
fn close(a: &Value, b: &Value, tol: f64) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= tol * x.abs().max(y.abs()).max(1.0)
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| close(x, y, tol)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| close(v, w, tol))),
        _ => a == b,
    }
}

/// The golden's body (webapp-rs/goldens/manifest.json) through `enhance_calculate`.
fn check_enhance(golden: &str, body: &str) {
    let out: Value = serde_json::from_str(&crate::enhance_calculate(&client(), &read("fixtures/econ/character.json"), body)).unwrap();
    let want: Value = serde_json::from_str(&read(&format!("fixtures/econ/{golden}"))).unwrap();
    assert!(close(&out, &want, 1e-6), "{golden}: {out}");
}

#[test]
fn enhance_calculate_matches_iron_goldens() {
    check_enhance("enhance_iron__calc.json", r#"{"config": {}, "item_hrid": "/items/holy_brush", "target": 10, "iron_cow": true}"#);
    check_enhance(
        "enhance_iron__calc_ov.json",
        r#"{"config": {}, "item_hrid": "/items/advanced_foraging_charm", "target": 7, "iron_cow": true, "essence_overrides": {"/items/foraging_essence": 2.5}}"#,
    );
}

#[test]
fn enhance_config_matches_character_golden() {
    let out: Value = serde_json::from_str(&crate::enhance_config(&client(), &read("fixtures/econ/character.json"))).unwrap();
    let want: Value = serde_json::from_str(&read("fixtures/econ/enhance__character.json")).unwrap();
    assert!(close(&out, &want, 1e-9), "{out}");
}

/// audit-4: the fixture character wears combat gear; its default enhancing loadout has
/// enchanted gloves +5 and a refined chance cape, which must count.
#[test]
fn enhance_config_reads_the_enhancing_loadout() {
    let ch = read("fixtures/econ/character.json");
    let cfg: Value = serde_json::from_str(&crate::enhance_config(&client(), &ch)).unwrap();
    assert_eq!(cfg["use_enchanted"], true, "{cfg}");
    assert_eq!(cfg["enchanted_level"], 5);
    assert_eq!(mwi_econ::enhance_sim::ENHANCE_BONUS[0], 1.0);
    // The loadout lists the refined chance cape at +0 but does not use exact levels, so the owned +3 counts:
    // base + per-level bonus x T[3] = 3.3.
    assert!((cfg["extra_speed"].as_f64().unwrap() - (0.058 + 0.0058 * 3.3) * 100.0).abs() < 1e-9, "{cfg}");
    // The cape's XP plus house (0.0335) and achievement (0.02) wisdom.
    assert!((cfg["extra_xp"].as_f64().unwrap() - (0.0348 + 0.00348 * 3.3 + 0.0335 + 0.02)).abs() < 1e-9, "{cfg}");
    let body = serde_json::json!({"config": cfg, "item_hrid": "/items/holy_brush", "target": 10, "iron_cow": true}).to_string();
    let out: Value = serde_json::from_str(&crate::enhance_calculate(&client(), &ch, &body)).unwrap();
    let t = out["attempt_time"].as_f64().unwrap();
    // 7.83 s from the worn gear; the gloves +5 (11.2 points) and the cape +3 (7.714) bring it to 12 / 1.7225.
    assert!((t - 6.967).abs() < 0.001, "attempt time {t}");
}

#[test]
fn enhance_bad_input_is_an_error_not_a_panic() {
    for body in ["{", "[]", r#"{"item_hrid": "/items/nope"}"#] {
        let out: Value = serde_json::from_str(&crate::enhance_calculate(&client(), "{}", body)).unwrap();
        assert_eq!(out["ok"], false, "{body}");
    }
    let out: Value = serde_json::from_str(&crate::enhance_config("{}", "{")).unwrap();
    assert_eq!(out["ok"], false);
}

#[test]
fn bad_json_is_an_error_not_a_panic() {
    let out: Value = serde_json::from_str(&crate::item_values("{", "{}", "")).unwrap();
    assert_eq!(out["ok"], false);
}

/// audit-12: a decompose takes the item's own level-over action time, not the flat alchemy time.
#[test]
fn decompose_time_uses_the_level_over_bonus() {
    use std::sync::Arc;
    let data: Value = serde_json::from_str(&client()).unwrap();
    let ch: Value = serde_json::from_str(&read("fixtures/econ/character.json")).unwrap();
    let gdc = mwi_econ::Gdc::new(Arc::new(data), Arc::new(ch));
    let (p, sources) = mwi_econ::alchemy::run_decompose_pass(&gdc, "default", None, true);
    let row = sources.values().flatten().find(|r| r["input_hrid"] == "/items/azure_milk").expect("an azure_milk row");
    let f = |k: &str| row[k].as_f64().unwrap();
    let action = f("time_per_unit_seconds") * f("bulk_multiplier") * p.pvalue * f("per_action_count_listed");
    let want = p.action_time_at(20.0); // azure_milk is itemLevel 20
    assert!(want < p.action_time, "{want} vs the flat {}", p.action_time);
    assert!((action - want).abs() <= 1e-3 * want, "the row's action time {action}, want {want} (flat {})", p.action_time);
}
