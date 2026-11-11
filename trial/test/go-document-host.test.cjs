'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { realpathSync } = require('node:fs');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = process.env.HTMLCLAY_SOURCE;
const SKIP = SOURCE
  ? false
  : 'HTMLCLAY_SOURCE is unset: these tests build and drive the Go managed-trial binary from the htmlclay source tree';

const { createGoDocumentHost, adapterCounts } = require('../go-document-host.cjs');
const { setConnection, clearConnection } = require('../go-process.cjs');

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0x01]);

// The first line of a control stream: how a real cursor of this process is read
// without the adapter, which never forwards one.
function firstFrame(target, query) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${target.control}/v1/events${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${target.secret}` },
    }, (response) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        response.destroy();
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// A call to Go's control API, answering the parsed JSON of a 200.
function controlCall(target, method, pathname, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { authorization: `Bearer ${target.secret}` };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(`${target.control}${pathname}`, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(`${pathname} answered ${response.statusCode}: ${text}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Every frame of Go's control stream, in the order it arrives, until the
// returned function closes the stream.
function streamFrames(target, frames) {
  const req = http.request(`${target.control}/v1/events`, {
    method: 'GET',
    headers: { authorization: `Bearer ${target.secret}`, accept: 'application/x-ndjson' },
  }, (response) => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          // A line that is not a frame is not one of the frames counted.
        }
      }
    });
    response.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
  return () => req.destroy();
}

// A loopback port nothing listens on, so a connection to it is refused.
function closedPortUrl() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}

function liveStub() {
  return { markBrowserSave() {}, broadcast() {} };
}

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

