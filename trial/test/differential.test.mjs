import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildRequests } from '../differential.mjs';

const expressEtag = createRequire(import.meta.url)('etag');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIFF = path.join(HERE, '..', 'differential.mjs');

const DOCS = [
  'index.html',
  'board.htmlclay',
  'journal.html',
  'notes.htmlclay',
  'scratch.html',
  'projects/alpha.html',
  'projects/beta.htmlclay',
  'projects/archive/old.html',
  'with space.html',
  'pages/one.html',
  'pages/two.htmlclay',
  'pages/three.html',
  'pages/deep/four.htmlclay',
];

const DEFAULT_META = ['conditional', 'receipts', 'sync', 'sync-worker', 'upload', 'wire'];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function makeRoot(options = {}) {
  const docs = options.docs || DOCS;
  const root = tempDir('hcl-diff-root-');
  for (const rel of docs) {
    writeFile(root, rel, `<!DOCTYPE html>\n<html lang="en"><head><title>source ${rel}</title></head><body>source ${rel}</body></html>\n`);
  }
  if (options.uploads !== false) {
    writeFile(root, 'uploads/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20]));
    writeFile(root, 'uploads/docs/scan.bin', Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xfd, 0x7f]));
  }
  writeFile(root, 'styles.css', 'body { color: #111 }\n');
  writeFile(root, '.hyperclay/versions/index/2026-01-01.html', '<html><body>never served</body></html>');
  return root;
}

