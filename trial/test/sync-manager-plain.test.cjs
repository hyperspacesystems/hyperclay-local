'use strict';

// L4: the sync manager and its engine load and run outside Electron. Any
// require('electron') below this loader throws, so a top-level one fails the load.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') throw new Error('electron is not available here');
  return originalLoad.call(this, request, ...rest);
};

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SyncManager } = require('../../src/main/sync-manager.js');
const { SyncLogger } = require('../../src/sync-engine/logger.js');
const { SyncEngine } = require('../../src/sync-engine/index.js');

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function memorySettings() {
  let settings = { roots: [], syncSessions: [] };
  return { get: () => settings, save: (next) => { settings = next; } };
}

test('the manager loads and runs with no Electron', async (t) => {
  await t.test('the manager and the engine load', () => {
    assert.equal(typeof SyncManager, 'function');
    assert.equal(typeof SyncEngine, 'function');
  });

  await t.test('the logs go to the folder it is given', async () => {
    const logsDir = tmp('plain-logs-');
    const logger = new SyncLogger();
    await logger.init(tmp('plain-root-'), { subdir: 's1', logsDir });
    assert.equal(logger.logDir, path.join(logsDir, 'sync', 's1').split(path.sep).join('/'));
    assert.ok(fs.existsSync(path.join(logsDir, 'sync', 's1')));
  });

  await t.test('an existing folder binds with no first bind', async () => {
    const manager = new SyncManager({
      userData: tmp('plain-data-'), deviceId: 'd1', serverUrl: 'http://127.0.0.1:9',
      getApiKey: () => null, settingsStore: memorySettings(), logsDir: tmp('plain-logs-'),
    });
    const calls = [];
    manager.start = async (session, root, options) => {
      calls.push(['start', options.firstBind]);
      manager.sessions.set(session.id, { session, root });
      return { success: true };
    };
    manager.runBind = async () => { calls.push(['runBind']); return { ok: true }; };
    manager.startRunner = () => { calls.push(['startRunner']); };
    const session = { id: 's1', rootId: 'r1', accountId: 7, kind: 'personal', cached: {}, paused: null, legacyMetaDir: null };
    const root = { id: 'r1', kind: 'personal', path: tmp('plain-root-') };

    const result = await manager.bind({ session, root, account: { syncBase: '/_/sync' }, mode: 'existing' });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [['start', false], ['startRunner']]);
    assert.deepEqual(manager.settingsStore.get().syncSessions.map((s) => s.id), ['s1']);
  });
});
