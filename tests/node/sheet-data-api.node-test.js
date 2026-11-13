const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../../src/main/server');
const { documentEtag } = require('../../src/main/spec-wire');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');
const { isPatchBodyViaTag } = require('../../src/main/utils/sheet-api');

const SHEET_DIR = path.join(__dirname, '..', '..', 'node_modules', 'hyper-html-api', 'conformance', 'sheet');
const TINY = 'sheet-read-tiny';

function parseMeta(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!Object.prototype.hasOwnProperty.call(fields, key)) fields[key] = trimmed.slice(separator + 1).trim();
  }
  return fields;
}

const SHARED = fsSync.readdirSync(SHEET_DIR)
  .filter((file) => file.endsWith('.meta'))
  .sort()
  .map((file) => ({ name: file.slice(0, -'.meta'.length), meta: parseMeta(fsSync.readFileSync(path.join(SHEET_DIR, file), 'utf8')) }))
  .filter(({ name, meta }) => (meta.face === 'read' && meta.view === undefined)
    // ?data= alone is the host's own extraction, not a sheet query (the case's note).
    || (meta.face === 'params' && name !== 'params-data-alone'));

assert.ok(SHARED.length > 20, `only ${SHARED.length} shared read cases found`);

const FACE = (face) => fsSync.readdirSync(SHEET_DIR)
  .filter((file) => file.endsWith('.meta'))
  .sort()
  .map((file) => ({ name: file.slice(0, -'.meta'.length), meta: parseMeta(fsSync.readFileSync(path.join(SHEET_DIR, file), 'utf8')) }))
  .filter(({ meta }) => meta.face === face);

const PATCH_CASES = FACE('patch');
const WRITE_CASES = FACE('write');
const BODY_CASES = FACE('body');

assert.ok(PATCH_CASES.length >= 15, `only ${PATCH_CASES.length} shared patch cases found`);
assert.equal(BODY_CASES.length, 7, `${BODY_CASES.length} shared body cases found`);

const casePath = (name, suffix) => path.join(SHEET_DIR, name + suffix);
const caseJson = (name, suffix) => JSON.parse(fsSync.readFileSync(casePath(name, suffix), 'utf8'));
const post = (server, url, body) => request(server).post(url).set('Content-Type', 'application/json').send(JSON.stringify(body));

async function fixture(fn) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-api-')));
  const server = await listenLoopback(createApp(dir));
  try { await fn(dir, server); }
  finally {
    await closeLoopback();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

const sidecar = (dir) => path.join(dir, '.hyperclay', 'api-v2', 'doc.html.json');
const tinyHtml = () => fsSync.readFileSync(path.join(SHEET_DIR, TINY + '.html'));
const read = (server, url) => request(server).get(url);

for (const { name, meta } of SHARED) {
  test(name, () => fixture(async (dir, server) => {
    const bytes = fsSync.readFileSync(path.join(SHEET_DIR, name + '.html'));
    await fs.writeFile(path.join(dir, 'doc.html'), bytes);
    const search = meta.face === 'params' ? (meta.params || '') : (meta.query ? new URLSearchParams(JSON.parse(meta.query)).toString() : '');
    const url = '/_/api/doc.html' + (search ? '?' + search : '');
    const result = await read(server, url);
    const expectedPath = path.join(SHEET_DIR, name + '.expected.json');
    if (fsSync.existsSync(expectedPath)) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body, JSON.parse(fsSync.readFileSync(expectedPath, 'utf8')));
      assert.equal(result.headers.etag, documentEtag(Buffer.from(bytes)));
      return;
    }
    const expected = JSON.parse(fsSync.readFileSync(path.join(SHEET_DIR, name + '.error.json'), 'utf8'));
    assert.equal(result.status, expected.status, JSON.stringify(result.body));
    if (expected.code) assert.equal(result.body.code, expected.code);
    if (expected.type === 'NoRulesTag') assert.equal(result.body.error, 'No api rules tag');
  }));
}

async function tinyFixture(fn) {
  return fixture(async (dir, server) => {
    const bytes = tinyHtml();
    await fs.writeFile(path.join(dir, 'doc.html'), bytes);
    return fn(dir, server, bytes);
  });
}

test('parameter case 1: a partial read answers 200 and writes no sidecar', () => tinyFixture(async (dir, server, bytes) => {
  const result = await read(server, '/_/api/doc.html?shape=index');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.headers.etag, documentEtag(Buffer.from(bytes)));
  await assert.rejects(fs.stat(sidecar(dir)));
}));