function contentType(rel) {
  if (/\.(html|htmlclay)$/i.test(rel)) return 'text/html; charset=utf-8';
  if (rel.endsWith('.css')) return 'text/css; charset=utf-8';
  if (rel.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function documentBody(rel, origin, variant) {
  const rootAttr = variant.savetokenRoot ? ' savetoken="x"' : '';
  const extra = variant.savetokenDiv ? '<div savetoken="x">x</div>' : '';
  let body = `<!DOCTYPE html>\n<html${rootAttr} lang="en"><head><meta charset="utf-8"><title>${rel}</title></head><body>${extra}<p>document ${rel}</p><a href="${origin}/nav">back</a></body></html>\n`;
  if (variant.bodyByteFor === rel) body = body.replace('document ', 'docuMent ');
  return body;
}

function listingBody(relDir, origin) {
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${relDir || '/'}</title></head><body><a href="${origin}/">${origin}</a><p>listing ${relDir || '/'}</p></body></html>\n`;
}

function startServer(root, variant = {}) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    state.requests.push(url.pathname);
    const send = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    const json = (body) => {
      const text = JSON.stringify(body);
      send(200, { 'Content-Type': 'application/json', ETag: expressEtag(text, { weak: true }) }, text);
    };

    if (url.pathname === '/_/meta') {
      let rel = '';
      try {
        rel = new URL(req.headers['document-url']).pathname;
      } catch { /* no document */ }
      json({ spec: 1, document: rel, extensions: (variant.metaExtensions || DEFAULT_META).slice() });
      return;
    }
    if (url.pathname.startsWith('/_/api/')) {
      const rel = decodeURIComponent(url.pathname.slice('/_/api/'.length));
      json({ document: rel, origin, data: { value: 1 } });
      return;
    }
    if (url.pathname.startsWith('/_/versions/')) {
      const rel = decodeURIComponent(url.pathname.slice('/_/versions/'.length));
      json({ document: rel, versions: [], origin });
      return;
    }
    if (url.pathname.startsWith('/_/uploads/')) {
      const rel = decodeURIComponent(url.pathname.slice('/_/uploads/'.length));
      const target = path.join(root, 'uploads', rel);
      const headers = { ETag: '"v1"', 'Content-Type': contentType(rel) };
      if (variant.cacheControlFor === `uploads/${rel}`) headers['Cache-Control'] = 'max-age=60';
      if (variant.pageRevision) headers['Page-Revision'] = '1';
      if (fs.existsSync(target)) send(200, headers, fs.readFileSync(target));
      else send(404, { 'Content-Type': 'text/plain' }, 'not found');
      return;
    }
    if (url.pathname.endsWith('/')) {
      const relDir = decodeURIComponent(url.pathname.slice(1, -1));
      const headers = { ETag: '"v1"', 'Content-Type': 'text/html; charset=utf-8' };
      if (variant.pageRevision) headers['Page-Revision'] = '1';
      send(200, headers, listingBody(relDir, origin));
      return;
    }
    const rel = decodeURIComponent(url.pathname.slice(1));
    const target = path.join(root, rel);
    const headers = { ETag: '"v1"', 'Content-Type': contentType(rel) };
    if (variant.cacheControlFor === rel) headers['Cache-Control'] = 'max-age=60';
    if (variant.pageRevision) headers['Page-Revision'] = '1';
    if (!fs.existsSync(target)) {
      send(404, { 'Content-Type': 'text/plain' }, 'not found');
      return;
    }
    if (/\.(html|htmlclay)$/i.test(rel)) {
      send(200, headers, documentBody(rel, origin, variant));
      return;
    }
    send(200, headers, fs.readFileSync(target));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(side) {
  return new Promise((resolve) => side.server.close(resolve));
}

async function withServers(variantA, variantB, fn) {
  const root = makeRoot();
  const a = await startServer(root, variantA);
  const b = await startServer(root, variantB);
  try {
    return await fn({ root, a, b });
  } finally {
    await closeServer(a);
    await closeServer(b);
  }
}

function runCli(args, file = DIFF) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function differencesOn(doc, pathName, field) {
  return doc.differences.filter((entry) => entry.path === pathName && entry.field === field);
}

test('identical servers agree on every judged request', async () => {
  await withServers({}, {}, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const doc = readJson(path.join(out, 'differences.json'));
    assert.deepEqual(doc.differences, []);
    assert.ok(doc.compared >= 50, `compared ${doc.compared}`);
    for (const family of ['document', 'document-source', 'meta', 'api', 'upload']) {
      assert.ok(doc.families[family] >= 1, `family ${family} is empty`);
    }
    assert.ok(doc.allowances.origin > 0, 'origin normalization never applied');
    assert.match(doc.requestListSha256, /^[0-9a-f]{64}$/);

    const extended = readJson(path.join(out, 'differences-extended.json'));
    for (const family of ['listing', 'asset', 'versions']) {
      assert.ok(extended.families[family] >= 1, `extended family ${family} is empty`);
    }

    for (const side of [a, b]) {
      assert.equal(side.state.requests.filter((p) => p.includes('.hyperclay')).length, 0);
    }
    const built = buildRequests(root);
    assert.equal(built.filter((request) => request.path.includes('.hyperclay')).length, 0);
  });
});

test('a header byte and a body byte are reported as differences', async () => {
  const variantB = { cacheControlFor: 'index.html', bodyByteFor: 'projects/alpha.html' };
  await withServers({}, variantB, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);

    const doc = readJson(path.join(out, 'differences.json'));
    assert.ok(differencesOn(doc, '/index.html', 'cache-control').length >= 1);
    assert.ok(differencesOn(doc, '/projects/alpha.html', 'body').length >= 1);
  });
});

test('savetoken on the root element is allowed, on a div it is not', async () => {
  await withServers({}, { savetokenRoot: true }, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.equal(doc.differences.length, 0);
    assert.ok(doc.allowances.AD4 > 0, 'AD4 never applied');
  });

  await withServers({}, { savetokenDiv: true }, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.ok(differencesOn(doc, '/index.html', 'body').length >= 1);
  });
});

test('meta extensions on A only are an allowance, on B only a difference', async () => {
  const localMeta = DEFAULT_META.concat(['presence', 'live-data', 'sync-worker-data']);
  await withServers({ metaExtensions: localMeta }, {}, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.equal(doc.differences.length, 0);
    assert.ok(doc.allowances.AD1 > 0, 'AD1 never applied');
  });

  await withServers({}, { metaExtensions: DEFAULT_META.concat(['presence']) }, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.ok(differencesOn(doc, '/_/meta', 'body').length >= 1);
  });
});

test('page-revision on A only is an allowance, on B only a difference', async () => {
  await withServers({ pageRevision: true }, {}, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.equal(doc.differences.length, 0);
    assert.ok(doc.allowances.AD3 > 0, 'AD3 never applied');
  });

  await withServers({}, { pageRevision: true }, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.ok(differencesOn(doc, '/index.html', 'page-revision').length >= 1);
  });
});

test('fewer than 50 requests and an unreachable side both fail the run', async () => {
  const root = makeRoot({ docs: ['index.html', 'notes.htmlclay'], uploads: false });
  const a = await startServer(root, {});
  const b = await startServer(root, {});
  try {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.equal(doc.compared, 8);
    assert.match(result.stdout, /only 8 requests compared/);
    assert.match(result.stdout, /at least 50/);
  } finally {
    await closeServer(a);
    await closeServer(b);
  }

  const root2 = makeRoot();
  const live = await startServer(root2, {});
  const dead = await startServer(root2, {});
  const deadUrl = dead.url;
  await closeServer(dead);
  try {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', live.url, '--b', deadUrl, '--root', root2, '--out', out]);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  } finally {
    await closeServer(live);
  }
});

test('mutation: disabling body comparison hides the body byte', async () => {
  const sourcePath = DIFF;
  const before = sha(fs.readFileSync(sourcePath));
  const needle = 'if (responseA.body !== responseB.body) {';
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(source.split(needle).length - 1, 1);

  const mutant = path.join(path.dirname(sourcePath), `.differential-mutant-${process.pid}.mjs`);
  fs.writeFileSync(mutant, source.replace(needle, 'if (false && responseA.body !== responseB.body) {'));

  const variantB = { bodyByteFor: 'projects/alpha.html' };
  try {
    await withServers({}, variantB, async ({ root, a, b }) => {
      const realOut = tempDir('hcl-diff-out-');
      const real = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', realOut]);
      assert.equal(real.status, 1, `${real.stdout}\n${real.stderr}`);
      const realDoc = readJson(path.join(realOut, 'differences.json'));
      assert.ok(differencesOn(realDoc, '/projects/alpha.html', 'body').length >= 1);

      const mutantOut = tempDir('hcl-diff-mutant-out-');
      const mutated = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', mutantOut], mutant);
      const mutantDoc = readJson(path.join(mutantOut, 'differences.json'));
      assert.equal(differencesOn(mutantDoc, '/projects/alpha.html', 'body').length, 0);
      assert.equal(mutated.status, 0, `mutated run should miss the body byte: ${mutated.stdout}`);
      console.log(`mutated run: exit ${mutated.status}, differences ${mutantDoc.differences.length} -> ${path.join(mutantOut, 'differences.json')}`);
    });
  } finally {
    fs.rmSync(mutant, { force: true });
  }

  assert.equal(sha(fs.readFileSync(sourcePath)), before);
});

test('the full stage counts the meta line the native stage allows', async () => {
  const withPresence = DEFAULT_META.concat(['presence']);
  await withServers({ metaExtensions: withPresence }, {}, async ({ root, a, b }) => {
    const fullOut = tempDir('hcl-diff-out-');
    const full = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', fullOut, '--stage', 'full']);
    assert.equal(full.status, 1, `${full.stdout}\n${full.stderr}`);
    const fullDoc = readJson(path.join(fullOut, 'differences.json'));
    assert.equal(fullDoc.stage, 'full');
    assert.equal(fullDoc.allowances.AD1, 0);
    const metaDiffs = fullDoc.differences.filter((entry) => entry.family === 'meta');
    assert.ok(metaDiffs.length >= 1, 'the meta line was not counted');
    assert.deepEqual([...new Set(fullDoc.differences.map((entry) => entry.family))], ['meta']);
    assert.ok(metaDiffs.every((entry) => entry.path === '/_/meta'));
  });

  await withServers({ metaExtensions: withPresence }, {}, async ({ root, a, b }) => {
    const nativeOut = tempDir('hcl-diff-out-');
    const native = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', nativeOut, '--stage', 'native']);
    assert.equal(native.status, 0, `${native.stdout}\n${native.stderr}`);
    const nativeDoc = readJson(path.join(nativeOut, 'differences.json'));
    assert.equal(nativeDoc.stage, 'native');
    assert.equal(nativeDoc.differences.length, 0);
    assert.ok(nativeDoc.allowances.AD1 > 0, 'AD1 never applied');
  });
});

test('the full stage counts a page-revision header on A only', async () => {
  await withServers({ pageRevision: true }, {}, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out, '--stage', 'full']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.equal(doc.allowances.AD3, 0);
    assert.ok(differencesOn(doc, '/index.html', 'page-revision').length >= 1);
  });
});

test('the full stage still allows a savetoken', async () => {
  await withServers({}, { savetokenRoot: true }, async ({ root, a, b }) => {
    const out = tempDir('hcl-diff-out-');
    const result = await runCli(['--a', a.url, '--b', b.url, '--root', root, '--out', out, '--stage', 'full']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const doc = readJson(path.join(out, 'differences.json'));
    assert.equal(doc.differences.length, 0);
    assert.ok(doc.allowances.AD4 > 0, 'AD4 never applied');
  });
});

test('a stage that is neither native nor full is an error', async () => {
  const root = makeRoot();
  const out = tempDir('hcl-diff-out-');
  const result = await runCli([
    '--a', 'http://127.0.0.1:1', '--b', 'http://127.0.0.1:1', '--root', root, '--out', out, '--stage', 'other',
  ]);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
});
