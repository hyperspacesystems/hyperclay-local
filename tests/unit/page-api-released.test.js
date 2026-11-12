// Managed trial M4a: a JS service mounts Local's own createApp with the Go
// adapter as its document host, and Go consults that same service while it holds
// the document's lock. The page API write therefore releases its own boundary
// before it hands the write to a host that says `documentHost.releasesBoundary`,
// carrying the checksum it rendered against and an opHandle under which the
// room's persistent hold is found. In process nothing about the write changes.
//
// The page engine is loaded by a dynamic `import()`, which jest's CJS vm cannot
// run, so each case drives the real server in a child process the way
// document-api-page.test.js and page-format-host.test.js do, and asserts on the
// JSON it prints.
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = `
'use strict';
const http = require('http');
const nodePath = require('path');
const fs = require('fs').promises;
const os = require('os');

const repo = process.cwd();
const scenario = process.env.SCENARIO;

// The real document host module, with its factory wrapped so a test can see what
// the in-process page API write hands its commit.
const hostPath = require.resolve(nodePath.join(repo, 'src/main/document-host.js'));
const actualHost = require(hostPath);
const inProcessRequests = [];
require.cache[hostPath].exports = {
  ...actualHost,
  createRootDocumentHost: (options) => {
    const host = actualHost.createRootDocumentHost(options);
    return {
      ...host,
      commit: (request) => {
        if (scenario === 'in-process') inProcessRequests.push({ opHandle: request.opHandle, expected: request.expected });
        return host.commit(request);
      },
    };
  },
};

const { createRooms } = require('@panphora/clayjs/server/rooms');
const { createApp } = require(nodePath.join(repo, 'src/main/server.js'));
const { createLocalAuthority } = require(nodePath.join(repo, 'src/main/local-authority'));
const { withDocumentWrite } = require(nodePath.join(repo, 'src/main/utils/write-queue'));
const { writeContexts } = require(nodePath.join(repo, 'src/main/write-contexts'));
const { calculateChecksum } = require(nodePath.join(repo, 'src/sync-engine/utils'));
const { pageFixture } = require(nodePath.join(repo, 'tests/helpers/page-fixture'));

const commits = [];
let script = null;

// Local's own host, built with the trial switch off for that one call.
function inProcessHost(options) {
  const saved = process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
  delete process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
  try {
    return actualHost.createRootDocumentHost({ ctx: options.ctx, live: options.live });
  } finally {
    if (saved === undefined) delete process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
    else process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = saved;
  }
}

function serviceHost(options) {
  const host = inProcessHost(options);
  return {
    ...host,
    releasesBoundary: true,
    commit: async (request) => {
      const context = writeContexts.get(request.opHandle);
      const boundary = await Promise.race([
        withDocumentWrite(async () => ({ canonicalPath: request.filePath }), async () => 'free'),
        new Promise((resolve) => setTimeout(() => resolve('held'), 200)),
      ]);
      commits.push({
        opHandle: request.opHandle,
        expected: request.expected,
        boundary,
        context: context ? {
          persistentToken: Boolean(context.persistentToken),
          canonicalPath: context.target && context.target.canonicalPath,
        } : null,
      });
      const answer = script ? await script(request) : null;
      return answer ?? host.commit({ ...request, context: {} });
    },
  };
}

if (scenario !== 'in-process') {
  process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = 'go';
  const adapterPath = require.resolve(nodePath.join(repo, 'trial/go-document-host.cjs'));
  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: {
      createGoDocumentHost: (options) => serviceHost(options),
      adapterCounts: () => ({ kinds: {} }),
      checkpointContext: () => null,
      configureService: () => {},
    },
  };
} else {
  delete process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
}

if (scenario === 'changed-twice') {
  let refusals = 2;
  script = async () => (refusals-- > 0 ? { outcome: 'refused', reason: 'changed' } : null);
}
if (scenario === 'changed-thrice') script = async () => ({ outcome: 'refused', reason: 'changed' });
if (scenario === 'host-refusal') {
  script = async () => ({
    outcome: 'refused',
    reason: 'peers-editing',
    refusal: { status: 409, code: 'peers-editing', body: { code: 'peers-editing' }, headers: { 'X-Test': '1' } },
  });
}

(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(nodePath.join(os.tmpdir(), 'blockeditor-api-released-')));
  const file = nodePath.join(dir, 'page.html');
  const fixture = pageFixture();
  await fs.writeFile(file, fixture.html);
  const authority = createLocalAuthority({ rooms: createRooms({}), withDocument: withDocumentWrite });
  const root = { id: 'blockeditor-api-released-root', kind: 'personal', path: dir, port: 0 };
  const server = http.createServer(createApp({ root, localAuthority: authority, devHooks: null, isKnownPath: null }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const target = authority.bindTarget({
      rootId: root.id, logicalPath: 'page.html', canonicalPath: file, origin, live: true,
    });
    await authority.roomFor(target, () => ({ canonicalPath: file, identity: target.identity }));

    const read = await fetch(origin + '/_/api/page.html');
    const etag = read.headers.get('etag');
    const revision = read.headers.get('blockeditor-revision');
    const before = await fs.readFile(file);
    const write = await fetch(origin + '/_/api/page.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Blockeditor-If-Match': revision },
      body: JSON.stringify({ body: 'new' }),
    });
    const body = await write.json().catch(() => null);
    const after = await fs.readFile(file);

    // The authority keys its rooms by the canonical form it hands back from the
    // binding, which is the same file this scenario named natively.
    const canonical = target.canonicalPath;
    const room = authority.rooms.get(canonical);
    let hold = 'free';
    try {
      const freed = authority.rooms.holdPersistent(canonical, { nodeId: room.nodeId });
      authority.rooms.releasePersistent(freed);
    } catch (error) {
      hold = error.code || error.message;
    }

    console.log(JSON.stringify({
      readStatus: read.status,
      revision,
      status: write.status,
      pageRevision: write.headers.get('blockeditor-revision'),
      retryAfter: write.headers.get('retry-after'),
      xTest: write.headers.get('x-test'),
      body,
      commits: commits.length,
      first: commits[0] || null,
      checksum: await calculateChecksum(before),
      unchanged: after.toString('utf8') === before.toString('utf8'),
      hold,
      contexts: writeContexts.size,
      inProcess: inProcessRequests[0] || null,
      inProcessCommits: inProcessRequests.length,
    }));
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
`;

