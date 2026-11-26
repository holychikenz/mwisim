//! The wasm twin (wasm-pack --target web): `load_data` once per realm, then
//! `run` per request. Same JSON boundary as the native child (lib.rs `run`).

use crate::data::GameData;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// The host `Math.pow`, so wasm sees exactly the numbers V8 does (H2).
    #[wasm_bindgen(js_namespace = Math, js_name = pow)]
    pub fn host_pow(x: f64, y: f64) -> f64;
}

thread_local! {
    static DATA: RefCell<Option<GameData>> = const { RefCell::new(None) };
}

/// The data files as one object keyed by base name (shared/twinEngine.js TWIN_DATA_NAMES).
#[wasm_bindgen]
pub fn load_data(json: &str) -> Result<(), JsValue> {
    let data = GameData::from_json(json).map_err(|e| JsValue::from_str(&e))?;
    DATA.with(|d| *d.borrow_mut() = Some(data));
    Ok(())
}

/// One request; `on_progress(fraction)` is called every 1000 ticks, as the JS "progress" event.
#[wasm_bindgen]
pub fn run(request: &str, on_progress: Option<js_sys::Function>) -> String {
    DATA.with(|d| {
        let d = d.borrow();
        let Some(data) = d.as_ref() else {
            return r#"{"ok":false,"error":"csim wasm twin: load_data() was not called","errorKind":"Error"}"#.to_string();
        };
        let mut cb = |f: f64| {
            if let Some(f_js) = &on_progress {
                let _ = f_js.call1(&JsValue::NULL, &JsValue::from_f64(f));
            }
        };
        let progress: Option<&mut dyn FnMut(f64)> = if on_progress.is_some() { Some(&mut cb) } else { None };
        crate::run(data, request, progress)
    })
}

#[wasm_bindgen]
pub fn selftest(input: &str) -> String {
    crate::selftest(input)
}

/// Item times (lib.rs `item_values`): stateless, so `load_data` is not needed.
#[wasm_bindgen]
pub fn item_values(client: &str, character: &str, overrides: &str) -> String {
    crate::item_values(client, character, overrides)
}

/// The enhancing setup off a raw character (lib.rs `enhance_config`); stateless.
#[wasm_bindgen]
pub fn enhance_config(client: &str, character: &str) -> String {
    crate::enhance_config(client, character)
}

/// The last character's parsed econ data and Iron Cow bootstraps: a Gear-tab scan costs ~60 rows
/// against one character, and each parse is 3.7 MB of JSON.
struct EconCache {
    client: String,
    character: String,
    gdc: mwi_econ::Gdc,
    /// (iron_cow, essence_overrides as sent) -> its bootstraps.
    boot: Option<(String, mwi_econ::enhance_request::Bootstraps)>,
}

thread_local! {
    static ECON: RefCell<Option<EconCache>> = const { RefCell::new(None) };
}

/// One enhancement costing (lib.rs `enhance_calculate`), cached on the exact client and character text.
#[wasm_bindgen]
pub fn enhance_calculate(client: &str, character: &str, body: &str) -> String {
    use mwi_econ::enhance_request::iron_bootstraps;
    ECON.with(|c| {
        let mut c = c.borrow_mut();
        if !c.as_ref().is_some_and(|e| e.client == client && e.character == character) {
            *c = None;
            match crate::econ_gdc(client, character) {
                Ok(gdc) => *c = Some(EconCache { client: client.into(), character: character.into(), gdc, boot: None }),
                Err(e) => return crate::err_json(&format!("enhance_calculate: {e}"), false, None),
            }
        }
        let e = c.as_mut().expect("filled above");
        let body = match crate::enhance_body(body) {
            Ok(b) => b,
            Err(reply) => return reply,
        };
        let iron = mwi_econ::util::truthy(body.get("iron_cow").unwrap_or(&serde_json::Value::Bool(false)));
        let key = format!("{iron}:{}", body.get("essence_overrides").map(|v| v.to_string()).unwrap_or_default());
        if e.boot.as_ref().is_none_or(|(k, _)| *k != key) {
            e.boot = Some((key, iron_bootstraps(&e.gdc, &body, None)));
        }
        let boot = e.boot.as_ref().and_then(|(_, b)| b.clone());
        crate::enhance_calculate_with(&e.gdc, boot, body)
    })
}
