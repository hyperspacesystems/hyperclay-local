/**
 * A synced Block document that has no merge state beside it takes the server's.
 *
 * A Local from before the rename asked on a route that no longer answers and kept
 * nothing, and it re-reads a record only when a changed file downloads. So an
 * unchanged document is caught up when it is served, before any editor can start
 * a second history that the next upload writes over the server's.
 */

jest.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => s }
}));

jest.mock('eventsource', () => ({
  EventSource: jest.fn()
}));

jest.mock('livesync-hyperclay', () => ({
  liveSync: {
    markBrowserSave: jest.fn(),
    wasBrowserSave: jest.fn(() => false),
    notify: jest.fn(),
    broadcast: jest.fn(),
    subscribeUser: jest.fn(),
    unsubscribeUser: jest.fn(),
    broadcastFileSaved: jest.fn(),
    broadcastToUser: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    configure: jest.fn(),
    onFrame: jest.fn()
  }
}));

jest.mock('../../src/main/utils/backup', () => (require('../helpers/mock-exports').mockExports('src/main/utils/backup', {
  createBackup: jest.fn(),
  createBackupIfExists: jest.fn(),
  createBinaryBackupIfExists: jest.fn()
})));

jest.mock('../../src/main/utils/utils', () => ({
  getServerBaseUrl: (url) => url || 'http://localhyperclay.com'
}));

jest.mock('../../src/main/data-loss-guard', () => (require('../helpers/mock-exports').mockExports('src/main/data-loss-guard', {
  runDataLossGuard: jest.fn(async () => ({}))
})));

jest.mock('../../src/main/utils/derived-artifacts', () => ({
  refreshDerivedArtifacts: jest.fn(async () => ({}))
}));

jest.mock('../../src/main/utils/write-queue', () => {
  const actual = jest.requireActual('../../src/main/utils/write-queue');
  return {
    ...actual,
    atomicWriteFile: jest.fn((filePath, content, encoding, beforeRename) =>
      actual.atomicWriteFile(filePath, content, encoding, beforeRename))
  };
});

jest.mock('../../src/sync-engine/api-client');

const fsSync = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const nodePath = require('path');
const upath = require('upath');
const request = require('supertest');
const { splitPage, createRooms } = require('@panphora/clayjs/server/rooms');

const apiClient = require('../../src/sync-engine/api-client');
const { SyncEngine } = require('../../src/sync-engine/index');
const { catchUpPageRecord } = require('../../src/sync-engine/page-state');
const { storePageState, readPageState, pageStatePath } = require('../../src/main/page-state-store');
const { createApp } = require('../../src/main/server.js');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { RootObserver } = require('../../src/main/root-observer');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');
const { createRootLive } = require('../../src/main/utils/root-live');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');

const TEMPLATE = fsSync.readFileSync(nodePath.join(__dirname, '../fixtures/ypage-template.html'), 'utf8');
const { state: TEMPLATE_STATE } = splitPage(TEMPLATE);

let root;
let engine;

const full = (rel) => upath.join(root, rel);

async function writePage(rel) {
  await fsp.mkdir(nodePath.dirname(full(rel)), { recursive: true });
  await fsp.writeFile(full(rel), await storePageState(root, rel, TEMPLATE));
}

// A tracked Block document with its sidecar missing, the state an older Local leaves.
async function trackedWithoutSidecar(rel, nodeId) {
  await writePage(rel);
  await fsp.rm(pageStatePath(root, rel), { force: true });
  engine.repo.seed([[String(nodeId), { type: 'site', path: rel }]]);
}

const serverRecord = () => ({ v: 1, rev: TEMPLATE_STATE.rev, tag: TEMPLATE_STATE.tag });

beforeEach(async () => {
  jest.clearAllMocks();

  root = upath.resolve(await fsp.realpath(await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'blockeditor-catch-up-'))));
  const metaDir = nodePath.join(root, '.meta');
  await fsp.mkdir(metaDir);

  engine = new SyncEngine();
  engine.syncFolder = root;
  engine.metaDir = metaDir;
  engine.serverUrl = 'http://test';
  engine.apiKey = 'test-key';
  engine.deviceId = 'test-device';
  engine.isRunning = true;
  engine.repo.seed([]);

  apiClient.getPageState.mockResolvedValue(null);
  apiClient.putPageState.mockResolvedValue(true);
});

