'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { realpathSync } = require('node:fs');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = process.env.HTMLCLAY_SOURCE;
const SKIP = SOURCE
  ? false
  : 'HTMLCLAY_SOURCE is unset: these tests build and drive the Go managed-trial binary from the htmlclay source tree';

const { createTrialService, Consultation } = require('../service.cjs');
const { clearConnection } = require('../go-process.cjs');
const { documentEtag } = require('../../src/main/spec-wire.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeout = 10000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await wait(interval);
  }
}

function document(inner) {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>go host</title></head>\n<body>${inner}</body>\n</html>\n`;
}

function request(target, { method = 'GET', headers = {}, body = null } = {}) {
  const payload = body === null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: { ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function save(rootUrl, name, html, headers = {}) {
  return request(`${rootUrl}/_/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html', 'Document-URL': `${rootUrl}/${name}`, ...headers },
    body: html,
  });
}

async function bootPair(bin, roots) {
  const service = createTrialService({ logError: () => {} });
  const serviceUrl = await service.listen();
  const goSecret = randomBytes(32).toString('hex');
  const child = spawn(bin, ['--root', roots[0], '--root', roots[1], '--port', '0', '--local-source', REPO, '--bootstrap-stdin'], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: process.env,
  });
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ v: 1, secret: goSecret, service: { url: serviceUrl, secret: service.secret, epoch: service.epoch } })}\n`);
  let out = '';
  child.stdout.setEncoding('utf8');
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no READY line: ${out}`)), 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /^READY (\{.*\})$/m.exec(out);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`go exited ${code}: ${out}`)); });
  });
  await service.attachGo({ url: ready.control, secret: goSecret, epoch: ready.epoch, roots: ready.roots });
  const stop = async () => {
    clearConnection();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
    await service.close();
  };
  return { service, child, ready, stop, url: serviceUrl };
}

