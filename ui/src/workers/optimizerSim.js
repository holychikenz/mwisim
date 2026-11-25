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

let twin = null;

onmessage = async ({ data }) => {
    if (data?.type === "init") {
        try {
            await loaded;
            applySimSettingsFromExtra({ experimental: data.experimental });
            twin = data.engine === "wasm" ? await loadWasmTwin() : null;
            setTwinBackend(twin);
            postMessage({ type: "ready" });
        } catch (error) {
            postMessage({ type: "init_error", error: error?.message || String(error) });
        }
        return;
    }
    if (data?.type !== "run") return;
    try {
        const { runJob } = await loaded;
        const { metrics } = await runJob(data.job, twin);
        postMessage({ type: "result", id: data.job.id, metrics });
    } catch (error) {
        // As poolWorker: a candidate that throws reports and does not compete.
        postMessage({ type: "result", id: data.job.id, error: error?.message || String(error) });
    }
};
