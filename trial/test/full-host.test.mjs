import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  judgeP9, judgeP10, judgeP11, judgeP13,
} from '../full-host.mjs';
import { GITHUB_ROOT } from '../setup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'full-host.mjs');
const MISSING_BIN = path.join(os.tmpdir(), 'full-host-test', 'managed-trial');

function refuse(args) {
  const run = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: path.join(HERE, '..', '..'),
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr };
}

test('an --out inside GITHUB_ROOT is refused without starting a host', () => {
  const out = path.join(GITHUB_ROOT, `full-host-test-${process.pid}`);
  const run = refuse(['--condition', 'p10', '--go-bin', MISSING_BIN, '--out', out]);
  assert.equal(run.signal, null);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /refusing --out inside GITHUB_ROOT/);
  assert.equal(run.stdout, '');
});

test('an --out inside DROPBOX_ROOT is refused without starting a host', () => {
  const out = path.join(os.homedir(), 'Dropbox', `full-host-test-${process.pid}`);
  const run = refuse(['--condition', 'p9', '--go-bin', MISSING_BIN, '--out', out]);
  assert.equal(run.signal, null);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /refusing --out inside DROPBOX_ROOT/);
});

test('an --out that is not empty is refused without starting a host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-test-out-'));
  try {
    fs.writeFileSync(path.join(dir, 'already-here'), 'x');
    const run = refuse(['--condition', 'p10', '--go-bin', MISSING_BIN, '--out', dir]);
    assert.equal(run.signal, null);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /--out must be an empty directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown --condition is refused without starting a host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-test-out-'));
  try {
    const run = refuse(['--condition', 'p12', '--go-bin', MISSING_BIN, '--out', dir]);
    assert.equal(run.signal, null);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /unknown --condition: p12/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing --go-bin is refused without starting a host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-test-out-'));
  try {
    const run = refuse(['--condition', 'p10', '--out', dir]);
    assert.equal(run.signal, null);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /--go-bin is required/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const P10_OK = [
  { id: 'page.api-requires-both-preconditions', status: 'pass' },
  { id: 'page.api-stale-refused', status: 'pass' },
  { id: 'page.api-preserves-dirty-room', status: 'pass' },
];

test('P10 passes only when all three cases pass', () => {
  const verdict = judgeP10({ cases: P10_OK });
  assert.equal(verdict.pass, true, verdict.reasons.join('; '));
  assert.equal(verdict.liveReads, 1);
  assert.equal(verdict.preservedDirty, 1);
  assert.equal(verdict.staleWrites, 0);
  assert.deepEqual(verdict.reasons, []);
});

const P10_FAILURES = [
  ['page.api-requires-both-preconditions', 'requires-both-preconditions'],
  ['page.api-stale-refused', 'stale-refused'],
  ['page.api-preserves-dirty-room', 'preserves-dirty-room'],
];

for (const [id, label] of P10_FAILURES) {
  test(`P10 fails when ${label} fails`, () => {
    const cases = P10_OK.map((entry) => (entry.id === id ? { id, status: 'fail' } : entry));
    const verdict = judgeP10({ cases });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reasons.length, 1, verdict.reasons.join('; '));
    assert.match(verdict.reasons[0], new RegExp(id.replace(/\./g, '\\.')));
    assert.equal(verdict.liveReads, id === 'page.api-preserves-dirty-room' ? 0 : 1);
    assert.equal(verdict.preservedDirty, verdict.liveReads);
    assert.equal(verdict.staleWrites, id === 'page.api-stale-refused' ? 1 : 0);
  });
}

const P9_OK = {
  rendered: 2,
  cleanWrites: 0,
  falseClean: 0,
  quit: {
    calls: 2, cancelled: true, buttons: true, detail: true, executed: false, running: true,
  },
  repair: { status: 200, sidecar: true },
  flushed: { unsaved: [], timedOut: false },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function withTerm(change) {
  const measured = clone(P9_OK);
  change(measured);
  return measured;
}

test('P9 passes only when every term holds', () => {
  const verdict = judgeP9(P9_OK);
  assert.equal(verdict.pass, true, verdict.reasons.join('; '));
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.rendered, 2);
  assert.equal(verdict.falseClean, 0);
  assert.equal(verdict.cleanWrites, 0);
});

const P9_FAILURES = [
  ['one part A case failed', (m) => { m.rendered = 1; }],
  ['a second clean checkpoint wrote', (m) => { m.cleanWrites = 1; }],
  ['the durable failure checkpointed cleanly', (m) => { m.falseClean = 1; }],
  ['quit asked once', (m) => { m.quit.calls = 1; }],
  ['quit did not cancel', (m) => { m.quit.cancelled = false; }],
  ['the dialog offered no Retry and Cancel', (m) => { m.quit.buttons = false; }],
  ['the dialog did not name the document', (m) => { m.quit.detail = false; }],
  ['quit executed while edits were unsaved', (m) => { m.quit.executed = true; }],
  ['a child of the session stopped', (m) => { m.quit.running = false; }],
  ['the repaired checkpoint timed out', (m) => { m.repair.status = 504; }],
  ['the repaired sidecar holds no p9-c', (m) => { m.repair.sidecar = false; }],
  ['stop().flushed reports an unsaved room', (m) => { m.flushed = { unsaved: ['p9.html'], timedOut: false }; }],
  ['stop().flushed reports a timeout', (m) => { m.flushed = { unsaved: [], timedOut: true }; }],
];

for (const [label, change] of P9_FAILURES) {
  test(`P9 fails when ${label}`, () => {
    const verdict = judgeP9(withTerm(change));
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reasons.length, 1, verdict.reasons.join('; '));
  });
}

const P11_OK = { outputMatches: 3, saveBeforeCompile: 1, staleInstalls: 0 };

test('P11 passes only when all three terms hold', () => {
  const verdict = judgeP11(P11_OK);
  assert.equal(verdict.pass, true, verdict.reasons.join('; '));
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.outputMatches, 3);
  assert.equal(verdict.saveBeforeCompile, 1);
  assert.equal(verdict.staleInstalls, 0);
});

