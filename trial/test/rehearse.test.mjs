import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSyntheticRoot } from '../synthetic-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const REHEARSE = path.join(REPO, 'trial', 'rehearse.mjs');
const HTMLCLAY = process.env.HTMLCLAY_SOURCE || path.join(path.dirname(REPO), 'htmlclay');
const SKIP = fs.existsSync(path.join(HTMLCLAY, 'internal', 'managedtrial', 'testdata'))
  ? false
  : 'the htmlclay source tree is not next to this repo: set HTMLCLAY_SOURCE to check the golden roots';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function digestOf(root, files) {
  return files.map((rel) => `${rel} ${sha256(path.join(root, rel))}`).join('\n');
}

test('the synthetic root is deterministic and carries only the golden roots and the p3 fixture', { skip: SKIP }, () => {
  const first = tempDir('hcl-synthetic-a-');
  const second = tempDir('hcl-synthetic-b-');
  const one = buildSyntheticRoot({ out: path.join(first, 'root'), htmlclay: HTMLCLAY });
  const two = buildSyntheticRoot({ out: path.join(second, 'root'), htmlclay: HTMLCLAY });

  assert.deepEqual(two.files, one.files);
  assert.equal(digestOf(two.root, two.files), digestOf(one.root, one.files));

  for (const wanted of [
    'index.html',
    'serve/index.html',
    'api/list.html',
    '.hyperclay/blockeditor-state/meta/paged.html.json',
    'uploads/img.png',
    'uploads/café-notes.txt',
  ]) {
    assert.ok(one.files.includes(wanted), `the synthetic root is missing ${wanted}`);
  }

  for (const rel of one.files) {
    for (const segment of rel.split('/')) {
      if (segment.startsWith('.')) {
        assert.equal(segment, '.hyperclay', `a hidden segment leaked into the root: ${rel}`);
      }
    }
  }

  assert.ok(!one.files.some((rel) => rel.includes('node_modules')), 'node_modules reached the root');

  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

test('a non-empty --out stops the rehearsal before it builds anything', () => {
  const work = tempDir('hcl-rehearse-');
  const source = path.join(work, 'source');
  const htmlclay = path.join(work, 'htmlclay');
  const out = path.join(work, 'out');
  for (const dir of [source, htmlclay, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(source, 'index.html'), '<html><body>index</body></html>\n');
  fs.writeFileSync(path.join(out, 'leftover.txt'), 'not empty\n');

  const run = spawnSync(process.execPath, [
    REHEARSE,
    '--source', source,
    '--htmlclay', htmlclay,
    '--out', out,
  ], { encoding: 'utf8' });

  assert.equal(run.status, 2, `expected exit 2, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /--out must be an empty directory/);
  assert.deepEqual(fs.readdirSync(out), ['leftover.txt']);

  fs.rmSync(work, { recursive: true, force: true });
});
