import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup, EXCLUDED, LOCAL_APPS } from '../setup.mjs';

const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'setup.mjs');
const FIXED_TIME = new Date('2026-01-02T03:04:05Z');

const KEPT_FILES = [
  'apps/board.htmlclay',
  'apps/empty.txt',
  'apps/journal.html',
  'uploads/assets-x/pic-abc123.png',
];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.utimesSync(target, FIXED_TIME, FIXED_TIME);
  return target;
}

function buildSource() {
  const root = tempDir('hcl-trial-src-');
  writeFile(root, 'personal/journal.htmlclay', 'secret-1');
  writeFile(root, '.hyperclay/versions/personal/journal/2026-01-01.html', 'secret-2');
  writeFile(root, '.hyperclay/guard/personal/journal.json', '{"guard":"secret-4"}');
  writeFile(root, '.hyperclay/conflicts/personal/journal.remote-ab12.htmlclay', 'secret-5');
  writeFile(root, '.hyperclay/page-state/personal/journal.htmlclay.json', '{"state":"secret-6"}');
  writeFile(root, '.hyperclay/versions/journal/old.html', 'secret-3');
  writeFile(root, '.hyperclay/guard/journal.json', '{"orphan":"secret-7"}');
  writeFile(root, '.git/HEAD', 'ref: refs/heads/main\n');
  writeFile(root, 'apps/journal.html', '<h1>public journal app</h1>');
  writeFile(root, 'apps/board.htmlclay', '<h1>board</h1>');
  writeFile(root, 'apps/empty.txt', '');
  writeFile(root, 'personal/empty.txt', '');
  fs.mkdirSync(path.join(root, 'uploads/assets-x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uploads/assets-x/pic-abc123.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]));
  fs.utimesSync(path.join(root, 'uploads/assets-x/pic-abc123.png'), FIXED_TIME, FIXED_TIME);
  fs.mkdirSync(path.join(root, 'apps/later'), { recursive: true });
  return root;
}

function freshRunDir() {
  return path.join(tempDir('hcl-trial-run-'), 'run');
}

function listFiles(root) {
  const files = [];
  const visit = (abs, segs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = [...segs, entry.name];
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        visit(full, next);
        continue;
      }
      files.push(next.join('/'));
    }
  };
  visit(root, []);
  return files.sort();
}

function listDirs(root) {
  const dirs = [];
  const visit = (abs, segs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const next = [...segs, entry.name];
      dirs.push(next.join('/'));
      visit(path.join(abs, entry.name), next);
    }
  };
  visit(root, []);
  return dirs.sort();
}

function runCli(src, run, extra = []) {
  return spawnSync(process.execPath, [SETUP, '--src', src, '--run', run, ...extra], { encoding: 'utf8' });
}

test('clean source: copies hold only the non-excluded tree and the proof passes', () => {
  const src = buildSource();
  const run = freshRunDir();
  const result = runCli(src, run);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const proof = JSON.parse(fs.readFileSync(path.join(run, 'exclusion-proof.json'), 'utf8'));
  assert.equal(proof.pass, true);
  assert.deepEqual(proof.pathsFound, []);
  assert.deepEqual(proof.hashesFound, []);
  assert.deepEqual(proof.excluded, EXCLUDED);
  assert.equal(fs.existsSync(path.join(run, 'PROOF-FAILED')), false);

  for (const label of ['C', 'A', 'B']) {
    const copy = path.join(run, label);
    assert.deepEqual(listFiles(copy), KEPT_FILES, `${label} file list`);
    assert.deepEqual(listDirs(copy).filter((dir) => dir === 'apps/later'), ['apps/later'], `${label} empty dir`);
    assert.equal(listFiles(copy).some((rel) => rel.split('/').includes('personal')), false, `${label} has no personal path`);
    assert.equal(fs.existsSync(path.join(copy, '.git')), false, `${label} has no .git`);
  }

  const sourceJournal = fs.readFileSync(path.join(src, 'apps/journal.html'));
  for (const label of ['C', 'A', 'B']) {
    const copy = path.join(run, label);
    assert.deepEqual(fs.readFileSync(path.join(copy, 'apps/journal.html')), sourceJournal);
    assert.equal(fs.statSync(path.join(copy, 'apps/journal.html')).mtimeMs, FIXED_TIME.getTime());
    assert.deepEqual(
      fs.readFileSync(path.join(copy, 'uploads/assets-x/pic-abc123.png')),
      fs.readFileSync(path.join(src, 'uploads/assets-x/pic-abc123.png')),
    );
    assert.equal(fs.readFileSync(path.join(copy, 'apps/empty.txt'), 'utf8'), '');
  }

  for (const rel of KEPT_FILES) {
    const mode = fs.statSync(path.join(run, 'C', rel)).mode;
    assert.equal(mode & 0o222, 0, `${rel} in C is read-only`);
    assert.throws(() => fs.accessSync(path.join(run, 'C', rel), fs.constants.W_OK));
  }

  const verify = spawnSync('shasum', ['-a', '256', '-c', path.join(run, 'before.sha256')], { cwd: path.join(run, 'A'), encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /apps\/journal\.html: OK/);
});

test('a copy of the journal under another name stops the run', () => {
  const src = buildSource();
  writeFile(src, '.trash/old.htmlclay', 'secret-1');
  const run = freshRunDir();
  const result = runCli(src, run);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(run, 'PROOF-FAILED')), true);

  const proof = JSON.parse(fs.readFileSync(path.join(run, 'exclusion-proof.json'), 'utf8'));
  assert.equal(proof.pass, false);
  assert.equal(proof.hashesFound.some((entry) => entry.path.includes('.trash/old.htmlclay')), true, JSON.stringify(proof.hashesFound));
  assert.match(result.stdout + result.stderr, /must not be uploaded/);
});

