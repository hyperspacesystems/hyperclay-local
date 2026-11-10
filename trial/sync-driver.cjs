// E4b: one human's desktop sync manager in a child process whose every document
// write goes through the Go host. It speaks the same JSON messages over the
// fork's IPC channel as tests/round-trip/desktop-driver.cjs, so the round trip
// that forks one can fork the other.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { Agent } = require(process.env.UNDICI_PATH);

const APP_HOST = process.env.APP_HOSTNAME;
const PORT = Number(process.env.APP_PORT);
const dispatcher = new Agent({
  connect: {
    lookup(_h, options, cb) {
      const a = { address: '127.0.0.1', family: 4 };
      return options?.all ? cb(null, [a]) : cb(null, a.address, a.family);
    },
  },
});
const nativeFetch = global.fetch;
global.fetch = (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== APP_HOST) throw new Error(`driver escaped the test app: ${url.href}`);
  url.port = String(PORT);
  return nativeFetch(url, { ...init, dispatcher });
};

const REPO = path.resolve(__dirname, '..');
if (!process.env.MANAGED_TRIAL_RUN) throw new Error('MANAGED_TRIAL_RUN is required');
const RUN = path.resolve(process.env.MANAGED_TRIAL_RUN);
const GO_BIN = process.env.MANAGED_TRIAL_GO_BIN;
const LOCAL_DIR = process.env.LOCAL_DIR;

process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = 'go';

// The adapter the document host loads is the one beside the Local source, so the
// connection and the counts this driver reads belong to the instance in use.
function localTrial(name) {
  const beside = path.join(LOCAL_DIR, 'trial', name);
  return fs.existsSync(beside) ? beside : path.join(__dirname, name);
}

const { SyncManager } = require(path.join(LOCAL_DIR, 'src/main/sync-manager.js'));
const { createRootDocumentHost } = require(path.join(LOCAL_DIR, 'src/main/document-host.js'));
const { load: loadConflicts } = require(path.join(LOCAL_DIR, 'src/sync-engine/reconcile/conflicts.js'));
const { adapterCounts } = require(localTrial('go-document-host.cjs'));
const { setConnection } = require(localTrial('go-process.cjs'));

const observer = passiveObserver();
const feeds = [];
let adapters = [];
let manager = null;
let apiKey = null;
let settings = null;
let go = null;
let goPaths = [];
let goRuns = 0;

function liveStub() {
  return { markBrowserSave() {}, broadcast() {} };
}

function passiveObserver() {
  const emitter = new EventEmitter();
  const listeners = new Set();
  emitter.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  emitter.setRemoteApplyCheck = () => {};
  emitter.start = async () => {};
  emitter.stop = async () => {};
  emitter.deliver = (frame) => {
    for (const listener of listeners) listener(frame);
  };
  return emitter;
}

