const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createDocumentHost } = require('../../src/main/document-host');
const { atomicWriteFile, withStructureChange, withDocumentWrite, assertStructureContext, assertWriteContext } = require('../../src/main/utils/write-queue');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { createLocalCheckpoint } = require('../../src/main/local-checkpoint');
const { storePageState, logicalDocument } = require('../../src/main/page-state-store');
const { pageFixture } = require('../helpers/page-fixture');
const { mockExports } = require('../helpers/mock-exports');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'local-authority-win-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  jest.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const readOrNull = (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);

function makeHost(overrides = {}) {
  const { filePath: requestedPath, calls: providedCalls, ...depOverrides } = overrides;
  const dir = depOverrides.baseDir || tempDir();
  const filePath = requestedPath || upath.join(dir, 'page.html');
  const calls = providedCalls || [];
  const state = {
    filePath,
    contentAtStore: undefined,
    contentAtMark: undefined,
    contentAtCommit: undefined,
    backupArgs: null,
  };

  const deps = {
    ctx: {},
    baseDir: dir,
    live: {
      markBrowserSave: (name) => {
        calls.push('markBrowserSave');
        state.contentAtMark = readOrNull(filePath);
      },
      broadcast: jest.fn(),
      notify: jest.fn(),
    },
    store: { etags: new Map(), snapshots: new Map() },
    resolveTailwindWrite: async (tailwindName) => upath.join(dir, 'tailwind', `${tailwindName}.css`),
    canonicalForWrite: (html) => { calls.push('canonicalForWrite'); return html; },
    formatHtml: (html) => { calls.push('formatHtml'); return html; },
    scopeTailwindLink: (name, html) => { calls.push('scopeTailwindLink'); return html; },
    stripSaveToken: (bytes) => { calls.push('stripSaveToken'); return bytes; },
    splitWrite: async (baseDir, name, formatted) => {
      calls.push('splitWrite');
      return { file: formatted, logical: formatted };
    },
    storePageState: async (baseDir, name, logical) => {
      calls.push('storePageState');
      state.contentAtStore = readOrNull(filePath);
      return logical;
    },
    createBackup: async (...args) => {
      calls.push('createBackup');
      state.backupArgs = args;
      return true;
    },
    atomicWriteFile,
    assertWriteContext: (token, canonicalPath) => { calls.push('assertWriteContext'); },
    writeApiSidecar: async () => { calls.push('writeApiSidecar'); },
    getTailwindCssName: () => null,
    compileTailwind: async () => { calls.push('compileTailwind'); return ''; },
    dataGuard: mockExports('src/main/data-loss-guard', {
      provenanceForLocalSave: (userDriven) => 'prov:' + userDriven,
      runDataLossGuard: jest.fn(() => {
        calls.push('runDataLossGuard');
        return Promise.resolve();
      }),
    }),
    documentEtag: (html) => 'etag:' + html,
    rebaseStaleSave: async () => null,
    newestVersionFiles: async () => [],
    needsAdoption: () => false,
    roomsPackage: () => ({ splitPage: (h) => ({ file: h }) }),
    writePageState: async (...args) => { calls.push('writePageState'); return args; },
    logicalDocument: async (baseDir, name, file) => { calls.push('logicalDocument'); return file; },
    createBackupIfExists: async (...args) => { calls.push('createBackupIfExists'); return args; },
    createBinaryBackupIfExists: async (...args) => { calls.push('createBinaryBackupIfExists'); return args; },
    assertStructureContext: (token) => { calls.push('assertStructureContext'); },
    stripCopyBytes: (bytes) => bytes,
    refreshDerivedArtifacts: async (...args) => { calls.push('refreshDerivedArtifacts'); return args; },
    emit: () => { calls.push('emit'); },
    logger: null,
    MAX_EXTERNAL_HTML: 1000000,
    VERSIONS_DIR: '.hyperclay/versions',
    TAILWIND_DIR: '.hyperclay/tailwindcss',
    ...depOverrides,
  };

  const host = createDocumentHost(deps);
  return { host, deps, calls, dir, filePath, state, live: deps.live };
}

