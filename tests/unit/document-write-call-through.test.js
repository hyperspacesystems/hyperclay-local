// The runtime half of the document-write proof, beside the static scan in
// document-writers.test.js: the scan cannot tell a call that writes the wrong
// path from one that writes the right path, and a trace cannot see a writer no
// test exercises. Every action below is real — a real HTTP route, a real sync
// engine, a real workspace command, a real observer, a real checkpoint — run
// against a real document host whose publishing methods are watched while every
// mutating call on require('fs').promises is recorded. An action passes only
// when every document path it touched is a path a host call named, when the
// expected host call happened, and when the bytes on disk are the bytes that
// call said it stored.
const recorder = require('../helpers/document-write-recorder');

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getName: () => 'HyperclayLocal' },
  shell: { showItemInFolder: jest.fn(), openPath: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value) => value },
}));

jest.mock('livesync-hyperclay', () => ({
  liveSync: {
    subscribe: jest.fn(), unsubscribe: jest.fn(), configure: jest.fn(), onFrame: jest.fn(),
    markBrowserSave: jest.fn(), wasBrowserSave: jest.fn(() => false), notify: jest.fn(),
    broadcast: jest.fn(), subscribeUser: jest.fn(), unsubscribeUser: jest.fn(),
    broadcastFileSaved: jest.fn(), broadcastToUser: jest.fn(),
  },
}));

jest.mock('../../src/sync-engine/api-client', () => ({
  ...jest.requireActual('../../src/sync-engine/api-client'),
  listNodes: jest.fn(), getNodeContent: jest.fn(), putNodeContent: jest.fn(),
  createNode: jest.fn(), renameNode: jest.fn(), moveNode: jest.fn(), deleteNode: jest.fn(),
}));

jest.mock('../../src/main/utils/derived-artifacts', () => ({
  refreshDerivedArtifacts: jest.fn(async () => {}),
}));

// The extractor loads its write path through a dynamic import, which jest's vm
// cannot run. What it splices is not what this test is about: the route, the
// document boundary and the commit below it are all real.
jest.mock('../../src/main/utils/data-extractor', () => {
  const cheerio = require('cheerio');
  // The rules the fixture's tag declares: the heading is `title`, the list is
  // `items`.
  const read = (html) => {
    const $ = cheerio.load(html);
    return {
      title: $('h1').first().text(),
      items: $('.item').map((index, node) => $(node).text()).get(),
    };
  };
  return {
    ...jest.requireActual('../../src/main/utils/data-extractor'),
    writeViaTag: jest.fn(async (html, data) => {
      const $ = cheerio.load(html);
      $('h1').first().text(String((data && data.title) ?? ''));
      const items = Array.isArray(data && data.items) ? data.items : [];
      $('#list').empty();
      for (const item of items) $('<li class="item"></li>').text(String(item)).appendTo($('#list'));
      return { html: $.html(), changed: true, spliced: true };
    }),
    extractViaTag: jest.fn(async (html) => read(html)),
  };
});

// Every host any module builds is the real one; only its publishing methods are
// watched, and only to record what it was asked to do.
jest.mock('../../src/main/document-host', () => {
  const actual = jest.requireActual('../../src/main/document-host');
  const record = require('../helpers/document-write-recorder');
  return {
    ...actual,
    createDocumentHost: (deps) => record.spy(actual.createDocumentHost(deps)),
    createRootDocumentHost: (options) => record.spy(actual.createRootDocumentHost(options)),
  };
});

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const request = require('supertest');

const { createApp } = require('../../src/main/server.js');
const { RootObserver } = require('../../src/main/root-observer');
const { createRootDocumentHost } = require('../../src/main/document-host');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { createLocalCheckpoint } = require('../../src/main/local-checkpoint');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');
const { createRootLive } = require('../../src/main/utils/root-live');
const { executeCommand } = require('../../src/main/workspace/commands');
const { createAutoNamer } = require('../../src/main/workspace/auto-name');
const { storePageState, pageStatePath, writePageState, readPageState } = require('../../src/main/page-state-store');
const { createBackup } = require('../../src/main/utils/backup');
const { splitPage } = require('@panphora/clayjs/server/rooms');
const { calculateChecksum } = require('../../src/sync-engine/utils');
const { pageFixture } = require('../helpers/page-fixture');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');
const { SyncEngine } = require('../../src/sync-engine/index');
const api = require('../../src/sync-engine/api-client');
const conflicts = require('../../src/sync-engine/reconcile/conflicts');
const { executeDecision, resolveConflict } = require('../../src/sync-engine/reconcile/execute');
const { A } = require('../../src/sync-engine/reconcile/decide');

