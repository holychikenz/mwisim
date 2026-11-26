// =============================================================================
// refreshData — refresh src/combatsimulator/data/*.json from a client dump.
//
// Every file in that directory is named after a top-level key of the game's
// `init_client_data` message, so the refresh is a per-key copy and nothing
// more. The dump is captured by MWIX (kernel/storage.js) and written to
// `milkyway_client_info.json` by whichever webapp received it; this script is
// the only seam between that file and csim's bundled copy.
//
//   node tools/refreshData.mjs --check            # report, write nothing
//   node tools/refreshData.mjs                    # write
//   node tools/refreshData.mjs path/to/dump.json  # a dump elsewhere
//
// The dump path is always explicit-or-default and never discovered, so test
// server data reaches csim only when someone names it aloud.
//
// The whole dump is checked before any file is written: a key missing from it,
// or one whose type (object, array, null, ...) differs from the current file,
// refuses the refresh and writes nothing, so a bad dump never leaves the data
// folder half-updated.
//
// Two rules keep the diffs honest:
//   - A file is rewritten only when its PARSED content differs. Equal content
//     in a different serialisation is left alone, so a dump that merely
//     round-tripped through another language does not touch 17 files.
//   - Output is JSON.stringify(obj, null, 4), which is byte-for-byte the house
//     format, with a trailing newline preserved where the file had one.
//
// A refresh is NOT finished when this script exits. The generated tables in
// rust/src/generated.rs are a pure function of this data, and the
// eval baseline was recorded against the old numbers, so a data change that
// touches either leaves the build red until they follow. The v1.20260927.0
// refresh added a `boss_status` trigger condition (regenerate) and nerfed
// dryad/salamander/siren with autoAttackDamage -0.5 (re-record lab-siren-250).
// Hence the closing reminder; see the README's "Refreshing game data".
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DUMP = path.resolve(HERE, '../../cowstuff/milkyway_client_info.json');
export const DEFAULT_DATA_DIR = path.resolve(HERE, '../src/combatsimulator/data');

const serialise = (value) => JSON.stringify(value, null, 4);
const canonical = (value) => JSON.stringify(value);
const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/**
 * @returns {{gameVersion, versionTimestamp, updated: string[], unchanged: string[]}}
 * @throws when any key is missing from the dump or changes type; nothing is written then
 */
export function refresh({ dumpPath = DEFAULT_DUMP, dataDir = DEFAULT_DATA_DIR, check = false } = {}) {
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  if (dump.type !== 'init_client_data') {
    throw new Error(`${dumpPath}: not an init_client_data dump (type=${dump.type})`);
  }

  const plan = [], problems = [], unchanged = [];
  for (const file of fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')).sort()) {
    const key = path.basename(file, '.json');
    if (!(key in dump)) { problems.push(`${key} missing from the dump`); continue; }

    const full = path.join(dataDir, file);
    const current = fs.readFileSync(full, 'utf8');
    const old = JSON.parse(current);
    if (kind(dump[key]) !== kind(old)) { problems.push(`${key} is ${kind(dump[key])}, was ${kind(old)}`); continue; }
    if (canonical(old) === canonical(dump[key])) { unchanged.push(file); continue; }

    plan.push({ file, full, text: serialise(dump[key]) + (current.endsWith('\n') ? '\n' : '') });
  }
  if (problems.length) {
    throw new Error(`${dumpPath}: refusing a partial refresh, nothing written — ${problems.join('; ')}`);
  }
  if (!check) for (const p of plan) fs.writeFileSync(p.full, p.text);
  return { gameVersion: dump.gameVersion, versionTimestamp: dump.versionTimestamp, updated: plan.map((p) => p.file), unchanged };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dumpPath = args.find((a) => !a.startsWith('--')) ?? DEFAULT_DUMP;

  const r = refresh({ dumpPath, check });
  console.log(`source ${dumpPath}`);
  console.log(`  gameVersion ${r.gameVersion} (${r.versionTimestamp})`);
  for (const f of r.updated) console.log(`  ${check ? 'would update' : 'updated'}: ${f}`);
  console.log(`${r.updated.length} changed, ${r.unchanged.length} unchanged`);
  if (r.updated.length && !check) {
    console.log('\nThe refresh is not finished. Next:');
    console.log('  ./build.sh gen      # generated tables follow the data');
    console.log('  ./build.sh check    # a red eval case is a real behaviour change:');
    console.log('                      # read it, then `npm run eval:record` in api/ if it is the game, not a bug');
  }
}
