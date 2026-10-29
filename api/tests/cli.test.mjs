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

test('audit2-19: a non-numeric --tier, --level or --time exits 1 with the help', () => {
  for (const flag of ['--tier', '--level', '--time']) {
    const run = cli('--zone', '/actions/combat/fly', flag, 'abc');
    assert.equal(run.status, 1, flag);
    assert.match(run.stdout, /Usage:/, flag);
  }
});

test('audit2-19: a tier outside 0-5 or a time that is not positive exits 1', () => {
  for (const args of [['--tier', '9'], ['--tier', '-1'], ['--time', '0'], ['--time', '-5']]) {
    const run = cli('--zone', '/actions/combat/fly', ...args);
    assert.equal(run.status, 1, args.join(' '));
  }
});

test('audit2-19: an unknown --zone exits 1', () => {
  const run = cli('--zone', '/actions/combat/nope', '--tier', 'abc');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown zone: \/actions\/combat\/nope/);
});
