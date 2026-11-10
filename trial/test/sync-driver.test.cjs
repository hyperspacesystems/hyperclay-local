'use strict';

// E4b: the driver's own half, against a fake sync server on loopback. There is
// no hyperclay server on this machine, so discovery names no account and every
// session pauses before its first pass: what is proven here is that the manager
// boots under the Go host, that every read goes through Go, that a restart
// replaces the host, and that the driver writes nothing inside a served root.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const DRIVER = path.join(REPO, 'trial', 'sync-driver.cjs');
const GUARD = path.join(REPO, 'trial', 'fs-guard.cjs');
const UNDICI_PATH = require.resolve('undici');
const SOURCE = process.env.HTMLCLAY_SOURCE;
const SKIP = SOURCE
  ? false
  : 'HTMLCLAY_SOURCE is unset: these tests build and drive the Go managed-trial binary from the htmlclay source tree';

const SESSION = { id: 'p6-sync', rootId: 'p6-root-a', kind: 'personal', accountId: null, cached: { username: null } };
const ROOT_ID = 'p6-root-a';

const FILES = {
  'index.html': Buffer.from('<!doctype html>\n<html><body><h1>one</h1></body></html>\n'),
  'a b c.html': Buffer.from('<!doctype html>\n<html><body>spaces</body></html>\n'),
  'notes/résumé — ñ.html': Buffer.from('<!doctype html>\n<html><body>unicode</body></html>\n'),
  'sub/page.html': Buffer.from('<!doctype html>\n<html><body>nested</body></html>\n'),
  'binary.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe, 0x01, 0x02]),
  'data.json': Buffer.from('{"v":1}\n'),
};

function checksumOf(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function buildBinary(dir) {
  const bin = path.join(dir, 'managed-trial');
  const build = spawnSync('go', ['build', '-tags', 'managedtrial', '-o', bin, './cmd/managed-trial'], {
    cwd: SOURCE,
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
    timeout: 600000,
  });
  assert.equal(build.status, 0, `the managed-trial build failed:\n${build.stderr || build.stdout}`);
  return bin;
}

// The two calls `startEnabledSessions` makes before it syncs: discovery, and the
// clock calibration every init performs. No accounts means no pass at all.
function fakeSyncServer(seen) {
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/_/sync/accounts') {
      response.end(JSON.stringify({ success: true, features: {}, accounts: [] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/_/sync/status') {
      response.end(JSON.stringify({ serverTime: new Date().toISOString() }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function nextMessage(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`the driver sent nothing in ${timeoutMs}ms: ${child.stderrText}`));
    }, timeoutMs);
    const onMessage = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    child.once('message', onMessage);
  });
}

let callId = 0;

async function callDriver(child, cmd, args = {}) {
  const id = ++callId;
  const reply = nextMessage(child);
  child.send({ id, cmd, args });
  const message = await reply;
  if (message.id !== id) throw new Error(`unexpected reply ${JSON.stringify(message)}`);
  if (!message.ok) throw new Error(`${cmd} failed: ${message.error && message.error.message}`);
  return message.result;
}

function pidsIn(log) {
  return [...String(log).matchAll(/"pid":(\d+)/g)].map((match) => match[1]);
}

test('the sync driver runs the manager through the Go host', { skip: SKIP }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-sync-driver-')));
  const bin = buildBinary(tmp);
  const runDir = path.join(tmp, 'run');
  const rootA = path.join(tmp, 'root-a');
  const userData = path.join(runDir, 'userData');
  const guardOut = path.join(runDir, 'fs-guard.json');
  fs.mkdirSync(runDir, { recursive: true });
  for (const [rel, bytes] of Object.entries(FILES)) {
    const target = path.join(rootA, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  const seen = [];
  const { server, port } = await fakeSyncServer(seen);
  const child = fork(DRIVER, [], {
    execArgv: ['--require', GUARD],
    env: {
      ...process.env,
      APP_HOSTNAME: '127.0.0.1',
      APP_PORT: String(port),
      LOCAL_DIR: REPO,
      UNDICI_PATH,
      MANAGED_TRIAL_GO_BIN: bin,
      MANAGED_TRIAL_RUN: runDir,
      FS_GUARD_ROOTS: JSON.stringify([rootA]),
      FS_GUARD_OUT: guardOut,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderrText = '';
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  assert.deepEqual(await nextMessage(child), { ready: true });

  await t.test('start answers a snapshot with the session paused before its first pass', async () => {
    const snapshot = await callDriver(child, 'start', {
      userData,
      apiKey: 'test-key',
      roots: [{ id: ROOT_ID, path: rootA, kind: 'personal', name: 'root-a' }],
      sessions: [SESSION],
    });
    assert.equal(Array.isArray(snapshot.sessions), true);
    const [status] = snapshot.sessions;
    assert.equal(status.sessionId, SESSION.id);
    assert.equal(status.status, 'paused');
    assert.equal(typeof status.paused.reason, 'string');
    assert.equal(status.stats.filesDownloaded, 0);
    assert.equal(status.stats.filesUploaded, 0);
    // Discovery runs twice: launch asks for the account list, and a protocol 2
    // session with no account id asks again before it opens its stream.
    assert.deepEqual([...new Set(seen)].sort(), ['GET /_/sync/accounts', 'GET /_/sync/status']);
  });

  await t.test('checksums reads every file through the adapter', async () => {
    const checksums = await callDriver(child, 'checksums', { root: ROOT_ID });
    const expected = {};
    for (const [rel, bytes] of Object.entries(FILES)) expected[rel] = checksumOf(bytes);
    assert.deepEqual(checksums, expected);
  });

  await t.test('counts answers the adapter tally', async () => {
    const counts = await callDriver(child, 'counts');
    assert.equal(typeof counts.kinds, 'object');
  });

  await t.test('conflicts answers the engine record for the root', async () => {
    const conflicts = await callDriver(child, 'conflicts', { root: ROOT_ID });
    assert.deepEqual(conflicts, {});
  });

  await t.test('restart runs a new Go process on the same roots', async () => {
    const before = pidsIn(await callDriver(child, 'goLog'));
    assert.equal(before.length > 0, true, 'the driver logged no Go process');
    const snapshot = await callDriver(child, 'restart', { apiKey: 'test-key' });
    assert.equal(snapshot.sessions[0].status, 'paused');
    const after = pidsIn(await callDriver(child, 'goLog'));
    assert.equal(after.length > before.length, true, `no new pid: ${JSON.stringify({ before, after })}`);
    const checksums = await callDriver(child, 'checksums', { root: ROOT_ID });
    assert.equal(checksums['index.html'], checksumOf(FILES['index.html']));
  });

  await t.test('stop writes the adapter counts', async () => {
    await callDriver(child, 'stop');
    const file = path.join(runDir, 'adapter-counts.json');
    assert.equal(fs.existsSync(file), true, 'the driver wrote no adapter-counts.json');
    const counts = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(typeof counts.kinds, 'object');
  });

  await t.test('the driver wrote nothing inside a served root', async () => {
    // The guard writes its report as the driver exits, so the driver has to be
    // gone before the report is read.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.disconnect();
    await exited;
    assert.equal(fs.existsSync(guardOut), true, `the fs-guard wrote no report: ${child.stderrText}`);
    const report = JSON.parse(fs.readFileSync(guardOut, 'utf8'));
    assert.deepEqual(report.forbidden, []);
    assert.equal(report.counts.forbidden, 0);
  });
});
