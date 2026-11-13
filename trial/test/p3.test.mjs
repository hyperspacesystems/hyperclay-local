import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const P3 = path.join(REPO, 'trial', 'p3.mjs');
const DRIVER = path.join(REPO, 'trial', 'driver.cjs');
const FIXTURE = path.join(HERE, 'fixtures', 'p3-root');
const SOURCE = process.env.HTMLCLAY_SOURCE;
const SKIP = SOURCE
  ? false
  : 'HTMLCLAY_SOURCE is unset: these tests build and drive the Go managed-trial binary from the htmlclay source tree';

const EXPECTED = {
  'browser-save': 'committed',
  restore: 'committed',
  'guard-restore': 'committed',
  create: 'committed',
  duplicate: 'committed',
  move: 'committed',
  trash: 'committed',
  'restore-trash': 'committed',
  'auto-name': 'committed',
  'external-rebase': 'committed',
  'sync-download': 'not-run (needs the box)',
  'sync-upload': 'not-run (needs the box)',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function buildBinary(dir) {
  const bin = path.join(dir, 'managed-trial');
  const build = spawnSync('go', ['build', '-tags', 'managedtrial', '-o', bin, './cmd/managed-trial'], {
    cwd: SOURCE,
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
    timeout: 600000,
  });
  assert.equal(build.status, 0, `the managed-trial build failed:\n${build.stderr || build.stdout}`);
  return bin;
}

function runP3({ bin, run }) {
  const child = spawnSync(process.execPath, [
    P3,
    '--run', run,
    '--source', FIXTURE,
    '--go-bin', bin,
    '--local-source', REPO,
  ], { encoding: 'utf8', timeout: 900000 });
  return { ...child, output: `${child.stdout || ''}${child.stderr || ''}` };
}

test('P3: the headless driver and the writer check', { skip: SKIP }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-p3-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const bin = buildBinary(tmp);
  const run = path.join(tmp, 'run');
  const result = runP3({ bin, run });
  const report = fs.existsSync(path.join(run, 'p3.json')) ? readJson(path.join(run, 'p3.json')) : null;

  assert.ok(report, `p3 wrote no report (exit ${result.status}):\n${result.output}`);
  const goWriters = readJson(path.join(run, 'go', 'driver', 'writers.json')).writers;
  const goGuard = readJson(path.join(run, 'go', 'driver', 'fs-guard.json'));
  const baselineGuard = readJson(path.join(run, 'baseline', 'driver', 'fs-guard.json'));
  const canaryGuard = readJson(path.join(run, 'canary', 'driver', 'fs-guard.json'));
  const goCounts = readJson(path.join(run, 'go', 'driver', 'adapter-counts.json')).kinds;

  await t.test('the go run writes no document and no Go storage', () => {
    assert.deepEqual(goGuard.forbidden, []);
    assert.equal(report.runs.go.forbidden, 0);
  });

  await t.test('the canary is caught', () => {
    assert.equal(canaryGuard.forbidden.some((entry) => entry.path === 'canary.html'), true,
      `the canary run lists ${JSON.stringify(canaryGuard.forbidden.map((entry) => entry.path))}`);
    assert.deepEqual(report.controlProblems, []);
  });

  await t.test('the baseline shows a Node write for every Node caller', () => {
    assert.ok(baselineGuard.forbidden.length > 0);
    const nodeWriters = readJson(path.join(run, 'baseline', 'driver', 'writers.json')).writers
      .filter((writer) => writer.origin === 'node' && writer.kind !== 'external-rebase' && writer.outcome === 'committed');
    assert.ok(nodeWriters.length >= 6, `the baseline ran ${nodeWriters.length} Node writers`);
    for (const writer of nodeWriters) {
      const covered = baselineGuard.forbidden.some((entry) => writer.edits.some((edit) => (
        edit.endsWith('/') ? entry.path.startsWith(edit) : entry.path === edit
      )));
      assert.equal(covered, true, `the baseline lists no write from the ${writer.kind} caller`);
    }
  });

  await t.test('every writer has the outcome P3 expects', (sub) => {
    for (const writer of goWriters) {
      if (writer.kind === 'data-api') continue;
      assert.equal(writer.outcome, EXPECTED[writer.kind], `${writer.kind}: ${writer.error || writer.reason || ''}`);
    }
    const dataWrite = goWriters.find((writer) => writer.kind === 'data-api');
    assert.ok(dataWrite, 'the go run recorded no data write');
    if (dataWrite.outcome === 'committed') {
      assert.ok((goCounts['data-api']?.committed ?? 0) >= 1, 'the data write has no Go commit frame');
    } else {
      assert.equal(dataWrite.outcome, 'pending', `the data write answered ${dataWrite.outcome}: ${dataWrite.error}`);
      assert.equal(report.pending.some((entry) => entry.kind === 'data-api'), true);
      sub.diagnostic(`the JSON data write is pending G8b in htmlclay: ${dataWrite.reason}`);
    }
  });

  await t.test('every writer that ran is proven by a Go commit or Go answer', () => {
    for (const writer of goWriters) {
      if (['not-run (needs the box)', 'not-node', 'pending'].includes(writer.outcome)) continue;
      if (['browser-save', 'restore', 'guard-restore', 'external-rebase', 'create'].includes(writer.kind)) {
        assert.ok((goCounts[writer.kind]?.committed ?? 0) >= 1, `${writer.kind} has no committed count`);
      } else {
        assert.ok(writer.evidence, `${writer.kind} has no evidence`);
      }
    }
  });

  await t.test('the verdict is a pass with sync named as not run', () => {
    assert.equal(report.verdict, 'pass (sync not run)', JSON.stringify(report.problems));
    assert.equal(result.status, 0);
    assert.deepEqual(report.problems, []);
  });

  await t.test('a Node document write in go mode turns the verdict into a failure', (sub) => {
    const backup = path.join(tmp, 'driver.cjs.backup');
    fs.copyFileSync(DRIVER, backup);
    const before = sha256(DRIVER);
    const source = fs.readFileSync(DRIVER, 'utf8');
    const anchor = '      feed = host.events(null, () => {});\n';
    assert.equal(source.split(anchor).length, 2, 'the driver anchor for the mutation is missing');
    const mutated = source.replace(anchor, `${anchor}      await fs.promises.writeFile(path.join(rootB.path, 'p3-mutation.html'), '<!doctype html><html><body><h1>mutation</h1></body></html>\\n');\n`);
    try {
      fs.writeFileSync(DRIVER, mutated);
      const mutationRun = path.join(tmp, 'mutation');
      const mutatedResult = runP3({ bin, run: mutationRun });
      const mutatedReport = readJson(path.join(mutationRun, 'p3.json'));
      const evidence = path.join(os.tmpdir(), 'p3-mutation-evidence');
      fs.mkdirSync(evidence, { recursive: true });
      for (const [from, to] of [
        [path.join(mutationRun, 'p3.json'), 'p3.json'],
        [path.join(mutationRun, 'go', 'driver', 'fs-guard.json'), 'go-fs-guard.json'],
        [path.join(mutationRun, 'go', 'driver', 'writers.json'), 'go-writers.json'],
        [path.join(mutationRun, 'go', 'driver.log'), 'go-driver.log'],
      ]) {
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(evidence, to));
      }
      fs.appendFileSync(path.join(evidence, 'stdout.log'), `${mutatedResult.output}\n`);
      sub.diagnostic(`the mutation's output is saved in ${evidence}`);
      assert.equal(mutatedReport.verdict, 'fail');
      assert.equal(mutatedResult.status, 1);
      assert.equal(mutatedReport.problems.some((problem) => problem.includes('p3-mutation.html')), true,
        JSON.stringify(mutatedReport.problems));
    } finally {
      fs.copyFileSync(backup, DRIVER);
    }
    assert.equal(sha256(DRIVER), before, 'the driver was not restored to its own bytes');
  });
});

