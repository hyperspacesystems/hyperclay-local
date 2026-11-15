// A synced folder is proven by two facts: its marker names the session's root, and its
// directory is the one the baseline was recorded in. A backup put back at the folder's own
// path carries the marker but not the directory, so no request that changes the server may
// leave it until a recheck has compared it (8.55 H2-u, H2-v).

jest.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => s }
}));

jest.mock('livesync-hyperclay', () => ({
  liveSync: {
    markBrowserSave: jest.fn(),
    wasBrowserSave: jest.fn(() => false),
    notify: jest.fn(),
    broadcast: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn()
  }
}));

jest.mock('eventsource', () => ({ EventSource: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SyncEngine } = require('../../src/sync-engine');
const { putNodeContent, deleteNode, createNode, listNodes } = require('../../src/sync-engine/api-client');
const { writeRootMarker, rootDirIdentity } = require('../../src/sync-engine/root-marker');

let base;
let realFetch;

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-root-proof-')));
  realFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ id: 16, etag: 'e2', checksum: 'e2' }), { status: 200 }));
});

afterEach(() => {
  global.fetch = realFetch;
  fs.rmSync(base, { recursive: true, force: true });
});

function sessionAt(root) {
  const engine = new SyncEngine();
  Object.assign(engine, {
    syncFolder: root, serverUrl: 'http://test', apiKey: 'hcsk_test', protocol: 2, accountId: 12,
    rootId: 'root-1', rootMarkerRequired: true, rootDir: rootDirIdentity(root),
  });
  engine.runner = { state: 'live', start: jest.fn(), pause: jest.fn() };
  return engine;
}

function syncedFolder() {
  const root = path.join(base, 'site');
  fs.mkdirSync(root);
  writeRootMarker(root, 'root-1');
  fs.writeFileSync(path.join(root, 'board.html'), '<html>newer</html>');
  return root;
}

test('a backup put back at the folder\'s own path sends nothing and restarts the session', async () => {
  const root = syncedFolder();
  const engine = sessionAt(root);
  await putNodeContent(engine.writeConn, 11, '<html>newer</html>');
  expect(global.fetch).toHaveBeenCalledTimes(1);

  fs.cpSync(root, `${root}-backup`, { recursive: true });
  fs.renameSync(root, `${root}-gone`);
  fs.renameSync(`${root}-backup`, root);

  expect(() => putNodeContent(engine.writeConn, 11, '<html>older</html>')).toThrow(expect.objectContaining({ code: 'folder-unproven' }));
  expect(() => deleteNode(engine.writeConn, 15)).toThrow(expect.objectContaining({ code: 'folder-unproven' }));
  expect(() => createNode(engine.writeConn, { type: 'site', name: 'x.html', parentId: null, content: 'x' })).toThrow(expect.objectContaining({ code: 'folder-unproven' }));
  await listNodes(engine.conn);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(engine.runner.start).toHaveBeenCalled();
  expect(engine.runner.pause).not.toHaveBeenCalled();
});

test('a copy put back without the hidden .hyperclay folder pauses as replaced and sends nothing', async () => {
  const root = syncedFolder();
  const engine = sessionAt(root);
  fs.renameSync(root, `${root}-gone`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'board.html'), '<html>older</html>');

  expect(() => putNodeContent(engine.writeConn, 11, '<html>older</html>')).toThrow(expect.objectContaining({ code: 'folder-replaced' }));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(engine.runner.pause).toHaveBeenCalledWith('folder-replaced');
});

test('the folder renamed or moved on the same disk is the same folder and keeps syncing', async () => {
  const root = syncedFolder();
  const engine = sessionAt(root);
  const moved = path.join(base, 'moved');
  fs.renameSync(root, moved);
  engine.syncFolder = moved;

  await putNodeContent(engine.writeConn, 11, '<html>newer</html>');
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(engine.runner.start).not.toHaveBeenCalled();
});

test('every request that changes the server is sent on writeConn', () => {
  const MUTATING = /\b(createNode|putNodeContent|putPageState|renameNode|moveNode|deleteNode|restoreNode)\(\s*([\w.]+)/g;
  const srcDir = path.join(__dirname, '../../src/sync-engine');
  const files = fs.readdirSync(srcDir, { recursive: true }).filter((rel) => rel.endsWith('.js') && rel !== 'api-client.js');
  const sent = [];
  const offenders = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(srcDir, rel), 'utf8');
    for (const [, name, first] of text.matchAll(MUTATING)) {
      if (first.endsWith('.writeConn')) sent.push(`${rel}:${name}`);
      else offenders.push(`${rel}: ${name}(${first}, ...)`);
    }
  }
  expect(offenders).toEqual([]);
  expect(sent.length).toBeGreaterThan(10);
});
