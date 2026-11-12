const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createDocumentHost } = require('../../src/main/document-host');
const { atomicWriteFile, withStructureChange, assertStructureContext } = require('../../src/main/utils/write-queue');
const { createLocalAuthority } = require('../../src/main/local-authority');
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
