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
    fn num_key_integers() {
        assert_eq!(num_key(12.0), "12");
        assert_eq!(num_key(0.0), "0");
        assert_eq!(num_key(f64::NAN), "NaN");
    }
}