test('parameter case 2: a whole read answers 200, writes the sidecar and repeats', () => tinyFixture(async (dir, server, bytes) => {
  const first = await read(server, '/_/api/doc.html');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.etag, documentEtag(Buffer.from(bytes)));
  await fs.stat(sidecar(dir));
  const second = await read(server, '/_/api/doc.html');
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers.etag, documentEtag(Buffer.from(bytes)));
}));

test('parameter case 3: a repeated range is refused', () => tinyFixture(async (dir, server) => {
  const result = await read(server, '/_/api/doc.html?range=A1&range=B2');
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid sheet query');
  assert.match(result.body.message, /range/);
}));

test('parameter case 4: an empty sheet parameter is refused', () => tinyFixture(async (dir, server) => {
  const result = await read(server, '/_/api/doc.html?sheet=');
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid sheet query');
}));

test('parameter case 5: an undecodable sheet parameter names no sheet', () => tinyFixture(async (dir, server) => {
  const result = await read(server, '/_/api/doc.html?sheet=%E0%A4%A');
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid sheet query');
  assert.equal(result.body.code, 'unknown_sheet');
}));

test('parameter case 6: a sheet parameter mixed with data is refused', () => tinyFixture(async (dir, server) => {
  const result = await read(server, '/_/api/doc.html?shape=index&data=' + encodeURIComponent('{title:h1}'));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Invalid sheet query');
  assert.equal(result.body.code, 'bad_query');
  assert.match(result.body.message, /data cannot be combined/);
}));

test('parameter case 7: an unrelated parameter alone reads the whole document', () => tinyFixture(async (dir, server, bytes) => {
  const whole = await read(server, '/_/api/doc.html');
  const other = await read(server, '/_/api/doc.html?v=123');
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.deepEqual(other.body, whole.body);
  assert.equal(other.headers.etag, documentEtag(Buffer.from(bytes)));
}));

for (const { name } of PATCH_CASES) {
  test(name, () => fixture(async (dir, server) => {
    const html = fsSync.readFileSync(casePath(name, '.html'));
    const file = path.join(dir, 'doc.html');
    await fs.writeFile(file, html);
    const body = { patch: caseJson(name, '.data.json') };
    const errorPath = casePath(name, '.error.json');
    if (fsSync.existsSync(errorPath)) {
      const expected = JSON.parse(fsSync.readFileSync(errorPath, 'utf8'));
      const result = await post(server, '/_/api/doc.html', body);
      assert.equal(result.status, expected.status, JSON.stringify(result.body));
      if (expected.code) assert.equal(result.body.code, expected.code, JSON.stringify(result.body));
      assert.deepEqual(await fs.readFile(file), html);
      return;
    }
    const original = await read(server, '/_/api/doc.html');
    assert.equal(original.status, 200, JSON.stringify(original.body));
    const result = await post(server, '/_/api/doc.html', body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const expected = caseJson(name, '.write.json');
    assert.deepEqual(result.body.changed, expected.changed);
    assert.deepEqual(result.body.stale, expected.stale);
    assert.equal(result.body.recalculated, false);
    const written = await fs.readFile(file);
    assert.equal(result.body.etag, documentEtag(written));
    assert.equal(result.headers.etag, result.body.etag);
    const get = await read(server, '/_/api/doc.html');
    assert.equal(get.status, 200, JSON.stringify(get.body));
    const expectedAfter = caseJson(name, '.after.json');
    if (name === 'sheet-patch-append') {
      const known = new Set();
      for (const sheet of original.body.sheets) for (const row of sheet.rows) known.add(row.id);
      const renamed = JSON.parse(JSON.stringify(get.body));
      let next = 0;
      const fresh = [];
      for (const sheet of renamed.sheets) {
        for (const row of sheet.rows) {
          if (known.has(row.id)) continue;
          row.id = 'n' + (++next);
          fresh.push(row.id);
        }
      }
      assert.ok(fresh.length > 0, JSON.stringify(get.body));
      assert.deepEqual(renamed, expectedAfter);
      const text = written.toString('utf8');
      assert.ok(text.includes('Porto'), text);
      assert.ok(text.includes('Lisbon'), text);
      return;
    }
    assert.deepEqual(get.body, expectedAfter);
    assert.deepEqual(written, fsSync.readFileSync(casePath(name, '.after.html')));
  }));
}

for (const { name } of WRITE_CASES) {
  test(name, () => fixture(async (dir, server) => {
    const html = fsSync.readFileSync(casePath(name, '.html'));
    const file = path.join(dir, 'doc.html');
    await fs.writeFile(file, html);
    const expected = caseJson(name, '.error.json');
    const result = await post(server, '/_/api/doc.html', caseJson(name, '.data.json'));
    assert.equal(result.status, expected.status, JSON.stringify(result.body));
    assert.equal(result.body.code, expected.code, JSON.stringify(result.body));
    assert.deepEqual(await fs.readFile(file), html);
  }));
}

for (const { name } of BODY_CASES) {
  test(name, async () => {
    const body = caseJson(name, '.data.json');
    const html = fsSync.readFileSync(casePath(name, '.html'), 'utf8');
    const expected = caseJson(name, '.body.json');
    assert.equal(await isPatchBodyViaTag(body, html, 'api'), expected.kind === 'patch');
  });
}

async function tinyPatch(server) {
  const index = await read(server, '/_/api/doc.html?shape=index');
  assert.equal(index.status, 200, JSON.stringify(index.body));
  return [{ sheet: index.body.sheets[0].id, range: 'B2', values: [[42]] }];
}

const cellValue = (cell) => (cell && typeof cell === 'object' ? cell.v : cell);

test('http patch case 1: a patch on a sheet answers only the patch result', () => tinyFixture(async (dir, server) => {
  const patch = await tinyPatch(server);
  const result = await post(server, '/_/api/doc.html', { operationId: 'op-1', patch });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body).sort(), ['changed', 'etag', 'recalculated', 'stale']);
}));

