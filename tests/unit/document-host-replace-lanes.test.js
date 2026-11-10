// M1b/S1: the replace, rebase, exact and create lanes as named halves. Every
// fixture below drives the host's own lanes against a real temp root and a real
// live object, so what is asserted is the bytes and the calls a restore actually
// makes, not a restatement of the code.

const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createRootDocumentHost } = require('../../src/main/document-host');
const roomsPackage = require('@panphora/clayjs/server/rooms');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'document-host-replace-lanes-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  jest.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function hostFor(dir, { live, localAuthority = null } = {}) {
  return createRootDocumentHost({
    ctx: { root: { id: `replace-lanes-${upath.basename(dir)}`, path: dir }, localAuthority },
    live: live || { markBrowserSave: () => {}, broadcast: jest.fn(), notify: jest.fn() },
  });
}

// An unformatted page whose root tag carries response-scoped metadata and whose
// head links the site's Tailwind stylesheet: stripSaveToken, scopeTailwindLink and
// formatHtml all change these bytes on the way to disk.
const UNFORMATTED = '<!DOCTYPE html><html formathtml="true" savetoken="secret-tok">'
  + '<head><title>restore</title><link rel="stylesheet" href="/tailwindcss/restore.css"></head>'
  + '<body><div><p>hello</p></div></body></html>';

const CURRENT = '<!DOCTYPE html><html><head><title>current</title></head><body><p>current</p></body></html>';

test('prepareReplace returns what a restore stores', async () => {
  const dir = tempDir();
  const host = hostFor(dir);
  const filePath = upath.join(dir, 'restore.html');

  const prepared = await host.lanes.prepareReplace({ name: 'restore.html', bytes: UNFORMATTED });
  const result = await host.commit({ kind: 'restore', name: 'restore.html', filePath, bytes: UNFORMATTED });

  expect(result.outcome).toBe('committed');
  expect(prepared.content).toBe(result.content);
  expect(prepared.content).not.toBe(UNFORMATTED);
  expect(prepared.content).not.toContain('secret-tok');
  expect(prepared.fileContent).toBe(fs.readFileSync(filePath, 'utf8'));
});

test('admitReplace backs up the current bytes and answers no refusal', async () => {
  const dir = tempDir();
  const host = hostFor(dir);
  const recorded = [];
  const currentHtml = CURRENT;

  const admitted = await host.lanes.admitReplace({
    name: 'a.html',
    filePath: upath.join(dir, 'a.html'),
    content: '<!DOCTYPE html><html><body><p>new</p></body></html>',
    safety: true,
    readCurrent: async () => Buffer.from(currentHtml),
    writeSafetyVersion: async html => { recorded.push(html); return true; },
  });

  expect(admitted).toEqual({ pageToken: null, refusal: null });
  expect(recorded).toEqual([currentHtml]);
});

test('admitReplace refuses when the safety backup fails', async () => {
  const dir = tempDir();
  const host = hostFor(dir);
  const written = [];

  const admitted = await host.lanes.admitReplace({
    name: 'a.html',
    filePath: upath.join(dir, 'a.html'),
    content: '<!DOCTYPE html><html><body><p>new</p></body></html>',
    safety: true,
    readCurrent: async () => Buffer.from(CURRENT),
    writeSafetyVersion: async html => { written.push(html); return false; },
  });

  expect(admitted).toEqual({ pageToken: null, refusal: 'backup-failed' });
  expect(written).toEqual([CURRENT]);
});

test('admitReplace refuses an unreadable current file without backing anything up', async () => {
  const dir = tempDir();
  const host = hostFor(dir);
  const writeSafetyVersion = jest.fn(async () => true);
  const error = new Error('permission denied');
  error.code = 'EACCES';

  const admitted = await host.lanes.admitReplace({
    name: 'a.html',
    filePath: upath.join(dir, 'a.html'),
    content: '<!DOCTYPE html><html><body><p>new</p></body></html>',
    safety: true,
    readCurrent: async () => { throw error; },
    writeSafetyVersion,
  });

  expect(admitted).toEqual({ pageToken: null, refusal: 'room-unavailable' });
  expect(writeSafetyVersion).not.toHaveBeenCalled();
});

test('admitReplace treats a missing current file as nothing to back up', async () => {
  const dir = tempDir();
  const host = hostFor(dir);
  const writeSafetyVersion = jest.fn(async () => true);
  const error = new Error('missing');
  error.code = 'ENOENT';

  const admitted = await host.lanes.admitReplace({
    name: 'a.html',
    filePath: upath.join(dir, 'a.html'),
    content: '<!DOCTYPE html><html><body><p>new</p></body></html>',
    safety: true,
    readCurrent: async () => { throw error; },
    writeSafetyVersion,
  });

  expect(admitted).toEqual({ pageToken: null, refusal: null });
  expect(writeSafetyVersion).not.toHaveBeenCalled();
});

test('admitReplace releases its reservation on a refusal', async () => {
  const dir = tempDir();
  const filePath = upath.join(dir, 'a.html');
  const releasePage = jest.fn();
  const authority = {
    rooms: {
      reservePageReplacement: () => 'tok',
      releasePage,
      get: () => null,
    },
  };
  const host = hostFor(dir, { localAuthority: authority });

  const admitted = await host.lanes.admitReplace({
    name: 'a.html',
    filePath,
    content: '<!DOCTYPE html><html><body><p>new</p></body></html>',
    safety: true,
    target: { identity: 'node-1', canonicalPath: filePath },
    token: 'ctx-token',
    readCurrent: async () => Buffer.from(CURRENT),
    writeSafetyVersion: async () => false,
  });

  expect(admitted).toEqual({ pageToken: null, refusal: 'backup-failed' });
  expect(releasePage).toHaveBeenCalledTimes(1);
  expect(releasePage).toHaveBeenCalledWith('tok');
});

test('settleReplace with no authority broadcasts the file part', async () => {
  const dir = tempDir();
  const live = { markBrowserSave: () => {}, broadcast: jest.fn(), notify: jest.fn() };
  const host = hostFor(dir, { live });
  const content = UNFORMATTED;

  await host.lanes.settleReplace({ name: 'a.html', content });

  expect(live.broadcast).toHaveBeenCalledTimes(1);
  const [name, payload, options] = live.broadcast.mock.calls[0];
  expect(name).toBe('a.html');
  expect(payload).toEqual({ html: roomsPackage.splitPage(content).file, sender: 'server-save' });
  expect(options).toEqual({ lane: 'saved' });
});
