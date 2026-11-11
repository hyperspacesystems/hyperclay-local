import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  canonical, evidencePathFor, parseCandidateArgs, validateCandidateContext, validateReport, verdictExit,
} from './conformance-candidate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WRAPPER = path.join(HERE, 'conformance-candidate.mjs');
const PACKAGE = '@panphora/host-conformance';
const HOST = 'hyperclay-local';

const LAUNCHER = `import { writeFileSync } from 'node:fs';
const modes = {
  green: { code: 0, checks: [['row.one', 'pass']] },
  red: { code: 1, checks: [['row.one', 'pass'], ['row.two', 'fail']] },
  infra: { code: 3, checks: [['row.one', 'na']] },
  zero_with_fail: { code: 0, checks: [['row.one', 'fail']] },
  one_without_fail: { code: 1, checks: [['row.one', 'pass']] },
  missing: { code: 0 },
  malformed: { code: 0, raw: '{ not json' },
  wrong_version: { code: 0, version: 'not-a-version', checks: [['row.one', 'pass']] },
  wrong_host: { code: 0, host: 'htmlclay', checks: [['row.one', 'pass']] },
  signal: { code: null, signal: true },
};
const mode = modes[process.env.FAKE_MODE || 'green'];
if (process.env.FAKE_ARGS) writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
if (mode.raw) writeFileSync(process.env.CONFORMANCE_REPORT, mode.raw);
else if (mode.checks) writeFileSync(process.env.CONFORMANCE_REPORT, JSON.stringify({
  schema: 1,
  package: '${PACKAGE}',
  version: mode.version || '1.0.0',
  host: mode.host || '${HOST}',
  checks: mode.checks.map(([id, status]) => ({ id, status })),
}));
if (mode.signal) process.kill(process.pid, 'SIGKILL');
process.exit(mode.code);
`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-candidate-test-'));
}

function fixture({
  platform = 'linux', manifest = {}, candidate = '{"schema":1}\n', writePlatform = true,
  writeContext = true, treeVersion = '1.0.0',
} = {}) {
  const cwd = scratch();
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'hyperclay-local-electron', version: treeVersion }));
  fs.writeFileSync(path.join(cwd, 'candidate.json'), candidate);
  const record = {
    manifest: {
      app: HOST,
      candidate_sha256: sha256(Buffer.from(candidate)),
      prepared_tree_sha256: 'b'.repeat(64),
      version: '1.0.0',
      workflow_sha: 'c'.repeat(40),
      ...candidateContract(),
      attempt: 'attempt-fixture',
      ...manifest,
    },
    source_sha: 'd'.repeat(40),
    payload_date: '2026-11-01T10:00:00Z',
  };
  if (writePlatform) fs.writeFileSync(path.join(cwd, 'platform-candidate.json'), JSON.stringify(record));
  if (writeContext) {
    fs.writeFileSync(path.join(cwd, '.platform-context.json'), JSON.stringify({ payload_date: record.payload_date }));
  }
  const launcher = path.join(cwd, 'fake-launcher.mjs');
  fs.writeFileSync(launcher, LAUNCHER);
  const identity = sha256(Buffer.from(canonical(record.manifest)));
  const env = {
    PATH: process.env.PATH,
    APP: HOST,
    ATTEMPT: record.manifest.attempt,
    CANDIDATE_SHA256: record.manifest.candidate_sha256,
    WORKFLOW_SHA: record.manifest.workflow_sha,
    MANIFEST_IDENTITY: identity,
    CONFORMANCE_LAUNCHER: launcher,
    FAKE_MODE: 'green',
  };
  return { cwd, env, platform, manifest: record.manifest, record, identity };
}

function candidateContract() {
  const checks = ['verify', 'conformance', 'linux-x64-server-save', 'linux-arm64-server-save'];
  return {
    checks,
    artifacts: ['identity', 'conformance-linux', 'conformance-linux-x64-artifact', 'conformance-linux-arm64-artifact'],
  };
}

function run({ cwd, env, args = [] }) {
  return spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd,
    env: { ...env },
    encoding: 'utf8',
  });
}

function evidence(cwd, platform = 'linux') {
  return JSON.parse(fs.readFileSync(path.join(cwd, evidencePathFor(platform)), 'utf8'));
}