afterEach(async () => {
  engine.syncQueue.clear();
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test('a tracked Block document with no sidecar takes the server record once', async () => {
  await trackedWithoutSidecar('doc.html', 7);
  apiClient.getPageState.mockResolvedValue(serverRecord());

  expect(await catchUpPageRecord(engine, 'doc.html')).toBe(true);

  expect(apiClient.getPageState).toHaveBeenCalledTimes(1);
  expect(apiClient.getPageState.mock.calls[0][1]).toBe('7');
  expect(await readPageState(root, 'doc.html', { rev: TEMPLATE_STATE.rev, exact: true }))
    .toEqual({ v: 1, rev: TEMPLATE_STATE.rev, tag: TEMPLATE_STATE.tag });

  expect(await catchUpPageRecord(engine, 'doc.html')).toBe(false);
  expect(apiClient.getPageState).toHaveBeenCalledTimes(1);
});

test('a record for another revision is not applied', async () => {
  await trackedWithoutSidecar('other.html', 8);
  apiClient.getPageState.mockResolvedValue({ v: 1, rev: 'ffffffffffffffff', tag: TEMPLATE_STATE.tag });

  expect(await catchUpPageRecord(engine, 'other.html')).toBe(false);
  expect(await readPageState(root, 'other.html', { rev: TEMPLATE_STATE.rev, exact: true })).toBeNull();
});

test('a document that already has its sidecar is not fetched', async () => {
  await writePage('kept.html');
  engine.repo.seed([['9', { type: 'site', path: 'kept.html' }]]);

  expect(await catchUpPageRecord(engine, 'kept.html')).toBe(false);
  expect(apiClient.getPageState).not.toHaveBeenCalled();
});

test('an untracked document is not fetched', async () => {
  await writePage('untracked.html');
  await fsp.rm(pageStatePath(root, 'untracked.html'), { force: true });
  engine.repo.seed([]);

  expect(await catchUpPageRecord(engine, 'untracked.html')).toBe(false);
  expect(apiClient.getPageState).not.toHaveBeenCalled();
});

test('a server with no record leaves the document as it was', async () => {
  await trackedWithoutSidecar('bare.html', 10);
  const before = fsSync.readFileSync(full('bare.html'));
  apiClient.getPageState.mockResolvedValue(null);

  expect(await catchUpPageRecord(engine, 'bare.html')).toBe(false);
  expect(fsSync.existsSync(pageStatePath(root, 'bare.html'))).toBe(false);
  expect(fsSync.readFileSync(full('bare.html'))).toEqual(before);
});

test('serving the document fetches the record before the page is sent', async () => {
  await trackedWithoutSidecar('served.html', 11);
  apiClient.getPageState.mockResolvedValue(serverRecord());

  const core = createRooms({});
  const rooms = { ...core };
  const authority = createLocalAuthority({ rooms, withDocument: withDocumentWrite });
  const appRoot = { id: 'root-a', kind: 'personal', path: root, port: 0 };
  const live = createRootLive(appRoot);
  const observer = new RootObserver(appRoot, { live, localAuthority: authority });
  const server = await listenLoopback(createApp({
    root: appRoot, live, observer, localAuthority: authority, devHooks: null, isKnownPath: null,
    syncEngineFor: () => engine
  }));

  try {
    const res = await request(server).get('/served.html');

    expect(res.status).toBe(200);
    expect(res.text).toContain('merge="blockeditor"');
    expect(res.text).toContain(TEMPLATE_STATE.tag);
  } finally {
    await closeLoopback();
    await observer.stop();
  }
});

test('a lookup that fails is asked again on the next open', async () => {
  await trackedWithoutSidecar('retry.html', 12);
  apiClient.getPageState.mockRejectedValueOnce(Object.assign(new Error('offline'), { statusCode: undefined }));

  await expect(catchUpPageRecord(engine, 'retry.html')).rejects.toThrow('offline');

  apiClient.getPageState.mockResolvedValueOnce(serverRecord());

  await expect(catchUpPageRecord(engine, 'retry.html')).resolves.toBe(true);

  expect(apiClient.getPageState).toHaveBeenCalledTimes(2);
  expect(apiClient.getPageState.mock.calls[0][2]).toEqual({ strict: true });
  expect(await readPageState(root, 'retry.html', { rev: TEMPLATE_STATE.rev, exact: true })).toEqual(serverRecord());
});

test('two opens at once share one lookup', async () => {
  await trackedWithoutSidecar('twice.html', 13);
  apiClient.getPageState.mockResolvedValueOnce(serverRecord());

  const [a, b] = await Promise.all([catchUpPageRecord(engine, 'twice.html'), catchUpPageRecord(engine, 'twice.html')]);

  expect(apiClient.getPageState).toHaveBeenCalledTimes(1);
  expect([a, b]).toEqual([true, true]);
});
