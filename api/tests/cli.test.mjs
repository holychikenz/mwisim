// audit-19 — the CLI keeps a fractional --time, its help names the game's
// tiers, and the loader works from any working directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// From the REPO ROOT, not api/: the loader must not depend on the cwd.
const cli = (...args) =>
  spawnSync(process.execPath, ['--import', './api/register-loader.js', 'api/cli.js', ...args], { cwd: ROOT, encoding: 'utf8' });

test('audit-19: --time 0.01 simulates 0.01 h from the repo root', () => {
  const run = cli('--zone', '/actions/combat/fly', '--time', '0.01');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Duration: 0\.01 hours/);
  assert.match(run.stdout, /Encounters: [1-9]/);
});

test('audit-19: the help text gives the game tier range', () => {
  const run = cli('--help');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Difficulty tier 0-5/);
});
