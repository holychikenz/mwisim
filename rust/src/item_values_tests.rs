//! `item_values` against cowstuff's `/api/value/market` goldens (webapp-rs/goldens), exactly:
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

#[test]
fn bad_json_is_an_error_not_a_panic() {
    let out: Value = serde_json::from_str(&crate::item_values("{", "{}", "")).unwrap();
    assert_eq!(out["ok"], false);
}