function filesUnder(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && entry.name === '.hyperclay') continue;
    if (entry.isDirectory()) out.push(...filesUnder(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function adapterFor(root) {
  const wanted = typeof root === 'string' ? root : root && root.id;
  const found = adapters.find((entry) => entry.settingsId === wanted || entry.goId === wanted
    || entry.path === wanted
    || (typeof wanted === 'string' && wanted !== '' && entry.path === path.resolve(wanted)));
  if (!found) throw new Error(`the Go document host serves no root ${wanted}`);
  return found;
}

async function startGoProcess() {
  fs.mkdirSync(RUN, { recursive: true });
  goRuns += 1;
  const scratch = path.join(RUN, 'go', String(goRuns));
  fs.mkdirSync(scratch, { recursive: true });
  const { startGo } = await import(pathToFileURL(path.join(__dirname, 'p1.mjs')).href);
  return startGo({
    bin: GO_BIN,
    cwd: REPO,
    scratch,
    roots: [goPaths[0], goPaths[1]],
    localSource: LOCAL_DIR,
  });
}

function connectGo(target) {
  const served = {};
  for (const root of target.readyRoots) served[fs.realpathSync(root.path)] = root.id;
  setConnection({ url: target.control, secret: target.secret, epoch: target.control, roots: served });
  return served;
}

function goPathsFor(roots) {
  const paths = roots.map((root) => fs.realpathSync(path.resolve(root.path)));
  if (paths.length === 0) throw new Error('the driver needs at least one root');
  if (paths.length > 2) throw new Error(`the Go host serves two roots; the driver was given ${paths.length}`);
  if (paths.length === 1) {
    const extra = path.join(RUN, 'extra-root');
    fs.mkdirSync(extra, { recursive: true });
    paths.push(fs.realpathSync(extra));
  }
  return paths;
}

// One adapter per served root: every read and write a handler makes is the
// adapter's, and the engine's own snapshot lane is pointed at the same ones.
function openAdapters(roots, served) {
  adapters = [];
  for (const [real, goId] of Object.entries(served)) {
    const spec = roots.find((root) => fs.realpathSync(path.resolve(root.path)) === real) || null;
    const host = createRootDocumentHost({
      ctx: { root: { id: spec ? spec.id : goId, path: real }, localAuthority: null },
      live: liveStub(),
      emit() {},
      logger: null,
    });
    adapters.push({ settingsId: spec ? spec.id : null, goId, path: real, host });
    feeds.push(host.events(null, (frame) => {
      if (frame.type === 'change') observer.deliver({ event: frame.event, rel: frame.rel });
    }));
  }
}

function metaDirFor(root) {
  const found = adapterFor(root);
  const entry = [...manager.sessions.values()].find((candidate) => candidate.root.id === found.settingsId);
  const session = entry ? entry.session
    : (settings.syncSessions || []).find((candidate) => candidate.rootId === found.settingsId);
  if (!session) throw new Error(`no sync session for root ${found.settingsId}`);
  return manager.metaDirFor(session);
}

const handlers = {
  async start({ userData, apiKey: key, roots, sessions = [] }) {
    apiKey = key;
    settings = { settingsVersion: 2, syncEnabled: true, roots, syncSessions: sessions };
    goPaths = goPathsFor(roots);
    go = await startGoProcess();
    const served = connectGo(go);
    openAdapters(roots, served);
    manager = new SyncManager({
      userData,
      deviceId: `sync-driver-${process.pid}`,
      serverUrl: `http://${APP_HOST}`,
      getApiKey: () => apiKey,
      settingsStore: { get: () => settings, save: () => {} },
      observerFor: () => observer,
      // The settings id picks the root's adapter, whose context is that root;
      // the adapter's own root argument names a Go root, never a settings id.
      takeSnapshot: (rel, rootId) => adapterFor(rootId).host.takeSnapshot(rel),
    });
    await manager.startEnabledSessions();
    return manager.snapshot();
  },
  async startAll() { await manager.startEnabledSessions(); return manager.snapshot(); },
  async setupTeam({ accountId, folder }) { return manager.setupTeam({ accountId, folder, trusted: true }); },
  async idle({ timeoutMs = 20_000 }) { return manager.whenAllIdle({ timeoutMs }); },
  async snapshot() { return manager.snapshot(); },
  async refresh() { await manager.refreshAccounts(); return manager.snapshot(); },
  async resolve(args) { return manager.resolveConflict(args); },
  // L4: the host comes back on the same roots with a new epoch, so the engine's
  // stream resumes from its cursor, is told gap, and reconciles the disk.
  async restart({ apiKey: key }) {
    await manager.stopAll();
    apiKey = key;
    await go.stop();
    go = await startGoProcess();
    connectGo(go);
    await manager.startEnabledSessions();
    return manager.snapshot();
  },
  async stopAll() { await manager.stopAll(); return true; },
  async counts() { return adapterCounts(); },
  async checksums({ root }) {
    const found = adapterFor(root);
    const out = {};
    for (const rel of filesUnder(found.path)) {
      const answer = await found.host.read(rel);
      out[rel] = answer ? answer.checksum : null;
    }
    return out;
  },
  async conflicts({ root }) { return loadConflicts(metaDirFor(root)); },
  // The engine's own path: SyncManager hands the root's settings id to the
  // takeSnapshot it was built with, exactly as an upload does.
  async takeSnapshot({ root, rel }) { return manager.takeSnapshot(rel, root); },
  async goLog() {
    const dir = path.join(RUN, 'go');
    if (!fs.existsSync(dir)) return '';
    const runs = fs.readdirSync(dir).filter((name) => /^\d+$/.test(name))
      .sort((left, right) => Number(left) - Number(right));
    const lines = [];
    for (const run of runs) {
      const log = path.join(dir, run, 'go-host.log');
      if (!fs.existsSync(log)) continue;
      lines.push(...fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== ''));
    }
    return lines.slice(-200).join('\n');
  },
  async stop() {
    await manager.stopAll();
    await go.stop();
    fs.writeFileSync(path.join(RUN, 'adapter-counts.json'), `${JSON.stringify(adapterCounts(), null, 2)}\n`);
    return true;
  },
};

process.on('message', async ({ id, cmd, args }) => {
  try {
    process.send({ id, ok: true, result: await handlers[cmd](args || {}) });
  } catch (error) {
    process.send({ id, ok: false, error: { message: error.message, code: error.code } });
  }
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[FATAL] Unhandled rejection:', error);
});
// An orphaned driver never outlives the test that forked it.
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