test('valid green and red child verdicts become evidence and a passed job', () => {
  for (const [mode, exitCode, statuses] of [
    ['green', 0, ['pass']],
    ['red', 1, ['pass', 'fail']],
  ]) {
    const { cwd, env, identity } = fixture();
    const result = run({ cwd, env: { ...env, FAKE_MODE: mode }, args: ['--platform', 'linux'] });
    assert.equal(result.status, 0, result.stderr);
    const envelope = evidence(cwd);
    assert.deepEqual(envelope, {
      schema: 1,
      app: HOST,
      platform: 'linux',
      workflow_sha: 'c'.repeat(40),
      candidate_sha256: sha256(Buffer.from('{"schema":1}\n')),
      attempt: 'attempt-fixture',
      manifest_identity: identity,
      exitCode,
      report: {
        schema: 1,
        package: PACKAGE,
        version: '1.0.0',
        host: HOST,
        checks: statuses.map((status, index) => ({ id: ['row.one', 'row.two'][index], status })),
      },
    });
  }
});

test('an infrastructure exit fails the job and writes no evidence', () => {
  const { cwd, env } = fixture();
  const result = run({ cwd, env: { ...env, FAKE_MODE: 'infra' }, args: ['--platform', 'linux'] });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /exited 3, which is not a verdict/);
  assert.equal(fs.existsSync(path.join(cwd, evidencePathFor('linux'))), false);
});

test('a signal, a missing report and a malformed report all fail the job', () => {
  for (const mode of ['signal', 'missing', 'malformed']) {
    const { cwd, env } = fixture();
    const result = run({ cwd, env: { ...env, FAKE_MODE: mode }, args: ['--platform', 'linux'] });
    assert.equal(result.status, 3, mode);
    assert.equal(fs.existsSync(path.join(cwd, evidencePathFor('linux'))), false, mode);
  }
});

test('a report that disagrees with the child exit is not a verdict', () => {
  for (const mode of ['zero_with_fail', 'one_without_fail', 'wrong_version', 'wrong_host']) {
    const { cwd, env } = fixture();
    const result = run({ cwd, env: { ...env, FAKE_MODE: mode }, args: ['--platform', 'linux'] });
    assert.equal(result.status, 3, mode);
    assert.equal(fs.existsSync(path.join(cwd, evidencePathFor('linux'))), false, mode);
  }
});

test('candidate identity must match the verified dispatch and archive', () => {
  const mutations = [
    (env) => ({ ...env, WORKFLOW_SHA: 'e'.repeat(40) }),
    (env) => ({ ...env, MANIFEST_IDENTITY: 'f'.repeat(64) }),
    (env) => ({ ...env, CANDIDATE_SHA256: 'a'.repeat(64) }),
    (env) => ({ ...env, ATTEMPT: 'other-attempt' }),
    (env) => ({ ...env, APP: 'other-app' }),
    (env) => ({ ...env, MANIFEST_IDENTITY: '' }),
  ];
  for (const mutate of mutations) {
    const { cwd, env } = fixture();
    const result = run({ cwd, env: mutate(env), args: ['--platform', 'linux'] });
    assert.equal(result.status, 3, JSON.stringify(mutate(env)));
  }
  const { cwd, env } = fixture();
  fs.writeFileSync(path.join(cwd, 'candidate.json'), '{"schema":2}\n');
  assert.equal(run({ cwd, env, args: ['--platform', 'linux'] }).status, 3);
});

test('the palette context and the prepared tree must agree with the archive', () => {
  const missingContext = fixture({ writeContext: false });
  assert.equal(run({ cwd: missingContext.cwd, env: missingContext.env, args: ['--platform', 'linux'] }).status, 3);
  const staleContext = fixture();
  fs.writeFileSync(path.join(staleContext.cwd, '.platform-context.json'), '{"payload_date":"2026-01-01T00:00:00Z"}');
  assert.equal(run({ cwd: staleContext.cwd, env: staleContext.env, args: ['--platform', 'linux'] }).status, 3);
  const wrongTree = fixture({ treeVersion: '9.9.9' });
  assert.equal(run({ cwd: wrongTree.cwd, env: wrongTree.env, args: ['--platform', 'linux'] }).status, 3);
  const wrongApp = fixture({ manifest: { app: 'htmlclay' } });
  assert.equal(run({ cwd: wrongApp.cwd, env: { ...wrongApp.env, APP: '' }, args: ['--platform', 'linux'] }).status, 3);
});

