import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judgeP8 } from '../p8.mjs';
import { GITHUB_ROOT, LOCAL_APPS } from '../setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const P8 = path.join(REPO, 'trial', 'p8.mjs');
const GO_BIN = path.join(os.tmpdir(), 'hcl-p8-no-such-managed-trial');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSource() {
  const dir = path.join(tempDir('hcl-p8-source-'), 'source');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html>\n<html><body>index</body></html>\n');
  return dir;
}

function runP8(args) {
  return spawnSync(process.execPath, [P8, ...args], { encoding: 'utf8', timeout: 60000 });
}

test('refuses an --out inside GITHUB_ROOT', () => {
  const source = makeSource();
  const out = path.join(GITHUB_ROOT, `hcl-p8-refused-${process.pid}`);
  try {
    const run = runP8(['--source', source, '--go-bin', GO_BIN, '--out', out]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /refusing --out inside GITHUB_ROOT/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(path.dirname(source), { recursive: true, force: true });
  }
});

test('refuses a non-empty --out', () => {
  const source = makeSource();
  const work = tempDir('hcl-p8-');
  const out = path.join(work, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'leftover.txt'), 'not empty\n');
  try {
    const run = runP8(['--source', source, '--go-bin', GO_BIN, '--out', out]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /--out must be an empty directory/);
    assert.deepEqual(fs.readdirSync(out), ['leftover.txt']);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(path.dirname(source), { recursive: true, force: true });
  }
});

test(
  'refuses a --source inside LOCAL_APPS without the flag',
  { skip: fs.existsSync(LOCAL_APPS) ? false : 'LOCAL_APPS is not on this machine' },
  () => {
    const work = tempDir('hcl-p8-');
    try {
      const run = runP8(['--source', LOCAL_APPS, '--go-bin', GO_BIN, '--out', path.join(work, 'out')]);
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /inside LOCAL_APPS/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
);

const GOOD = {
  p1: { exit: 0, verdict: 'pass', failing: [] },
  p2: {
    exit: 0,
    compared: 60,
    families: [],
    allowances: {
      origin: 0, AD1: 0, AD3: 0, AD4: 0,
    },
  },
  missingExtensions: [],
};

function withChange(change) {
  const p1 = { ...GOOD.p1, ...(change.p1 || {}) };
  const p2 = {
    ...GOOD.p2,
    ...(change.p2 || {}),
    allowances: { ...GOOD.p2.allowances, ...((change.p2 && change.p2.allowances) || {}) },
  };
  return { p1, p2, missingExtensions: change.missingExtensions ?? GOOD.missingExtensions };
}

const FAILING_CASES = [
  ['P1 exit 1', { p1: { exit: 1 } }],
  ['P1 verdict fail', { p1: { verdict: 'fail' } }],
  ['differential exit 1', { p2: { exit: 1 } }],
  ['compared 49', { p2: { compared: 49 } }],
  ['AD1 applied once', { p2: { allowances: { AD1: 1 } } }],
  ['AD3 applied once', { p2: { allowances: { AD3: 1 } } }],
  ['one missing extension', { missingExtensions: ['presence'] }],
];

test('judgeP8 passes only the all-good case', (t) => {
  const good = judgeP8(GOOD);
  assert.equal(good.verdict, 'PASS');
  assert.deepEqual(good.reasons, []);

  for (const [name, change] of FAILING_CASES) {
    t.test(name, () => {
      const result = judgeP8(withChange(change));
      assert.equal(result.verdict, 'FAIL');
      assert.equal(result.reasons.length, 1, result.reasons.join('; '));
    });
  }
});
