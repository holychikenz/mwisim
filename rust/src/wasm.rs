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