function structureHost(root, registeredRoot = root) {
  let ids = 0;
  const authority = createLocalAuthority({
    withDocument: (resolveTarget, fn) => Promise.resolve().then(async () => fn(await resolveTarget())),
    readSaved: async () => '<html></html>',
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  authority.registerRoot({ id: 'root-a', canonicalPath: registeredRoot, path: registeredRoot }, { owner: 'server' });
  const { host } = makeHost({ baseDir: root, ctx: { localAuthority: authority }, assertStructureContext });
  return { authority, host };
}

test('a root registered with native separators still admits a structure step and one document identity', async () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const from = upath.join(root, 'a.html');
  const renamed = upath.join(root, 'c.html');
  fs.writeFileSync(from, 'a');
  const { authority, host } = structureHost(root, winRoot);

  const bound = authority.bindTarget({
    rootId: 'root-a', logicalPath: 'a.html', canonicalPath: from, origin: 'http://localhost',
  });
  authority.registerEditor(bound, { clientId: 'client-1', send: () => {} });
  expect(authority.connectedIds(winRoot + '\\a.html')).toEqual(['client-1']);

  const result = await withStructureChange(token => host.restructure({
    kind: 'move',
    rootId: 'root-a',
    steps: [{ from: 'a.html', to: 'c.html' }],
    context: {
      token,
      entries: [{ from: { location: from, canonical: from, isDir: false, isSymlink: false }, to: { location: renamed, canonical: renamed } }],
    },
  }));

  expect(result).toMatchObject({ outcome: 'committed', completed: 1, reason: null });
  expect(fs.readFileSync(renamed, 'utf8')).toBe('a');
  expect(fs.existsSync(from)).toBe(false);
  expect(authority.connectedIds(upath.join(root, 'a.html')))
    .toEqual(authority.connectedIds(winRoot + '\\a.html'));

  const moved = authority.bindTarget({
    rootId: 'root-a', logicalPath: 'c.html', canonicalPath: winRoot + '\\c.html', origin: 'http://localhost',
  });
  authority.registerEditor(moved, { clientId: 'client-2', send: () => {} });
  expect(authority.connectedIds(winRoot + '\\c.html')).toEqual(['client-2']);
  expect(authority.connectedIds(upath.join(root, 'c.html'))).toEqual(['client-2']);
});

test('a target bound with native separators carries the one canonical form', () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const { authority } = structureHost(root);

  const bound = authority.bindTarget({
    rootId: 'root-a', logicalPath: 'a.html', canonicalPath: `${winRoot}\\a.html`, origin: 'http://localhost',
  });

  expect(bound.canonicalPath).toBe(upath.join(root, 'a.html'));
  expect(authority.rooms.get(bound.canonicalPath)).toBe(authority.rooms.get(upath.join(root, 'a.html')));
});

test('a staged write target carries the one canonical form under a native boundary', async () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const file = upath.join(root, 'new.html');
  const authority = createLocalAuthority({
    withDocument: withDocumentWrite,
    readSaved: async () => '<html></html>',
    now: () => 1000,
    newId: () => 'id-1',
  });
  authority.registerRoot({ id: 'root-a', canonicalPath: root, path: root }, { owner: 'server' });
  const claim = authority.captureAdmission({ rootId: 'root-a', logicalPath: 'new.html', canonicalPath: file });

  const staged = await withDocumentWrite(
    () => ({ canonicalPath: `${winRoot}\\new.html` }),
    async (_locked, token) => authority.admitWriteTarget(claim, {
      rootId: 'root-a', logicalPath: 'new.html', canonicalPath: `${winRoot}\\new.html`, origin: 'http://localhost',
    }, token, { explicitCreate: true }),
  );

  expect(staged.canonicalPath).toBe(file);
});