test('an empty guard record the journal shares with other documents does not stop the run', () => {
  const src = buildSource();
  const empty = '{"baseline":null,"uiWorkPending":false,"event":null,"status":"none"}';
  writeFile(src, '.hyperclay/guard/personal/journal.json', empty);
  writeFile(src, '.hyperclay/guard/journal.json', empty);
  writeFile(src, '.hyperclay/guard/apps/board.json', empty);
  const run = freshRunDir();
  const result = runCli(src, run);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(run, 'C', '.hyperclay/guard/apps/board.json'), 'utf8'), empty);
});

test('a guard record carrying a baseline is still fingerprinted', () => {
  const src = buildSource();
  const record = '{"baseline":{"items":["secret-8"]},"uiWorkPending":false,"event":null,"status":"none"}';
  writeFile(src, '.hyperclay/guard/journal.json', record);
  writeFile(src, '.hyperclay/guard/apps/board.json', record);
  const run = freshRunDir();
  const result = runCli(src, run);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('the journal save test history is excluded', () => {
  const src = buildSource();
  writeFile(src, '.hyperclay/versions/journal-save-test/2026-09-25.html', 'secret-9');
  writeFile(src, '.hyperclay/guard/journal-save-test.json', '{"guard":"secret-10"}');
  const run = freshRunDir();
  const result = runCli(src, run);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(run, 'C', '.hyperclay/versions/journal-save-test')), false);
  assert.equal(fs.existsSync(path.join(run, 'C', '.hyperclay/guard/journal-save-test.json')), false);
});

test('refusals: non-empty run directory, run inside src and a run under the GitHub folder', () => {
  const src = buildSource();

  const busyRun = freshRunDir();
  fs.mkdirSync(busyRun, { recursive: true });
  fs.writeFileSync(path.join(busyRun, 'already-here.txt'), 'x');
  assert.throws(() => setup({ src, run: busyRun }), /must be an empty directory/);

  assert.throws(() => setup({ src, run: path.join(src, 'nested-run') }), /--run must not be inside --src/);

  const githubRun = path.join(os.homedir(), 'Documents', 'GitHub', 'hcl-trial-never-created-' + crypto.randomBytes(4).toString('hex'));
  assert.equal(fs.existsSync(githubRun), false);
  assert.throws(() => setup({ src, run: githubRun }), /refusing --run inside .*GitHub/);
});

test('refusals: a src inside LOCAL_APPS needs --allow-local-apps and a symlink in src stops the copy', () => {
  const nearLocalApps = path.join(LOCAL_APPS, 'does-not-exist-' + crypto.randomBytes(4).toString('hex'));
  assert.equal(fs.existsSync(nearLocalApps), false);
  assert.throws(() => setup({ src: nearLocalApps, run: freshRunDir() }), /--allow-local-apps/);

  const symlinkSrc = buildSource();
  fs.symlinkSync(path.join(symlinkSrc, 'apps/journal.html'), path.join(symlinkSrc, 'link.htmlclay'));
  assert.throws(() => setup({ src: symlinkSrc, run: freshRunDir() }), /symlink: .*link\.htmlclay/);
});

// Run against a scratch home whose LOCAL_APPS is a fixture, so a regression
// copies fixtures, never this machine's workspace.
test('refusals: a src that contains LOCAL_APPS is refused, even with --allow-local-apps', () => {
  const home = fs.realpathSync(tempDir('hcl-trial-home-'));
  const hyper = path.join(home, 'Documents', 'GitHub', 'hyper');
  writeFile(hyper, 'LOCAL_APPS/apps/a.html', '<p>a</p>');
  writeFile(hyper, 'other/b.html', '<p>b</p>');
  const runs = [freshRunDir(), freshRunDir()];
  const script = `
    import { setup } from ${JSON.stringify(new URL(`file://${SETUP}`).href)};
    const results = [];
    for (const [index, allowLocalApps] of [false, true].entries()) {
      try {
        setup({ src: ${JSON.stringify(hyper)}, run: ${JSON.stringify(runs)}[index], allowLocalApps });
        results.push('accepted');
      } catch (error) {
        results.push(error.message);
      }
    }
    console.log(JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(results.length, 2);
  for (const message of results) assert.match(message, /contains LOCAL_APPS/);
  for (const run of runs) assert.equal(fs.existsSync(run), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('mutation proof: dropping the .hyperclay/*/personal exclusion fails the clean-source run', () => {
  const src = buildSource();
  const run = freshRunDir();
  const mutated = EXCLUDED.filter((entry) => entry !== '.hyperclay/*/personal');
  assert.equal(mutated.length, EXCLUDED.length - 1);

  let error = null;
  try {
    setup({ src, run, excluded: mutated });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'the mutated exclusion list must fail the proof');
  assert.equal(error.code, 'PROOF_FAILED');

  const proof = JSON.parse(fs.readFileSync(path.join(run, 'exclusion-proof.json'), 'utf8'));
  assert.equal(proof.pass, false);
  assert.equal(proof.pathsFound.some((entry) => entry.includes('.hyperclay/versions/personal/')), true, JSON.stringify(proof.pathsFound));
  assert.equal(fs.existsSync(path.join(run, 'PROOF-FAILED')), true);

  const saved = path.join(os.tmpdir(), 'hcl-trial-mutation-output.json');
  fs.writeFileSync(saved, JSON.stringify({ message: error.message, proof }, null, 2) + '\n');
});
