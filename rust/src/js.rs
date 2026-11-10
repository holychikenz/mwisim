//! JavaScript number semantics the port must reproduce exactly (hazards H2, H3, H17).
//! Never call `f64::min`, `f64::max` or `f64::round` from engine code: they
//! disagree with `Math.min`/`Math.max`/`Math.round` on NaN, signed zero and ties.

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use std::fmt;
use std::rc::Rc;

/// Interned-ish string: cheap to clone, compared by content.
pub type S = Rc<str>;

pub fn s(v: &str) -> S {
    Rc::from(v)
}

pub const MIN_SAFE_INTEGER: f64 = -9007199254740991.0;

/// `Math.pow`. Native `powf` matches V8 on macOS (measured, ResearchPack A);
/// the wasm build imports the host `Math.pow` instead.
#[cfg(not(target_arch = "wasm32"))]
pub fn pow(x: f64, y: f64) -> f64 {
    x.powf(y)
}

#[cfg(target_arch = "wasm32")]
pub fn pow(x: f64, y: f64) -> f64 {
    crate::wasm::host_pow(x, y)
}

/// `Math.round`: ties go towards +Infinity, and a zero result keeps the sign of x.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 {
        r.copysign(x)
    } else {
        r
    }
}

/// `Math.min(a, b)`: NaN if either is NaN; -0 is smaller than +0.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && (a.is_sign_negative() || b.is_sign_negative()) {
        -0.0
    } else {
        a
    }
}

/// `Math.max(a, b)`: NaN if either is NaN; +0 is larger than -0.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && (a.is_sign_positive() || b.is_sign_positive()) {
        0.0
    } else {
        a
    }
}

/// JS truthiness of a number.
pub fn truthy(v: f64) -> bool {
    v != 0.0 && !v.is_nan()
}

/// `String(n)` for the keys the engine forms from numbers (hit damage, tiers).
/// Exact for integers below 1e21; anything else falls back to shortest round-trip.
pub fn num_key(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if v == v.trunc() && v.abs() < 1e21 {
        if v == 0.0 {
            return "0".into();
        }
        return format!("{}", v as i128);
    }
    serde_json::to_string(&v).unwrap_or_else(|_| "NaN".into())
}

/// `Number(v)` (ECMAScript ToNumber) for a JSON value: null 0, booleans 1/0,
/// strings by StringToNumber, arrays via their `String()` join, objects NaN.
pub fn number(v: &serde_json::Value) -> f64 {
    use serde_json::Value;
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(st) => string_to_number(st),
        Value::Array(_) => string_to_number(&to_js_string(v, false)),
        Value::Object(_) => f64::NAN,
    }
}

/// `String(v)` for a JSON value, as far as ToNumber can tell (numbers render to a
/// round-trip form, not JS's exact digits). Inside an array join null is "".
fn to_js_string(v: &serde_json::Value, in_array: bool) -> String {
    use serde_json::Value;
    match v {
        Value::Null => if in_array { String::new() } else { "null".into() },
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f == 0.0 { "0".into() } else { format!("{f:e}") }
        }
        Value::String(st) => st.clone(),
        Value::Array(a) => a.iter().map(|x| to_js_string(x, true)).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// ECMAScript WhiteSpace and LineTerminator (what `String.prototype.trim` strips; not Rust's `trim`, which takes U+0085 and leaves U+FEFF).
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// StringToNumber: decimal (with sign, `Infinity`), or unsigned 0x/0o/0b; anything else NaN.
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return radix_to_number(&t[2..], radix);
        }
    }
    let (sign, body) = match b[0] {
        b'-' => (-1.0, &t[1..]),
        b'+' => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits [. digits] | . digits, then [eE [+-] digits].
    let bb = body.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < bb.len() && bb[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - s
    };
    let mut n = digits(&mut i);
    if i < bb.len() && bb[i] == b'.' {
        i += 1;
        n += digits(&mut i);
    }
    if n == 0 {
        return f64::NAN;
    }
    if i < bb.len() && (bb[i] == b'e' || bb[i] == b'E') {
        i += 1;
        if i < bb.len() && (bb[i] == b'+' || bb[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return f64::NAN;
        }
    }
    if i != bb.len() {
        return f64::NAN;
    }
    // The grammar is checked; Rust's parse is correctly rounded on it.
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

/// Digits in a power-of-two radix, correctly rounded: the top 128 bits, a sticky bit, then a scale.
fn radix_to_number(d: &str, radix: u32) -> f64 {
    let bits = radix.trailing_zeros();
    let (mut acc, mut sticky, mut shift) = (0u128, false, 0i32);
    for c in d.chars() {
        let Some(v) = c.to_digit(radix) else { return f64::NAN };
        if acc >> (128 - bits) != 0 {
            sticky |= v != 0;
            shift += bits as i32;
        } else {
            acc = (acc << bits) | v as u128;
        }
    }
    // Past 128 bits the lowest bit is far below f64 precision, so it only breaks ties: it can carry the sticky bit.
    ((acc | sticky as u128) as f64) * 2f64.powi(shift)
}

/// A JS array index key ("0", "1", ... below 2^32 - 1). Such keys enumerate
/// first, ascending, in every JS object regardless of insertion order.
pub fn is_array_index(k: &str) -> bool {
    let b = k.as_bytes();
    if b.is_empty() || b.len() > 10 {
        return false;
    }
    if b == b"0" {
        return true;
    }
    if b[0] == b'0' || !b.iter().all(|c| c.is_ascii_digit()) {
        return false;
    }
    k.parse::<u64>().map(|n| n < 4294967295).unwrap_or(false)
}

/// An object parsed from JSON with JS key order: document order for string
/// keys, array-index keys moved to the front in ascending numeric order (H17).
#[derive(Clone, Debug)]
pub struct OrderedMap<V>(pub Vec<(String, V)>);

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        OrderedMap(Vec::new())
    }
}

