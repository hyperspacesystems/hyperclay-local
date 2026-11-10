'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'fs-guard.cjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runGuard(script, options) {
  const opts = options || {};
  const dir = tempDir('hcl-fs-guard-run-');
  const scriptPath = path.join(dir, 'plant.cjs');
  fs.writeFileSync(scriptPath, script);
  const out = path.join(tempDir('hcl-fs-guard-out-'), 'fs-guard.json');
  const env = { ...process.env };
  delete env.FS_GUARD_ROOTS;
  delete env.FS_GUARD_OUT;
  delete env.FS_GUARD_DISABLE_FILEHANDLE;
  if (opts.roots) env.FS_GUARD_ROOTS = JSON.stringify(opts.roots);
  env.FS_GUARD_OUT = out;
  Object.assign(env, opts.env || {});
  const result = spawnSync(process.execPath, ['--require', GUARD, scriptPath], { env, encoding: 'utf8' });
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return { result, report, out };
}

function find(list, op, relPath) {
  return list.find((entry) => entry.op === op && entry.path === relPath);
}

const PLANT_SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const { writeFile } = require('fs/promises');

const root = process.env.GUARD_TEST_ROOT;
const outside = process.env.GUARD_TEST_OUTSIDE;
const p = (...parts) => path.join(root, ...parts);

async function main() {
  fs.mkdirSync(p('docs'), { recursive: true });
  fs.writeFileSync(p('docs/sync.txt'), 'sync');
  await fs.promises.writeFile(p('docs/promises.txt'), 'promises');
  await writeFile(p('docs/destructured.txt'), 'destructured');
  const handle = await fs.promises.open(p('docs/handle.txt'), 'w');
  await handle.write('handle');
  await handle.close();
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(p('docs/stream.txt'));
    stream.on('error', reject);
    stream.end('stream', resolve);
  });
  fs.mkdirSync(p('.trash'), { recursive: true });
  fs.writeFileSync(p('docs/moved.txt'), 'moved');
  fs.renameSync(p('docs/moved.txt'), p('.trash/moved.txt'));
  fs.writeFileSync(p('docs/unlinked.txt'), 'unlinked');
  fs.unlinkSync(p('docs/unlinked.txt'));
  fs.mkdirSync(p('.hyperclay/page-state'), { recursive: true });
  fs.writeFileSync(p('.hyperclay/page-state/app.json'), '{}');
  fs.mkdirSync(p('.hyperclay/conflicts'), { recursive: true });
  fs.writeFileSync(p('.hyperclay/conflicts/app.remote.html'), 'conflict');
  fs.writeFileSync(p('.hyperclay/sync-root.json'), '{}');
  fs.mkdirSync(p('fresh-dir'));
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

function plant() {
  const base = tempDir('hcl-fs-guard-case-');
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  return { base, root, outside };
}

