// The shared preview host is retired only when broken, and retiring it settles every waiting preview.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPreviewClient } = await import('../../ui/src/workers/previewClient.js');

class FakeHost extends EventTarget {
  posted = [];
  terminated = false;
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  reply(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
  crash(message) { this.dispatchEvent(Object.assign(new Event('error'), { message })); }
}

const setup = () => {
  const hosts = [];
  const request = createPreviewClient(() => { const h = new FakeHost(); hosts.push(h); return h; },
    (event) => new Error(`crashed: ${event.message}`));
  return { hosts, request };
};

test('a 500 from a tool keeps the host', async () => {
  const { hosts, request } = setup();
  const p = request('a', {});
  hosts[0].reply({ type: 'preview', id: hosts[0].posted[0].id, status: 500, json: { success: false, error: 'bad' } });
  assert.equal((await p).status, 500);
  request('a', {});
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].terminated, false);
});

test('loadFailed retires the host and rejects the other waiting previews', async () => {
  const { hosts, request } = setup();
  const first = request('a', {});
  const second = request('b', {});
  hosts[0].reply({ type: 'preview', id: hosts[0].posted[0].id, status: 500, loadFailed: true, json: { success: false, error: 'no load' } });
  assert.equal((await first).loadFailed, true);
  await assert.rejects(second, /no load/);
  assert.equal(hosts[0].terminated, true);
  request('a', {});
  assert.equal(hosts.length, 2);
});

test('a crash rejects every waiting preview and the next starts a fresh host', async () => {
  const { hosts, request } = setup();
  const waits = [request('a', {}), request('b', {})];
  hosts[0].crash('boom');
  for (const w of waits) await assert.rejects(w, /crashed: boom/);
  request('a', {});
  assert.equal(hosts.length, 2);
});
