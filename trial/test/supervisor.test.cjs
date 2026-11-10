'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { realpathSync } = require('node:fs');

const {
  REPO, SKIP, document, request, save, buildTrialBinary, makeRoots,
} = require('./service-harness.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gone = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode });
    return;
  }
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

function within(promise, ms, what) {
  return Promise.race([
    promise,
    wait(ms).then(() => { throw new Error(`${what} did not happen within ${ms}ms`); }),
  ]);
}

test('the supervisor runs the service and Go as two processes, and they answer together', { skip: SKIP }, async (t) => {
  const { startManaged } = await import('../supervisor.mjs');
  const { STOP_GRACE_MS } = await import('../../scripts/conformance.mjs');

  const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-supervisor-')));
  const bin = buildTrialBinary(tmp);
  const roots = makeRoots(tmp);
  const scratch = path.join(tmp, 'logs');
  fs.mkdirSync(scratch, { recursive: true });

  const session = await startManaged({ bin, cwd: REPO, scratch, roots });

  t.after(async () => {
    if (session.child.exitCode === null && session.child.signalCode === null) await session.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('the handshake leaves two processes, each on its own loopback URL', () => {
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+$/, session.url);
    assert.match(session.service.url, /^http:\/\/127\.0\.0\.1:\d+$/, session.service.url);
    assert.notEqual(session.url, session.service.url);
    assert.equal(session.child.exitCode, null);
    assert.equal(session.child.signalCode, null);
    assert.equal(session.service.child.exitCode, null);
    assert.equal(session.service.child.signalCode, null);
  });

  await t.test('a save through Go is admitted by the service process', async () => {
    const answer = await save(session.url, 'notes.html', document('<p>m10</p>'));
    assert.equal(answer.status, 200, answer.body);

    const file = path.join(roots[0], 'notes.html');
    assert.ok(fs.existsSync(file), file);
    assert.match(fs.readFileSync(file, 'utf8'), /<p>m10<\/p>/);

    const meta = await request(`${session.url}/_/meta`);
    assert.equal(meta.status, 200, meta.body);
    const extensions = JSON.parse(meta.body).extensions;
    assert.ok(extensions.includes('presence'), JSON.stringify(extensions));
    assert.ok(extensions.includes('live-data'), JSON.stringify(extensions));

    const serviceLog = fs.readFileSync(session.service.logPath, 'utf8');
    assert.doesNotMatch(serviceLog, /\[trial-service\]/, serviceLog);
  });

  await t.test('stop flushes the checkpoint and then ends both children', async () => {
    const serviceExit = gone(session.service.child);
    const goExit = gone(session.child);

    await session.stop();

    assert.deepEqual(session.flushed, { unsaved: [], timedOut: false });

    const [service, go] = await within(Promise.all([serviceExit, goExit]), 3 * STOP_GRACE_MS, 'both children exiting');
    for (const [name, exit] of [['service', service], ['go', go]]) {
      assert.ok(
        exit.code === 0 || ['SIGTERM', 'SIGKILL'].includes(exit.signal),
        `${name} exited ${exit.signal ?? `with code ${exit.code}`}`,
      );
    }
  });

  await t.test('ending only the service’s stdin shuts the service down on its own', async () => {
    fs.mkdirSync(path.join(tmp, 'second'), { recursive: true });
    const second = await startManaged({
      bin, cwd: REPO, scratch: path.join(tmp, 'second'), roots,
    });
    try {
      const exited = gone(second.service.child);
      second.service.child.stdin.end();
      const service = await within(exited, 3 * STOP_GRACE_MS, 'the service exiting on EOF');
      assert.equal(service.code, 0, `the service exited ${service.signal ?? `with code ${service.code}`}`);
      assert.equal(second.child.exitCode, null);
    } finally {
      await second.stop();
    }
  });
});
