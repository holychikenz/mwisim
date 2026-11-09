// The WebLLM engine lives only here, behind localLlm.js's small RPC: a
// main-thread import of web-llm would add a second ~2 MB-gzip copy of it.
import { CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache } from '@mlc-ai/web-llm';

let engine = null;
const ops = {
  async load({ id, modelId }) {
    await engine?.unload();
    engine = null;
    engine = await CreateMLCEngine(modelId, { initProgressCallback: (report) => self.postMessage({ id, progress: report }) });
  },
  async chat({ messages, max_tokens, temperature }) {
    const r = await engine.chat.completions.create({ messages, max_tokens, temperature });
    return { text: r.choices[0]?.message?.content ?? '', finish: r.choices[0]?.finish_reason };
  },
  cached: ({ modelId }) => hasModelInCache(modelId),
  delete: ({ modelId }) => deleteModelAllInfoInCache(modelId),
};
self.onmessage = async ({ data }) => {
  if (data.op === 'interrupt') return void engine?.interruptGenerate();
  try { self.postMessage({ id: data.id, value: await ops[data.op](data) }); }
  catch (e) { self.postMessage({ id: data.id, error: `${e?.name || 'Error'}: ${e?.message || e}` }); }
};
