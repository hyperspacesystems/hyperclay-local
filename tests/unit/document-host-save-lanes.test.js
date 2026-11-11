// M1a/S1: the save lane as four named functions. Every fixture below drives the
// host's own lanes -- the halves commitSave calls, in the order it calls them --
// against a real temp root and a real live object, so what is asserted is the
// bytes and the calls a save actually makes, not a restatement of the code.

const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createRootDocumentHost } = require('../../src/main/document-host');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'document-host-lanes-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  jest.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function hostFor(dir, { live, localAuthority = null } = {}) {
  return createRootDocumentHost({
    ctx: { root: { id: `lanes-${upath.basename(dir)}`, path: dir }, localAuthority },
    live: live || { markBrowserSave: () => {}, broadcast: jest.fn(), notify: jest.fn() },
  });
}

function listing(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = upath.join(dir, entry.name);
      const relative = upath.relative(root, full);
      if (entry.isDirectory()) {
        out.push({ path: relative, type: 'dir' });
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out.push({ path: relative, type: 'file', size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return out;
}

// An unformatted page that links the site's Tailwind stylesheet: scopeTailwindLink
// and formatHtml both change these bytes on the way to disk.
const UNFORMATTED = '<!DOCTYPE html><html formathtml="true"><head><title>tw</title>'
  + '<link rel="stylesheet" href="/tailwindcss/tw.css"></head>'
  + '<body><div><p>hello</p></div></body></html>';

test('prepareSave returns the logical document a save then stores', async () => {
  const dir = tempDir();
  const host = hostFor(dir);
  const filePath = upath.join(dir, 'tw.html');
  const bytes = UNFORMATTED;

  const prepared = await host.lanes.prepareSave({ name: 'tw.html', bytes });
  const result = await host.commit({
    kind: 'browser-save', name: 'tw.html', filePath, bytes, userDriven: true,
  });

  expect(result.outcome).toBe('committed');
  expect(prepared.content).not.toBe(bytes);
  expect(prepared.content).toBe(result.content);
  expect(prepared.fileContent).toBe(result.file);
});

test('prepareSave writes nothing', async () => {
  const dir = tempDir();
  fs.writeFileSync(upath.join(dir, 'tw.html'), UNFORMATTED);
  fs.mkdirSync(upath.join(dir, '.hyperclay', 'versions', 'tw'), { recursive: true });
  fs.writeFileSync(upath.join(dir, '.hyperclay', 'versions', 'tw', 'older.html'), '<!DOCTYPE html><html><body><p>v1</p></body></html>');
  const host = hostFor(dir);

  const before = listing(dir);
  const prepared = await host.lanes.prepareSave({ name: 'tw.html', bytes: UNFORMATTED });
  const after = listing(dir);

  expect(prepared.content).toEqual(expect.any(String));
  expect(after).toEqual(before);
});

test('settleSave with no authority morphs the viewers with the file part', async () => {
  const dir = tempDir();
  const live = { markBrowserSave: () => {}, broadcast: jest.fn(), notify: jest.fn() };
  const host = hostFor(dir, { live });
  const content = '<!DOCTYPE html><html><body><p>saved</p></body></html>';
  const fileContent = '<!DOCTYPE html><html><body><p>file part</p></body></html>';

  await host.lanes.settleSave({ name: 'a.html', origin: 'save', content, fileContent });

  expect(live.broadcast).toHaveBeenCalledTimes(1);
  expect(live.broadcast).toHaveBeenCalledWith('a.html', { html: fileContent, sender: 'server-save' }, { lane: 'saved' });
  expect(live.notify).not.toHaveBeenCalled();

  live.broadcast.mockClear();
  live.notify.mockClear();

  await host.lanes.settleSave({ name: 'a.html', origin: 'api', content, fileContent });

  expect(live.notify).toHaveBeenCalledTimes(1);
  const [, payload] = live.notify.mock.calls[0];
  expect(payload.data.kind).toBe('external-change');
  expect(payload.data.sender).toBe('data-api');
  expect(live.broadcast).toHaveBeenCalledTimes(1);
  expect(live.broadcast).toHaveBeenCalledWith('a.html', { html: fileContent, sender: 'data-api' }, { lane: 'saved' });
});

// The installed rooms package decides pageLineageLost from a room's transition and
// its page store, so the room below is shaped to reach the replacement branch and
// the fake authority's checkPersistent then refuses the save after the reservation
// is held. The admission is the host's real one; only the authority is a stand-in,
// because a real room cannot be made lineage-lost without a live editor session.
test('admitSave releases its reservation when the admission throws after reserving', async () => {
  const dir = tempDir();
  const filePath = upath.join(dir, 'a.html');
  const released = [];
  const rooms = {
    get: () => ({ nodeId: 'node-1', blockeditorTransition: { format: 'yjs' }, stores: new Map([['blockeditor', true]]) }),
    reservePageReplacement: () => 'tok',
    releasePage: (token) => { released.push(token); },
    checkPersistent: () => { throw new Error('persistent reservation is stale'); },
    commitPage: () => { throw new Error('the refused save must never commit its reservation'); },
  };
  const authority = {
    rooms,
    roomIsDirty: () => false,
    admittedFormats: () => null,
  };
  const host = hostFor(dir, { localAuthority: authority });
  const content = '<!DOCTYPE html><html><body><p>replacement</p></body></html>';

  await expect(host.lanes.admitSave({
    name: 'a.html', filePath, origin: 'save', content, fileContent: content,
    target: { identity: 'node-1' }, token: 'ctx-token', persistentToken: 'stale-token',
  })).rejects.toThrow('persistent reservation is stale');

  expect(released).toEqual(['tok']);
});
