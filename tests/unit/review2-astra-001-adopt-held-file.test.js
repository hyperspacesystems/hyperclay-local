jest.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => s }
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
    broadcastToUser: jest.fn()
  }
}));

jest.mock('../../src/main/data-loss-guard', () => (require('../helpers/mock-exports').mockExports('src/main/data-loss-guard', {
  runDataLossGuard: jest.fn(() => Promise.resolve({})),
  applyRemoteResolution: jest.fn()
})));

jest.mock('../../src/main/utils/derived-artifacts', () => ({
  refreshDerivedArtifacts: jest.fn(async () => {})
}));

jest.mock('../../src/main/utils/backup', () => (require('../helpers/mock-exports').mockExports('src/main/utils/backup', {
  createBackup: jest.fn(),
  createBackupIfExists: jest.fn(),
  createBinaryBackupIfExists: jest.fn()
})));

const api = require('../../src/sync-engine/api-client');
jest.mock('../../src/sync-engine/api-client', () => ({
  ...jest.requireActual('../../src/sync-engine/api-client'),
  listNodes: jest.fn(),
  getNodeContent: jest.fn(),
  putNodeContent: jest.fn(),
  createNode: jest.fn(),
  renameNode: jest.fn(),
  moveNode: jest.fn(),
  deleteNode: jest.fn(),
  getPageState: jest.fn(async () => null),
  putPageState: jest.fn(async () => true),
}));

const os = require('os');
const fsp = require('fs').promises;
const path = require('upath');
const crypto = require('crypto');

const { SyncEngine } = require('../../src/sync-engine/index');

const checksum = (content) => crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);

let root;
let metaDir;
let engine;

async function makeEngine() {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'upload-admission-root-')));
  metaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'upload-admission-meta-'));
  engine = new SyncEngine();
  engine.syncFolder = root;
  engine.metaDir = metaDir;
  engine.serverUrl = 'http://localhost:5';
  engine.apiKey = 'hcsk_test';
  engine.accountId = 42;
  engine.protocol = 2;
  engine.live = { markBrowserSave: jest.fn(), broadcast: jest.fn() };
  engine.snapshots = { take: () => null };
  jest.spyOn(engine, 'emit');
  return engine;
}

async function writeLocalFile(rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
  return full;
}

const completeList = (nodes) => Object.assign([...nodes], { complete: true });

beforeEach(async () => {
  jest.clearAllMocks();
  await makeEngine();
});

afterEach(async () => {
  engine.syncQueue.clearQueueTimer();
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(metaDir, { recursive: true, force: true });
});

describe('file-limit recovery after another device uploaded the first held file', () => {
  it('drops the adopted file from the held list and continues with the next file', async () => {
    const html = '<html><body>Local notes</body></html>';
    await writeLocalFile('alpha.html', html);
    await writeLocalFile('beta.html', html);
    await engine.blockFileLimit('alpha.html');
    await engine.blockFileLimit('beta.html');
    api.listNodes.mockResolvedValue(completeList([
      { id: 701, type: 'site', name: 'alpha.html', path: '', parentId: 0, etag: checksum(html), structureVersion: 'alpha-v1' },
    ]));
    api.createNode.mockResolvedValue({ id: 702, type: 'site', name: 'beta.html', parentId: 0, etag: checksum(html), structureVersion: 'beta-v1' });
    engine.isRunning = true;

    engine.retryFileLimitBlocks();
    engine.syncQueue.clearQueueTimer();
    await engine.processQueue();
    engine.syncQueue.clearQueueTimer();

    expect(engine.repo.get('701')).toMatchObject({ path: 'alpha.html' });
    engine.retryFileLimitBlocks();
    engine.syncQueue.clearQueueTimer();
    await engine.processQueue();
    engine.syncQueue.clearQueueTimer();
    expect(await fsp.readFile(path.join(root, 'alpha.html'), 'utf8')).toBe(html);
    expect(await fsp.readFile(path.join(root, 'beta.html'), 'utf8')).toBe(html);
    expect(api.createNode.mock.calls.map(([, body]) => body.name)).toEqual(['beta.html']);
    expect(engine.blockedUploads()).toEqual([]);
  });
});
