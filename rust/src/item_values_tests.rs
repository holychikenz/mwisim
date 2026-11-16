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
    let out: Value = serde_json::from_str(&crate::enhance_config(&read("fixtures/econ/character.json"))).unwrap();
    let want: Value = serde_json::from_str(&read("fixtures/econ/enhance__character.json")).unwrap();
    assert!(close(&out, &want, 1e-9), "{out}");
}

#[test]
fn enhance_bad_input_is_an_error_not_a_panic() {
    for body in ["{", "[]", r#"{"item_hrid": "/items/nope"}"#] {
        let out: Value = serde_json::from_str(&crate::enhance_calculate(&client(), "{}", body)).unwrap();
        assert_eq!(out["ok"], false, "{body}");
    }
    let out: Value = serde_json::from_str(&crate::enhance_config("{")).unwrap();
    assert_eq!(out["ok"], false);
}

#[test]
fn bad_json_is_an_error_not_a_panic() {
    let out: Value = serde_json::from_str(&crate::item_values("{", "{}", "")).unwrap();
    assert_eq!(out["ok"], false);
}
