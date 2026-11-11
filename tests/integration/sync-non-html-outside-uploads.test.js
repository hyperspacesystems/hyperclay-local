/**
 * A folder with `site.json` beside its pages is a site.
 *
 * On hyperclay.com a save to `site.json` rewrites every page of its folder, so a
 * synced folder has to carry `site.json` both ways with no Local feature code of
 * its own: the local edit uploads, the server fans out, the pages come back.
 *
 * The docs and the code disagree about whether a file outside `uploads/` that is
 * not a page syncs at all. These cases ask the engine directly: a local edit to
 * `ada/site.json` goes up as an upload (a PUT of the body for a tracked node, a
 * POST for a new one), and a `node-saved` frame brings a file back. Real temp
 * roots and the real document host do the work; only `/sync/nodes` is the fake.
 */

jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getName: () => 'HyperclayLocal' },
  shell: { showItemInFolder: jest.fn(), openPath: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => s }
}));

jest.mock('eventsource', () => ({ EventSource: jest.fn() }));

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

jest.mock('../../src/main/utils/backup', () => (require('../helpers/mock-exports').mockExports('src/main/utils/backup', {
  createBackup: jest.fn(),
  createBackupIfExists: jest.fn(),
  createBinaryBackupIfExists: jest.fn()
})));

jest.mock('../../src/main/utils/utils', () => ({
  getServerBaseUrl: (url) => url || 'http://localhyperclay.com'
}));

// The remote writers refresh derived artifacts inside their critical section,
// which reaches the extractor's dynamic ESM import that jest's vm cannot run.
jest.mock('../../src/main/utils/derived-artifacts', () => ({
  refreshDerivedArtifacts: jest.fn(async () => {})
}));

jest.mock('../../src/sync-engine/api-client');

const fsSync = require('fs');
const os = require('os');
const nodePath = require('path');
const api = require('../../src/sync-engine/api-client');
const fsScenario = require('../helpers/fs-scenario');
const { FakeServer, install } = require('../helpers/sync-fake-server');

jest.setTimeout(30000);

const tick = () => new Promise((resolve) => setImmediate(resolve));

const SITE_JSON = JSON.stringify({ name: 'Ada', pages: ['about', 'contact'] }, null, 2);
const EDITED_JSON = JSON.stringify({ name: 'Ada Lovelace', pages: ['about', 'contact'] }, null, 2);
const ABOUT = '<!DOCTYPE html><html lang="en"><body><h1>About Ada</h1></body></html>';
const CONTACT = '<!DOCTYPE html><html lang="en"><body><h1>Contact</h1></body></html>';

const TREE = {
  'ada/site.json': SITE_JSON,
  'ada/about.html': ABOUT,
  'ada/contact.html': CONTACT
};

const IDS = {
  10: 'ada',
  11: 'ada/site.json',
  12: 'ada/about.html',
  13: 'ada/contact.html'
};

const TREE_WITHOUT_JSON = {
  'ada/about.html': ABOUT,
  'ada/contact.html': CONTACT
};

const IDS_WITHOUT_JSON = {
  10: 'ada',
  12: 'ada/about.html',
  13: 'ada/contact.html'
};

const QUIET_MS = 500;

const roots = [];

function makeEngine(root, metaDir, ledger) {
  let engine;
  jest.isolateModules(() => {
    const { SyncEngine } = require('../../src/sync-engine/index');
    engine = new SyncEngine();
  });
  engine.isRunning = true;
  engine.serverUrl = 'http://test';
  engine.apiKey = 'test-key';
  engine.syncFolder = root;
  engine.rootId = 'root-ada';
  engine.metaDir = metaDir;
  engine.lastSyncedAt = Date.now();
  engine.repo.seed(ledger);
  engine.runner = { start: jest.fn(), pause: jest.fn(), state: 'live' };
  return engine;
}

function setup({ tree = TREE, ids = IDS } = {}) {
  const baseDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'site-json-'));
  roots.push(baseDir);
  const root = fsScenario.mkroot(tree, baseDir);
  const metaDir = fsSync.mkdtempSync(nodePath.join(baseDir, 'meta-'));
  const ledger = fsScenario.ledgerFor(root, ids);
  const server = new FakeServer(fsScenario.serverNodesFor(root, ids));
  install(api, server);
  const engine = makeEngine(root, metaDir, ledger);
  return { root, metaDir, ledger, server, engine };
}

/**
 * Let the watcher handlers finish, the quiet window close, and every queued
 * change drain through the lane. Two idle rounds in a row are required, so a
 * handler that queues its change a tick late is still picked up.
 */
async function settle(engine) {
  let idleRounds = 0;
  for (let round = 0; round < 12 && idleRounds < 2; round += 1) {
    for (let i = 0; i < 5; i += 1) await tick();
    jest.advanceTimersByTime(QUIET_MS);
    await engine._lane;
    await engine.processQueue();
    await engine.whenQueueEmpty();
    for (let i = 0; i < 5; i += 1) await tick();
    await engine._lane;
    const idle = engine.syncQueue.isEmpty() && !engine.syncQueue.isProcessingQueue();
    idleRounds = idle ? idleRounds + 1 : 0;
  }
  if (idleRounds < 2) throw new Error('the sync queue did not settle');
}

/**
 * A local edit through the watcher's `change` path. The per-type handler it
 * hands the path to is fire-and-forget, so wait for the queue to take it rather
 * than for a tick count.
 */
async function localChange(engine, rel) {
  engine._dispatchRaw('change', rel);
  for (let i = 0; i < 50 && engine.syncQueue.isEmpty(); i += 1) await tick();
  if (engine.syncQueue.isEmpty()) throw new Error(`the watcher never queued ${rel}`);
}