test('the platform must be one the candidate manifest declares', () => {
  const { cwd, env } = fixture();
  assert.equal(run({ cwd, env, args: ['--platform', 'windows'] }).status, 3);
  assert.equal(run({ cwd, env, args: ['--platform', 'linux-arm64-artifact'] }).status, 0);
  assert.equal(run({ cwd, env, args: ['--platform'] }).status, 3);
});

test('missing context files fail the job', () => {
  const { cwd, env } = fixture({ writePlatform: false });
  assert.equal(run({ cwd, env, args: ['--platform', 'linux'] }).status, 3);
  const second = fixture();
  fs.rmSync(path.join(second.cwd, 'package.json'));
  assert.equal(run({ cwd: second.cwd, env: second.env, args: ['--platform', 'linux'] }).status, 3);
});

test('an envelope that cannot be written fails the job', () => {
  const { cwd, env } = fixture();
  fs.mkdirSync(path.join(cwd, evidencePathFor('linux')), { recursive: true });
  const result = run({ cwd, env, args: ['--platform', 'linux'] });
  assert.equal(result.status, 3);
});

test('attach arguments reach the launcher unchanged', () => {
  const { cwd, env } = fixture();
  const argsFile = path.join(cwd, 'args.json');
  const result = run({
    cwd,
    env: { ...env, FAKE_ARGS: argsFile },
    args: ['--platform', 'linux-x64-artifact', '--url', 'http://127.0.0.1:4321', '--root', '/tmp/home/apps',
      '--page', '_mhf-host-test.html', '--doc', '/_mhf-host-test.html', '--target', '/_mhf-host-test.html'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), [
    '--url', 'http://127.0.0.1:4321', '--root', '/tmp/home/apps',
    '--page', '_mhf-host-test.html', '--doc', '/_mhf-host-test.html', '--target', '/_mhf-host-test.html',
  ]);
  assert.equal(evidence(cwd, 'linux-x64-artifact').platform, 'linux-x64-artifact');
});

test('candidate arguments and manifest identity follow the dispatch', () => {
  assert.deepEqual(parseCandidateArgs(['--platform', 'linux', '--url', 'u']), { platform: 'linux', launcher: ['--url', 'u'] });
  assert.deepEqual(parseCandidateArgs(['--platform=linux', '--engine', 'http']), { platform: 'linux', launcher: ['--engine', 'http'] });
  assert.throws(() => parseCandidateArgs([]), /--platform is required/);
  assert.throws(() => parseCandidateArgs(['--platform', 'Linux']), /not a label/);
  const { cwd, env } = fixture();
  const context = validateCandidateContext({ cwd, env, platform: 'linux' });
  assert.equal(context.manifest_identity, env.MANIFEST_IDENTITY);
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

function writeReport(checks, overrides = {}) {
  const cwd = scratch();
  const reportPath = path.join(cwd, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    schema: 1, package: PACKAGE, version: '1.0.0', host: HOST, checks, ...overrides,
  }));
  return reportPath;
}

test('every row status the package emits is a report the wrapper accepts', () => {
  const checks = [
    { id: 'row.pass', status: 'pass', blocking: false },
    { id: 'row.skip', status: 'skip', blocking: false },
    { id: 'row.na', status: 'na', blocking: false },
    { id: 'row.waived', status: 'waived', blocking: false },
    { id: 'row.waiver-unused', status: 'waiver-unused', blocking: false },
  ];
  const report = validateReport(writeReport(checks));
  assert.deepEqual(report.checks, checks);
  assert.equal(verdictExit(report, 0), 0);
});

test('a report the wrapper cannot read a verdict from is still refused', () => {
  const refused = [
    ['unknown status', [{ id: 'row.maybe', status: 'maybe' }], /unknown status "maybe"/],
    ['blocking na', [{ id: 'row.answer', status: 'na', blocking: true }], /leaves row row\.answer unanswered/],
    ['missing status', [{ id: 'row.absent' }], /unknown status null/],
    ['duplicate ids', [{ id: 'row.same', status: 'pass' }, { id: 'row.same', status: 'pass' }], /nonempty unique row ids/],
    ['no checks', [], /holds no checks/],
  ];
  for (const [label, checks, message] of refused) {
    assert.throws(() => validateReport(writeReport(checks)), message, label);
  }
});

test('a complete report shaped like the real gate is a passed verdict', () => {
  const rows = [
    ['capability.conditional', 'pass'], ['capability.data-guard-v1', 'pass'],
    ['capability.data-read', 'pass'], ['capability.data-write', 'pass'],
    ['capability.format', 'pass'], ['capability.live-data', 'pass'],
    ['capability.live-provenance', 'pass'], ['capability.page', 'pass'],
    ['capability.blockeditor-awareness-v1', 'pass'], ['capability.blockeditor-format-v1', 'pass'],
    ['capability.blockeditor-recovery-v1', 'pass'], ['capability.people', 'pass'],
    ['capability.presence', 'pass'], ['capability.receipts', 'pass'],
    ['capability.record-awareness-v1', 'pass'], ['capability.scoped-stylesheet', 'pass'],
    ['capability.sync', 'pass'], ['capability.sync-worker', 'pass'],
    ['capability.upload', 'pass'], ['capability.wire', 'pass'],
    ['capability.registered', 'pass'], ['page.target-same-origin', 'pass'],
    ['core.meta', 'pass'], ['core.save-roundtrip', 'pass'], ['core.document-block', 'pass'],
    ['core.non-html-refused', 'pass'], ['core.refusal-reason', 'pass'], ['core.traversal', 'na'],
    ['core.cross-origin', 'na'], ['core.unknown-host-path', 'pass'], ['format.opt-in', 'pass'],
    ['sync.relay', 'pass'], ['sync-worker.one-stream', 'pass'], ['conditional.stale-if-match', 'pass'],
    ['receipts.save-id', 'pass'], ['upload.announced', 'pass'], ['upload.url-resolves', 'pass'],
    ['upload.no-listing', 'pass'], ['upload.same-name', 'pass'], ['upload.concurrent', 'pass'],
    ['upload.document-refused', 'pass'], ['upload.not-a-page', 'pass'],
    ['upload.traversal', 'pass'], ['upload.size-cap', 'pass'], ['wire.document-url', 'pass'],
    ['core.origin-probe', 'pass', true], ['frozen.inline-token-save', 'pass'],
    ['frozen.welcome-alias-save', 'pass'], ['frozen.oldest-cookie-lane', 'pass'],
    ['frozen.bare-save-route', 'pass'], ['frozen.marked-save-route', 'pass'],
    ['frozen.unchanged-save', 'pass'], ['frozen.lost-response', 'pass'],
    ['frozen.foreign-save-not-overwritten', 'pass'], ['http.h1', 'pass'], ['http.h2', 'pass'],
    ['http.h3-token', 'skip'], ['http.h3-strip', 'skip'], ['http.h4-identity', 'skip'],
    ['http.h5', 'pass'], ['http.h6', 'pass'], ['http.h7', 'pass'], ['http.h8', 'pass'],
    ['http.h9', 'pass'], ['http.h10-refused', 'pass'], ['http.h11', 'pass'],
    ['http.data-guard-restore', 'pass'], ['http.data-guard-refusals', 'pass'],
    ['http.data-guard-notified', 'pass'],
  ];
  const checks = rows.map(([id, status, blocking]) => ({ id, status, blocking: blocking === true }));
  const report = validateReport(writeReport(checks));
  assert.equal(verdictExit(report, 0), 0);
  assert.ok(report.checks.some((check) => check.status === 'skip'));
  assert.ok(report.checks.some((check) => check.status === 'na' && check.blocking === false));
});

test('the evidence the wrapper writes is the file each workflow uploads', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.length, 'no workflows to check');
  const counts = {};
  for (const file of files) {
    const workflow = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
    const uploads = Object.values(workflow?.jobs ?? {})
      .flatMap((job) => job?.steps ?? [])
      .filter((step) => step?.uses === 'actions/upload-artifact@v4'
        && typeof step?.with?.name === 'string' && step.with.name.startsWith('conformance-'));
    counts[file] = uploads.length;
    for (const step of uploads) {
      const expected = evidencePathFor(step.with.name.slice('conformance-'.length));
      const uploaded = String(step.with.path ?? '').replace(/^candidate\//, '');
      assert.equal(uploaded, expected, `${file} uploads ${step.with.name} from ${step.with.path}`);
    }
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  assert.ok(total > 0, 'no workflow uploads conformance evidence');
});
