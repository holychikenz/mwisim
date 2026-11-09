// =============================================================================
// models — the local WebLLM tiers (web-llm 0.2.86 prebuiltAppConfig) and
// which one this device should start with. Every tier has a 4096-token context.
// VRAM figures are the records' vram_required_MB; downloads are the summed
// Hugging Face repo sizes (identical for q4f16_1 and q4f32_1).
// Pure: no React, no browser globals.
// =============================================================================

export const MODEL_TIERS = [
  { base: 'Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B', vramMB: { f16: 944.62, f32: 1060.2 }, downloadMB: 290 },
  { base: 'Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B', vramMB: { f16: 1629.75, f32: 1888.97 }, downloadMB: 880 },
  { base: 'Qwen2.5-3B-Instruct', label: 'Qwen2.5 3B', vramMB: { f16: 2504.76, f32: 2893.64 }, downloadMB: 1748 },
  { base: 'Qwen2.5-7B-Instruct', label: 'Qwen2.5 7B', vramMB: { f16: 5106.67, f32: 5900.09 }, downloadMB: 4296 },
  { base: 'Llama-3.2-1B-Instruct', label: 'Llama 3.2 1B', vramMB: { f16: 879.04, f32: 1128.82 }, downloadMB: 705 },
  { base: 'Llama-3.2-3B-Instruct', label: 'Llama 3.2 3B', vramMB: { f16: 2263.69, f32: 2951.51 }, downloadMB: 1817 },
  { base: 'Hermes-3-Llama-3.1-8B', label: 'Hermes 3 8B', vramMB: { f16: 4876.13, f32: 5779.27 }, downloadMB: 4527 },
];

export const modelId = (tier, quant) => `${tier.base}-${quant}-MLC`;

const MIN_BUFFER = 256 * 1024 * 1024;   // the runtime's fallback floor for maxBufferSize
// tvmjs detectGPUDevice requests exactly this for every model and quant (0.2.86 and 0.2.87); fewer and no model can initialise.
const MIN_STORAGE_BUFFERS = 10;

/**
 * @param {{hasGpu: boolean, shaderF16: boolean, maxBufferSize: number, maxStorageBuffersPerShaderStage: number, deviceMemory?: number}} gpu
 * @returns {{quant, budgetMB, reason: 'no-webgpu'|'limits'|'memory'|null, recommended: string|null,
 *            list: {base, label, id, vramMB, downloadMB, fits, recommended}[]}}
 */
export function recommendModel({ hasGpu, shaderF16, maxBufferSize, maxStorageBuffersPerShaderStage, deviceMemory } = {}) {
  const usable = !!hasGpu && (maxBufferSize || 0) >= MIN_BUFFER && (maxStorageBuffersPerShaderStage || 0) >= MIN_STORAGE_BUFFERS;
  // shortcut: the web cannot see GPU memory; budget = half of navigator.deviceMemory (Chrome caps it at 8 GB; unknown counts as 8). Upgrade if WebGPU exposes memory.
  const budgetMB = Math.min(deviceMemory ?? 8, 8) * 512;
  const quant = shaderF16 ? 'q4f16_1' : 'q4f32_1';
  const list = MODEL_TIERS.map(t => {
    const vramMB = t.vramMB[shaderF16 ? 'f16' : 'f32'];
    return { base: t.base, label: t.label, id: modelId(t, quant), vramMB, downloadMB: t.downloadMB, fits: usable && vramMB <= budgetMB };
  });
  const pick = ['Qwen2.5-1.5B-Instruct', 'Qwen2.5-0.5B-Instruct'].map(b => list.find(m => m.base === b)).find(m => m.fits);
  for (const m of list) m.recommended = m === pick;
  const reason = !hasGpu ? 'no-webgpu' : !usable ? 'limits' : pick ? null : 'memory';
  return { quant, budgetMB, reason, recommended: pick?.id ?? null, list };
}