const DOC = '<!DOCTYPE html><html lang="en"><body><p>one</p></body></html>';
const DOC_TWO = '<!DOCTYPE html><html lang="en"><body><p>two</p></body></html>';
const LOCAL_BYTES = '<h1>mine</h1>';
const REMOTE_BYTES = '<h1>theirs</h1>';
const ETAG = 'aaaa1111bbbb2222';

// A document with an api-rules tag, so the data API and the data-loss guard both
// have something to read and write.
function page({ title = 'Title', items = ['a', 'b', 'c'] } = {}) {
  const lis = items.map((text) => `<li class="item">${text}</li>`).join('');
  return `<!DOCTYPE html><html><head>
<script type="application/json" data-rules-name="api" data-rules-version="1">
{ "title": "h1", "items": ".item[]" }
</script></head><body>
<h1>${title}</h1>
<ul id="list">${lis}</ul>
</body></html>`;
}

jest.setTimeout(120000);

const roots = [];
const servers = [];
const observers = [];

async function makeRoot(prefix = 'doc-write-') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function serve(dir) {
  const root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };
  const server = await listenLoopback(createApp({ root, live: createRootLive(root), devHooks: null, isKnownPath: null }));
  servers.push(server);
  return server;
}

const save = (server, rel, html) => request(server)
  .post('/save')
  .set('Page-URL', `http://localhost:4321/${rel}`)
  .set('Content-Type', 'text/plain')
  .send(html);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  recorder.stop();
  for (const observer of observers.splice(0)) await observer.stop().catch(() => {});
  await closeLoopback();
  servers.length = 0;
  jest.restoreAllMocks();
  while (roots.length) await fs.rm(roots.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

// The two assertions every action shares: nothing wrote a document outside the
// paths a host call named, and every document still holds the bytes its host
// call said it stored.
function expectOnlyHostWrites() {
  expect(recorder.violations()).toEqual([]);
  expect(recorder.finalByteMismatches()).toEqual([]);
}

function expectHostCall(method, match = () => true) {
  const calls = recorder.callsTo(method).filter(match);
  expect(calls.map((call) => `${method}:${call.request?.kind ?? ''}`)).not.toEqual([]);
  return calls;
}

// A tree the workspace commands report into; the documents are on disk, which is
// what this test reads.
const tree = () => ({ scan: async () => {}, moved: () => {} });
const noop = () => {};

function engineFor({ dir, authority = null, generation = 1 }) {
  const engine = new SyncEngine();
  engine.syncFolder = dir;
  engine.rootId = 'root-a';
  engine.metaDir = path.join(dir, '.hyperclay', 'test-meta');
  engine.serverUrl = 'http://localhost:5';
  engine.apiKey = 'hcsk_test';
  engine.accountId = 42;
  engine.protocol = 2;
  engine.generation = generation;
  engine.localAuthority = authority;
  engine.live = { markBrowserSave: noop, broadcast: noop, notify: noop };
  engine.snapshots = { take: () => null };
  engine.resolveContainedPath = require('../../src/main/utils/path-resolver').validateSegments;
  return engine;
}

// A local file and a parked remote copy, with the conflict record that says the
// two diverged: the state resolveConflict reads.
async function seedConflict(dir) {
  const engine = engineFor({ dir });
  const localChecksum = await calculateChecksum(LOCAL_BYTES);
  await fs.writeFile(path.join(dir, 'page.html'), LOCAL_BYTES);
  engine.serverNodesCache = [];
  engine.repo.seed([['901', {
    type: 'site', path: 'page.html', inode: 11, remoteEtag: ETAG, localChecksum,
    structureVersion: 'st1', checksum: localChecksum, syncedAt: 1,
  }]]);
  await conflicts.set(engine.metaDir, {
    kind: conflicts.KINDS.BOTH_EDITED, path: 'page.html', localChecksum, remoteEtag: ETAG,
    remoteCopy: conflicts.remoteCopyRef('page.html', ETAG), detectedAt: Date.now(), nodeId: 901,
  });
  const parked = conflicts.remoteCopyPath(dir, 'page.html', ETAG);
  await fs.mkdir(path.dirname(parked), { recursive: true });
  await fs.writeFile(parked, REMOTE_BYTES);
  api.createNode.mockResolvedValue({ id: 903, type: 'site', name: 'page (conflicted copy).html', parentId: 0, etag: ETAG, structureVersion: 'st3' });
  return engine;
}

describe('every commit kind reaches the document host', () => {
  it('a browser save through /save commits the document', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    await fs.writeFile(file, DOC);
    const server = await serve(dir);

    recorder.begin(dir);
    const res = await save(server, 'page.html', DOC_TWO);

    expect(res.status).toBe(200);
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'browser-save');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('a data API write through /_/api commits the document', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'app.html');
    await fs.writeFile(file, page());
    const server = await serve(dir);

    recorder.begin(dir);
    const res = await request(server)
      .post('/_/api/app.html')
      .set('Document-URL', 'http://localhost:4321/app.html')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ title: 'Changed' }));

    expect(res.status).toBe(200);
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'data-api');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('a version restore through /_/restore commits the document', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    await fs.writeFile(file, DOC);
    const server = await serve(dir);
    // The first save versions the bytes already on disk, which is the version
    // this restore puts back.
    expect((await save(server, 'page.html', DOC_TWO)).status).toBe(200);
    const versions = await fs.readdir(path.join(dir, '.hyperclay', 'versions', 'page'));
    const versionName = versions.find((name) => name.endsWith('.html'));
    expect(versionName).toBeTruthy();

    recorder.begin(dir);
    const res = await request(server).post(`/_/restore/page.html/${versionName}`);

    expect(res.status).toBe(200);
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'restore');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('the guard resolves an event through /_/data-loss and commits the document', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'app.html');
    const clobbered = page({ title: '', items: ['a'] });
    const whole = page({ title: 'Title', items: ['a', 'b', 'c'] });
    await fs.writeFile(file, clobbered);
    // The event the guard raised on an earlier write, in the real guard store. Its
    // Revert is the guard's whole-file restore: the merge onto the live page needs
    // the platform engine's dynamic import, which jest's vm cannot run, so the
    // choice resolved here is the one that reads a backup and writes it back
    // through the same `writeBack` and the same `guard-restore` commit.
    const guardDir = path.join(dir, '.hyperclay', 'guard');
    const backup = path.join(guardDir, 'app.recover.html');
    await fs.mkdir(guardDir, { recursive: true });
    await fs.writeFile(backup, whole);
    await fs.writeFile(path.join(guardDir, 'app.json'), JSON.stringify({
      baseline: { data: { api: { title: 'Title', items: ['a', 'b', 'c'] } }, hash: 'x', at: 1 },
      uiWorkPending: false,
      status: 'pending',
      event: {
        id: 'evt-1', status: 'pending', detectedAt: 1, firstDetectedAt: 1, lastWriteAt: 1,
        recoverableData: { api: { title: 'Title', items: ['a', 'b', 'c'] } },
        recoverableHtmlBackup: backup,
      },
    }));
    const server = await serve(dir);

    recorder.begin(dir);
    const res = await request(server)
      .post('/_/data-loss')
      .set('Document-URL', 'http://localhost:4321/app.html')
      .send({ id: 'evt-1', choice: 'revert' });

    expect(res.status).toBe(200);
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'guard-restore');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('creating a document from a template commits it', async () => {
    const dir = await makeRoot();
    const root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };

    recorder.begin(dir);
    const result = await executeCommand({
      root, request: { command: 'create', template: 'blank', name: 'new.html', parent: '' },
      tree: tree(), moved: noop, changed: noop,
    });

    expect(result.path).toBe('new.html');
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'create');
    expect(recorder.namedPathsOf(call)).toEqual([path.join(dir, 'new.html')]);
    expectOnlyHostWrites();
  });

  it('a sync download through executeDecision commits the document', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    const engine = engineFor({ dir });
    const localChecksum = await calculateChecksum(LOCAL_BYTES);
    await fs.writeFile(file, LOCAL_BYTES);
    engine.repo.seed([['901', {
      type: 'site', path: 'page.html', inode: 11, remoteEtag: ETAG, localChecksum,
      structureVersion: 'st1', checksum: localChecksum, syncedAt: 1,
    }]]);
    api.getNodeContent.mockResolvedValue({
      content: REMOTE_BYTES, nodeType: 'site', modifiedAt: '2026-09-23T12:00:00.000Z',
      checksum: 'cccc', etag: ETAG, structureVersion: 'st2',
    });

    recorder.begin(dir);
    const result = await executeDecision(engine, '901', { action: A.DOWNLOAD });

    expect(result.action).toBe(A.DOWNLOAD);
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'sync-download');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('keep both writes the conflict copy through commit', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    const engine = await seedConflict(dir);
    const copy = path.join(dir, 'page (conflicted copy).html');

    recorder.begin(dir);
    const result = await resolveConflict(engine, { path: 'page.html', choice: 'both' });

    expect(result).toEqual({ ok: true, copy: 'page (conflicted copy).html' });
    const named = expectHostCall('commit', (c) => c.request.kind === 'sync-download').map((c) => recorder.namedPathsOf(c)[0]);
    expect(named).toEqual(expect.arrayContaining([file, copy]));
    expectOnlyHostWrites();
  });

  it('theirs writes the remote bytes through commit', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    const engine = await seedConflict(dir);

    recorder.begin(dir);
    const result = await resolveConflict(engine, { path: 'page.html', choice: 'theirs' });

    expect(result).toEqual({ ok: true });
    const [call] = expectHostCall('commit', (c) => c.request.kind === 'sync-download');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expect(await fs.readFile(file, 'utf8')).toBe(REMOTE_BYTES);
    expectOnlyHostWrites();
  });

  it('an SSE save applies the remote content through commit', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    const engine = engineFor({ dir });
    await fs.writeFile(file, DOC);
    await engine.repo.set(901, { type: 'site', path: 'page.html', syncedAt: 1 });

    recorder.begin(dir);
    await engine.handleNodeSaved({
      nodeType: 'site', nodeId: 901, path: 'page.html', content: DOC_TWO,
      modifiedAt: '2026-09-23T12:00:00.000Z', checksum: 'ffff',
    });

    const [call] = expectHostCall('commit', (c) => c.request.kind === 'sync-download');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('downloadFile writes the fetched document through commit', async () => {
    const dir = await makeRoot();
    const file = path.join(dir, 'page.html');
    const engine = engineFor({ dir });
    await fs.writeFile(file, DOC);
    await engine.repo.set(901, { type: 'site', path: 'page.html', syncedAt: 1 });
    api.getNodeContent.mockResolvedValue({ content: DOC_TWO, modifiedAt: '2026-09-23T12:00:00.000Z', checksum: 'dddd' });

    recorder.begin(dir);
    await engine.downloadFile(901, 'page.html');

    const [call] = expectHostCall('commit', (c) => c.request.kind === 'sync-download');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('an external rebase through the observer commits the merged document', async () => {
    const dir = await makeRoot('doc-write-rebase-');
    const file = path.join(dir, 'A.html');
    const older = pageFixture('abc');
    const stored = pageFixture('xyz');
    await fs.writeFile(file, await storePageState(dir, 'A.html', older.html));
    await createBackup(dir, 'A', splitPage(older.html).file);
    await fs.writeFile(file, await storePageState(dir, 'A.html', stored.html));
    await createBackup(dir, 'A', splitPage(stored.html).file);
    const authority = createLocalAuthority({ withDocument: withDocumentWrite, pageCompaction: false });
    authority.registerRoot({ id: 'root-a', path: dir, canonicalPath: dir }, { owner: 'server' });
    const root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };
    // The stored document is the one the authority last confirmed; the outside
    // edit is based on the version before it.
    const target = authority.bindTarget({ rootId: root.id, logicalPath: 'A.html', canonicalPath: file });
    await withDocumentWrite(async () => ({ canonicalPath: file }), async (resolved, token) => {
      await authority.confirmKnownWrite(target, splitPage(stored.html).file, token, { sender: 'server-save' });
    });
    const observer = new RootObserver(root, { localAuthority: authority, live: { notify: noop, broadcast: noop } });
    observers.push(observer);
    observer._runDataGuard = noop;
    // An outside edit based on the older version: the disk holds it before the
    // observer is told, exactly as a real editor would leave it.
    const stale = splitPage(older.html).file.replace('>abc<', '>outside<');
    await fs.writeFile(file, stale);

    recorder.begin(dir);
    await observer._raw('change', 'A.html');

    const [call] = expectHostCall('commit', (c) => c.request.kind === 'external-rebase');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    expectOnlyHostWrites();
  });

  it('a checkpoint through attempt writes the room through checkpoint', async () => {
    const dir = await makeRoot('doc-write-checkpoint-');
    const name = 'page.html';
    const file = path.join(dir, name);
    const fixture = pageFixture('abc');
    const root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };
    const authority = createLocalAuthority({ withDocument: withDocumentWrite, pageCompaction: false });
    authority.registerRoot({ id: root.id, path: dir, canonicalPath: dir }, { owner: 'server' });
    const checkpoint = createLocalCheckpoint({
      authority, logError: noop,
      loadCore: async () => require('@panphora/clayjs/server/checkpoint'),
      setTimer: () => ({ unref: noop }), clearTimer: noop,
    });
    authority.setCheckpointService(checkpoint);
    const live = createRootLive(root);
    checkpoint.registerHost(root.id, createRootDocumentHost({
      ctx: { root, localAuthority: authority }, live,
      loadCheckpoint: async () => require('@panphora/clayjs/server/checkpoint'),
    }));
    await fs.writeFile(file, await storePageState(dir, name, fixture.html));
    const target = authority.bindTarget({ rootId: root.id, logicalPath: name, canonicalPath: file });
    const room = await authority.roomFor(target, () => ({
      rootId: root.id, logicalPath: name, canonicalPath: file, identity: target.identity,
    }));
    const edited = authority.rooms.apply(room, 'editor', {
      name: 'page', n: 1, epoch: room.epoch, pageGeneration: room.pageTransition?.id ?? null,
      ops: [{ op: 'set', path: ['y', 'edit-1'], value: fixture.update }],
    });
    expect(edited.error).toBeUndefined();

    recorder.begin(dir);
    const result = await checkpoint.attempt(file);

    expect(result.kind).toBe('ok');
    const [call] = expectHostCall('checkpoint');
    expect(recorder.namedPathsOf(call)).toEqual([file]);
    // The room's typed edit reached the document and its page state.
    expect(await fs.readFile(file, 'utf8')).toBe(splitPage(result.written).file);
    expect(await fs.readFile(pageStatePath(dir, name), 'utf8')).toContain('edit-1');
    expectOnlyHostWrites();
  });
});

