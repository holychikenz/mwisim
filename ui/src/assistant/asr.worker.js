// Whisper (tiny.en, q8, wasm) for voice input on this device.
import { env, pipeline } from '@huggingface/transformers';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

// transformers points ORT at jsdelivr unless wasmPaths is set (transformers.web.js:8728); serve our own copy.
env.backends.onnx.wasm.wasmPaths = { wasm: ortWasm };
let asr;
self.onmessage = async ({ data }) => {   // data: Float32Array, 16 kHz mono (transferred)
  try {
    asr ??= await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en',
      { device: 'wasm', dtype: 'q8', progress_callback: (p) => self.postMessage({ type: 'progress', p }) });
    self.postMessage({ type: 'text', text: (await asr(data)).text });
  } catch (e) { self.postMessage({ type: 'error', message: String(e?.message || e) }); }
};
