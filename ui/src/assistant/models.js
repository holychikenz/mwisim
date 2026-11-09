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

// The floors tvmjs detectGPUDevice (inside web-llm 0.2.86, unchanged in 0.2.87) throws below, for every model
// and quant: under any one, no local model can initialise. Re-check these against lib/index.js when bumping web-llm.
export const GPU_LIMITS = {
  maxBufferSize: 256 * 1024 * 1024,                 // its fallback after 1 GiB
  maxStorageBufferBindingSize: 128 * 1024 * 1024,   // its fallback after 1 GiB
  maxComputeWorkgroupStorageSize: 32 * 1024,
  maxStorageBuffersPerShaderStage: 10,
};

/**
 * @param {{hasGpu: boolean, shaderF16: boolean, deviceMemory?: number}} gpu plus each GPU_LIMITS key (missing counts as 0)
 * @returns {{quant, budgetMB, reason: 'no-webgpu'|'limits'|'memory'|null, recommended: string|null,
 *            list: {base, label, id, vramMB, downloadMB, fits, recommended}[]}}
 */
export function recommendModel(gpu = {}) {
  const { hasGpu, shaderF16, deviceMemory } = gpu;
  const usable = !!hasGpu && Object.entries(GPU_LIMITS).every(([k, min]) => (gpu[k] || 0) >= min);
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