test('the JS service lanes, proven against the Go host', { skip: SKIP }, async (t) => {
  const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-service-lanes-')));
  const bin = path.join(tmp, 'managed-trial');
  const roots = ['root-a', 'root-b'].map((name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  });

  const build = spawnSync('go', ['build', '-tags', 'managedtrial', '-o', bin, './cmd/managed-trial'], {
    cwd: SOURCE,
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
    timeout: 600000,
  });
  assert.equal(build.status, 0, `the managed-trial build failed:\n${build.stderr || build.stdout}`);

  const pair = await bootPair(bin, roots);
  const { service, ready } = pair;
  const rootA = roots[0];
  const rootAUrl = ready.roots[0].url;
  const rootAId = ready.roots[0].id;

  const calls = [];
  for (const pathname of ['/v1/admit', '/v1/settle']) {
    const original = service.handlers.get(pathname);
    service.handlers.set(pathname, (body, reply) => {
      calls.push({ path: pathname, lane: body.lane, name: body.name });
      original(body, reply);
    });
  }

  t.after(async () => {
    await pair.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const admitsFor = (name) => calls.filter((call) => call.path === '/v1/admit' && call.name === name);

  await t.test('a save through Go is admitted and confirmed by Local\'s room code', async () => {
    const answer = await save(rootAUrl, 'notes.html', document('<p>one</p>'));
    assert.equal(answer.status, 200, answer.body);

    const admitted = calls.filter((call) => call.name === 'notes.html' && call.lane === 'save');
    assert.equal(admitted.filter((call) => call.path === '/v1/admit').length, 1, JSON.stringify(calls));
    assert.equal(await until(() => admitted.filter((call) => call.path === '/v1/settle').length === 1), true, JSON.stringify(calls));

    const file = path.join(rootA, 'notes.html');
    const bytes = fs.readFileSync(file);
    const stat = fs.statSync(file, { bigint: true });
    const stamp = service.authority.confirmedStamp(file);
    assert.ok(stamp, 'the authority confirmed no stamp for notes.html');
    assert.equal(stamp.etag, documentEtag(bytes), JSON.stringify(stamp, (key, value) => (typeof value === 'bigint' ? String(value) : value)));
    for (const field of ['mtimeNs', 'ino', 'size']) {
      assert.equal(stamp[field], stat[field], `${field}: ${JSON.stringify(stamp, (key, value) => (typeof value === 'bigint' ? String(value) : value))}`);
    }
    assert.equal(service.authority.confirmedDocument(file), bytes.toString('utf8'));
  });

  await t.test('a refusal from Local\'s admission passes through Go unchanged, and nothing is written', async () => {
    const file = path.join(rootA, 'notes.html');
    const versionsDir = path.join(rootA, '.hyperclay', 'versions', 'notes');
    const before = fs.readFileSync(file);
    const versionsBefore = fs.readdirSync(versionsDir).length;
    const admitsBefore = calls.filter((call) => call.path === '/v1/admit').length;

    const answer = await save(rootAUrl, 'notes.html', document('<p>changed</p>'), { 'Page-Conversion': 'v2' });
    assert.equal(answer.status, 400, answer.body);
    const body = JSON.parse(answer.body);
    assert.equal(body.msgType, 'error');
    assert.equal(body.code, 'page-conversion-refused');
    assert.equal(body.reason, 'invalid-header');
    assert.equal(typeof body.msg, 'string');

    assert.equal(calls.filter((call) => call.path === '/v1/admit').length, admitsBefore + 1, JSON.stringify(calls));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.readdirSync(versionsDir).length, versionsBefore);
  });

  await t.test('a version restore writes Local\'s safety version through the artifact loop', async () => {
    const file = path.join(rootA, 'notes.html');
    const versionsDir = path.join(rootA, '.hyperclay', 'versions', 'notes');
    assert.equal((await save(rootAUrl, 'notes.html', document('<p>two</p>'))).status, 200);
    assert.equal((await save(rootAUrl, 'notes.html', document('<p>three</p>'))).status, 200);

    const before = new Set(fs.readdirSync(versionsDir));
    const version = [...before].find((name) => fs.readFileSync(path.join(versionsDir, name), 'utf8').includes('<p>two</p>'));
    assert.ok(version, `no version holds <p>two</p>: ${[...before].join(', ')}`);

    const answer = await request(`${rootAUrl}/_/restore/notes.html/${encodeURIComponent(version)}`, { method: 'POST' });
    assert.equal(answer.status, 200, answer.body);

    assert.equal(fs.readFileSync(file, 'utf8').includes('<p>two</p>'), true);
    const added = fs.readdirSync(versionsDir).filter((name) => !before.has(name)).sort();
    const contents = added.map((name) => fs.readFileSync(path.join(versionsDir, name), 'utf8'));
    assert.equal(contents.some((text) => text.includes('<p>three</p>')), true, JSON.stringify(added));
    assert.deepEqual(added.map((name, index) => (contents[index].includes('<p>three</p>') ? 'three'
      : contents[index].includes('<p>two</p>') ? 'two' : 'other')).sort(), ['three', 'two'], JSON.stringify(added));

    assert.equal(await until(() => admitsFor('notes.html').some((call) => call.lane === 'replace')), true, JSON.stringify(calls));
  });

  await t.test('an abort that arrives before its admit refuses that admit', async () => {
    const consultId = 'a'.repeat(32);
    service.handlers.get('/v1/abort')({ consultId, reason: 'deadline' }, () => {});

    const replies = [];
    service.handlers.get('/v1/admit')({
      consultId,
      root: rootAId,
      name: 'x.html',
      canonicalPath: path.join(rootA, 'x.html'),
      lane: 'save',
    }, (body, status) => replies.push([body, status]));

    assert.equal(await until(() => replies.length > 0), true, 'the admit was never answered');
    assert.deepEqual(replies, [[{ error: 'aborted' }, 409]]);
  });

  await t.test('artifacts written in one turn leave as one batch, and receipts resume them', async () => {
    const replies = [];
    const c = new Consultation('b'.repeat(32), (body) => replies.push(body));
    const p1 = c.write({ type: 'safety-version', logical: { encoding: 'utf8', data: 'x' } });
    const p2 = c.write({ type: 'safety-version', logical: { encoding: 'utf8', data: 'y' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replies.length, 1, JSON.stringify(replies));
    assert.equal(replies[0].pending, true);
    assert.equal(replies[0].artifacts.length, 2);
    const [a1, a2] = replies[0].artifacts;
    assert.match(a1.artifactId, /^[0-9a-f]{16}$/);
    assert.match(a2.artifactId, /^[0-9a-f]{16}$/);

    c.receive([
      { artifactId: a1.artifactId, version: 'v1', error: null },
      { artifactId: a2.artifactId, version: 'v2', error: null },
    ], (body) => replies.push(body));
    assert.deepEqual(await p1, { artifactId: a1.artifactId, version: 'v1', error: null });
    assert.deepEqual(await p2, { artifactId: a2.artifactId, version: 'v2', error: null });

    c.abort('deadline');
    const next = await Promise.race([c.next(), wait(1000).then(() => 'timed out')]);
    assert.deepEqual(next, { abort: 'deadline' });
  });

  await t.test('the service refuses requests that are not Go\'s', async () => {
    const host = new URL(pair.url).host;
    const port = new URL(pair.url).port;
    const right = {
      authorization: `Bearer ${service.secret}`,
      'x-trial-epoch': ready.epoch,
      'x-trial-peer-epoch': service.epoch,
      'content-type': 'application/json',
    };
    const body = '{}';

    const unauthorized = await request(`${pair.url}/v1/admit`, {
      method: 'POST', headers: { ...right, authorization: 'Bearer nope', host }, body,
    });
    assert.equal(unauthorized.status, 401, unauthorized.body);

    const foreign = await request(`${pair.url}/v1/admit`, {
      method: 'POST', headers: { ...right, host: `localhost:${port}` }, body,
    });
    assert.equal(foreign.status, 403, foreign.body);

    const stale = await request(`${pair.url}/v1/admit`, {
      method: 'POST', headers: { ...right, host, 'x-trial-epoch': 'f'.repeat(16) }, body,
    });
    assert.equal(stale.status, 409, stale.body);
    assert.equal(JSON.parse(stale.body).error, 'epoch');
  });
});