function probe(scenario) {
  const output = execFileSync(process.execPath, ['-e', SCRIPT], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, SCENARIO: scenario, HYPERCLAY_LOCAL_DOCUMENT_HOST: '' },
  });
  return JSON.parse(output.trim().split('\n').pop());
}

describe('the page API write that releases its boundary', () => {
  test('the write releases its boundary and hands the host its checksum', () => {
    const result = probe('released');

    expect(result.readStatus).toBe(200);
    expect(result.status).toBe(200);
    expect(result.body.body).toBe('new');
    expect(result.pageRevision).toBeTruthy();

    expect(result.commits).toBe(1);
    expect(result.first.boundary).toBe('free');
    expect(result.first.opHandle).toMatch(/^[0-9a-f]{32}$/);
    expect(result.first.expected).toEqual({ type: 'checksum', value: result.checksum });
    expect(result.first.context.persistentToken).toBe(true);
    expect(result.first.context.canonicalPath).toBeTruthy();

    expect(result.contexts).toBe(0);
    expect(result.hold).toBe('free');
  });

  test('a document that changed twice is written again from its read', () => {
    const result = probe('changed-twice');

    expect(result.status).toBe(200);
    expect(result.body.body).toBe('new');
    expect(result.commits).toBe(3);
  });

  test('a document that changed three times answers retryable', () => {
    const result = probe('changed-thrice');

    expect(result.status).toBe(503);
    expect(result.retryAfter).toBe('1');
    expect(result.body).toEqual({ reason: 'changed', retryable: true });
    expect(result.commits).toBe(3);
    expect(result.unchanged).toBe(true);
  });

  test('a host refusal passes through with its status, body and headers', () => {
    const result = probe('host-refusal');

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ code: 'peers-editing' });
    expect(result.xTest).toBe('1');
  });

  test('in process the write takes no opHandle and no expected', () => {
    const result = probe('in-process');

    expect(result.status).toBe(200);
    expect(result.body.body).toBe('new');
    expect(result.inProcessCommits).toBe(1);
    expect(result.inProcess.opHandle).toBeUndefined();
    expect(result.inProcess.expected).toBeUndefined();
  });
});
