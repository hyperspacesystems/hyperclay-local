'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { realpathSync } = require('node:fs');

const { createGoDocumentHost, checkpointContext } = require('../go-document-host.cjs');
const { setConnection, getConnection, clearConnection } = require('../go-process.cjs');

const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-checkpoint-')));
const SECRET = 'f'.repeat(64);

const open = new Set();

test.afterEach(async () => {
  clearConnection();
  for (const control of open) await control.close();
  open.clear();
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A stand-in for the Go host's control server: it records each request's
// method, path, headers and JSON body, and answers from the test's function.
async function fakeControl(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const record = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: raw.length ? JSON.parse(raw.toString('utf8')) : null,
      };
      requests.push(record);
      const reply = answer(record);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(Buffer.from(JSON.stringify(reply.json), 'utf8'));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const control = {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  open.add(control);
  return control;
}

function connect(control) {
  setConnection({ url: control.url, secret: SECRET, roots: { [tmp]: 'root-0' } });
}

function host({ checkpointClaim = null } = {}) {
  return createGoDocumentHost({ ctx: { root: { id: 'local-root-0', path: tmp } }, checkpointClaim });
}

const CALL = [
  { name: 'a.html', filePath: '/x/a.html' },
  { roomIdentity: 7, generation: null },
];

test('the checkpoint context is there while Go holds the lock', async () => {
  const target = { rootId: 'root-0', logicalPath: 'a.html', identity: 'room-7' };
  const room = { key: '/x/a.html', nodeId: 'n1', seq: 4 };
  const seen = [];
  const claimed = [];
  const control = await fakeControl((record) => {
    seen.push(checkpointContext(record.body.opId));
    return { json: { kind: 'ok', revision: 3, written: { encoding: 'utf8', data: '<p>w</p>' } } };
  });
  connect(control);
  const host_ = host({
    checkpointClaim(arg) {
      claimed.push(arg);
      return { claim: 1 };
    },
  });

  const answer = await host_.checkpoint(...CALL, { target, room });
  assert.deepEqual(answer, { kind: 'ok', revision: 3, written: '<p>w</p>' });

  assert.equal(control.requests.length, 1);
  const sent = control.requests[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/v1/checkpoint');
  assert.match(sent.body.opId, /^[0-9a-f]{32}$/);
  assert.deepEqual(sent.body, {
    opId: sent.body.opId,
    root: 'root-0',
    name: 'a.html',
    roomIdentity: '7',
    generation: null,
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, target);
  assert.equal(seen[0].room, room);
  assert.deepEqual(seen[0].claim, { claim: 1 });
  assert.equal(seen[0].filePath, '/x/a.html');
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0], target);

  assert.equal(checkpointContext(sent.body.opId), null);
});

test('an indeterminate answer throws and the context is gone', async () => {
  const target = { rootId: 'root-0', logicalPath: 'a.html', identity: 'room-7' };
  const room = { key: '/x/a.html', nodeId: 'n1', seq: 4 };
  let opId = null;
  const control = await fakeControl((record) => {
    opId = record.body.opId;
    return { json: { kind: 'indeterminate', reason: 'dir-sync' } };
  });
  connect(control);

  await assert.rejects(host().checkpoint(...CALL, { target, room }), (error) => {
    assert.equal(error.indeterminate, true);
    assert.equal(error.code, 'dir-sync');
    return true;
  });
  assert.equal(checkpointContext(opId), null);
});

test('other answers pass through', async () => {
  const target = { rootId: 'root-0', logicalPath: 'a.html', identity: 'room-7' };
  const room = { key: '/x/a.html', nodeId: 'n1', seq: 4 };
  let reply = { kind: 'refused', reason: 'invalid-identity' };
  const control = await fakeControl(() => ({ json: reply }));
  connect(control);

  assert.deepEqual(await host().checkpoint(...CALL, { target, room }), {
    kind: 'refused',
    reason: 'invalid-identity',
  });

  reply = { kind: 'clean' };
  assert.deepEqual(await host().checkpoint(...CALL, { target, room }), { kind: 'clean' });
});

test('epoch headers are sent only by a connection that names both epochs', async () => {
  const target = { rootId: 'root-0', logicalPath: 'a.html', identity: 'room-7' };
  const room = { key: '/x/a.html', nodeId: 'n1', seq: 4 };
  const control = await fakeControl((record) => (
    record.path.startsWith('/v1/read')
      ? { json: { exists: false, checksum: null, bytes: null } }
      : { json: { kind: 'clean' } }
  ));

  connect(control);
  const bare = host();
  await bare.checkpoint(...CALL, { target, room });
  await bare.read('a.html');
  assert.equal(control.requests.length, 2);
  for (const record of control.requests) {
    assert.equal(record.headers['x-trial-epoch'], undefined);
    assert.equal(record.headers['x-trial-peer-epoch'], undefined);
  }

  clearConnection();
  connect(control);
  Object.assign(getConnection(), { epoch: 'aaaaaaaaaaaaaaaa', peerEpoch: 'bbbbbbbbbbbbbbbb' });
  const signed = host();
  await signed.checkpoint(...CALL, { target, room });
  await signed.read('a.html');
  assert.equal(control.requests.length, 4);
  for (const record of control.requests.slice(2)) {
    assert.equal(record.headers['x-trial-epoch'], 'aaaaaaaaaaaaaaaa');
    assert.equal(record.headers['x-trial-peer-epoch'], 'bbbbbbbbbbbbbbbb');
  }
  assert.equal(control.requests[2].path, '/v1/checkpoint');
  assert.equal(control.requests[3].path.startsWith('/v1/read'), true);
});

test('a transport failure is host-unreachable and the context is gone', async () => {
  const target = { rootId: 'root-0', logicalPath: 'a.html', identity: 'room-7' };
  const room = { key: '/x/a.html', nodeId: 'n1', seq: 4 };
  const control = await fakeControl(() => ({ json: { kind: 'clean' } }));
  connect(control);
  await control.close();

  let opId = null;
  await assert.rejects(host().checkpoint(...CALL, { target, room }), (error) => {
    assert.equal(error.code, 'host-unreachable');
    opId = error.opId;
    return true;
  });
  assert.match(opId, /^[0-9a-f]{32}$/);
  assert.equal(checkpointContext(opId), null);
});
