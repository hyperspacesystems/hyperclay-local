// The shared data worker, run for real: the actual src/main/assets/sync-data-worker.js
// in a Node vm, the real Local app on a loopback port, and a real authority whose
// rooms receive real writes. Nothing in the worker is stubbed except the browser
// around it -- MessagePorts that record what the worker posts, and an EventSource
// backed by Node's http client, so the worker's one connection is a real socket
// through the v2 shared stream route.

const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { createRooms } = require('@panphora/clayjs/server/rooms');
const { liveSync } = require('livesync-hyperclay');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { onLiveFrame } = require('../../src/main/utils/root-live');
const { startLiveDataFixture } = require('../helpers/local-live-data');
const { HttpEventSource } = require('../helpers/http-event-source');

jest.setTimeout(20000);

const WORKER_PATH = path.join(__dirname, '../../src/main/assets/sync-data-worker.js');
// ClayJS's golden transcript of the v2 shared data stream, copied unchanged.
const GOLDEN = JSON.parse(fsSync.readFileSync(path.join(__dirname, '../fixtures/shared-data-stream.json'), 'utf8'));
const WORKER_SOURCE = fsSync.readFileSync(WORKER_PATH, 'utf8');

const DOC = (count) => `<!doctype html>\n<html><body><script type="application/json" merge="store" clay="live">{"count":${count}}</script></body></html>\n`;
const ADD = { op: 'add', path: ['count'], n: 1 };
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A bounded wait, for the assertions that nothing arrived.
const settle = () => wait(120);

// A MessagePort that records what the worker posts. The copy is made across the
// realm boundary the way a real postMessage makes it, so assertions compare this
// realm's plain objects.
class FakePort {
  constructor() {
    this.sent = [];
    this.onmessage = null;
    this.onmessageerror = null;
    this.closed = false;
  }

  postMessage(msg) {
    this.sent.push(JSON.parse(JSON.stringify(msg)));
  }

  addEventListener() {}

  start() {}

  close() {
    this.closed = true;
  }

  push(msg) {
    this.onmessage({ data: msg });
  }

  drain() {
    const all = this.sent;
    this.sent = [];
    return all;
  }
}

