// Roboburble's local model tiers and the recommendation from WebGPU facts.
import test from 'node:test';
import assert from 'node:assert/strict';

const { MODEL_TIERS, recommendModel } = await import('../../ui/src/assistant/models.js');

const MiB = 1024 * 1024;
const gpu = (over = {}) => ({ hasGpu: true, shaderF16: true, maxBufferSize: 1024 * MiB, maxStorageBuffersPerShaderStage: 10, deviceMemory: 8, ...over });

test('1: no WebGPU — nothing recommended, nothing fits', () => {
  const r = recommendModel({ hasGpu: false, shaderF16: false, maxBufferSize: 0 });
  assert.equal(r.recommended, null);
  assert.equal(r.reason, 'no-webgpu');
  assert.ok(r.list.every(m => !m.fits));
});

test('2: f16 with 8 GB recommends Qwen2.5 1.5B; 7B and 8B do not fit', () => {
  const r = recommendModel(gpu());
  assert.equal(r.quant, 'q4f16_1');
  assert.equal(r.recommended, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.ok(r.list.every(m => m.id.endsWith('-q4f16_1-MLC')));
  const fits = Object.fromEntries(r.list.map(m => [m.base, m.fits]));
  assert.equal(fits['Qwen2.5-7B-Instruct'], false);
  assert.equal(fits['Hermes-3-Llama-3.1-8B'], false);
  assert.equal(fits['Qwen2.5-3B-Instruct'], true);
  assert.equal(MODEL_TIERS.length, 7);
  assert.ok(r.list.every(m => m.downloadMB > 0));
});

test('3: no shader-f16 — q4f32 ids and f32 VRAM', () => {
  const r = recommendModel(gpu({ shaderF16: false }));
  assert.equal(r.quant, 'q4f32_1');
  assert.ok(r.list.every(m => m.id.endsWith('-q4f32_1-MLC')));
  assert.equal(r.list.find(m => m.base === 'Qwen2.5-0.5B-Instruct').vramMB, 1060.2);
});

test('4: 2 GB — f16 recommends 0.5B; f32 recommends nothing (1060 > 1024)', () => {
  assert.equal(recommendModel(gpu({ deviceMemory: 2 })).recommended, 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
  assert.equal(recommendModel(gpu({ deviceMemory: 2, shaderF16: false })).recommended, null);
});

test('5: a buffer limit under 256 MiB — nothing fits', () => {
  const r = recommendModel(gpu({ maxBufferSize: 128 * MiB }));
  assert.equal(r.reason, 'limits');
  assert.ok(r.list.every(m => !m.fits));
});

test('6: unknown deviceMemory counts as 8 GB', () => {
  assert.deepEqual(recommendModel(gpu({ deviceMemory: undefined })), recommendModel(gpu({ deviceMemory: 8 })));
});

test('7: fewer than 10 storage buffers per shader stage — nothing fits (web-llm always requests 10)', () => {
  for (const n of [8, 9, undefined]) {
    const r = recommendModel(gpu({ maxStorageBuffersPerShaderStage: n }));
    assert.equal(r.reason, 'limits');
    assert.equal(r.recommended, null);
    assert.ok(r.list.every(m => !m.fits));
  }
});