const callsNamed = (server, name) => server.calls.filter((call) => call.name === name);

const nodeNamed = (server, rel) => {
  const id = [...server.nodes.keys()].find((nodeId) => server.relPathOf(nodeId) === rel);
  return id === undefined ? null : server.get(id);
};

const disk = (root, rel) => fsSync.readFileSync(nodePath.join(root, rel), 'utf8');

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  while (roots.length) {
    fsSync.rmSync(roots.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

describe('a local edit to ada/site.json', () => {
  it('uploads the edited body to the node that already tracks it', async () => {
    const { root, engine, server } = setup();

    fsSync.writeFileSync(nodePath.join(root, 'ada/site.json'), EDITED_JSON);
    await localChange(engine, 'ada/site.json');
    await settle(engine);

    const puts = callsNamed(server, 'putNodeContent');
    expect(puts.map((call) => call.nodeId)).toEqual([11]);
    expect(server.get(11).content.toString()).toBe(EDITED_JSON);
    expect(callsNamed(server, 'createNode')).toEqual([]);
    expect(disk(root, 'ada/site.json')).toBe(EDITED_JSON);
  });

  it('creates a site.json the server has never seen with a POST', async () => {
    const { root, engine, server } = setup({ tree: TREE_WITHOUT_JSON, ids: IDS_WITHOUT_JSON });

    fsSync.writeFileSync(nodePath.join(root, 'ada/site.json'), SITE_JSON);
    engine._dispatchRaw('add', 'ada/site.json');
    await settle(engine);

    const creates = callsNamed(server, 'createNode');
    expect(creates).toHaveLength(1);
    expect(server.relPathOf(creates[0].nodeId)).toBe('ada/site.json');
    expect(nodeNamed(server, 'ada/site.json').content.toString()).toBe(SITE_JSON);
    expect(callsNamed(server, 'putNodeContent')).toEqual([]);
  });
});

describe('a node-saved frame from the server', () => {
  it('writes a page of the folder to disk', async () => {
    const { root, engine } = setup();
    const rewritten = '<!DOCTYPE html><html lang="en"><body><h1>About Ada Lovelace</h1></body></html>';

    await engine.handleNodeSaved({
      nodeId: 12,
      nodeType: 'site',
      name: 'about.html',
      path: 'ada/about.html',
      content: rewritten,
      checksum: fsScenario.checksumOf(Buffer.from(rewritten)),
      modifiedAt: '2026-02-01T00:00:00.000Z'
    });

    expect(disk(root, 'ada/about.html')).toBe(rewritten);
  });

  it('fetches site.json and writes its body to disk', async () => {
    const { root, engine, server } = setup();
    const stored = JSON.stringify({ name: 'Ada', pages: ['about', 'contact', 'notes'] }, null, 2);
    server.get(11).content = Buffer.from(stored);

    await engine.handleNodeSaved({
      nodeId: 11,
      nodeType: 'upload',
      name: 'site.json',
      path: 'ada/site.json',
      checksum: fsScenario.checksumOf(Buffer.from(stored)),
      modifiedAt: '2026-02-01T00:00:00.000Z'
    });

    expect(callsNamed(server, 'getNodeContent').map((call) => call.nodeId)).toEqual([11]);
    expect(disk(root, 'ada/site.json')).toBe(stored);
  });
});

describe('a page the server stored differently from what was sent', () => {
  const SENT_PAGE = '<!DOCTYPE html><html lang="en"><body><h1>About Ada, edited here</h1></body></html>';
  const STORED_PAGE = '<!DOCTYPE html><html lang="en"><body><h1>About Ada, edited here</h1><footer>Ada</footer></body></html>';

  async function editThenRewrite() {
    const { root, engine, server } = setup();

    fsSync.writeFileSync(nodePath.join(root, 'ada/about.html'), SENT_PAGE);
    await localChange(engine, 'ada/about.html');
    await settle(engine);
    expect(server.get(12).content.toString()).toBe(SENT_PAGE);

    // The platform's save hook keeps bytes of its own for the page it stored.
    server.get(12).content = Buffer.from(STORED_PAGE);
    return { root, engine, server };
  }

  const frame = (content, modifiedAt) => ({
    nodeId: 12,
    nodeType: 'site',
    name: 'about.html',
    path: 'ada/about.html',
    content,
    checksum: fsScenario.checksumOf(Buffer.from(content)),
    modifiedAt
  });

  // The frame that answers this device's own PUT is its echo: the outbox entry
  // the upload leaves (src/sync-engine/reconcile/execute.js:235) makes
  // _skipIfEcho drop it (src/sync-engine/engine-sse.js:77), so the bytes the
  // save hook stored never reach the disk. Recorded, not papered over.
  it.failing('applies the server\'s bytes from the frame that answers the save', async () => {
    const { root, engine } = await editThenRewrite();

    await engine.handleNodeSaved(frame(STORED_PAGE, '2026-02-01T00:00:01.000Z'));

    expect(disk(root, 'ada/about.html')).toBe(STORED_PAGE);
  });

  it('applies the server\'s bytes from the frame that follows the echo', async () => {
    const { root, engine } = await editThenRewrite();

    await engine.handleNodeSaved(frame(SENT_PAGE, '2026-02-01T00:00:01.000Z'));
    await engine.handleNodeSaved(frame(STORED_PAGE, '2026-02-01T00:00:02.000Z'));

    expect(disk(root, 'ada/about.html')).toBe(STORED_PAGE);
  });
});