// The worker file in a vm scope: a fake SharedWorker scope with the fixture's
// origin, short timers, and this test's recording ports and HTTP EventSource.
function startWorker(origin, timing = {}, limits = undefined) {
  const timers = { timeouts: new Set(), intervals: new Set() };
  const sandbox = {
    self: {
      location: { origin },
      claySyncTiming: Object.assign(
        { debounce: 5, portTTL: 60000, hiddenPortTTL: 120000, sweep: 25, backoffMin: 20, backoffMax: 100 },
        timing
      ),
      claySyncLimits: limits,
    },
    EventSource: HttpEventSource,
    URL,
    URLSearchParams,
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.timeouts.add(id);
      return id;
    },
    clearTimeout: (id) => {
      timers.timeouts.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.intervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      timers.intervals.delete(id);
      clearInterval(id);
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(WORKER_SOURCE, sandbox, { filename: 'sync-data-worker.js' });
  const worker = sandbox.self;
  return {
    connect() {
      const port = new FakePort();
      worker.onconnect({ ports: [port] });
      return port;
    },
    stop() {
      for (const id of timers.intervals) clearInterval(id);
      for (const id of timers.timeouts) clearTimeout(id);
      timers.intervals.clear();
      timers.timeouts.clear();
    },
  };
}

const subscribe = (port, document, lane, since, clientId) => {
  const message = { v: 2, type: 'subscribe', document, lane, since };
  if (clientId !== undefined) message.clientId = clientId;
  port.push(message);
};

const statuses = (port) => port.sent.filter((m) => m.type === 'status').map((m) => m.state);
const openCount = (port) => statuses(port).filter((state) => state === 'open').length;
const isOpen = (port) => statuses(port).at(-1) === 'open' && openCount(port) > 0;
const cursors = (port) => port.sent.filter((m) => m.type === 'cursor');
const eventsOf = (port, name) => port.sent.filter((m) => m.type === 'event' && m.event === name);
const presenceOf = (port) => eventsOf(port, 'presence').at(-1)?.data ?? null;
const dataEvents = (port) => eventsOf(port, 'data');

const indexOfFirst = (port, predicate) => port.sent.findIndex(predicate);

function request(origin, { method = 'GET', target, headers = {}, body = null }) {
  const url = new URL(target, origin);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function harness() {
  const state = { now: 1000, epoch: 0, id: 0 };
  const core = createRooms({ now: () => state.now, newEpoch: () => `e${++state.epoch}` });
  const authority = createLocalAuthority({
    rooms: core,
    withDocument: async (resolve, fn) => fn(await resolve()),
    readSaved: (target) => fs.readFile(target.canonicalPath, 'utf8'),
    now: () => state.now,
    newId: () => `id${++state.id}`,
  });
  return { state, core, authority };
}

let dir;
let h;
let fixture;
let worker;
let documentUrl;

const stateOf = (clientId, name = 'index.html') => request(fixture.origin, {
  target: `/_/sync/data?client-id=${encodeURIComponent(clientId)}`,
  headers: { 'Document-URL': documentUrl(name), ...SAME_ORIGIN },
});

const postFrame = (clientId, conn, { n = 1, ops = [ADD], name = 'index.html' } = {}) => request(fixture.origin, {
  method: 'POST',
  target: `/_/sync/data?client-id=${encodeURIComponent(clientId)}`,
  headers: {
    Origin: fixture.origin,
    'Content-Type': 'application/json',
    'Document-URL': documentUrl(name),
    ...SAME_ORIGIN,
  },
  body: JSON.stringify({ name: 'store', n, ops, conn }),
});

const PAGE_TARGET = {
  kind: 'page',
  v: 1,
  epoch: 'epoch-1',
  generation: 0,
  selection: {
    kind: 'text',
    anchor: { block: 'p1', rel: 'AAAAAA==' },
    head: { block: 'p1', rel: 'AAAAAA==' },
  },
};

const postPresence = (clientId, token, n = 1) => request(fixture.origin, {
  method: 'POST',
  target: `/_/presence?client-id=${encodeURIComponent(clientId)}`,
  headers: {
    Origin: fixture.origin,
    'Content-Type': 'application/json',
    'Document-URL': documentUrl('index.html'),
    ...SAME_ORIGIN,
  },
  body: JSON.stringify({ v: 1, session: token, n, editing: PAGE_TARGET }),
});

// Every live-lane frame the process broadcasts, so a test can name the position
// it wants a subscription to resume from.
const liveFrames = [];
onLiveFrame((frame) => liveFrames.push(frame));

const liveKey = (name) => `${fixture.root.id}:${name}`;

// A snapshot frame on a document's live lane, recorded before any subscriber
// exists, and its position: what a browser tab would resume from.
const broadcastSnapshot = (name, html) => {
  liveSync.broadcast(liveKey(name), { html, sender: 'tab-1' }, { lane: 'live' });
  return liveFrames.filter((frame) => frame.file === liveKey(name) && frame.lane === 'live').at(-1).seq;
};

const framesOf = (port) => port.sent.filter((m) => m.type === 'frame');

// The golden records message types, a status's state and an event's name, and
// nothing else: sequence numbers and payloads there come from another document.
// Presence is newer than the golden and a redundant connecting notice is not a
// golden payload (October's contract), so both are dropped on the way in.
const projectionOf = (messages) => messages
  .filter((message) => !(message.type === 'event' && message.event === 'presence'))
  .filter((message) => !(message.type === 'status' && message.state === 'connecting'))
  .map((message) => {
    if (message.type === 'status') return `status:${message.state}`;
    if (message.type === 'event') return `event:${message.event}`;
    return message.type;
  });

beforeEach(async () => {
  dir = path.resolve(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shared-data-worker-'))));
  await fs.writeFile(path.join(dir, 'index.html'), DOC(0));
  await fs.writeFile(path.join(dir, 'second.html'), DOC(0));
  await fs.writeFile(path.join(dir, 'third.html'), DOC(0));
  HttpEventSource.reset();
  liveFrames.length = 0;
  h = harness();
  fixture = await startLiveDataFixture({ authority: h.authority, rootDir: dir, rootId: 'shared-data-worker' });
  worker = startWorker(fixture.origin);
  documentUrl = (name) => `${fixture.origin}/${name}`;
});

afterEach(async () => {
  HttpEventSource.cleanup();
  worker?.stop();
  worker = null;
  await fixture.close();
  fixture = null;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('the shared data worker', () => {
  test('two editors of one document get one connection, their own rosters and the room frame', async () => {
    const one = documentUrl('index.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    const b = worker.connect();
    b.push({ v: 2, type: 'visible' });
    subscribe(b, one, 'live', 0, 'cB');

    await waitFor(() => isOpen(a) && isOpen(b), 'both editors to open');
    expect(openCount(a)).toBe(1);
    expect(openCount(b)).toBe(1);

    // One physical connection, the v2 wire, one snapshot entry, two members.
    expect(HttpEventSource.opened.length).toBe(1);
    expect(HttpEventSource.live().length).toBe(1);
    const url = new URL(HttpEventSource.opened[0].url);
    expect(url.searchParams.get('v')).toBe('2');
    expect(url.searchParams.getAll('s')).toEqual([`live:0:${one}`]);
    expect(url.searchParams.getAll('m')).toEqual([`cA:${one}`, `cB:${one}`]);

    // hello, then a cursor, then open, then this member's own roster.
    for (const port of [a, b]) {
      expect(port.sent[0]).toEqual({ v: 2, type: 'hello', features: ['live-data', 'presence'] });
      const cursorAt = indexOfFirst(port, (m) => m.type === 'cursor');
      const openAt = indexOfFirst(port, (m) => m.type === 'status' && m.state === 'open');
      const presenceAt = indexOfFirst(port, (m) => m.type === 'event' && m.event === 'presence');
      expect(cursorAt).toBeGreaterThan(0);
      expect(openAt).toBeGreaterThan(cursorAt);
      expect(presenceAt).toBeGreaterThan(openAt);
      expect(cursors(port).length).toBeGreaterThan(0);
    }

    const learned = [presenceOf(a), presenceOf(b)];
    expect(learned.every((roster) => roster && roster.selfSession)).toBe(true);
    const tokenA = learned[0].selfSession.token;
    const tokenB = learned[1].selfSession.token;
    expect(typeof tokenA).toBe('string');
    expect(tokenA).not.toBe(tokenB);

    // A room increment through the real authority reaches both editors once each.
    await waitFor(() => h.authority.connectedIds(path.join(dir, 'index.html')).length === 2, 'both members to register');
    const connA = (await stateOf('cA')).json.conn;
    const connB = (await stateOf('cB')).json.conn;
    expect(typeof connA).toBe('string');
    expect(connB).not.toBe(connA);
    const posted = await postFrame('cA', connA);
    expect(posted.status).toBe(200);

    await waitFor(() => dataEvents(a).length >= 1 && dataEvents(b).length >= 1, 'the room frame at both editors');
    await settle();
    expect(dataEvents(a).length).toBe(1);
    expect(dataEvents(b).length).toBe(1);
    const frameA = dataEvents(a)[0];
    expect(frameA).toEqual(dataEvents(b)[0]);
    expect(frameA.event).toBe('data');
    expect(frameA.data.from).toBe('cA');
    expect(frameA.data.seq).toBe(1);
    expect(frameA.data.ops).toEqual([ADD]);
  });

  test('a third document rebuilds once, and a port joining a ready member needs no rebuild', async () => {
    const [one, two, three] = [documentUrl('index.html'), documentUrl('second.html'), documentUrl('third.html')];
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    const b = worker.connect();
    b.push({ v: 2, type: 'visible' });
    subscribe(b, two, 'live', 0, 'cB');

    await waitFor(() => isOpen(a) && isOpen(b), 'the first two documents to open');
    expect(HttpEventSource.opened.length).toBe(1);
    const firstConnection = HttpEventSource.opened[0];
    await waitFor(() => presenceOf(a) !== null, 'the first roster');
    const firstTokenA = presenceOf(a).selfSession.token;

    const c = worker.connect();
    c.push({ v: 2, type: 'visible' });
    subscribe(c, three, 'live', 0, 'cC');

    await waitFor(() => HttpEventSource.opened.length === 2, 'one rebuild');
    await waitFor(() => openCount(a) === 2 && openCount(b) === 2 && isOpen(c), 'every surviving port to reopen');
    expect(firstConnection.closed).toBe(true);
    expect(HttpEventSource.live().length).toBe(1);

    const rebuilt = new URL(HttpEventSource.opened[1].url);
    expect(rebuilt.searchParams.getAll('s').length).toBe(3);
    expect(rebuilt.searchParams.getAll('m').length).toBe(3);

    // Every surviving port is told connecting, then opens on the new connection.
    expect(statuses(a)).toEqual(['connecting', 'open', 'connecting', 'open']);
    expect(statuses(b)).toEqual(['connecting', 'open', 'connecting', 'open']);
    expect(statuses(c)).toEqual(['connecting', 'open']);

    // After the rebuild a reopened port is handed only rosters from the new
    // connection: the first connection's session ended with it.
    const reopenAt = a.sent.findLastIndex((m) => m.type === 'status' && m.state === 'open');
    await waitFor(() => a.sent.slice(reopenAt).some((m) => m.type === 'event' && m.event === 'presence'), 'a roster on the new connection');
    const rostersAfter = a.sent.slice(reopenAt).filter((m) => m.type === 'event' && m.event === 'presence');
    expect(rostersAfter.length).toBeGreaterThan(0);
    for (const roster of rostersAfter) expect(roster.data.selfSession.token).not.toBe(firstTokenA);

    // A second port on an already-ready member: cursor, open, the roster it last
    // saw, and no third socket.
    const tokenA = presenceOf(a).selfSession.token;
    const d = worker.connect();
    d.push({ v: 2, type: 'visible' });
    subscribe(d, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(d), 'the joining port to open at once');
    await settle();
    expect(HttpEventSource.opened.length).toBe(2);
    expect(statuses(d)).toEqual(['open']);
    expect(d.sent[0].type).toBe('hello');
    const cursorAt = indexOfFirst(d, (m) => m.type === 'cursor');
    const openAt = indexOfFirst(d, (m) => m.type === 'status' && m.state === 'open');
    const presenceAt = indexOfFirst(d, (m) => m.type === 'event' && m.event === 'presence');
    expect(cursorAt).toBe(1);
    expect(openAt).toBeGreaterThan(cursorAt);
    expect(presenceAt).toBeGreaterThan(openAt);
    expect(presenceOf(d).selfSession.token).toBe(tokenA);
  });

  test('a live port opens only after both cursors and never sees the roster before open', async () => {
    const one = documentUrl('index.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'hidden' });
    subscribe(a, one, 'live', 0, 'cA');

    await waitFor(() => isOpen(a), 'the live port to open');
    await settle();

    const assertOrder = (port) => {
      const cursorAt = indexOfFirst(port, (m) => m.type === 'cursor');
      const openAt = indexOfFirst(port, (m) => m.type === 'status' && m.state === 'open');
      const presenceAt = indexOfFirst(port, (m) => m.type === 'event' && m.event === 'presence');
      expect(cursorAt).toBeGreaterThan(-1);
      expect(openAt).toBeGreaterThan(cursorAt);
      expect(presenceAt).toBeGreaterThan(openAt);
      // Exactly one open, so nothing opened twice on the way.
      expect(openCount(port)).toBe(1);
    };
    assertOrder(a);
    // A hidden live port still receives its roster at once.
    expect(eventsOf(a, 'presence').length).toBeGreaterThan(0);

    // A port joining an already-ready member is handed that member's roster at
    // once -- after its open, never before it.
    const joining = worker.connect();
    joining.push({ v: 2, type: 'visible' });
    subscribe(joining, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(joining), 'the joining port to open');
    await settle();
    assertOrder(joining);
    expect(presenceOf(joining)).not.toBeNull();
    expect(HttpEventSource.opened.length).toBe(1);

    // A saved port opens from its snapshot cursor alone, and never holds a member.
    const saved = worker.connect();
    saved.push({ v: 2, type: 'visible' });
    subscribe(saved, one, 'saved', 0);
    await waitFor(() => isOpen(saved), 'the saved port to open');
    await settle();
    expect(indexOfFirst(saved, (m) => m.type === 'cursor')).toBeGreaterThan(0);
    expect(presenceOf(saved)).toBeNull();
    const savedUrl = new URL(HttpEventSource.live()[0].url);
    expect(savedUrl.searchParams.getAll('m').length).toBe(1);
  });

  test('callbacks from a superseded connection deliver nothing and change no state', async () => {
    const one = documentUrl('index.html');
    const two = documentUrl('second.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(a), 'the first open');

    const first = HttpEventSource.opened[0].source;
    const oldCursor = [...first.listeners.get('cursor')][0];
    const oldMember = [...first.listeners.get('m0')][0];
    const oldError = first.onerror;
    expect(typeof oldCursor).toBe('function');
    expect(typeof oldMember).toBe('function');
    expect(typeof oldError).toBe('function');

    const b = worker.connect();
    b.push({ v: 2, type: 'visible' });
    subscribe(b, two, 'live', 0, 'cB');
    await waitFor(() => HttpEventSource.opened.length === 2 && openCount(a) === 2 && isOpen(b), 'the rebuild');
    // Let the replacement's own frames land first: only the superseded callbacks
    // may be silent, not the live connection they were replaced by.
    await settle();
    const beforeA = a.sent.length;
    const beforeB = b.sent.length;
    const beforePresence = eventsOf(a, 'presence').length;
    const beforeStatuses = statuses(a);

    oldCursor({ data: JSON.stringify({ v: 2, sub: 0, seq: 999 }) });
    oldMember({ data: JSON.stringify({ event: 'presence', data: { people: [], injected: true } }) });
    oldMember({ data: JSON.stringify({ event: 'data', data: { injected: true } }) });
    oldError({ type: 'error' });
    await settle();

    expect(a.sent.length).toBe(beforeA);
    expect(b.sent.length).toBe(beforeB);
    expect(eventsOf(a, 'presence').length).toBe(beforePresence);
    expect(statuses(a)).toEqual(beforeStatuses);
    expect(a.sent.some((m) => m.type === 'event' && m.data?.injected)).toBe(false);
    expect(a.sent.some((m) => m.type === 'cursor' && m.seq === 999)).toBe(false);
    expect(HttpEventSource.opened.length).toBe(2);
    expect(openCount(a)).toBe(2);
  });

  test('the worker route is marker-gated and serves the file itself', async () => {
    const source = await fs.readFile(WORKER_PATH, 'utf8');
    const served = await request(fixture.origin, { target: '/_/sync/data-worker.js' });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toBe('no-cache');
    expect(served.text).toBe(source);

    const bare = await request(fixture.origin, { target: '/sync/data-worker.js' });
    expect(bare.text).not.toBe(source);
    expect(bare.headers['x-content-type-options']).not.toBe('nosniff');
  });

  test('a hidden pinging port outlives portTTL, still receives events, and holds snapshot frames', async () => {
    worker.stop();
    worker = startWorker(fixture.origin, { portTTL: 200, hiddenPortTTL: 1000, sweep: 50 });
    const one = documentUrl('index.html');
    const canonical = path.join(dir, 'index.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'hidden' });
    subscribe(a, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(a), 'the hidden port to open');
    await waitFor(() => presenceOf(a) !== null, 'the hidden port roster');
    await waitFor(() => h.authority.connectedIds(canonical).length === 1, 'the member to register');
    const roster = presenceOf(a);
    const presenceBefore = eventsOf(a, 'presence').length;

    const pinging = setInterval(() => a.push({ v: 2, type: 'ping' }), 40);
    try {
      // Three times portTTL, with a ping inside every sweep.
      await wait(600);
      expect(a.closed).toBe(false);
      expect(openCount(a)).toBe(1);

      const conn = (await stateOf('cA')).json.conn;
      expect(typeof conn).toBe('string');
      const posted = await postFrame('cA', conn);
      expect(posted.status).toBe(200);
      await waitFor(() => dataEvents(a).length === 1, 'the room frame at a hidden port');

      const presence = await postPresence('cA', roster.selfSession.token);
      expect(presence.status).toBe(204);
      await waitFor(() => eventsOf(a, 'presence').length > presenceBefore, 'a fresh roster at a hidden port');
      expect(a.closed).toBe(false);

      // A snapshot frame is held while the port is hidden, and flushed whole when
      // it says it is visible again.
      broadcastSnapshot('index.html', '<p>held</p>');
      await settle();
      expect(framesOf(a).length).toBe(0);
      a.push({ v: 2, type: 'visible' });
      await waitFor(() => framesOf(a).length === 1, 'the held snapshot frame');
      expect(framesOf(a)[0].data).toContain('held');
      expect(a.closed).toBe(false);
    } finally {
      clearInterval(pinging);
    }
  });

  test('a hidden port that stops pinging is dropped after hiddenPortTTL and leaves the stream', async () => {
    worker.stop();
    worker = startWorker(fixture.origin, { portTTL: 200, hiddenPortTTL: 1000, sweep: 50 });
    const one = documentUrl('index.html');
    const quiet = worker.connect();
    quiet.push({ v: 2, type: 'hidden' });
    subscribe(quiet, one, 'live', 0, 'cQ');
    const busy = worker.connect();
    busy.push({ v: 2, type: 'hidden' });
    subscribe(busy, one, 'live', 0, 'cB');
    await waitFor(() => isOpen(quiet) && isOpen(busy), 'both hidden ports to open');

    const pinging = setInterval(() => busy.push({ v: 2, type: 'ping' }), 30);
    try {
      // Well past portTTL, so only the longer hidden lifetime is keeping it.
      await wait(500);
      expect(quiet.closed).toBe(false);
      await waitFor(() => quiet.closed, 'the silent hidden port to be swept', 3000);

      // Its membership leaves the stream on the next rebuild, and the editor that
      // kept pinging stays connected with its own member and entry.
      await waitFor(() => HttpEventSource.opened.length >= 2, 'the rebuild after the sweep');
      await waitFor(() => isOpen(busy) && HttpEventSource.live().length === 1, 'the surviving editor to reopen');
      await settle();
      const rebuilt = new URL(HttpEventSource.live()[0].url);
      expect(rebuilt.searchParams.getAll('s')).toEqual([`live:${cursors(busy).at(-1).seq}:${one}`]);
      expect(rebuilt.searchParams.getAll('m')).toEqual([`cB:${one}`]);

      const conn = (await stateOf('cB')).json.conn;
      const posted = await postFrame('cB', conn);
      expect(posted.status).toBe(200);
      await waitFor(() => dataEvents(busy).length === 1, 'the surviving editor frame');
      expect(quiet.closed).toBe(true);
    } finally {
      clearInterval(pinging);
    }
  });

  test('a visible port that stops pinging is dropped after portTTL', async () => {
    worker.stop();
    worker = startWorker(fixture.origin, { portTTL: 200, hiddenPortTTL: 1000, sweep: 50 });
    const one = documentUrl('index.html');
    const two = documentUrl('second.html');
    const idle = worker.connect();
    idle.push({ v: 2, type: 'visible' });
    subscribe(idle, one, 'saved', 0);
    const kept = worker.connect();
    kept.push({ v: 2, type: 'visible' });
    subscribe(kept, two, 'saved', 0);
    await waitFor(() => isOpen(idle) && isOpen(kept), 'both visible ports to open');

    const pinging = setInterval(() => kept.push({ v: 2, type: 'ping' }), 50);
    try {
      await wait(120);
      expect(idle.closed).toBe(false);
      expect(kept.closed).toBe(false);
      await waitFor(() => idle.closed, 'the silent visible port to be swept', 2000);
      expect(kept.closed).toBe(false);
    } finally {
      clearInterval(pinging);
    }
  });

  test('the 257th snapshot entry is answered with capacity on its own port only', async () => {
    // The count cap is what this test is about, so the byte budget is out of its way.
    worker.stop();
    worker = startWorker(fixture.origin, {}, { maxQueryBytes: Infinity });
    const count = 256;
    const names = Array.from({ length: count }, (_, i) => `c${i}.html`);
    await Promise.all(names.map((name) => fs.writeFile(path.join(dir, name), DOC(0))));
    const ports = names.map((name, i) => {
      const port = worker.connect();
      port.push({ v: 2, type: 'visible' });
      subscribe(port, documentUrl(name), 'saved', 0);
      return port;
    });

    await waitFor(() => HttpEventSource.opened.length === 1, 'the stream with every entry');
    await waitFor(() => new URL(HttpEventSource.live()[0].url).searchParams.getAll('s').length === count, 'all 256 entries');
    await waitFor(() => isOpen(ports[0]), 'the first entry to open');

    const overflow = worker.connect();
    overflow.push({ v: 2, type: 'visible' });
    subscribe(overflow, documentUrl('overflow.html'), 'saved', 0);
    await settle();
    expect(overflow.sent).toEqual([
      { v: 2, type: 'hello', features: ['live-data', 'presence'] },
      { v: 2, type: 'capacity' },
    ]);
    expect(overflow.closed).toBe(false);

    // Nothing else moved: one connection, 256 entries, every port still bound.
    expect(HttpEventSource.opened.length).toBe(1);
    const url = new URL(HttpEventSource.live()[0].url);
    expect(url.searchParams.getAll('s')).toHaveLength(count);
    expect(url.searchParams.getAll('s')[0]).toBe(`saved:0:${documentUrl(names[0])}`);

    // A port that already holds a subscription and asks for one that would
    // overflow keeps the subscription it had.
    const before = ports[0].sent.length;
    subscribe(ports[0], documentUrl('overflow.html'), 'saved', 0);
    await settle();
    expect(ports[0].sent.slice(before)).toEqual([{ v: 2, type: 'capacity' }]);
    expect(framesOf(ports[0])).toHaveLength(0);
    liveSync.broadcast(liveKey(names[0]), { html: '<p>kept</p>', sender: 'server-save' }, { lane: 'saved' });
    await waitFor(() => framesOf(ports[0]).length === 1, 'the kept subscription frame');
    expect(framesOf(ports[0])[0].data).toContain('kept');
    expect(HttpEventSource.opened.length).toBe(1);
  });

  test('the 257th member is answered with capacity on its own port only', async () => {
    // The count cap is what this test is about, so the byte budget is out of its way.
    worker.stop();
    worker = startWorker(fixture.origin, {}, { maxQueryBytes: Infinity });
    // 256 members over 8 documents: eight entries keep the request line inside the
    // host's header limit, and each member is still a distinct member.
    const documents = 8;
    const perDocument = 32;
    const names = Array.from({ length: documents }, (_, i) => `m${i}.html`);
    await Promise.all(names.map((name) => fs.writeFile(path.join(dir, name), DOC(0))));
    const ports = [];
    for (let i = 0; i < documents * perDocument; i += 1) {
      const port = worker.connect();
      port.push({ v: 2, type: 'hidden' });
      subscribe(port, documentUrl(names[Math.floor(i / perDocument)]), 'live', 0, `c${i}`);
      ports.push(port);
    }

    await waitFor(() => HttpEventSource.opened.length >= 1, 'the stream');
    const first = new URL(HttpEventSource.opened[0].url);
    await waitFor(() => first.searchParams.getAll('m').length === documents * perDocument, 'all 256 members');
    expect(first.searchParams.getAll('s')).toHaveLength(documents);

    const overflow = worker.connect();
    overflow.push({ v: 2, type: 'hidden' });
    subscribe(overflow, documentUrl(names[0]), 'live', 0, 'cOverflow');
    await settle();
    // The port's own answer is the capacity message and nothing else. Status
    // notices are not part of that answer: every connected v2 port is told when
    // the shared connection is rebuilt, and the host tears a 256-member stream
    // down itself (its write budget fills long before a frame is served), so the
    // rebuilds this port sees belong to the host, not to the refusal.
    expect(overflow.sent.filter((message) => message.type !== 'status')).toEqual([
      { v: 2, type: 'hello', features: ['live-data', 'presence'] },
      { v: 2, type: 'capacity' },
    ]);
    expect(overflow.closed).toBe(false);
    expect(overflow.sent.some((message) => message.type === 'cursor' || message.type === 'event')).toBe(false);

    // No stream the worker built names the refused member, and the 256 it did
    // build are still there.
    for (const connection of HttpEventSource.opened) {
      expect(new URL(connection.url).searchParams.getAll('m')).not.toContain(`cOverflow:${documentUrl(names[0])}`);
    }
    expect(first.searchParams.getAll('m')).toHaveLength(documents * perDocument);
  });

  test('a page whose entry would push the URL past the budget gets capacity, and the others keep the stream', async () => {
    await fs.mkdir(path.join(dir, 'apps'), { recursive: true });
    const names = Array.from({ length: 40 }, (_, i) => `apps/${`long-document-name-${i}`.padEnd(130, 'x')}.html`);
    await Promise.all(names.map((name) => fs.writeFile(path.join(dir, name), DOC(0))));

    const admitted = [];
    let refused = null;
    let refusedName = null;
    for (const [i, name] of names.entries()) {
      const port = worker.connect();
      port.push({ v: 2, type: 'hidden' });
      subscribe(port, documentUrl(name), 'live', 0, `c${i}`);
      if (port.sent.some((message) => message.type === 'capacity')) {
        refused = port;
        refusedName = name;
        break;
      }
      admitted.push(port);
    }

    // The list is refused by its bytes, not by its count, and only after a lot of
    // documents: the budget is a realistic ceiling, not one entry.
    expect(refused).not.toBeNull();
    expect(admitted.length).toBeGreaterThanOrEqual(20);
    expect(refused.sent).toEqual([
      { v: 2, type: 'hello', features: ['live-data', 'presence'] },
      { v: 2, type: 'capacity' },
    ]);
    expect(refused.closed).toBe(false);
    expect(cursors(refused)).toHaveLength(0);

    await waitFor(() => admitted.every((port) => isOpen(port)), 'every admitted port to open');
    const last = new URL(HttpEventSource.opened.at(-1).url);
    expect(Buffer.byteLength(last.search.replace(/^\?/, ''))).toBeLessThanOrEqual(8192);
    for (const value of last.searchParams.values()) expect(value.includes(refusedName)).toBe(false);

    // A page leaving frees its entry, so the rebuild has room and the refused
    // document is admitted on its own port.
    const leaving = admitted.pop();
    leaving.push({ v: 2, type: 'unsubscribe' });
    const openedBefore = HttpEventSource.opened.length;
    await waitFor(() => HttpEventSource.opened.length === openedBefore + 1, 'the rebuild after the close');
    const retry = worker.connect();
    retry.push({ v: 2, type: 'hidden' });
    subscribe(retry, documentUrl(refusedName), 'live', 0, 'cRetry');
    await waitFor(() => isOpen(retry), 'the retried document to open');
    expect(retry.sent.some((message) => message.type === 'capacity')).toBe(false);

    // The stream the others kept still works: a room frame on the first document
    // reaches its own port.
    const conn = (await stateOf('c0', names[0])).json.conn;
    expect((await postFrame('c0', conn, { name: names[0] })).status).toBe(200);
    await waitFor(() => dataEvents(admitted[0]).length >= 1, 'the room frame at the first document');
  });

  test('a malformed subscribe is answered with gone on its own port and changes nothing else', async () => {
    const one = documentUrl('index.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(a), 'the good port to open');
    const opened = HttpEventSource.opened.length;
    const streamUrl = HttpEventSource.live()[0].url;
    const sentBefore = a.sent.length;

    const cases = [
      ['an empty document', { document: '', lane: 'saved', since: 0 }],
      ['a draft lane', { document: one, lane: 'draft', since: 0 }],
      ['a negative since', { document: one, lane: 'saved', since: -1 }],
      ['a fractional since', { document: one, lane: 'saved', since: 1.5 }],
      ['a live subscribe without a client id', { document: one, lane: 'live', since: 0 }],
      ['a live client id with a space', { document: one, lane: 'live', since: 0, clientId: 'c A' }],
      ['a 65 character client id', { document: one, lane: 'live', since: 0, clientId: 'c'.repeat(65) }],
      ['a saved subscribe with a client id', { document: one, lane: 'saved', since: 0, clientId: 'cA' }],
    ];
    for (const [what, message] of cases) {
      const bad = worker.connect();
      bad.push({ v: 2, type: 'subscribe', ...message });
      await settle();
      expect([what, bad.sent]).toEqual([what, [
        { v: 2, type: 'hello', features: ['live-data', 'presence'] },
        { v: 2, type: 'gone' },
      ]]);
      expect(bad.closed).toBe(false);
    }
    await settle();
    expect(HttpEventSource.opened.length).toBe(opened);
    expect(HttpEventSource.live()[0].url).toBe(streamUrl);
    expect(a.sent.length).toBe(sentBefore);

    // The same connection still delivers, so the silence above is a refusal and
    // not a stream that had stopped working.
    const conn = (await stateOf('cA')).json.conn;
    expect((await postFrame('cA', conn)).status).toBe(200);
    await waitFor(() => dataEvents(a).length === 1, 'the good port frame');
    expect(HttpEventSource.opened.length).toBe(opened);

    // A message of another version, or none at all, is ignored entirely: not even
    // a refusal comes back, and the port still subscribes afterwards.
    const ignored = worker.connect();
    ignored.push({ v: 1, type: 'subscribe', document: one, lane: 'live', since: 0, clientId: 'cV' });
    ignored.push({ type: 'subscribe', document: one, lane: 'live', since: 0, clientId: 'cV' });
    ignored.push({ v: 1, type: 'visible' });
    await settle();
    expect(ignored.sent).toEqual([{ v: 2, type: 'hello', features: ['live-data', 'presence'] }]);
    subscribe(ignored, documentUrl('second.html'), 'live', 0, 'cV');
    await waitFor(() => isOpen(ignored), 'the ignored port to subscribe on v2');
  });

  test('malformed member envelopes and a member index past the list deliver nothing', async () => {
    const one = documentUrl('index.html');
    const canonical = path.join(dir, 'index.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(a), 'the port to open');
    await waitFor(() => h.authority.connectedIds(canonical).length === 1, 'the member to register');

    const conn = (await stateOf('cA')).json.conn;
    const posted = await postFrame('cA', conn);
    expect(posted.status).toBe(200);
    await waitFor(() => dataEvents(a).length === 1, 'a real room event');

    const source = HttpEventSource.live()[0].source;
    const member = [...source.listeners.get('m0')][0];
    expect(typeof member).toBe('function');
    // The same listener delivers a well-formed envelope, so silence below is not
    // silence of the whole path.
    source._emit('m0', { type: 'm0', data: JSON.stringify({ event: 'data', data: { from: 'probe' } }), lastEventId: '' });
    expect(dataEvents(a).length).toBe(2);

    const sentBefore = a.sent.length;
    for (const data of [
      JSON.stringify({ event: 'unknown', data: { from: 'injected' } }),
      JSON.stringify({ event: 'data', data: [{ from: 'injected' }] }),
      JSON.stringify({ event: 'data', data: null }),
      JSON.stringify({ event: 'data', data: 'text' }),
      '{"event":"data","data":',
    ]) {
      source._emit('m0', { type: 'm0', data, lastEventId: '' });
    }
    source._emit('m5', { type: 'm5', data: JSON.stringify({ event: 'data', data: { from: 'stale' } }), lastEventId: '' });
    expect(source.listeners.has('m5')).toBe(false);
    await settle();
    expect(a.sent.length).toBe(sentBefore);
    expect(dataEvents(a).length).toBe(2);
    expect(a.sent.some((m) => m.data?.from === 'injected' || m.data?.from === 'stale')).toBe(false);
    expect(dataEvents(a)[0].data.from).toBe('cA');
  });

  test('a cursor without v2 sends unsupported to every port and closes the stream for good', async () => {
    const one = documentUrl('index.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    const b = worker.connect();
    b.push({ v: 2, type: 'visible' });
    subscribe(b, one, 'saved', 0);
    await waitFor(() => isOpen(a) && isOpen(b), 'both ports to open');

    const source = HttpEventSource.live()[0].source;
    const cursor = [...source.listeners.get('cursor')][0];
    // A v1 host answers a v2 request without the marker.
    cursor({ type: 'cursor', data: JSON.stringify({ sub: 0, seq: 5 }), lastEventId: '' });
    await settle();
    for (const port of [a, b]) {
      expect(port.sent.at(-1)).toEqual({ v: 2, type: 'unsupported' });
      expect(port.closed).toBe(true);
    }
    // Past the longest backoff and a few sweeps: no retry.
    await wait(400);
    expect(HttpEventSource.opened.length).toBe(1);
    expect(HttpEventSource.live()).toHaveLength(0);
  });

  test('an indexed not-found sends gone to that entry only and the stream keeps serving the rest', async () => {
    const one = documentUrl('index.html');
    const two = documentUrl('second.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    const b = worker.connect();
    b.push({ v: 2, type: 'visible' });
    subscribe(b, two, 'live', 0, 'cB');
    await waitFor(() => isOpen(a) && isOpen(b), 'both entries to open');
    expect(new URL(HttpEventSource.live()[0].url).searchParams.getAll('s')).toEqual([`live:0:${one}`, `live:0:${two}`]);

    const source = HttpEventSource.live()[0].source;
    const cursor = [...source.listeners.get('cursor')][0];
    cursor({ type: 'cursor', data: JSON.stringify({ v: 2, sub: 0, error: 'not-found' }), lastEventId: '' });
    await settle();
    expect(a.sent.at(-1)).toEqual({ v: 2, type: 'gone' });
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(b.sent.some((m) => m.type === 'gone')).toBe(false);

    await waitFor(() => HttpEventSource.opened.length === 2 && isOpen(b), 'the survivor to reopen');
    const rebuilt = new URL(HttpEventSource.live()[0].url);
    expect(rebuilt.searchParams.getAll('s')).toEqual([`live:${cursors(b).at(-1).seq}:${two}`]);
    expect(rebuilt.searchParams.getAll('m')).toEqual([`cB:${two}`]);

    const conn = (await stateOf('cB', 'second.html')).json.conn;
    const posted = await postFrame('cB', conn, { name: 'second.html' });
    expect(posted.status).toBe(200);
    await waitFor(() => dataEvents(b).length === 1, 'the surviving entry frame');
    expect(dataEvents(a)).toHaveLength(0);
  });

  test('a dropped connection reconnects once from each entry last position and opens every port', async () => {
    const one = documentUrl('index.html');
    const two = documentUrl('second.html');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(a), 'the live port to open');
    const seq = broadcastSnapshot('index.html', '<p>while open</p>');
    await waitFor(() => framesOf(a).length === 1, 'the live snapshot frame');

    const b = worker.connect();
    b.push({ v: 2, type: 'visible' });
    subscribe(b, two, 'saved', 0);
    await waitFor(() => isOpen(b) && openCount(a) === 2, 'the second entry to open');
    const opened = HttpEventSource.opened.length;
    const openings = openCount(a);
    const connectingBefore = statuses(a).filter((state) => state === 'connecting').length;

    HttpEventSource.live()[0].source.drop();
    await waitFor(
      () => statuses(a).filter((state) => state === 'connecting').length > connectingBefore,
      'the loss to be reported'
    );
    await waitFor(() => HttpEventSource.opened.length === opened + 1, 'one reconnect');
    await waitFor(() => openCount(a) === openings + 1 && openCount(b) === 2, 'every port to open again');
    await settle();
    expect(HttpEventSource.opened.length).toBe(opened + 1);
    expect(HttpEventSource.live()).toHaveLength(1);

    const rebuilt = new URL(HttpEventSource.live()[0].url);
    expect(rebuilt.searchParams.getAll('s')).toEqual([`live:${seq}:${one}`, `saved:${cursors(b).at(-1).seq}:${two}`]);
    expect(rebuilt.searchParams.getAll('m')).toEqual([`cA:${one}`]);
  });

  test('a room event missed while disconnected is repaired by the state read', async () => {
    const name = 'index.html';
    const one = documentUrl(name);
    const canonical = path.join(dir, name);
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    subscribe(a, one, 'live', 0, 'cA');
    await waitFor(() => isOpen(a), 'the port to open');
    await waitFor(() => h.authority.connectedIds(canonical).length === 1, 'the member to register');

    const first = (await stateOf('cA')).json;
    expect(typeof first.conn).toBe('string');
    const posted = await postFrame('cA', first.conn, { n: 1, ops: [ADD] });
    expect(posted.status).toBe(200);
    await waitFor(() => dataEvents(a).length === 1, 'the first operation');
    const applied = dataEvents(a)[0].data;
    expect(applied.seq).toBe(1);

    // A direct editor connection, the shape a browser tab opens, so the room can
    // take an operation while the worker's shared connection is down.
    const direct = new HttpEventSource(`${fixture.origin}/_/sync?document-url=${encodeURIComponent(one)}&lane=live&client-id=cB`);
    const directEvents = [];
    direct.addEventListener('cursor', (event) => directEvents.push(event));
    try {
      await waitFor(() => directEvents.length > 0, 'the direct connection cursor');
      await waitFor(() => h.authority.connectedIds(canonical).length === 2, 'the direct editor to register');

      const openings = openCount(a);
      const connectingBefore = statuses(a).filter((state) => state === 'connecting').length;
      HttpEventSource.live().find((connection) => connection.url.includes('v=2')).source.drop();
      await waitFor(
        () => statuses(a).filter((state) => state === 'connecting').length > connectingBefore,
        'the loss to be reported'
      );

      const directConn = (await stateOf('cB')).json.conn;
      expect(typeof directConn).toBe('string');
      const missed = await postFrame('cB', directConn, { n: 2, ops: [ADD] });
      expect(missed.status).toBe(200);
      expect(missed.json.seq).toBe(2);

      await waitFor(() => openCount(a) === openings + 1, 'the worker to open again');
      // The state read ClayJS makes after open, from the last frame this page
      // applied: the operation it never received is in the moves.
      const state = (await request(fixture.origin, {
        target: `/_/sync/data?client-id=cA&since=${encodeURIComponent(`${applied.epoch}:${applied.seq}`)}`,
        headers: { 'Document-URL': documentUrl(name), ...SAME_ORIGIN },
      })).json;
      expect(state.epoch).toBe(applied.epoch);
      expect(state.moves.store.some((entry) => entry.seq === 2)).toBe(true);
      expect(state.stores.store.value.count).toBe(2);
      expect(dataEvents(a).some((message) => message.data.seq === 2)).toBe(false);
    } finally {
      direct.close();
    }

    // A room sequence far above the snapshot position is not a snapshot position.
    const snapshotEntry = () => new URL(HttpEventSource.live()[0].url).searchParams.getAll('s')[0];
    const before = snapshotEntry();
    for (let i = 0; i < 300; i += 1) {
      h.authority.publish(canonical, 'data', { epoch: 'e1', seq: 900 + i, name: 'store', ops: [ADD], from: 'cA', n: i });
    }
    await waitFor(() => dataEvents(a).length >= 301, 'the whole room sequence');
    const opened = HttpEventSource.opened.length;
    const c = worker.connect();
    c.push({ v: 2, type: 'visible' });
    subscribe(c, documentUrl('third.html'), 'saved', 0);
    await waitFor(() => isOpen(c) && HttpEventSource.opened.length === opened + 1, 'the rebuild');
    expect(snapshotEntry()).toBe(before);
  });

  test.each(GOLDEN.ports)('replays the $role golden transcript against the real worker', async (port) => {
    const name = 'golden.html';
    await fs.writeFile(path.join(dir, name), DOC(0));
    const one = documentUrl(name);
    // The golden names a document of its own, with a position of its own (12).
    // This document has a different one, so the subscribe resumes from the frame
    // it really has, and the comparison is on shapes, never on values.
    const seq = broadcastSnapshot(name, '<p>saved</p>');
    const a = worker.connect();
    a.push({ v: 2, type: 'visible' });
    a.push({ ...port.subscribe, document: one, since: seq - 1 });
    await waitFor(() => isOpen(a), `the ${port.role} port to open`);

    if (port.subscribe.lane === 'live') {
      await waitFor(() => framesOf(a).length === 1, 'the resumed snapshot frame');
      const canonical = path.join(dir, name);
      // A state frame is built by the room, which the data lane's state read opens.
      expect((await stateOf(port.subscribe.clientId, name)).status).toBe(200);
      for (const message of port.receive.filter((entry) => entry.type === 'event')) {
        const before = eventsOf(a, message.event).length;
        if (message.event === 'data-state') h.authority.publishState(canonical);
        else h.authority.publish(canonical, message.event, message.data);
        await waitFor(() => eventsOf(a, message.event).length === before + 1, `the ${message.event} frame`);
      }
    }

    // The golden records the session in two halves: what the first connection
    // delivers, then a fresh connecting, cursor and open after a reconnect.
    const firstOpenAt = port.receive.findIndex((m) => m.type === 'status' && m.state === 'open');
    const reconnectAt = port.receive.findIndex(
      (m, i) => i > firstOpenAt && m.type === 'status' && m.state === 'connecting'
    );
    const firstHalf = reconnectAt < 0 ? port.receive : port.receive.slice(0, reconnectAt);
    const secondHalf = reconnectAt < 0 ? [] : port.receive.slice(reconnectAt);
    expect(projectionOf(a.sent)).toEqual(projectionOf(firstHalf));

    if (secondHalf.length > 0) {
      const seen = a.sent.length;
      const openings = openCount(a);
      const opened = HttpEventSource.opened.length;
      HttpEventSource.live()[0].source.drop();
      await waitFor(
        () => HttpEventSource.opened.length === opened + 1 && openCount(a) === openings + 1,
        'the reconnected port'
      );
      await settle();
      expect(HttpEventSource.opened.length).toBe(opened + 1);
      expect(projectionOf(a.sent.slice(seen))).toEqual(projectionOf(secondHalf));
    }

    // The subscribe a page re-sends after a reconnect. It produces a fresh
    // connecting, cursor and open -- the same resume shapes the golden records,
    // before (editor_A) or after (the saved viewer's own record) its reconnect.
    const resumeFrom = a.sent.length;
    const openedBeforeResume = HttpEventSource.opened.length;
    a.push({ ...port.reconnectSubscribe, document: one, since: seq });
    await waitFor(() => a.sent.length >= resumeFrom + 3 && statuses(a).at(-1) === 'open', 'the resume open');
    await settle();
    expect(HttpEventSource.opened.length).toBe(openedBeforeResume + 1);
    expect(projectionOf(a.sent.slice(resumeFrom))).toEqual(
      projectionOf(secondHalf.length > 0 ? secondHalf : port.receive.slice(1))
    );
  });
});