test('records a planted write in every class and lets each write through', () => {
  const { root, outside } = plant();
  const { result, report } = runGuard(PLANT_SCRIPT, {
    roots: [root],
    env: { GUARD_TEST_ROOT: root, GUARD_TEST_OUTSIDE: outside },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(report, 'guard output should exist');

  assert.deepEqual(report.roots, [root]);

  const documentWrites = [
    ['writeFileSync', 'docs/sync.txt'],
    ['writeFile', 'docs/promises.txt'],
    ['writeFile', 'docs/destructured.txt'],
    ['write', 'docs/handle.txt'],
    ['createWriteStream', 'docs/stream.txt'],
    ['unlinkSync', 'docs/unlinked.txt'],
  ];
  for (const [op, rel] of documentWrites) {
    const entry = find(report.forbidden, op, rel);
    assert.ok(entry, `expected forbidden ${op} on ${rel} in ${JSON.stringify(report.forbidden)}`);
    assert.equal(entry.class, 'document');
    assert.equal(typeof entry.stack, 'string');
    assert.ok(entry.stack.split('\n').length <= 8);
  }

  const renamed = find(report.forbidden, 'renameSync', '.trash/moved.txt');
  assert.ok(renamed, 'rename destination should be recorded');
  assert.equal(renamed.class, 'document');
  assert.ok(find(report.forbidden, 'renameSync-source', 'docs/moved.txt'), 'rename source should be recorded as a removal');

  const pageState = find(report.forbidden, 'writeFileSync', '.hyperclay/page-state/app.json');
  assert.ok(pageState, 'page-state write should be recorded');
  assert.equal(pageState.class, 'go-storage');
  const pageStateDir = find(report.forbidden, 'mkdirSync', '.hyperclay/page-state');
  assert.ok(pageStateDir, 'page-state mkdir should be recorded');
  assert.equal(pageStateDir.class, 'go-storage');

  assert.ok(find(report.allowed, 'writeFileSync', '.hyperclay/conflicts/app.remote.html'), 'conflict write is allowed');
  assert.ok(find(report.allowed, 'writeFileSync', '.hyperclay/sync-root.json'), 'sync-root write is allowed');
  assert.ok(find(report.allowed, 'mkdirSync', 'fresh-dir'), 'mkdir inside a root is allowed');
  for (const entry of report.allowed) {
    assert.ok(['sync-state', 'directory'].includes(entry.class), JSON.stringify(entry));
  }

  assert.equal(find(report.forbidden, 'writeFileSync', 'outside.txt'), undefined);
  assert.equal(find(report.allowed, 'writeFileSync', 'outside.txt'), undefined);
  assert.equal(report.forbidden.filter((entry) => entry.path.startsWith('..')).length, 0);

  assert.equal(report.counts.forbidden, report.forbidden.length);
  assert.equal(report.counts.allowed, report.allowed.length);
  assert.ok(report.counts.forbidden > 0 && report.counts.allowed > 0);

  assert.equal(fs.readFileSync(path.join(root, 'docs/sync.txt'), 'utf8'), 'sync');
  assert.equal(fs.readFileSync(path.join(root, 'docs/destructured.txt'), 'utf8'), 'destructured');
  assert.equal(fs.readFileSync(path.join(root, 'docs/handle.txt'), 'utf8'), 'handle');
  assert.equal(fs.readFileSync(path.join(root, 'docs/stream.txt'), 'utf8'), 'stream');
  assert.equal(fs.readFileSync(path.join(root, '.trash/moved.txt'), 'utf8'), 'moved');
  assert.equal(fs.existsSync(path.join(root, 'docs/unlinked.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, '.hyperclay/page-state/app.json'), 'utf8'), '{}');
  assert.equal(fs.statSync(path.join(root, 'fresh-dir')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(outside, 'outside.txt'), 'utf8'), 'outside');
});

test('read-only calls record nothing', () => {
  const { root } = plant();
  fs.writeFileSync(path.join(root, 'page.html'), '<h1>hi</h1>');
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const root = process.env.GUARD_TEST_ROOT;

async function main() {
  fs.readFileSync(path.join(root, 'page.html'), 'utf8');
  fs.statSync(path.join(root, 'page.html'));
  const handle = await fs.promises.open(path.join(root, 'page.html'), 'r');
  await handle.readFile('utf8');
  await handle.close();
  const again = await fs.promises.open(path.join(root, 'page.html'));
  await again.close();
  await fs.promises.stat(path.join(root, 'page.html'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  const { result, report } = runGuard(script, { roots: [root], env: { GUARD_TEST_ROOT: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(report);
  assert.deepEqual(report.forbidden, []);
  assert.deepEqual(report.allowed, []);
  assert.equal(report.counts.forbidden, 0);
  assert.equal(report.counts.allowed, 0);
});

test('without FS_GUARD_ROOTS the guard stays dormant but writes still happen', () => {
  const { root } = plant();
  const script = String.raw`
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.env.GUARD_TEST_ROOT, 'plain.txt'), 'plain');
`;
  const { result, report, out } = runGuard(script, { env: { GUARD_TEST_ROOT: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report, null);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), 'plain');
});

test('a root reached through a symlink still classifies writes inside it', () => {
  const base = tempDir('hcl-fs-guard-link-');
  const realRoot = path.join(base, 'real-root');
  fs.mkdirSync(realRoot, { recursive: true });
  const linkRoot = path.join(base, 'link-root');
  fs.symlinkSync(realRoot, linkRoot, 'dir');
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const linkRoot = process.env.GUARD_TEST_LINK;
const realRoot = process.env.GUARD_TEST_REAL;
fs.writeFileSync(path.join(linkRoot, 'via-link.html'), 'via-link');
fs.writeFileSync(path.join(realRoot, 'via-real.html'), 'via-real');
fs.mkdirSync(path.join(realRoot, '.hyperclay', 'guard'), { recursive: true });
fs.writeFileSync(path.join(linkRoot, '.hyperclay', 'guard', 'state.json'), '{}');
`;
  const { result, report } = runGuard(script, {
    roots: [linkRoot],
    env: { GUARD_TEST_LINK: linkRoot, GUARD_TEST_REAL: realRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(report);
  const viaLink = find(report.forbidden, 'writeFileSync', 'via-link.html');
  assert.ok(viaLink, JSON.stringify(report.forbidden));
  assert.equal(viaLink.class, 'document');
  const viaReal = find(report.forbidden, 'writeFileSync', 'via-real.html');
  assert.ok(viaReal, JSON.stringify(report.forbidden));
  assert.equal(viaReal.class, 'document');
  const guardWrite = find(report.forbidden, 'writeFileSync', '.hyperclay/guard/state.json');
  assert.ok(guardWrite, JSON.stringify(report.forbidden));
  assert.equal(guardWrite.class, 'go-storage');
});

test('mutation: without the FileHandle wrapping the handle write goes unseen', () => {
  const { root, outside } = plant();
  const env = { GUARD_TEST_ROOT: root, GUARD_TEST_OUTSIDE: outside, FS_GUARD_DISABLE_FILEHANDLE: '1' };
  const mutated = runGuard(PLANT_SCRIPT, { roots: [root], env });
  assert.equal(mutated.result.status, 0, mutated.result.stderr);
  assert.ok(mutated.report);

  const handleEntry = find(mutated.report.forbidden, 'write', 'docs/handle.txt');
  const observedFileWritten = fs.readFileSync(path.join(root, 'docs/handle.txt'), 'utf8') === 'handle';
  assert.equal(handleEntry, undefined, 'mutated guard should miss the handle write');
  assert.equal(observedFileWritten, true, 'the write still reached disk');

  const saved = path.join(tempDir('hcl-fs-guard-mutation-'), 'failing.json');
  fs.writeFileSync(saved, JSON.stringify({ mutation: 'FileHandle wrapping disabled', report: mutated.report }, null, 2));
  assert.equal(fs.existsSync(saved), true);

  assert.throws(() => {
    assert.ok(find(mutated.report.forbidden, 'write', 'docs/handle.txt'), 'handle write recorded');
  }, /handle write recorded/);
});