const P11_FAILURES = [
  ['one of the three stylesheets did not match', (m) => { m.outputMatches = 2; }, /2 of 3/],
  ['the save waited for its compile', (m) => { m.saveBeforeCompile = 0; }, /saveBeforeCompile=0/],
  ['an older compile replaced newer output', (m) => { m.staleInstalls = 1; }, /staleInstalls=1/],
];

for (const [label, change, pattern] of P11_FAILURES) {
  test(`P11 fails when ${label}`, () => {
    const measured = { ...P11_OK };
    change(measured);
    const verdict = judgeP11(measured);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reasons.length, 1, verdict.reasons.join('; '));
    assert.match(verdict.reasons[0], pattern);
  });
}

const P13_OK = { raised: 2, notices: 2, restored: 2 };

test('P13 passes only when all three counts are met', () => {
  const verdict = judgeP13(P13_OK);
  assert.equal(verdict.pass, true, verdict.reasons.join('; '));
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.raised, 2);
  assert.equal(verdict.notices, 2);
  assert.equal(verdict.restored, 2);
});

const P13_FAILURES = [
  ['the guard raised no event', (m) => { m.raised = 1; }, /raised 1 of 2/],
  ['a notice never reached a stream', (m) => { m.notices = 1; }, /1 of 2 data-loss notices/],
  ['a restore did not bring the items back', (m) => { m.restored = 1; }, /1 of 2 restores/],
];

for (const [label, change, pattern] of P13_FAILURES) {
  test(`P13 fails when ${label}`, () => {
    const measured = { ...P13_OK };
    change(measured);
    const verdict = judgeP13(measured);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reasons.length, 1, verdict.reasons.join('; '));
    assert.match(verdict.reasons[0], pattern);
  });
}
