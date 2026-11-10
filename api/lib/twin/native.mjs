// =============================================================================
// The native twin backend: one persistent `csim-native serve` child per Node
// realm, line-framed over stdio ("<id> <json>\n" each way). The child is
// unref'd while idle so it never keeps Node alive, and exits on stdin EOF.
// =============================================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const NATIVE_BIN = join(ROOT, 'rust', 'target', 'release', 'csim-native');
const DATA_DIR = join(ROOT, 'src', 'combatsimulator', 'data');

// A stalled child, not a slow run: 1000 sim-hours of a 5-player L600 dungeon take 14 s here.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// The one libm call the engine makes. Native powf equals V8 on macOS (measured); elsewhere, check.
const POW_SAMPLE = Array.from({ length: 4096 }, (_, i) => 10 + i * 12.2071 + (i % 97) * 1e-4); // 10 .. 50,000

export function nativeBackend() {
  if (!existsSync(NATIVE_BIN)) throw new Error('csim native engine not built: run ./build.sh rust');
  let child = null;
  let buf = '';
  let nextId = 1;
  const pending = new Map();

  const idle = () => {
    if (!child) return;
    const busy = pending.size > 0;
    for (const h of [child, child.stdin, child.stdout]) busy ? h.ref?.() : h.unref?.();
  };

  const fail = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    child = null;
    buf = '';
  };

  const start = () => {
    const c = spawn(NATIVE_BIN, ['serve', '--data', DATA_DIR], { stdio: ['pipe', 'pipe', 'inherit'] });
    child = c;
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      if (child !== c) return; // a killed child's late line must not land in the next child's buf
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const sp = line.indexOf(' ');
        const p = pending.get(Number(line.slice(0, sp)));
        if (p) {
          pending.delete(Number(line.slice(0, sp)));
          p.resolve(line.slice(sp + 1));
        }
      }
      idle();
    });
    c.on('exit', (code, signal) => { if (child === c) fail(new Error(`csim-native exited (${code ?? signal})`)); });
    c.on('error', (err) => { if (child === c) fail(err); });
    c.stdin.on('error', () => {});
    idle();
  };

  const send = (body) => {
    if (!child) start();
    const id = nextId++;
    const c = child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (child === c) fail(new Error(`csim-native: no reply in ${REQUEST_TIMEOUT_MS / 1000} s; child killed`));
        c.kill('SIGKILL');
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      idle();
      child.stdin.write(`${id} ${body}\n`);
    });
  };

  let powOk = null;
  const checkPow = () => {
    powOk ??= send(`{"selftest":${JSON.stringify({ seed: 0, draws: 0, pow: POW_SAMPLE, numbers: [] })}}`).then((out) => {
      const got = JSON.parse(out).pow ?? [];
      const bad = POW_SAMPLE.filter((x, i) => !Object.is(Math.pow(x, 1.4), got[i])).length;
      if (bad) throw new Error(`csim-native: pow(x, 1.4) differs from Math.pow on ${bad}/${POW_SAMPLE.length} samples; the native engine is not bit-identical on this platform. Use CSIM_ENGINE=wasm or js.`);
    });
    powOk.catch(() => { powOk = null; }); // a crashed check is retried; a real mismatch fails again
    return powOk;
  };

  return {
    run: async (json) => { await checkPow(); return send(json); },
    selftest: (json) => send(`{"selftest":${json}}`),
    close: () => { child?.stdin.end(); },
  };
}
