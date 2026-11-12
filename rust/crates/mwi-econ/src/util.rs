//! Python-parity primitives: hrid helpers, `str.title`, half-even rounding,
//! `dict.get`-style accessors over `serde_json::Value`, and query helpers.

use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;

/// `cow.to_hrid`: names become `/items/<snake_lower>`; hrids pass through.
pub fn to_hrid(name: &str) -> String {
    if name.contains("/items/") {
        return name.to_string();
    }
    format!("/items/{}", name.replace(' ', "_").to_lowercase())
}

/// `cow.from_hrid`: `/items/holy_brush` -> `Holy Brush`; non-item strings are `.title()`d.
pub fn from_hrid(hrid: &str) -> String {
    match hrid.split("/items/").nth(1) {
        Some(tail) if hrid.contains("/items/") => py_title(&tail.replace('_', " ")),
        _ => py_title(hrid),
    }
}

/// Python `str.title()`: a letter is uppercased iff the previous char is not a letter.
pub fn py_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_letter = false;
    for c in s.chars() {
        if c.is_alphabetic() {
            if prev_letter {
                out.extend(c.to_lowercase());
            } else {
                out.extend(c.to_uppercase());
            }
            prev_letter = true;
        } else {
            out.push(c);
            prev_letter = false;
        }
    }
    out
}

/// Python `round(x, n)` (correctly rounded, half-even on the exact binary value).
pub fn py_round(x: f64, ndigits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{:.*}", ndigits, x).parse().unwrap_or(x)
}

/// Python `round(x)` with no digits: banker's rounding to an integer.
pub fn py_round_int(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// Python `float(v)` for a JSON value: numbers, bools and numeric strings.
pub fn py_float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => py_float_str(s),
        _ => None,
    }
}

/// Python `float(str)`: surrounding whitespace, `inf`/`nan`, and `_` between digits.
pub fn py_float_str(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.contains('_') {
        let b = t.as_bytes();
        for (i, &c) in b.iter().enumerate() {
            if c == b'_' && !(i > 0 && i + 1 < b.len() && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit()) {
                return None;
            }
        }
        return t.replace('_', "").parse().ok();
    }
    t.parse().ok()
}

/// Python `int(str)` as used by `request.args.get(type=int)`.
pub fn py_int_str(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.contains('_') {
        return None; // shortcut: Python accepts `1_000`; nothing sends it
    }
    t.parse().ok()
}

/// `request.args.get(name, default, type=int)`: the default on absence or a parse failure.
pub fn arg_int(q: &HashMap<String, String>, name: &str, default: i64) -> i64 {
    q.get(name).and_then(|s| py_int_str(s)).unwrap_or(default)
}

/// `request.args.get(name, default, type=float)`.
pub fn arg_float(q: &HashMap<String, String>, name: &str, default: f64) -> f64 {
    q.get(name).and_then(|s| py_float_str(s)).unwrap_or(default)
}

/// `request.args.get(name, default)`.
pub fn arg_str<'a>(q: &'a HashMap<String, String>, name: &str, default: &'a str) -> &'a str {
    q.get(name).map(String::as_str).unwrap_or(default)
}

/// Python `d.get(key, default)`: a present key wins even when its value is null.
pub fn get_or(v: &Value, key: &str, default: Value) -> Value {
    match v.as_object().and_then(|o| o.get(key)) {
        Some(x) => x.clone(),
        None => default,
    }
}

/// `(d.get(key) or {})`-style: the child, or `Null` when absent or not an object.
pub fn child<'a>(v: &'a Value, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    v.get(key).unwrap_or(&NULL)
}

/// Python truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Number as f64 (ints and floats alike), else `default`.
pub fn num_or(v: Option<&Value>, default: f64) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(default)
}

/// Python `int(x)` on a JSON number: truncation toward zero.
pub fn py_int(v: &Value) -> i64 {
    match v.as_i64() {
        Some(i) => i,
        None => v.as_f64().map(|f| f.trunc() as i64).unwrap_or(0),
    }
}