const PAGE_STATE = { v: 1, rev: 'rev-page', tag: '<p>merge</p>' };

describe('every restructure kind reaches the document host', () => {
  const workspace = (dir) => ({
    root: { id: 'root-a', kind: 'personal', path: dir, port: 0 },
    tree: tree(), moved: noop, changed: noop,
  });

  it('a workspace rename moves the document through restructure', async () => {
    const dir = await makeRoot();
    await fs.writeFile(path.join(dir, 'page.html'), DOC);
    await writePageState(dir, 'page.html', PAGE_STATE);
    const { root, ...report } = workspace(dir);

    recorder.begin(dir);
    const result = await executeCommand({ root, ...report, request: { command: 'rename', path: 'page.html', name: 'renamed.html' } });

    expect(result.path).toBe('renamed.html');
    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'move');
    expect(recorder.requestedPaths(call)).toEqual([path.join(dir, 'page.html'), path.join(dir, 'renamed.html')]);
    const [state] = expectHostCall('pageState', (c) => c.request.op === 'move');
    expect(state.request).toEqual({ op: 'move', name: 'page.html', to: 'renamed.html' });
    expect(await readPageState(dir, 'page.html')).toBeNull();
    expect(await readPageState(dir, 'renamed.html')).toMatchObject(PAGE_STATE);
    expect(await fs.readFile(path.join(dir, 'renamed.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });

  it('a workspace move into a folder moves the document through restructure', async () => {
    const dir = await makeRoot();
    await fs.writeFile(path.join(dir, 'page.html'), DOC);
    await fs.mkdir(path.join(dir, 'Notes'));
    await writePageState(dir, 'page.html', PAGE_STATE);
    const { root, ...report } = workspace(dir);

    recorder.begin(dir);
    const result = await executeCommand({ root, ...report, request: { command: 'move', path: 'page.html', parent: 'Notes' } });

    expect(result.path).toBe('Notes/page.html');
    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'move');
    expect(recorder.requestedPaths(call)).toEqual([path.join(dir, 'page.html'), path.join(dir, 'Notes', 'page.html')]);
    const [state] = expectHostCall('pageState', (c) => c.request.op === 'move');
    expect(state.request).toEqual({ op: 'move', name: 'page.html', to: 'Notes/page.html' });
    expect(await readPageState(dir, 'Notes/page.html')).toMatchObject(PAGE_STATE);
    expectOnlyHostWrites();
  });

  it('a workspace rename of a folder moves the document it holds', async () => {
    const dir = await makeRoot();
    await fs.mkdir(path.join(dir, 'Notes'));
    await fs.writeFile(path.join(dir, 'Notes', 'page.html'), DOC);
    await writePageState(dir, 'Notes/page.html', PAGE_STATE);
    const { root, ...report } = workspace(dir);

    recorder.begin(dir);
    const result = await executeCommand({ root, ...report, request: { command: 'rename', path: 'Notes', name: 'Archive' } });

    expect(result.path).toBe('Archive');
    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'move');
    expect(recorder.requestedPaths(call)).toEqual([path.join(dir, 'Notes', 'page.html'), path.join(dir, 'Archive', 'page.html')]);
    const [state] = expectHostCall('pageState', (c) => c.request.op === 'moveDir');
    expect(state.request).toEqual({ op: 'moveDir', name: 'Notes', to: 'Archive' });
    expect(await readPageState(dir, 'Notes/page.html')).toBeNull();
    expect(await readPageState(dir, 'Archive/page.html')).toMatchObject(PAGE_STATE);
    expect(await fs.readFile(path.join(dir, 'Archive', 'page.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });

  it('a workspace trash moves the document into Trash through restructure', async () => {
    const dir = await makeRoot();
    await fs.writeFile(path.join(dir, 'page.html'), DOC);
    await writePageState(dir, 'page.html', PAGE_STATE);
    const { root, ...report } = workspace(dir);

    recorder.begin(dir);
    const result = await executeCommand({ root, ...report, request: { command: 'trash', path: 'page.html' } });

    expect(result.path).toBe('.trash/page.html');
    expectHostCall('restructure', (c) => c.request.kind === 'trash');
    const [state] = expectHostCall('pageState', (c) => c.request.op === 'drop');
    expect(state.request).toEqual({ op: 'drop', name: 'page.html' });
    expect(await readPageState(dir, 'page.html')).toBeNull();
    expect(await fs.readFile(path.join(dir, '.trash', 'page.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });

  it('a workspace restore moves the document out of Trash through restructure', async () => {
    const dir = await makeRoot();
    await fs.mkdir(path.join(dir, '.trash'));
    await fs.writeFile(path.join(dir, '.trash', 'page.html'), DOC);
    const { root, ...report } = workspace(dir);

    recorder.begin(dir);
    const result = await executeCommand({ root, ...report, request: { command: 'restore-trash', trashPath: '.trash/page.html' } });

    expect(result.path).toBe('page.html');
    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'move');
    expect(recorder.requestedPaths(call)).toEqual([path.join(dir, 'page.html')]);
    expect(await fs.readFile(path.join(dir, 'page.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });

  it('a workspace duplicate copies the document through restructure', async () => {
    const dir = await makeRoot();
    await fs.writeFile(path.join(dir, 'page.html'), DOC);
    const { root, ...report } = workspace(dir);

    recorder.begin(dir);
    const result = await executeCommand({ root, ...report, request: { command: 'duplicate', path: 'page.html', name: 'copy.html' } });

    expect(result.path).toBe('copy.html');
    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'duplicate');
    expect(recorder.requestedPaths(call)).toEqual([path.join(dir, 'page.html'), path.join(dir, 'copy.html')]);
    expect(await fs.readFile(path.join(dir, 'copy.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });

  it('the auto-namer settles an Untitled page through a real executeCommand', async () => {
    const dir = await makeRoot('doc-write-auto-name-');
    const appDataPath = await makeRoot('doc-write-auto-name-data-');
    const root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };
    const file = path.join(dir, 'untitled.html');
    await fs.writeFile(file, '<article data-page><h1>First Heading</h1></article>');
    const room = { key: file, nodeId: 'node-1', emptySince: Date.now() };
    const authority = {
      rooms: new Map([[room.key, room]]),
      identityAt: () => room.nodeId,
      hasParticipatingEditors: () => false,
      checkpointTargets: () => [{ rootId: root.id, logicalPath: 'untitled.html' }],
    };
    const rename = (from, name) => executeCommand({
      root, request: { command: 'rename', path: from, name },
      tree: tree(), moved: noop, changed: noop,
    });
    const namer = createAutoNamer({
      appDataPath, authority, checkpoint: { dirty: () => false, pending: () => null },
      rootFor: () => root, rename: (rootArg, from, name) => rename(from, name),
    });
    await namer.record(root, 'untitled.html', 'page');
    expect(namer.entries.size).toBe(1);

    recorder.begin(dir);
    await namer.settle(room.key);

    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'move');
    expect(recorder.requestedPaths(call)).toEqual([file, path.join(dir, 'first-heading.html')]);
    expect(await fs.readFile(path.join(dir, 'first-heading.html'), 'utf8')).toContain('First Heading');
    expectOnlyHostWrites();
    namer.close();
  });

  it('a sync relocate moves the document through restructure', async () => {
    const dir = await makeRoot();
    const authority = createLocalAuthority({ withDocument: withDocumentWrite });
    authority.registerRoot({ id: 'root-a', path: dir, canonicalPath: dir }, { owner: 'server' });
    const engine = engineFor({ dir, authority });
    await fs.writeFile(path.join(dir, 'page.html'), DOC);
    await engine.repo.set(7, { type: 'site', path: 'page.html', syncedAt: 5 });

    recorder.begin(dir);
    await engine._applyFileRelocate(7, 'page.html', 'moved.html', 'site');

    const [call] = expectHostCall('restructure', (c) => c.request.kind === 'sync-move');
    expect(recorder.requestedPaths(call)).toEqual([path.join(dir, 'page.html'), path.join(dir, 'moved.html')]);
    expect(await fs.readFile(path.join(dir, 'moved.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });

  it('a sync trash moves the document into Trash through restructure', async () => {
    const dir = await makeRoot();
    const authority = createLocalAuthority({ withDocument: withDocumentWrite });
    authority.registerRoot({ id: 'root-a', path: dir, canonicalPath: dir }, { owner: 'server' });
    const engine = engineFor({ dir, authority });
    await fs.writeFile(path.join(dir, 'page.html'), DOC);
    await engine.repo.set(7, { type: 'site', path: 'page.html', syncedAt: 5 });

    recorder.begin(dir);
    await engine._applyFileDelete(7, 'page.html', 'site');

    expectHostCall('restructure', (c) => c.request.kind === 'sync-trash' && c.request.steps[0].to === '.trash/page.html');
    expect(await fs.readFile(path.join(dir, '.trash', 'page.html'), 'utf8')).toBe(DOC);
    expectOnlyHostWrites();
  });
});
