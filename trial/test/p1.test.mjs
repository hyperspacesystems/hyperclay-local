import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge } from '../p1.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const P1 = path.join(REPO, 'trial', 'p1.mjs');
const HTMLCLAY = path.join(path.dirname(REPO), 'htmlclay');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runP1(args, tmp) {
  return spawnSync(process.execPath, [P1, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
    timeout: 900000,
  });
}

function report(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function entries(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function leftoverRoots(dir) {
  return entries(dir).filter(
    (name) => name.startsWith('hyperclay-p1-') || name.startsWith('host-http-fixture-'),
  );
}

function processesUnder(dir) {
  const ps = spawnSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' });
  return ps.stdout.split('\n').filter((line) => line.includes(dir)).map((line) => line.trim());
}

function hasGo() {
  return spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
}

test('a local run passes', () => {
  const tmp = tempDir('hcl-p1-local-');
  try {
    const reportPath = path.join(tmp, 'report.json');
    const result = runP1(['--target', 'local', '--skip-local-gate', '--report', reportPath], tmp);
    assert.equal(result.status, 0, result.stderr);
    const written = report(reportPath);
    assert.equal(written.verdict, 'pass');
    assert.equal(written.target, 'local');
    assert.equal(written.packageExit, 0);
    assert.equal(written.localGateExit, null);
    assert.equal(written.waivers, 0);
    assert.equal(written.engine, 'all');
    assert.ok(fs.existsSync(written.packageReport), written.packageReport);
    assert.match(written.package.tarballSha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the go scaffold, which serves no documents yet, does not pass', (t) => {
  if (!hasGo()) {
    t.skip('go is not on PATH: cannot build cmd/managed-trial in htmlclay');
    return;
  }
  const tmp = tempDir('hcl-p1-go-');
  try {
    const bin = path.join(tmp, 'managed-trial');
    const build = spawnSync(
      'go',
      ['build', '-tags', 'managedtrial', '-o', bin, './cmd/managed-trial'],
      { cwd: HTMLCLAY, encoding: 'utf8', env: { ...process.env, CGO_ENABLED: '0' } },
    );
    assert.equal(build.status, 0, build.stderr);
    const reportPath = path.join(tmp, 'report.json');
    const result = runP1(
      ['--target', 'go', '--go-bin', bin, '--skip-local-gate', '--report', reportPath],
      tmp,
    );
    assert.equal(result.status, 3, result.stderr);
    const written = report(reportPath);
    assert.equal(written.verdict, 'could-not-demonstrate');
    assert.equal(written.packageExit, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a package that answers with failures is a fail, and one that cannot answer is not a verdict', () => {
  assert.deepEqual(
    [judge({ packageExit: 0, waivers: 0 }).verdict, judge({ packageExit: 1, waivers: 0 }).verdict, judge({ packageExit: 3, waivers: 0 }).verdict],
    ['pass', 'fail', 'could-not-demonstrate'],
  );
  assert.equal(judge({ packageExit: 1, waivers: 0 }).code, 1);
});

test('a waiver makes an otherwise passing local run fail', () => {
  const tmp = tempDir('hcl-p1-waiver-');
  try {
    const waivers = path.join(tmp, 'waivers.json');
    fs.writeFileSync(waivers, `${JSON.stringify({
      version: 1,
      waivers: [{ check: 'core.meta', reason: 'the trial may not waive anything', until: '2099-01-01' }],
    }, null, 2)}\n`);
    const reportPath = path.join(tmp, 'report.json');
    const result = runP1(
      ['--target', 'local', '--skip-local-gate', '--waivers', waivers, '--report', reportPath],
      tmp,
    );
    assert.equal(result.status, 1, result.stderr);
    const written = report(reportPath);
    assert.equal(written.verdict, 'fail');
    assert.equal(written.waivers, 1);
    assert.match(result.stderr, /1 waiver/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a go host that exits immediately is infrastructure, not a verdict', () => {
  const tmp = tempDir('hcl-p1-dead-');
  try {
    const bin = path.join(tmp, 'go-that-exits');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(bin, 0o755);
    const reportPath = path.join(tmp, 'report.json');
    const result = runP1(
      ['--target', 'go', '--go-bin', bin, '--skip-local-gate', '--report', reportPath],
      tmp,
    );
    assert.equal(result.status, 3, result.stderr);
    const written = report(reportPath);
    assert.equal(written.verdict, 'could-not-demonstrate');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a run leaves no process and no temp root behind', () => {
  const tmp = tempDir('hcl-p1-clean-');
  try {
    const reportPath = path.join(tmp, 'report.json');
    const result = runP1(['--target', 'local', '--skip-local-gate', '--report', reportPath], tmp);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(leftoverRoots(tmp), []);
    assert.deepEqual(processesUnder(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
