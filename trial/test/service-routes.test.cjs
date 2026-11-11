'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { realpathSync } = require('node:fs');

const {
  SKIP, until, request, save, buildTrialBinary, makeRoots, bootPair, trackCalls,
} = require('./service-harness.cjs');
const { pageStatePath } = require('../../src/main/page-state-store.js');
const { documentEtag } = require('../../src/main/spec-wire.js');
const { pageFixture } = require('../../tests/helpers/page-fixture');

const FIXTURE = pageFixture('abc');

// A document with an api rules tag and no live page store: Go's own data API
// answers it (htmlclay's api-golden `list.html`).
const PLAIN = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>List</title>
    <script type="application/json" data-rules-name="api" data-rules-version="1">{"title":"h1","items":["ul.items li",{"name":".name","done":"input@checked"}]}</script>
  </head>
  <body>
    <h1>List</h1>
    <ul class="items">
      <li><span class="name">alpha</span><input type="checkbox" checked></li>
      <li><span class="name">beta</span><input type="checkbox"></li>
      <li><span class="name">gamma</span><input type="checkbox" checked></li>
    </ul>
  </body>
</html>
`;

// A relay snapshot posted to the served root's own `/_/sync`, the way a browser
// tab hands the platform its unstripped working state.
function postRelay(target, rel, html) {
  const body = Buffer.from(JSON.stringify({ snapshot: html }), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(`${target.url}/_/sync`, {
      method: 'POST',
      headers: {
        'Document-URL': `${target.url}/${rel}`,
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('the JS service answers Local\'s routes, Go\'s notices and the supervisor, proven against the Go host', { skip: SKIP }, async (t) => {
  const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-service-routes-')));
  const bin = buildTrialBinary(tmp);
  const roots = makeRoots(tmp);

  const pair = await bootPair(bin, roots);
  const { service, ready } = pair;
  const rootA = roots[0];
  const rootAUrl = ready.roots[0].url;
  const rootAId = ready.roots[0].id;
  const pagePath = path.join(rootA, 'page.html');
  const sidecarPath = pageStatePath(rootA, 'page.html');
  const versionsDir = path.join(rootA, '.hyperclay', 'versions', 'page');

  const calls = trackCalls(service, ['/v1/admit', '/v1/settle']);

  // What Local's own app for root A answers, and what Go's notices hand its hub.
  const answered = [];
  const record = service.rootFor(rootAId);
  const app = record.app;
  record.app = (req, res) => {
    answered.push({ method: req.method, url: req.url });
    return app(req, res);
  };
  const notified = [];
  const notify = record.live.notify;
  record.live.notify = (rel, payload, opts) => {
    notified.push({ rel, payload });
    return notify(rel, payload, opts);
  };

  const supervisor = (pathname, body, authorization = `Bearer ${service.secret}`) => request(`${pair.url}${pathname}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  t.after(async () => {
    await pair.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const opened = {};

  await t.test("a tab's live stream is answered by Local's app, and a save through Go reaches it", async () => {
    const first = await save(rootAUrl, 'page.html', FIXTURE.html, { 'If-Match': documentEtag(Buffer.alloc(0)) });
    assert.equal(first.status, 200, first.body);
    opened.etag = JSON.parse(first.body).etag;

    const documentUrl = `${rootAUrl}/page.html`;
    const streamUrl = `${rootAUrl}/_/sync?document-url=${encodeURIComponent(documentUrl)}&lane=saved`;
    const received = [];
    let response = null;
    const stream = http.get(streamUrl, {
      headers: { accept: 'text/event-stream', 'document-url': documentUrl },
    }, (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk) => received.push(chunk));
    });
    stream.on('error', () => {});
    t.after(() => stream.destroy());

    assert.equal(await until(() => response !== null, { timeout: 10000 }), true, 'the stream never answered');
    assert.equal(response.statusCode, 200, `the stream answered ${response.statusCode}`);
    assert.equal(response.headers['content-type'], 'text/event-stream');

    assert.equal(await until(() => answered.some((call) => call.method === 'GET' && call.url.startsWith('/_/sync')), { timeout: 5000 }),
      true, JSON.stringify(answered));

    // The subscription is in place once the connection marker is written, so the
    // save below cannot fall before it.
    assert.equal(await until(() => received.join('').includes(': connected'), { timeout: 5000 }), true, received.join(''));

    const before = received.join('').length;
    const edited = FIXTURE.html.replace('</body>', '<p id="m9c-save">go-m9c-save</p></body>');
    const wrote = await save(rootAUrl, 'page.html', edited, { 'If-Match': opened.etag });
    assert.equal(wrote.status, 200, wrote.body);
    opened.etag = JSON.parse(wrote.body).etag;

    assert.equal(await until(() => received.join('').includes('go-m9c-save'), { timeout: 10000 }), true, received.join('').slice(before));
    console.log(`the stream received after the save: ${received.join('').slice(before, before + 300)}`);

    stream.destroy();
  });

  await t.test('the relay leaves a snapshot that the supervisor takes once', async () => {
    const relayed = await postRelay({ url: rootAUrl }, 'page.html', FIXTURE.html.replace('</body>', '<p>go-m9c-relay</p></body>'));
    assert.equal(relayed.status, 200, relayed.body);
    assert.equal(answered.filter((call) => call.method === 'POST' && call.url === '/_/sync').length > 0, true, JSON.stringify(answered));

    const first = await supervisor('/v1/snapshot/take', { root: rootAId, name: 'page.html', takeId: 't-1' });
    assert.equal(first.status, 200, first.body);
    const answer = JSON.parse(first.body);
    assert.ok(answer.snapshot, first.body);
    assert.equal(String(answer.snapshot.html).includes('go-m9c-relay'), true, first.body.slice(0, 300));

    const again = await supervisor('/v1/snapshot/take', { root: rootAId, name: 'page.html', takeId: 't-1' });
    assert.equal(again.status, 200, again.body);
    assert.equal(again.body, first.body);

    const next = await supervisor('/v1/snapshot/take', { root: rootAId, name: 'page.html', takeId: 't-2' });
    assert.equal(next.status, 200, next.body);
    assert.deepEqual(JSON.parse(next.body), { snapshot: null });
  });

  await t.test('a data API write on a live page store goes through Local\'s released write; a stale revision changes nothing', async () => {
    const read = await request(`${rootAUrl}/_/api/page.html`);
    assert.equal(read.status, 200, read.body);
    assert.ok(read.headers.etag, JSON.stringify(read.headers));
    assert.ok(read.headers['blockeditor-revision'], JSON.stringify(read.headers));
    assert.equal(answered.some((call) => call.method === 'GET' && call.url.startsWith('/_/api/page.html')), true, JSON.stringify(answered));
    const revision = read.headers['blockeditor-revision'];

    const write = await request(`${rootAUrl}/_/api/page.html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': read.headers.etag, 'Blockeditor-If-Match': revision },
      body: JSON.stringify({ body: 'go-m9c-api' }),
    });
    assert.equal(write.status, 200, write.body);
    assert.equal(JSON.parse(write.body).body, 'go-m9c-api', write.body);

    assert.equal(calls.some((call) => call.path === '/v1/admit' && call.lane === 'api' && call.name === 'page.html'), true, JSON.stringify(calls));
    assert.equal(calls.some((call) => call.path === '/v1/settle' && call.name === 'page.html'), true, JSON.stringify(calls));

    const marked = fs.readFileSync(pagePath, 'utf8').includes('go-m9c-api')
      || fs.readFileSync(sidecarPath, 'utf8').includes('go-m9c-api');
    assert.equal(marked, true, `${pagePath} and its sidecar hold no marker`);

    const fileBefore = fs.readFileSync(pagePath);
    const sidecarBefore = fs.readFileSync(sidecarPath);
    const versionsBefore = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : [];

    const fresh = await request(`${rootAUrl}/_/api/page.html`);
    assert.equal(fresh.status, 200, fresh.body);
    const stale = await request(`${rootAUrl}/_/api/page.html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'If-Match': fresh.headers.etag, 'Blockeditor-If-Match': revision },
      body: JSON.stringify({ body: 'go-m9c-api' }),
    });
    assert.equal(stale.status, 409, stale.body);
    assert.equal(JSON.parse(stale.body).code, 'revision-stale', stale.body);

    assert.deepEqual(fs.readFileSync(pagePath), fileBefore);
    assert.deepEqual(fs.readFileSync(sidecarPath), sidecarBefore);
    assert.deepEqual(fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).sort() : [], versionsBefore);
  });

  await t.test("a notice Go raises reaches the service's live hub", async () => {
    const saved = await save(rootAUrl, 'plain.html', PLAIN);
    assert.equal(saved.status, 200, saved.body);

    const seenBefore = answered.length;
    const write = await request(`${rootAUrl}/_/api/plain.html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Changed', items: [{ name: 'alpha', done: true }] }),
    });
    assert.equal(write.status, 200, write.body);

    assert.deepEqual(answered.slice(seenBefore).filter((call) => String(call.url).includes('plain.html')), [],
      JSON.stringify(answered.slice(seenBefore)));

    const delivered = await until(() => notified.some((call) => call.rel === 'plain.html'
      && call.payload && String(call.payload.msg).includes('was updated through the data API')), { timeout: 10000 });
    console.log(`the notices the hub received: ${JSON.stringify(notified.filter((call) => call.rel === 'plain.html')
      .map((call) => [call.payload && call.payload.msgType, call.payload && call.payload.msg]))}`);
    assert.equal(delivered, true, JSON.stringify(notified).slice(0, 600));

    const raised = await until(() => notified.some((call) => call.rel === 'plain.html'
      && call.payload && call.payload.msgType === 'data-loss' && String(call.payload.msg).includes('Saved data overwritten')), { timeout: 10000 });
    assert.equal(raised, true, JSON.stringify(notified).slice(0, 600));
  });

  await t.test("the supervisor's flush writes a dirty room through Go", async () => {
    const target = service.authority.bindTarget({ rootId: rootAId, logicalPath: 'page.html', canonicalPath: pagePath });
    const room = await service.authority.roomFor(target, () => ({
      rootId: rootAId, logicalPath: 'page.html', canonicalPath: pagePath, identity: target.identity,
    }));
    const edited = service.authority.rooms.apply(room, 'editor', {
      name: 'blockeditor', n: 1, epoch: room.epoch, blockeditorGeneration: room.blockeditorTransition?.id ?? null,
      compaction: 1,
      ops: [{ op: 'set', path: ['y', 'uflush-1-x'], value: FIXTURE.update }],
    });
    assert.equal(edited.error, undefined, JSON.stringify(edited));
    assert.equal(service.authority.roomIsDirty(room), true);

    const flushed = await supervisor('/v1/flush', { deadlineMs: 10000 });
    assert.equal(flushed.status, 200, flushed.body);
    assert.deepEqual(JSON.parse(flushed.body), { unsaved: [], timedOut: false });

    assert.equal(fs.readFileSync(sidecarPath, 'utf8').includes('flush-1'), true);
    assert.equal(service.authority.roomIsDirty(room), false);
  });

  await t.test("the supervisor's routes need the bearer; Go's need the epochs", async () => {
    const wrong = await supervisor('/v1/flush', { deadlineMs: 1000 }, 'Bearer nope');
    assert.equal(wrong.status, 401, wrong.body);

    const admit = await supervisor('/v1/admit', {});
    assert.equal(admit.status, 409, admit.body);
    assert.equal(JSON.parse(admit.body).error, 'epoch');

    const route = await request(`${pair.url}/v1/route/_/sync`, {
      headers: { authorization: `Bearer ${service.secret}` },
    });
    assert.equal(route.status, 409, route.body);
    assert.equal(JSON.parse(route.body).error, 'epoch');
  });
});
