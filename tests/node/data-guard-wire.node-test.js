// End-to-end test for the data-loss wire contract Hyperclay Local serves: the
// `/_/meta` document block's `dataGuard` href, `GET /_/data-loss` and the
// `POST` that resolves an event, and the raised/resolved frames on the served
// root's live transport. Real Express app, real engine, real guard store, real
// RootObserver. Run via `node --test` (npm run test:node), for the same reason
// data-loss-guard.node-test.js is: jest's vm sandbox cannot run the engine's
// dynamic ESM import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createApp } = require('../../src/main/server.js');
const { RootObserver } = require('../../src/main/root-observer.js');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');

const NAME = 'app.html';

// The contract's ten keys for a client-side event (data-loss-guard's
// toClientEvent), sorted for a set comparison.
const CONTRACT_KEYS = [
  'canRevert',
  'droppedAdditions',
  'fieldCount',
  'firstDetectedAt',
  'id',
  'lastWriteAt',
  'lossSummary',
  'preview',
  'restorable',
  'status',
];

// The clobber the guard fires on: the heading emptied and two of the three list
// items gone, which destroys three of four meaningful leaves while leaving the
// one sibling a Restore needs to put the others back beside.
const clobbered = () => page({ title: '', items: ['a'] });

function page({ title = 'Title', items = ['a', 'b', 'c'] } = {}) {
  const lis = items.map((t) => `<li class="item">${t}</li>`).join('');
  return `<!DOCTYPE html><html><head>
<script type="application/json" data-rules-name="api" data-rules-version="1">
{ "title": "h1", "items": ".item[]" }
</script></head><body>
<h1>${title}</h1>
<ul id="list">${lis}</ul>
</body></html>`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every wait in this file has a deadline that fails the test on expiry, so a
// frame or an event that never arrives is a failure rather than a hang.
async function waitFor(predicate, what, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The served root's live transport, observed rather than mocked: subscribers
// receive exactly what notify/broadcast would deliver, and every notify frame
// is recorded with no SSE client to sequence.
function createLiveSpy() {
  const subscribers = new Map();
  const frames = [];
  const deliver = (rel, payload) => {
    frames.push({ rel, payload });
    for (const handler of subscribers.get(rel) || []) handler(payload);
  };
  return {
    frames,
    key: (rel) => rel,
    subscribe: (rel, handler) => {
      if (!subscribers.has(rel)) subscribers.set(rel, new Set());
      subscribers.get(rel).add(handler);
    },
    unsubscribe: (rel, handler) => {
      const handlers = subscribers.get(rel);
      if (handlers) handlers.delete(handler);
    },
    notify: deliver,
    broadcast: () => {},
    markBrowserSave: () => {},
    wasBrowserSave: () => false,
  };
}

// A served folder holding the given files, the real app on its own live
// transport.
async function withSite(files, fn) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guard-wire-')));
  for (const [name, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), bytes);
  }
  const live = createLiveSpy();
  const root = { id: `guard-wire-${path.basename(dir)}`, kind: 'personal', path: dir, port: 0 };
  const server = await listenLoopback(createApp({ root, devHooks: null, isKnownPath: null, live }));
  try {
    return await fn({ dir, file: path.join(dir, NAME), live, server });
  } finally {
    await closeLoopback();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

const documentUrl = (name) => `http://localhost:4321/${name}`;

const getEvent = (server, name = NAME) =>
  request(server).get('/_/data-loss').set('Document-URL', documentUrl(name));

const save = (server, name, html) =>
  request(server)
    .post('/_/save')
    .set('Document-URL', documentUrl(name))
    .set('Content-Type', 'text/plain')
    .send(html);

const post = (server, url, body, name = NAME) =>
  request(server)
    .post(url)
    .set('Document-URL', documentUrl(name))
    .set('Content-Type', 'application/json')
    .send(body);

async function waitForEvent(server, what = 'the guard event') {
  let answer = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    answer = await getEvent(server);
    if (answer.body && answer.body.event) return answer;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('/_/meta advertises the guard read for HTML and .htmlclay documents only', async () => {
  await withSite({ 'app.html': page(), 'page.htmlclay': page(), 'notes.txt': 'plain' }, async ({ server }) => {
    const html = await request(server).get('/_/meta').set('Document-URL', documentUrl('app.html'));
    assert.equal(html.status, 200);
    assert.deepEqual(html.body.document.dataGuard, { href: '/_/data-loss' });

    const clay = await request(server).get('/_/meta').set('Document-URL', documentUrl('page.htmlclay'));
    assert.deepEqual(clay.body.document.dataGuard, { href: '/_/data-loss' });

    const other = await request(server).get('/_/meta').set('Document-URL', documentUrl('notes.txt'));
    assert.equal(other.status, 200);
    assert.equal(other.body.document, undefined, 'a non-document gets no block, so no guard read either');

    const none = await request(server).get('/_/meta');
    assert.equal(none.status, 200);
    assert.equal(none.body.document, undefined, 'no Document-URL, no document block');
  });
});

test('a clobbering save is readable from /_/data-loss and restorable by id', async () => {
  await withSite({ 'app.html': page() }, async ({ server }) => {
    const seeded = await getEvent(server);
    assert.equal(seeded.status, 200);
    assert.equal(seeded.body.event, null, 'the page-load read seeds the baseline');

    const clobber = await save(server, NAME, clobbered());
    assert.equal(clobber.status, 200);

    const answer = await waitForEvent(server, 'the raised event');
    assert.equal(answer.headers['cache-control'], 'no-store');
    const event = answer.body.event;
    assert.deepEqual(Object.keys(event).sort(), CONTRACT_KEYS);
    assert.equal(typeof event.id, 'string');
    assert.ok(event.id.length > 0);
    assert.equal(event.status, 'pending');
    assert.ok(event.fieldCount > 0, 'the recovered item count is nonzero');

    const restored = await post(server, '/_/data-loss', { id: event.id, choice: 'restore' });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body, { ok: true, choice: 'restore', status: 'restored' });

    const cleared = await getEvent(server);
    assert.equal(cleared.body.event, null, 'the resolved event is gone');
  });
});

test('the document stream carries the raised and resolved envelopes', async () => {
  await withSite({ 'app.html': page() }, async ({ live, server }) => {
    const received = [];
    live.subscribe(NAME, (payload) => received.push(payload));

    const seeded = await getEvent(server);
    assert.equal(seeded.body.event, null);

    const clobber = await save(server, NAME, clobbered());
    assert.equal(clobber.status, 200);

    await waitFor(() => received.length >= 1, 'the raised envelope');
    const raised = received[0];
    assert.deepEqual(Object.keys(raised).sort(), ['action', 'data', 'msg', 'msgType']);
    assert.equal(raised.msgType, 'data-loss');
    assert.equal(raised.action, 'raised');
    assert.equal(raised.msg, 'Saved data overwritten');
    assert.deepEqual(Object.keys(raised.data).sort(), CONTRACT_KEYS);
    assert.equal(raised.data.status, 'pending');
    assert.equal(typeof raised.data.id, 'string');

    const restored = await post(server, '/_/data-loss', { id: raised.data.id, choice: 'restore' });
    assert.equal(restored.status, 200);

    await waitFor(() => received.length >= 2, 'the resolved envelope');
    assert.deepEqual(received[1], {
      msgType: 'data-loss',
      action: 'resolved',
      msg: 'Data guard resolved',
      data: { id: raised.data.id },
    });
    assert.equal(received.length, 2, 'one raised and one resolved frame, and nothing else');
  });
});

test('an edit outside the app raises an event the same GET returns', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guard-wire-watch-')));
  const file = path.join(dir, NAME);
  await fs.writeFile(file, page());

  const live = createLiveSpy();
  const root = { id: `guard-wire-watch-${path.basename(dir)}`, kind: 'personal', path: dir, port: 0 };
  const observer = new RootObserver(root, { live });
  const changes = [];
  observer.on('change', (event) => changes.push(event));
  observer.start();
  await new Promise((resolve) => observer.watcher.once('ready', resolve));
  const server = await listenLoopback(createApp({ root, devHooks: null, isKnownPath: null, live, observer }));

  try {
    const seeded = await getEvent(server);
    assert.equal(seeded.body.event, null);

    await fs.writeFile(file, clobbered());

    await waitFor(
      () => changes.some((event) => event.kind === 'external' && event.rel === NAME),
      'the watcher to see the edit',
    );

    const answer = await waitForEvent(server, 'the event the outside edit raised');
    assert.equal(answer.headers['cache-control'], 'no-store');
    const event = answer.body.event;
    assert.deepEqual(Object.keys(event).sort(), CONTRACT_KEYS);
    assert.equal(event.status, 'pending');
    assert.ok(event.fieldCount > 0, 'the recovered item count is nonzero');
    assert.ok(
      event.preview.some((row) => row.key === 'items' && row.yours === 'a, b, c'),
      'the unreadable items are what the event recovers',
    );
  } finally {
    await closeLoopback();
    await observer.stop();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