test('P3 with --prefix runs its writers in a fixture folder inside a root that has its own documents', { skip: SKIP }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-p3-prefix-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  fs.mkdirSync(path.join(source, 'notes'), { recursive: true });
  const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`;
  for (const rel of ['index.html', 'untitled.html', 'untitled-2.html', 'page.html', 'notes/today.html']) {
    fs.writeFileSync(path.join(source, rel), page(rel));
  }
  const bin = process.env.MANAGED_TRIAL_GO_BIN || buildBinary(tmp);
  const run = path.join(tmp, 'run');
  const child = spawnSync(process.execPath, [
    P3, '--run', run, '--source', source, '--go-bin', bin, '--local-source', REPO, '--prefix', 'p3',
  ], { encoding: 'utf8', timeout: 900000 });
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  const report = fs.existsSync(path.join(run, 'p3.json')) ? readJson(path.join(run, 'p3.json')) : null;
  assert.ok(report, `p3 wrote no report (exit ${child.status}):\n${output}`);
  assert.equal(report.prefix, 'p3');
  assert.equal(report.verdict, 'pass (sync not run)', JSON.stringify({ problems: report.problems, controlProblems: report.controlProblems }));
  assert.equal(child.status, 0);

  const goGuard = readJson(path.join(run, 'go', 'driver', 'fs-guard.json'));
  assert.deepEqual(goGuard.forbidden, []);
  const canaryGuard = readJson(path.join(run, 'canary', 'driver', 'fs-guard.json'));
  assert.equal(canaryGuard.forbidden.some((entry) => entry.path === 'p3/canary.html'), true,
    `the canary run lists ${JSON.stringify(canaryGuard.forbidden.map((entry) => entry.path))}`);

  const writers = readJson(path.join(run, 'go', 'driver', 'writers.json')).writers;
  for (const writer of writers) {
    if (writer.kind === 'data-api' || writer.outcome.startsWith('not-run')) continue;
    assert.equal(writer.outcome, 'committed', `${writer.kind}: ${writer.error || writer.reason || ''}`);
    for (const edit of writer.edits) {
      assert.ok(edit.startsWith('p3/') || edit.startsWith('.trash/p3/') || /^\.hyperclay\/[^/]+\/(\.trash\/)?p3\//.test(edit),
        `${writer.kind} aims at ${edit}, outside the fixture folder`);
    }
  }

  const goCopy = report.runs.go.copies[0];
  for (const rel of ['index.html', 'untitled.html', 'untitled-2.html', 'page.html', 'notes/today.html']) {
    assert.equal(fs.readFileSync(path.join(goCopy, rel), 'utf8'), page(rel), `${rel} at the root changed`);
  }

  const goRun = path.dirname(goCopy);
  for (const label of ['B', 'A']) {
    const p5 = spawnSync(process.execPath, [
      path.join(REPO, 'trial', 'p5.mjs'),
      '--before', path.join(goRun, 'before.sha256'),
      '--root', path.join(goRun, label),
      '--intended', path.join(run, 'go', 'driver', 'intended-edits.txt'),
      '--reference', path.join(goRun, 'C'),
      '--out', path.join(tmp, `p5-${label}.json`),
    ], { encoding: 'utf8', timeout: 300000 });
    assert.equal(p5.status, 0, `P5 on the prefixed copy ${label}:\n${p5.stdout || ''}${p5.stderr || ''}`);
  }

  const clash = path.join(tmp, 'clash');
  fs.mkdirSync(path.join(clash, 'p3'), { recursive: true });
  fs.writeFileSync(path.join(clash, 'p3', 'mine.html'), page('mine'));
  const refused = spawnSync(process.execPath, [
    P3, '--run', path.join(tmp, 'run-clash'), '--source', clash, '--go-bin', bin, '--local-source', REPO, '--prefix', 'p3',
  ], { encoding: 'utf8', timeout: 300000 });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout || ''}${refused.stderr || ''}`, /already exists in the copy/);
});
