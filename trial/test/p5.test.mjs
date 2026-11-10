import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup, LOCAL_APPS } from '../setup.mjs';
import { checkIntegrity } from '../p5.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P5 = path.join(HERE, '..', 'p5.mjs');

const INDEX = '<!DOCTYPE html>\n<html lang="en"><head><title>index</title></head><body>index</body></html>\n';
const MANAGED = '<!DOCTYPE html>\n<html htmlclayid="abc123" lang="en"><body>managed</body></html>\n';
const BOARD = '<html><body>board</body></html>\n';
const NOTES = '<!DOCTYPE html>\n<html lang="en"><body>notes</body></html>\n';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function buildSource() {
  const src = tempDir('hcl-p5-src-');
  writeFile(src, 'index.html', INDEX);
  writeFile(src, 'managed.html', MANAGED);
  writeFile(src, 'board.htmlclay', BOARD);
  writeFile(src, 'folder with space/notes doc.html', NOTES);
  writeFile(src, 'uploads/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]));
  writeFile(src, '.hyperclay/versions/board/2026-01-01.htmlclay', '<html><body>old</body></html>\n');
  writeFile(src, 'styles.css', 'body { color: #111 }\n');
  return src;
}

function makeFixture() {
  const src = buildSource();
  const run = path.join(tempDir('hcl-p5-run-'), 'run');
  setup({ src, run });
  const fixture = {
    src,
    run,
    C: path.join(run, 'C'),
    B: path.join(run, 'B'),
    before: path.join(run, 'before.sha256'),
    intended: path.join(run, 'intended-edits.txt'),
  };
  writeFile(run, 'intended-edits.txt', '');
  return fixture;
}

function declare(fixture, lines) {
  writeFile(fixture.run, 'intended-edits.txt', lines.length ? `${lines.join('\n')}\n` : '');
}

function runCli(fixture, extra = []) {
  return spawnSync(
    process.execPath,
    [P5, '--before', fixture.before, '--root', fixture.B, '--intended', fixture.intended, '--reference', fixture.C, ...extra],
    { encoding: 'utf8' },
  );
}

function report(fixture) {
  return checkIntegrity({
    before: fixture.before,
    root: fixture.B,
    intended: fixture.intended,
    reference: fixture.C,
  });
}

function kinds(reportObject) {
  return reportObject.violations.map((violation) => `${violation.kind} ${violation.path}`);
}

function shasum(file) {
  const result = spawnSync('shasum', ['-a', '256', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\s+/)[0];
}

test('unchanged tree and an empty intended file pass', () => {
  const fixture = makeFixture();
  const result = report(fixture);
  assert.equal(result.pass, true, JSON.stringify(result.violations));
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.counts, { checked: 7, changed: 0, removed: 0, added: 0, covered: 0 });

  const cli = runCli(fixture);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /P5 PASS/);
  const written = JSON.parse(fs.readFileSync(path.join(fixture.run, 'p5.json'), 'utf8'));
  assert.equal(written.pass, true);
  assert.deepEqual(written.counts, { checked: 7, changed: 0, removed: 0, added: 0, covered: 0 });
});

test('declared changes pass with the counts', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'index.html', INDEX.replace('index</body>', 'edited</body>'));
  writeFile(fixture.B, '.hyperclay/versions/index/2026-02-02.html', '<html><body>new version</body></html>\n');
  fs.unlinkSync(path.join(fixture.B, 'board.htmlclay'));
  declare(fixture, ['index.html', 'board.htmlclay', '.hyperclay/versions/index/']);

  const result = report(fixture);
  assert.equal(result.pass, true, JSON.stringify(result.violations));
  assert.deepEqual(result.counts, { checked: 7, changed: 1, removed: 1, added: 1, covered: 3 });

  const cli = runCli(fixture);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /P5 PASS/);
});

test('an undeclared changed file fails', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'index.html', INDEX.replace('index</body>', 'edited</body>'));
  const result = report(fixture);
  assert.equal(result.pass, false);
  assert.deepEqual(kinds(result), ['changed index.html']);
  assert.deepEqual(result.counts, { checked: 7, changed: 1, removed: 0, added: 0, covered: 0 });

  const cli = runCli(fixture);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /changed index\.html/);
  assert.match(cli.stdout, /P5 FAIL 1 violations/);
  const written = JSON.parse(fs.readFileSync(path.join(fixture.run, 'p5.json'), 'utf8'));
  assert.equal(written.pass, false);
  assert.equal(written.violations[0].kind, 'changed');
  assert.equal(written.violations[0].path, 'index.html');
});

test('an undeclared removed file fails', () => {
  const fixture = makeFixture();
  fs.unlinkSync(path.join(fixture.B, 'managed.html'));
  const result = report(fixture);
  assert.equal(result.pass, false);
  assert.deepEqual(kinds(result), ['removed managed.html']);
  assert.equal(result.counts.removed, 1);

  const cli = runCli(fixture);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /removed managed\.html/);
});

test('an undeclared added file fails', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'extra.html', '<html><body>extra</body></html>\n');
  const result = report(fixture);
  assert.equal(result.pass, false);
  assert.deepEqual(kinds(result), ['added extra.html']);
  assert.equal(result.counts.added, 1);

  const cli = runCli(fixture);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /added extra\.html/);
});

