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
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      idle();
      child.stdin.write(`${id} ${body}\n`);
    });
  };

  return {
    run: (json) => send(json),
    selftest: (json) => send(`{"selftest":${json}}`),
    close: () => { child?.stdin.end(); },
  };
}