test('a checkpoint attempt named with native separators finds the document room', async () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const file = upath.join(root, 'page.html');
  const fixture = pageFixture('abc');
  fs.writeFileSync(file, await storePageState(root, 'page.html', fixture.html));
  const authority = createLocalAuthority({
    withDocument: (resolveTarget, fn) => Promise.resolve().then(async () => fn(await resolveTarget())),
    readSaved: async () => logicalDocument(root, 'page.html', fs.readFileSync(file, 'utf8')),
    now: () => 1000,
    newId: () => 'id-1',
    pageCompaction: false,
  });
  authority.registerRoot({ id: 'root-a', canonicalPath: root, path: root }, { owner: 'server' });
  const target = authority.bindTarget({
    rootId: 'root-a', logicalPath: 'page.html', canonicalPath: `${winRoot}\\page.html`, origin: 'http://localhost',
  });
  const room = await authority.roomFor(target, () => ({
    rootId: 'root-a', logicalPath: 'page.html', canonicalPath: upath.join(root, 'page.html'), identity: target.identity,
  }));
  const edited = authority.rooms.apply(room, 'editor', {
    name: 'blockeditor', n: 1, epoch: room.epoch, blockeditorGeneration: room.blockeditorTransition?.id ?? null,
    ops: [{ op: 'set', path: ['y', 'edit-1'], value: fixture.update }],
  });
  expect(edited.error).toBeUndefined();

  const checkpoint = createLocalCheckpoint({
    authority, logError: () => {},
    setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
  });
  checkpoint.registerHost('root-a', { checkpoint: async () => ({ kind: 'ok', written: fixture.html }) });

  const result = await checkpoint.attempt(`${winRoot}\\page.html`);

  expect(result.kind).toBe('ok');
});

test('a room named by the native path is the one the auto-namer settles', async () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const page = upath.join(root, 'untitled.html');
  const html = '<article data-blockeditor><h1>First Heading</h1></article>';
  fs.writeFileSync(page, html);
  // The key a Windows caller holds: backslashes, as fs.watch and path.join give it.
  const nativeKey = `${winRoot}\\untitled.html`;
  const room = { key: nativeKey, nodeId: 'node-1', emptySince: 1000 };
  const authority = {
    rooms: new Map([[nativeKey, room]]),
    identityAt: () => room.nodeId,
    hasParticipatingEditors: () => false,
    checkpointTargets: () => [{ rootId: 'root-a', logicalPath: 'untitled.html' }],
  };
  const { createAutoNamer } = require('../../src/main/workspace/auto-name');
  const renames = [];
  const namer = createAutoNamer({
    appDataPath: tempDir(), authority,
    checkpoint: { dirty: () => false, pending: () => null },
    rootFor: () => ({ id: 'root-a', path: root }),
    rename: async (_root, from, name) => {
      renames.push(name);
      fs.renameSync(upath.join(root, from), upath.join(root, name));
      return { path: name };
    },
  });
  try {
    await namer.record({ id: 'root-a', path: root }, 'untitled.html', 'blockeditor');
    await namer.settle(nativeKey);
  } finally { namer.close(); }

  expect(renames).toEqual(['first-heading.html']);
  expect(fs.readFileSync(upath.join(root, 'first-heading.html'), 'utf8')).toBe(html);
});

test('a checkpoint attempt names a natively keyed room by its native path', async () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const page = upath.join(root, 'doc.html');
  fs.writeFileSync(page, '<html><body></body></html>');
  const nativeKey = `${winRoot}\\doc.html`;
  const room = { key: nativeKey, nodeId: 'node-1', emptySince: 1000 };
  const authority = {
    rooms: new Map([[nativeKey, room]]),
    roomIsDirty: () => true,
    hasParticipatingEditors: () => false,
    checkpointTargets: () => [{ rootId: 'root-a', identity: 'node-1', logicalPath: 'doc.html' }],
    captureAdmission: () => ({}),
    validateAdmission: () => {},
    reconcileDisk: async () => ({ kind: 'current' }),
  };
  const checkpoint = createLocalCheckpoint({
    authority, logError: () => {},
    setTimer: () => ({ unref: () => {} }), clearTimer: () => {},
  });
  checkpoint.registerHost('root-a', { checkpoint: async () => ({ kind: 'refused', reason: 'invalid-document' }) });

  const result = await checkpoint.attempt(nativeKey);

  expect(result.reason).toBe('invalid-document');
});

test('a document boundary opened on a native path owns the canonical path', async () => {
  const root = tempDir();
  const winRoot = root.split('/').join('\\');
  const page = upath.join(root, 'A.html');
  fs.writeFileSync(page, 'a');

  const context = await withDocumentWrite(
    async () => ({ canonicalPath: `${winRoot}\\A.html` }),
    async (_target, token) => {
      assertWriteContext(token, page);
      return 'written';
    },
  );

  expect(context).toBe('written');
});
