// =============================================================================
// twinWasm — the browser worker's loader for the wasm Rust twin (rust/pkg/,
// built by `./build.sh wasm`). The globs are empty in a checkout without that
// build, so the UI still builds; loadWasmTwin() then throws instead.
// No top-level await: workers build as iife.
// =============================================================================

import * as dataProvider from "./combatsimulator/dataProvider";
import { TWIN_DATA_NAMES } from "../shared/twinEngine.js";

const pkg = Object.values(import.meta.glob("../rust/pkg/csim_twin.js", { eager: true }))[0];
// The glue's source, for a fresh module copy after a trap (the glue memoises its instance per module).
const pkgSource = Object.values(import.meta.glob("../rust/pkg/csim_twin.js", { eager: true, query: "?raw", import: "default" }))[0];
const wasmUrl = Object.values(import.meta.glob("../rust/pkg/csim_twin_bg.wasm", { eager: true, query: "?url", import: "default" }))[0];

// dataProvider's export name where it differs from the data file's base name.
const EXPORT_NAME = { enhancementLevelTotalBonusMultiplierTable: "enhancementLevelTotalMultiplierTable" };

let loading = null;
let loads = 0;

/** The wasm backend ({ run(json, onProgress) }), loaded once per worker, and again after a trap. */
export function loadWasmTwin() {
    loading ??= (async () => {
        if (!pkg || !wasmUrl) throw new Error("The Rust (wasm) engine is not in this build: run ./build.sh wasm ui");
        const mod = loads++ === 0 ? pkg : await import(/* @vite-ignore */ URL.createObjectURL(new Blob([pkgSource], { type: "text/javascript" })));
        await mod.default({ module_or_path: wasmUrl });
        // shortcut: each worker re-stringifies the 13 maps (~5 ms of a ~20 ms load, measured in Node); pass raw text or a filtered subset (plan R3) if per-worker start-up on wasm starts to matter.
        // The live dataProvider maps, so the twin sees what the JS engine in this realm sees.
        const data = {};
        for (const name of TWIN_DATA_NAMES) data[name] = dataProvider[EXPORT_NAME[name] ?? name];
        mod.load_data(JSON.stringify(data));
        // The three maps the item valuation (rust/src/lib.rs item_values) reads.
        const client = JSON.stringify({ actionDetailMap: data.actionDetailMap, itemDetailMap: data.itemDetailMap, enhancementLevelTotalBonusMultiplierTable: data.enhancementLevelTotalBonusMultiplierTable });
        const mine = loading;
        const guard = (f) => {
            try {
                return f();
            } catch (e) {
                // A trap (Rust panic or abort) leaves this instance unsound: the next load re-instantiates.
                if (e instanceof WebAssembly.RuntimeError && loading === mine) loading = null;
                throw e;
            }
        };
        return {
            run: async (json, onProgress) => guard(() => mod.run(json, onProgress ?? null)),
            itemValues: (character, overrides = "") => guard(() => mod.item_values(client, character, overrides)),
        };
    })();
    loading.catch(() => { loading = null; });
    return loading;
}