test('paths with spaces are hashed, reported and covered', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'folder with space/notes doc.html', NOTES.replace('notes</body>', 'edited notes</body>'));
  const undeclared = report(fixture);
  assert.equal(undeclared.pass, false);
  assert.deepEqual(kinds(undeclared), ['changed folder with space/notes doc.html']);

  declare(fixture, ['folder with space/']);
  const declared = report(fixture);
  assert.equal(declared.pass, true, JSON.stringify(declared.violations));
  assert.equal(declared.counts.changed, 1);
  assert.equal(declared.counts.covered, 1);
});

test('a declared entry does not cover a different path', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'index.html', INDEX.replace('index</body>', 'edited</body>'));
  declare(fixture, ['apps/index.html', '.hyperclay/versions/board/']);
  const result = report(fixture);
  assert.equal(result.pass, false);
  assert.deepEqual(kinds(result), ['changed index.html']);
});

test('identity attributes: savetoken on a root element fails', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'index.html', INDEX.replace('<html lang="en"', '<html savetoken="x" lang="en"'));
  declare(fixture, ['index.html']);
  const result = report(fixture);
  assert.equal(result.pass, false);
  assert.deepEqual(kinds(result), ['identity-attribute index.html']);
  assert.match(result.violations[0].detail, /savetoken/);

  const cli = runCli(fixture);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /identity-attribute index\.html/);
});

test('identity attributes: an attribute already in the reference copy passes', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'managed.html', MANAGED.replace('managed</body>', 'edited</body>'));
  declare(fixture, ['managed.html']);
  const result = report(fixture);
  assert.equal(result.pass, true, JSON.stringify(result.violations));
});

test('identity attributes: savetoken inside a div or in body text passes', () => {
  const fixture = makeFixture();
  writeFile(
    fixture.B,
    'board.htmlclay',
    '<html><body><div savetoken="x">savetoken="x" and htmlclayid and documentetag</div></body></html>\n',
  );
  declare(fixture, ['board.htmlclay']);
  const result = report(fixture);
  assert.equal(result.pass, true, JSON.stringify(result.violations));
});

test('a symlink in the root is a non-regular violation', () => {
  const fixture = makeFixture();
  fs.symlinkSync(path.join(fixture.B, 'index.html'), path.join(fixture.B, 'link.html'));
  const result = report(fixture);
  assert.equal(result.pass, false);
  assert.deepEqual(kinds(result), ['non-regular link.html']);

  const cli = runCli(fixture);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /non-regular link\.html/);
});

test('a root under LOCAL_APPS is refused with exit 2', () => {
  const fixture = makeFixture();
  const nearLocalApps = path.join(LOCAL_APPS, 'p5-never-created-' + crypto.randomBytes(4).toString('hex'));
  assert.equal(fs.existsSync(nearLocalApps), false);
  const result = spawnSync(
    process.execPath,
    [P5, '--before', fixture.before, '--root', nearLocalApps, '--intended', fixture.intended, '--reference', fixture.C],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /LOCAL_APPS/);
  assert.equal(fs.existsSync(nearLocalApps), false);
});

test('a reference under LOCAL_APPS is refused with exit 2', () => {
  const fixture = makeFixture();
  const nearLocalApps = path.join(LOCAL_APPS, 'p5-never-created-' + crypto.randomBytes(4).toString('hex'));
  const result = spawnSync(
    process.execPath,
    [P5, '--before', fixture.before, '--root', fixture.B, '--intended', fixture.intended, '--reference', nearLocalApps],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /LOCAL_APPS/);
  assert.equal(fs.existsSync(nearLocalApps), false);
});

test('mutation: disabling coverage checking lets an undeclared change through', () => {
  const fixture = makeFixture();
  writeFile(fixture.B, 'index.html', INDEX.replace('index</body>', 'edited</body>'));
  declare(fixture, []);

  const pristine = shasum(P5);
  const backup = path.join(tempDir('hcl-p5-backup-'), 'p5.mjs');
  fs.copyFileSync(P5, backup);
  let mutated = null;
  try {
    const source = fs.readFileSync(P5, 'utf8');
    const target = '  if (intended.exact.has(rel)) return true;\n  return intended.folders.some((folder) => rel.startsWith(folder));';
    assert.equal(source.includes(target), true, 'coverage check anchor not found');
    fs.writeFileSync(P5, source.replace(target, '  return true;'));
    mutated = runCli(fixture);
    const saved = path.join(os.tmpdir(), 'hcl-p5-mutation-output.txt');
    fs.writeFileSync(saved, `status=${mutated.status}\n${mutated.stdout}${mutated.stderr}`);
  } finally {
    fs.copyFileSync(backup, P5);
  }
  assert.equal(shasum(P5), pristine, 'p5.mjs was not restored');

  assert.equal(mutated.status, 0, mutated.stdout + mutated.stderr);
  assert.match(mutated.stdout, /P5 PASS/);

  const restored = runCli(fixture);
  assert.equal(restored.status, 1, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /P5 FAIL/);
});
