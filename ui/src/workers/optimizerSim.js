// =============================================================================
// optimizerSim — one worker of the in-browser optimiser pool (browserPool.js):
// the browser twin of api/lib/triggerSearch/poolWorker.js. `init` loads the
// engine once (the wasm twin, or the JS engine when the UI's engine toggle says
// "js") and applies the experimental knobs; then each `run` is one seeded,
// scored job (api/lib/triggerSearch/runJob.js), answered as a `result`.
// =============================================================================

import { applySimSettingsFromExtra } from "../../../src/combatsimulator/simSettings";
import { setTwinBackend } from "../../../shared/twinEngine.js";
import { loadWasmTwin } from "../../../src/twinWasm.js";

// Loaded after onmessage is set: runJob.js loads the engine with top-level await, and a module worker
// drops the messages (here `init`) that arrive while its imports evaluate.
const loaded = import("../../../api/lib/triggerSearch/runJob.js");

let engine = null;

onmessage = async ({ data }) => {
    if (data?.type === "init") {
        try {
            await loaded;
            applySimSettingsFromExtra({ experimental: data.experimental });
            engine = data.engine;
            if (engine === "wasm") await loadWasmTwin();
            postMessage({ type: "ready" });
        } catch (error) {
            postMessage({ type: "init_error", error: error?.message || String(error) });
        }
        return;
    }
    if (data?.type !== "run") return;
    let runJob, twin;
    try {
        ({ runJob } = await loaded);
        // Per job, as src/worker.js does per message: after a trap loadWasmTwin() hands back a fresh instance (cached otherwise).
        twin = engine === "wasm" ? await loadWasmTwin() : null;
    } catch (error) {
        // No engine is a dead worker, not a failed candidate: browserPool ends it, so its later jobs are not all errors.
        postMessage({ type: "fatal", error: error?.message || String(error) });
        return;
    }
    try {
        setTwinBackend(twin);
        const { metrics } = await runJob(data.job, twin);
        postMessage({ type: "result", id: data.job.id, metrics });
    } catch (error) {
        // As poolWorker: a candidate that throws reports and does not compete.
        postMessage({ type: "result", id: data.job.id, error: error?.message || String(error) });
    }
};