impl<V> OrderedMap<V> {
    pub fn get(&self, k: &str) -> Option<&V> {
        self.0.iter().find(|(kk, _)| kk == k).map(|(_, v)| v)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.0.iter().map(|(_, v)| v)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// Insert in JS order: an existing key keeps its position.
    pub fn insert(&mut self, k: String, v: V) {
        if let Some(slot) = self.0.iter_mut().find(|(kk, _)| *kk == k) {
            slot.1 = v;
        } else {
            self.0.push((k, v));
        }
    }
    /// Apply the JS enumeration rule after a build in insertion order.
    pub fn js_order(&mut self) {
        let mut idx: Vec<(String, V)> = Vec::new();
        let mut rest: Vec<(String, V)> = Vec::new();
        for (k, v) in self.0.drain(..) {
            if is_array_index(&k) {
                idx.push((k, v));
            } else {
                rest.push((k, v));
            }
        }
        idx.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
        idx.extend(rest);
        self.0 = idx;
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Vis<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for Vis<V> {
            type Value = OrderedMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut out = OrderedMap(Vec::new());
                while let Some((k, v)) = m.next_entry::<String, V>()? {
                    out.insert(k, v);
                }
                out.js_order();
                Ok(out)
            }
        }
        d.deserialize_map(Vis(std::marker::PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_js() {
        assert_eq!(round(0.5), 1.0);
        assert_eq!(round(1.5), 2.0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-0.5).to_bits(), (-0.0f64).to_bits());
        assert_eq!(round(-1.5), -1.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(-0.2).to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn min_max_nan_and_zero() {
        assert!(min(f64::NAN, 1.0).is_nan());
        assert!(min(1.0, f64::NAN).is_nan());
        assert!(max(f64::NAN, 1.0).is_nan());
        assert!(max(1.0, f64::NAN).is_nan());
        assert!(min(0.0, -0.0).is_sign_negative());
        assert!(max(-0.0, 0.0).is_sign_positive());
        assert_eq!(min(2.0, 3.0), 2.0);
        assert_eq!(max(2.0, 3.0), 3.0);
    }

    #[test]
    fn ordered_map_integer_keys_first() {
        let m: OrderedMap<u32> =
            serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4,"01":5,"0":6}"#).unwrap();
        let keys: Vec<&str> = m.0.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["0", "2", "10", "b", "a", "01"]);
    }

    #[test]
    fn number_is_js_to_number() {
        let nan = f64::NAN;
        let table: &[(&str, f64)] = &[
            ("null", 0.0), ("true", 1.0), ("false", 0.0), ("1.5", 1.5), ("-0", -0.0), ("{}", nan),
            (r#""""#, 0.0), (r#"" \t\n ""#, 0.0), (r#"" 12 ""#, 12.0), (r#"" 12﻿""#, 12.0), (r#""\u008512""#, nan),
            (r#""1.""#, 1.0), (r#"".5""#, 0.5), (r#"".""#, nan), (r#""+.5e1""#, 5.0), (r#""-1e-2""#, -0.01), (r#""1e""#, nan),
            (r#""1_000""#, nan), (r#""Infinity""#, f64::INFINITY), (r#""-Infinity""#, f64::NEG_INFINITY), (r#""infinity""#, nan),
            (r#""inf""#, nan), (r#""NaN""#, nan), (r#""-0""#, -0.0), (r#""0x1F""#, 31.0), (r#""0X1f""#, 31.0), (r#""-0x1""#, nan),
            (r#""0x""#, nan), (r#""0o17""#, 15.0), (r#""0b101""#, 5.0), (r#""0b2""#, nan), (r#""0x1p3""#, nan), (r#""1 2""#, nan),
            (r#""0x20000000000001""#, 9007199254740992.0), (r#""0x20000000000003""#, 9007199254740996.0),
            ("[]", 0.0), ("[5]", 5.0), (r#"["7"]"#, 7.0), ("[null]", 0.0), ("[[]]", 0.0), ("[[3]]", 3.0), ("[-0]", 0.0),
            ("[1,2]", nan), ("[true]", nan), ("[{}]", nan), ("[1e300]", 1e300),
        ];
        for (src, want) in table {
            let got = number(&serde_json::from_str(src).unwrap());
            assert!(got.to_bits() == want.to_bits() || (got.is_nan() && want.is_nan()), "Number({src}) = {got}, want {want}");
        }
        let long = format!("0x{}", "f".repeat(300));
        assert_eq!(string_to_number(&long), f64::INFINITY);
        assert_eq!(string_to_number(&format!("0x{}", "f".repeat(40))), 2f64.powi(160));
    }

    #[test]
    fn num_key_integers() {
        assert_eq!(num_key(12.0), "12");
        assert_eq!(num_key(0.0), "0");
        assert_eq!(num_key(f64::NAN), "NaN");
    }
}