test('the Go document host adapter', { skip: SKIP }, async (t) => {
  const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-go-host-')));
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

  const { startGo } = await import('../p1.mjs');
  const start = () => startGo({ bin, cwd: REPO, localSource: REPO, scratch: tmp, roots });
  let go = await start();

  function connect(target) {
    const served = {};
    for (const root of target.readyRoots) served[realpathSync(root.path)] = root.id;
    setConnection({ url: target.control, secret: target.secret, epoch: target.control, roots: served });
  }

  connect(go);

  const ctx = { root: { id: 'local-root-a', path: roots[0] } };
  const host = createGoDocumentHost({ ctx, live: liveStub(), emit() {}, logger: null });

  t.after(async () => {
    clearConnection();
    await go.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('a create commits and answers the in-process shape', async () => {
    const result = await host.commit({
      kind: 'create',
      name: 'index.html',
      filePath: path.join(roots[0], 'index.html'),
      bytes: document('one'),
      expected: { type: 'absent' },
      context: {},
    });
    assert.equal(result.outcome, 'committed');
    assert.equal(result.reason, null);
    assert.equal(typeof result.etag, 'string');
    assert.equal(typeof result.stored, 'string');
    assert.equal(typeof result.content, 'string');
    assert.equal(Object.hasOwn(result, 'error'), false);
  });

  await t.test('a browser-save with a matching and a stale expected checksum', async () => {
    const current = await host.read('index.html');
    assert.ok(Buffer.isBuffer(current.bytes));
    assert.equal(current.bytes.toString('utf8').includes('one'), true);
    assert.equal(typeof current.checksum, 'string');

    const saved = await host.commit({
      kind: 'browser-save',
      name: 'index.html',
      filePath: path.join(roots[0], 'index.html'),
      bytes: document('two'),
      expected: { type: 'checksum', value: current.checksum },
      context: {},
    });
    assert.equal(saved.outcome, 'committed');
    assert.equal(saved.content.includes('two'), true);

    const stale = await host.commit({
      kind: 'browser-save',
      name: 'index.html',
      filePath: path.join(roots[0], 'index.html'),
      bytes: document('three'),
      expected: { type: 'checksum', value: current.checksum },
    });
    assert.equal(stale.outcome, 'refused');
    assert.equal(stale.reason, 'changed');
    assert.equal(stale.stored, null);
    assert.equal(stale.content, null);
  });

  await t.test('an exact write of a PNG Buffer reads back byte-identical', async () => {
    const written = await host.commit({
      kind: 'sync-download',
      name: 'logo.png',
      filePath: path.join(roots[0], 'logo.png'),
      bytes: PNG,
      expected: { type: 'absent' },
      modifiedAt: Date.now(),
    });
    assert.equal(written.outcome, 'committed');
    assert.ok(Buffer.isBuffer(written.content));
    assert.deepEqual(written.content, PNG);

    const back = await host.read('logo.png');
    assert.ok(Buffer.isBuffer(back.bytes));
    assert.deepEqual(back.bytes, PNG);
    assert.deepEqual(fs.readFileSync(path.join(roots[0], 'logo.png')), PNG);
  });

  await t.test('a sync download stamps the server time, whether it comes as a string or a Date', async () => {
    const stamp = '2026-10-01T12:34:56.789Z';
    for (const [name, modifiedAt] of [['stamped-string.html', stamp], ['stamped-date.html', new Date(stamp)]]) {
      const written = await host.commit({
        kind: 'sync-download',
        name,
        filePath: path.join(roots[0], name),
        bytes: document(name),
        expected: { type: 'absent' },
        modifiedAt,
      });
      assert.equal(written.outcome, 'committed', `${name}: ${written.reason}`);
      assert.equal(fs.statSync(path.join(roots[0], name)).mtimeMs, Date.parse(stamp));
    }
  });

  await t.test('reading a missing file answers null', async () => {
    assert.equal(await host.read('not-here.html'), null);
  });

  await t.test('a read by path alone, as the sync engine makes it, reads the same file', async () => {
    const byName = await host.read('index.html');
    const byPath = await host.read(null, path.join(roots[0], 'index.html'));
    assert.ok(byPath, 'read(null, filePath) found nothing for a file that exists');
    assert.deepEqual(byPath.bytes, byName.bytes);
    assert.equal(byPath.checksum, byName.checksum);
    assert.equal(await host.read(null, path.join(roots[0], 'no-folder', 'x.html')), null);
    await assert.rejects(host.read(null, path.join(roots[1], 'index.html')), /does not serve/);
  });

  await t.test('a restructure moves a document', async () => {
    fs.writeFileSync(path.join(roots[0], 'move-me.html'), document('move'));
    const moved = await host.restructure({ kind: 'move', steps: [{ from: 'move-me.html', to: 'moved.html' }] });
    assert.equal(moved.outcome, 'committed');
    assert.equal(moved.completed, 1);
    assert.equal(moved.reason, null);
    assert.equal(fs.existsSync(path.join(roots[0], 'moved.html')), true);
    assert.equal(fs.existsSync(path.join(roots[0], 'move-me.html')), false);
  });

  await t.test('pageState writes and moves a sidecar', async () => {
    assert.equal(await host.pageState({ op: 'write', name: 'moved.html', record: { v: 1, rev: 'rev-1', tag: 'tag-1' } }), undefined);
    await host.pageState({ op: 'move', name: 'moved.html', to: 'moved-again.html' });
    await host.pageState({ op: 'drop', name: 'moved-again.html' });
  });

  await t.test('takeSnapshot answers a relay snapshot once, then null', async () => {
    const rel = 'relayed.html';
    const html = document('relayed');
    const relayed = await postRelay(go, rel, html);
    assert.equal(relayed.status, 200, `the relay answered ${relayed.status}: ${relayed.body}`);
    const taken = await host.takeSnapshot(rel);
    assert.equal(taken && taken.html, html);
    assert.equal(taken.userDriven, undefined, 'a relay alone names no provenance, so the upload reports ui-unknown');
    assert.equal(await host.takeSnapshot(rel), null);
  });

  await t.test('hooks and unknown kinds are refused before any request', async () => {
    const real = http.request;
    let requests = 0;
    http.request = function counted(...args) {
      requests += 1;
      return real.apply(this, args);
    };
    try {
      await assert.rejects(
        host.commit({ kind: 'browser-save', name: 'index.html', bytes: document('hooked'), hooks: { onWrite: () => {} } }),
        (error) => error instanceof TypeError && error.message === 'hooks ended in M16',
      );
      await assert.rejects(
        host.commit({ kind: 'not-a-kind', name: 'index.html', bytes: document('unknown') }),
        (error) => error instanceof TypeError && error.message === 'Unknown document write kind: not-a-kind',
      );
    } finally {
      http.request = real;
    }
    assert.equal(requests, 0);
  });

  await t.test('a checkpoint is refused by a Go host with no service attached', async () => {
    await assert.rejects(host.checkpoint({ name: 'index.html', filePath: 'x' }, { roomIdentity: 1 }, {}), (error) => {
      assert.equal(error.status, 404);
      return true;
    });
  });

  await t.test('an outside write reaches the stream as one change frame', async () => {
    const name = 'outside.html';
    fs.writeFileSync(path.join(roots[0], name), document('outside one'));
    await wait(1800);
    const frames = [];
    const unsubscribe = host.events(null, (frame) => frames.push(frame));
    try {
      fs.writeFileSync(path.join(roots[0], name), document('outside two'));
      const arrived = await until(() => frames.some((frame) => frame.type === 'change' && frame.rel === name));
      assert.equal(arrived, true, `no change frame for ${name}: ${JSON.stringify(frames)}`);
    } finally {
      unsubscribe();
    }
    const changes = frames.filter((frame) => frame.type === 'change' && frame.rel === name);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].event, 'change');
  });

  await t.test('a commit forwards no frame but raises adapterCounts', async () => {
    await wait(1800);
    const before = adapterCounts().kinds['browser-save'] ?? { adapter: 0, committed: 0 };
    const frames = [];
    const unsubscribe = host.events(null, (frame) => frames.push(frame));
    try {
      const result = await host.commit({
        kind: 'browser-save',
        name: 'counted.html',
        bytes: document('counted'),
        expected: { type: 'absent' },
      });
      assert.equal(result.outcome, 'committed');
      const counted = await until(() => (adapterCounts().kinds['browser-save']?.committed ?? 0) > before.committed);
      assert.equal(counted, true, `no commit frame was counted: ${JSON.stringify(adapterCounts())}`);
      assert.deepEqual(frames, []);
    } finally {
      unsubscribe();
    }
    const after = adapterCounts().kinds['browser-save'];
    assert.equal(after.adapter, before.adapter + 1);
    assert.equal(after.committed, before.committed + 1);
  });

  await t.test('two subscriptions on one root count a commit once', async () => {
    await wait(1800);
    const before = adapterCounts().kinds['browser-save'] ?? { adapter: 0, committed: 0 };
    const first = host.events(null, () => {});
    const second = host.events(null, () => {});
    try {
      await wait(300);
      const result = await host.commit({
        kind: 'browser-save',
        name: 'counted-once.html',
        bytes: document('counted once'),
        expected: { type: 'absent' },
      });
      assert.equal(result.outcome, 'committed');
      await until(() => (adapterCounts().kinds['browser-save']?.committed ?? 0) > before.committed);
      await wait(500);
    } finally {
      first();
      second();
    }
    assert.equal(adapterCounts().kinds['browser-save'].committed, before.committed + 1);
  });

  await t.test('a commit whose reply was lost asks Go what became of the op', async () => {
    const filePath = path.join(roots[0], 'notes.html');
    const created = await host.commit({
      kind: 'create',
      name: 'notes.html',
      filePath,
      bytes: document('notes-one'),
      expected: { type: 'absent' },
      context: {},
    });
    assert.equal(created.outcome, 'committed');
    const current = await host.read('notes.html');
    assert.equal(typeof current.checksum, 'string');

    const frames = [];
    const stop = streamFrames(go, frames);
    try {
      await wait(200);
      const armed = await controlCall(go, 'POST', '/v1/fault', { point: 'drop-reply', rel: 'notes.html' });
      assert.equal(armed.armed, 1);

      const saved = await host.commit({
        kind: 'browser-save',
        name: 'notes.html',
        filePath,
        bytes: document('notes-two'),
        expected: { type: 'checksum', value: current.checksum },
        context: {},
      });
      assert.equal(saved.outcome, 'committed');
      assert.equal(typeof saved.etag, 'string');
      assert.ok(saved.etag.length > 0, saved.etag);
      assert.match(fs.readFileSync(filePath, 'utf8'), /notes-two/);

      const counted = await until(() => frames.filter((frame) => frame.type === 'commit' && frame.rel === 'notes.html').length > 0);
      assert.equal(counted, true, 'no commit frame arrived');
      await wait(500);
      const commits = frames.filter((frame) => frame.type === 'commit' && frame.rel === 'notes.html');
      assert.equal(commits.length, 1, JSON.stringify(commits));

      const op = await controlCall(go, 'GET', `/v1/op/${commits[0].opId}`);
      assert.equal(op.state, 'committed');
      assert.equal(op.answer.outcome, 'committed');
      assert.equal(frames.filter((frame) => frame.type === 'commit' && frame.opId === commits[0].opId).length, 1);
    } finally {
      stop();
    }
  });

  await t.test('an op Go never received keeps the failure', async () => {
    const closed = await closedPortUrl();
    setConnection({ url: closed, secret: go.secret, roots: { [roots[0]]: 'root-0' } });
    const started = Date.now();
    try {
      await assert.rejects(host.commit({ kind: 'browser-save', name: 'unheard.html', bytes: document('unheard') }), (error) => {
        assert.equal(error.code, 'host-unreachable');
        assert.match(error.opId, /^[0-9a-f]{32}$/);
        return true;
      });
    } finally {
      connect(go);
    }
    assert.ok(Date.now() - started < 10000, `the failure took ${Date.now() - started}ms`);
  });

  await t.test('a restarted host makes the stream say gap first', async () => {
    const stale = await firstFrame(go, '?since=0000000000000000:1');
    assert.equal(stale.type, 'gap');
    assert.equal(typeof stale.cursor, 'string');
    await go.stop();
    go = await start();
    connect(go);
    const frames = [];
    const unsubscribe = host.events(stale.cursor, (frame) => frames.push(frame));
    try {
      const arrived = await until(() => frames.length > 0);
      assert.equal(arrived, true, 'the restarted host sent no frame');
    } finally {
      unsubscribe();
    }
    assert.equal(frames[0].type, 'gap');
    assert.match(String(frames[0].since), /^[0-9a-f]{16}:\d+$/);
  });

  await t.test('a feed that never got a cursor reports a gap when it reconnects to a restarted host', async () => {
    const frames = [];
    const unsubscribe = host.events(null, (frame) => frames.push(frame));
    try {
      await wait(500);
      assert.deepEqual(frames, []);
      await go.stop();
      go = await start();
      connect(go);
      const arrived = await until(() => frames.some((frame) => frame.type === 'gap'), { timeout: 20000 });
      assert.equal(arrived, true, `no gap after the restart: ${JSON.stringify(frames)}`);
    } finally {
      unsubscribe();
    }
    assert.equal(frames.filter((frame) => frame.type === 'gap').length, 1);
  });

  await t.test('a stopped host is host-unreachable with an opId', async () => {
    await go.stop();
    await assert.rejects(host.commit({ kind: 'browser-save', name: 'gone.html', bytes: document('gone') }), (error) => {
      assert.equal(error.code, 'host-unreachable');
      assert.match(error.opId, /^[0-9a-f]{32}$/);
      return true;
    });
  });

  await t.test('createRootDocumentHost returns this adapter under the go env flag', () => {
    const previous = process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
    process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = 'go';
    try {
      const { createRootDocumentHost } = require('../../src/main/document-host.js');
      const created = createRootDocumentHost({ ctx, live: liveStub() });
      assert.equal(created.isGoDocumentHost, true);
      assert.equal(typeof created.commit, 'function');
      assert.equal(typeof created.events, 'function');
    } finally {
      if (previous === undefined) delete process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
      else process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = previous;
    }
  });
});