test('http patch case 2: a rules tag with a top-level patch key makes the body data', () => fixture(async (dir, server) => {
  const html = '<script data-rules-name="api" data-rules-version="1">{"patch":"h1"}</script><h1>Old</h1>';
  const file = path.join(dir, 'doc.html');
  await fs.writeFile(file, html);
  const result = await post(server, '/_/api/doc.html', { patch: 'New' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { patch: 'New' });
  assert.match(await fs.readFile(file, 'utf8'), /<h1>New<\/h1>/);
  const empty = await post(server, '/_/api/doc.html', { patch: [] });
  assert.equal(empty.body.etag, undefined, JSON.stringify(empty.body));
}));

test('http patch case 3: a patch array beside another key is data', () => fixture(async (dir, server) => {
  const html = '<script data-rules-name="api" data-rules-version="1">{"title":"h1","other":"h2"}</script><h1>A</h1><h2>B</h2>';
  await fs.writeFile(path.join(dir, 'doc.html'), html);
  const result = await post(server, '/_/api/doc.html', { patch: [], other: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'etag'), false, JSON.stringify(result.body));
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'changed'), false, JSON.stringify(result.body));
}));

test('http patch case 4: a patch value that is not an array is data', () => fixture(async (dir, server) => {
  const html = '<script data-rules-name="api" data-rules-version="1">{"title":"h1"}</script><h1>A</h1>';
  await fs.writeFile(path.join(dir, 'doc.html'), html);
  const result = await post(server, '/_/api/doc.html', { patch: 'x' });
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'changed'), false, JSON.stringify(result.body));
}));

test('precondition case 1: a wrong If-Match refuses the patch and writes nothing', () => tinyFixture(async (dir, server, bytes) => {
  const patch = await tinyPatch(server);
  const result = await post(server, '/_/api/doc.html', { patch }).set('If-Match', '"nope"');
  assert.equal(result.status, 412, JSON.stringify(result.body));
  assert.deepEqual(await fs.readFile(path.join(dir, 'doc.html')), bytes);
}));

test('precondition case 2: an If-Match equal to a fresh read accepts the patch', () => tinyFixture(async (dir, server) => {
  const patch = await tinyPatch(server);
  const fresh = await read(server, '/_/api/doc.html');
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.headers.etag, documentEtag(Buffer.from(tinyHtml())));
  const result = await post(server, '/_/api/doc.html', { patch }).set('If-Match', fresh.headers.etag);
  assert.equal(result.status, 200, JSON.stringify(result.body));
}));

test('precondition case 3: a whole read after a patch answers the patched value', () => tinyFixture(async (dir, server) => {
  const patch = await tinyPatch(server);
  const before = await read(server, '/_/api/doc.html');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const result = await post(server, '/_/api/doc.html', { patch });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const after = await read(server, '/_/api/doc.html');
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(cellValue(after.body.sheets[0].rows[1].cells[1]), 42, JSON.stringify(after.body));
  assert.equal(after.headers.etag, documentEtag(await fs.readFile(path.join(dir, 'doc.html'))));
}));