/// `_parse_essence_overrides` (app.py:476-504): a URI-decoded JSON object
/// `{hrid: seconds}`; keys get a leading `/`, only floats >= 0 survive, and
/// anything malformed yields an empty map.
pub fn parse_essence_overrides(raw: Option<&str>) -> IndexMap<String, f64> {
    let mut out = IndexMap::new();
    let Some(raw) = raw.filter(|r| !r.is_empty()) else { return out };
    // shortcut: Python json.loads also accepts NaN/Infinity literals; serde does not, so such input yields {}.
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) else { return out };
    for (k, v) in &obj {
        if let Some(fv) = py_float(v) {
            if fv >= 0.0 {
                let key = if k.starts_with('/') { k.clone() } else { format!("/{k}") };
                out.insert(key, fv);
            }
        }
    }
    out
}

/// An unpredictable seed for unseeded Monte Carlo (Python seeds from os.urandom).
pub fn os_seed() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// Flask's `re.sub(r'[^A-Za-z0-9._-]+', '_', name).strip('_') or 'unknown'`.
pub fn slugify_character(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    let s = out.trim_matches('_');
    if s.is_empty() { "unknown".into() } else { s.into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hrids() {
        assert_eq!(to_hrid("Holy Brush"), "/items/holy_brush");
        assert_eq!(to_hrid("/items/x"), "/items/x");
        assert_eq!(from_hrid("/items/holy_brush"), "Holy Brush");
        assert_eq!(from_hrid("/items/philosophers_mirror"), "Philosophers Mirror");
        assert_eq!(from_hrid("total_level"), "Total_Level");
    }

    #[test]
    fn title() {
        assert_eq!(py_title("total_level"), "Total_Level");
        assert_eq!(py_title("philosopher's stone"), "Philosopher'S Stone");
        assert_eq!(py_title("1st AID"), "1St Aid");
    }

    #[test]
    fn rounding() {
        assert_eq!(py_round(2.675, 2), 2.67); // binary value is below .675
        assert_eq!(py_round(0.125, 2), 0.12);
        assert_eq!(py_round(0.375, 2), 0.38);
        assert_eq!(py_round_int(2.5), 2);
        assert_eq!(py_round_int(3.5), 4);
        assert_eq!(py_round_int(-2.5), -2);
    }

    #[test]
    fn overrides() {
        let m = parse_essence_overrides(Some(r#"{"items/a": 5, "/items/b": "2.5", "/items/c": -1, "/items/d": null, "/items/e": true}"#));
        assert_eq!(m.into_iter().collect::<Vec<_>>(), vec![
            ("/items/a".to_string(), 5.0), ("/items/b".to_string(), 2.5), ("/items/e".to_string(), 1.0)]);
        assert!(parse_essence_overrides(Some("[1]")).is_empty());
        assert!(parse_essence_overrides(Some("nope")).is_empty());
        assert!(parse_essence_overrides(None).is_empty());
    }

    #[test]
    fn accessors() {
        let v = json!({"a": null, "b": 2});
        assert_eq!(get_or(&v, "a", json!(1)), Value::Null);
        assert_eq!(get_or(&v, "z", json!(1)), json!(1));
        assert!(!truthy(&json!({})) && truthy(&json!("x")) && !truthy(&json!(0.0)));
        assert_eq!(py_int(&json!(12.9)), 12);
        assert_eq!(py_float_str(" 1_000.5 "), Some(1000.5));
        assert_eq!(py_float_str("1__0"), None);
    }

    #[test]
    fn slug() {
        assert_eq!(slugify_character("Twin Tester!"), "Twin_Tester");
        assert_eq!(slugify_character("??"), "unknown");
        assert_eq!(slugify_character("a.b-c_d"), "a.b-c_d");
    }
}
