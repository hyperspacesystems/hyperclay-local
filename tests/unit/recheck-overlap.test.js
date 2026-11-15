/**
  * A runner restart that starts a second recheck while the
 * first recheck's pass is still in the engine's lane (8.55 final review).
 */
jest.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => s }
}));
jest.mock('livesync-hyperclay', () => ({
  liveSync: { markBrowserSave: jest.fn(), wasBrowserSave: jest.fn(() => false), notify: jest.fn(), broadcast: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn() }
}));
jest.mock('eventsource', () => ({ EventSource: jest.fn() }));
jest.mock('../../src/main/utils/backup', () => (require('../helpers/mock-exports').mockExports('src/main/utils/backup', {
  createBackup: jest.fn(), createBackupIfExists: jest.fn(), createBinaryBackupIfExists: jest.fn()
})));
jest.mock('../../src/main/data-loss-guard', () => (require('../helpers/mock-exports').mockExports('src/main/data-loss-guard', {
  runDataLossGuard: jest.fn(async () => ({}))
})));
jest.mock('../../src/main/utils/derived-artifacts', () => ({ refreshDerivedArtifacts: jest.fn(async () => ({})) }));
jest.mock('../../src/sync-engine/api-client', () => ({
  ...jest.requireActual('../../src/sync-engine/api-client'),
  listNodes: jest.fn(), getNodeContent: jest.fn(), putNodeContent: jest.fn(), createNode: jest.fn(), deleteNode: jest.fn(),
  getPageState: jest.fn(async () => null), putPageState: jest.fn(async () => true),
}));

const fsp = require('fs').promises;
const os = require('os');
const path = require('upath');
const crypto = require('crypto');
const api = require('../../src/sync-engine/api-client');
const { SyncEngine } = require('../../src/sync-engine/index');
const { rootDirIdentity } = require('../../src/sync-engine/root-marker');

const checksum = (c) => crypto.createHash('sha256').update(c).digest('hex').substring(0, 16);
const PAGES = { 11: 'notes.html', 12: 'plan.html', 13: 'team-new.html' };
const BYTES = Object.fromEntries(Object.entries(PAGES).map(([id, name]) => [id, `<html><body>${name} newer online</body></html>`]));
const SUM = Object.fromEntries(Object.entries(BYTES).map(([id, b]) => [id, checksum(b)]));
const list = () => Object.assign(Object.entries(PAGES).map(([id, name]) => ({ id: Number(id), type: 'site', name, parentId: null, path: '', etag: SUM[id], checksum: SUM[id] })), { complete: true });

const dirs = [];
let root; let metaDir; let engine;
let gate = null; let release = null; let started = false;

async function tmpDir(prefix) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

beforeEach(async () => {
  for (const fn of [api.listNodes, api.getNodeContent, api.putNodeContent, api.createNode, api.deleteNode]) fn.mockReset();
  api.listNodes.mockImplementation(async () => list());
  api.deleteNode.mockResolvedValue({});
  gate = null; started = false;
  api.getNodeContent.mockImplementation(async (conn, id) => {
    if (gate) { started = true; await gate; }
    return { content: BYTES[id], etag: SUM[id], checksum: SUM[id], structureVersion: `${id}-2` };
  });
  root = await tmpDir('r855-root-');
  metaDir = await tmpDir('r855-meta-');
  engine = new SyncEngine();
  Object.assign(engine, {
    syncFolder: root, metaDir, serverUrl: 'https://hyperclay.test', apiKey: 'hcsk_test', syncBase: '/_/sync',
    protocol: 2, accountId: 42, deviceId: 'device-1', isRunning: true,
    live: { markBrowserSave: jest.fn(), broadcast: jest.fn() }, snapshots: { take: () => null },
  });
  engine.recheckQuietMs = 20;
  engine.rootId = 'root-1';
  // The older copy: notes.html as last synced; plan.html and team-new.html (newer pages) missing.
  await fsp.writeFile(path.join(root, 'notes.html'), BYTES[11]);
  for (const [id, name] of Object.entries(PAGES)) {
    await engine.repo.set(id, { type: 'site', path: name, remoteEtag: SUM[id], localChecksum: SUM[id], localSeenAt: Date.now() - 60_000 });
  }
  engine.lastSyncedAt = Date.now() - 60_000;
  // The baseline was recorded in another directory: this folder is unproven.
  engine.rootDir = 'another-directory:1';
  expect(engine.rootUnproven()).toBe(true);
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); if (!cond()) throw new Error('never'); };
const present = async (name) => fsp.access(path.join(root, name)).then(() => true, () => false);

test('control: two rechecks one after the other send nothing and download the missing pages', async () => {
  const s1 = new AbortController();
  expect(await engine.recheckRoot(list(), { generation: 1, signal: s1.signal })).toBe(true);
  expect(engine.rootDir).toBe(rootDirIdentity(root));
  expect(await present('plan.html')).toBe(true);
  expect(await present('team-new.html')).toBe(true);
  await engine.reconcileAll(list(), { generation: 1, signal: s1.signal });
  expect(api.deleteNode).not.toHaveBeenCalled();
});

test('race: a restart starts a second recheck while the first is still in the lane', async () => {
  let opened;
  gate = new Promise((r) => { release = r; });
  const s1 = new AbortController();
  const first = engine.recheckRoot(list(), { generation: 1, signal: s1.signal });
  await until(() => started);
  // The runner bumps its generation (a stream error ends in a backoff restart): the first
  // recheck's signal aborts, and the restart reaches recheckRoot again.
  s1.abort();
  const s2 = new AbortController();
  const second = engine.recheckRoot(list(), { generation: 2, signal: s2.signal });
  gate = null;
  release();
  const firstProven = await first;
  const secondProven = await second;
  // The runner's normal pass after a proven recheck.
  if (secondProven) await engine.reconcileAll(list(), { generation: 2, signal: s2.signal });
  expect(api.deleteNode).not.toHaveBeenCalled();
});

test('both overlapping recheck passes run as rechecks', async () => {
  const seen = [];
  const inner = engine.reconcileAllInLane.bind(engine);
  engine.reconcileAllInLane = async (inv, work) => {
    const result = await (async () => { if (work.stale) await new Promise((r) => setTimeout(r, 0)); seen.push({ generation: work.generation, recheckPass: engine.recheckPass }); return inner(inv, work); })();
    return result;
  };
  gate = new Promise((r) => { release = r; });
  const s1 = new AbortController();
  const first = engine.recheckRoot(list(), { generation: 1, signal: s1.signal });
  await until(() => started);
  s1.abort();
  const s2 = new AbortController();
  const second = engine.recheckRoot(list(), { generation: 2, signal: s2.signal });
  gate = null;
  release();
  await first; await second;
  expect(seen.length).toBe(2);
  expect(seen.every((pass) => pass.recheckPass === true)).toBe(true);
});
