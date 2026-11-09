const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createDocumentHost, createRootDocumentHost } = require('../../src/main/document-host');
const writeQueue = require('../../src/main/utils/write-queue');
const { atomicWriteFile, withFileLock, withStructureChange, assertStructureContext } = require('../../src/main/utils/write-queue');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { calculateChecksum } = require('../../src/sync-engine/utils');
const { mockExports } = require('../helpers/mock-exports');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'document-host-')));
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
    splitWriteOptions: undefined,
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
    splitWrite: async (baseDir, name, formatted, options) => {
      calls.push('splitWrite');
      state.splitWriteOptions = options;
      return { file: formatted, logical: formatted };
    },
    storePageState: async (baseDir, name, logical, durable) => {
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

function authorityStub(calls, filePath, state) {
  return {
    rooms: {
      reservePageReplacement: (path, options) => {
        calls.push('reservePageReplacement');
        return 'page-token';
      },
      commitPage: (token) => {
        calls.push('commitPage');
        state.contentAtCommit = readOrNull(filePath);
      },
      releasePage: (token) => { calls.push('releasePage'); },
    },
    confirmKnownWrite: async () => { calls.push('confirmKnownWrite'); },
  };
}

test('a missing dependency throws a TypeError naming it', () => {
  const { deps } = makeHost();
  delete deps.store;
  expect(() => createDocumentHost(deps)).toThrow(TypeError);
  expect(() => createDocumentHost(deps)).toThrow('store');
});

test('an unknown or absent kind throws and an unmigrated one says so', async () => {
  const { host, filePath } = makeHost();
  await expect(host.commit({ name: 'page.html', filePath })).rejects.toThrow(TypeError);
  await expect(host.commit({ kind: 'nope', name: 'page.html', filePath })).rejects.toThrow(TypeError);
  await expect(host.commit({ kind: 'constructor', name: 'page.html', filePath })).rejects.toThrow(TypeError);
  await expect(host.commit({ kind: 'workspace', name: 'page.html', filePath })).rejects.toThrow('not migrated yet');
});

test('sync-download writes bytes byte for byte without running any formatter', async () => {
  const { host, calls, filePath, state } = makeHost();
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]);

  const result = await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes });

  expect(result.outcome).toBe('committed');
  const written = fs.readFileSync(filePath);
  expect(written.equals(bytes)).toBe(true);
  expect(await calculateChecksum(written)).toBe(await calculateChecksum(bytes));
  for (const name of ['formatHtml', 'scopeTailwindLink', 'canonicalForWrite', 'stripSaveToken', 'storePageState']) {
    expect(calls).not.toContain(name);
  }
  expect(state.contentAtMark.equals(bytes)).toBe(true);
});

test('sync-download of a document stores it, stamps modifiedAt and checksums the file', async () => {
  const { host, filePath, calls } = makeHost();
  const html = '<html><body>exported</body></html>';
  const modifiedAt = Date.UTC(2020, 0, 2, 3, 4, 5);

  const result = await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: html, modifiedAt });

  expect(result.outcome).toBe('committed');
  expect(fs.readFileSync(filePath, 'utf8')).toBe(html);
  expect(Math.floor(fs.statSync(filePath).mtimeMs)).toBe(modifiedAt);
  expect(result.checksum).toBe(await calculateChecksum(fs.readFileSync(filePath)));
  expect(calls).toContain('createBackupIfExists');
  expect(calls).not.toContain('createBinaryBackupIfExists');
});

test('sync-download writes the page sidecar before the file', async () => {
  const seen = {};
  const { host, filePath } = makeHost({
    writePageState: async (baseDir, name, record) => {
      seen.existed = fs.existsSync(filePath);
      seen.record = record;
    },
  });
  const html = '<html><body>exported</body></html>';
  const pageRecord = { rev: 7 };

  const result = await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: html, pageRecord });

  expect(result.outcome).toBe('committed');
  expect(seen.record).toBe(pageRecord);
  expect(seen.existed).toBe(false);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(html);
});

test('sync-download of a Buffer runs no document lane and backs up as binary', async () => {
  const { host, filePath, calls, deps } = makeHost();
  const bytes = Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80]);

  const result = await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes });

  expect(result.outcome).toBe('committed');
  expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
  for (const name of ['storePageState', 'writePageState', 'logicalDocument', 'refreshDerivedArtifacts', 'runDataLossGuard', 'createBackupIfExists']) {
    expect(calls).not.toContain(name);
  }
  expect(calls).toContain('createBinaryBackupIfExists');
  expect(deps.dataGuard.runDataLossGuard).not.toHaveBeenCalled();
});

function exactAuthority(seen, { dirty = false, get = () => ({ id: 'room' }) } = {}) {
  return {
    rooms: { get },
    roomIsDirty: () => dirty,
    confirmKnownWrite: async (target, html, token, options) => {
      seen.confirmed = { target, html, token, options };
    },
    observeExternal: async (target, html, token) => {
      seen.observed = { target, html, token };
    },
  };
}

test('an authority write confirms a clean room with the composed document', async () => {
  const seen = {};
  const authority = exactAuthority(seen);
  const { host, filePath, calls } = makeHost({
    ctx: { localAuthority: authority },
    logicalDocument: async (baseDir, name, stored) => {
      calls.push('logicalDocument');
      return '<html><body>composed</body></html>';
    },
  });
  const target = { canonicalPath: filePath };
  const html = '<html><body>transport</body></html>';

  const result = await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: html, context: { target, token: 'tok' } });

  expect(result.outcome).toBe('committed');
  expect(seen.confirmed).toEqual({
    target, html: '<html><body>composed</body></html>', token: 'tok', options: { sender: 'sync-engine' },
  });
  expect(seen.observed).toBe(undefined);
  expect(calls).toContain('assertWriteContext');
});

test('an authority write over a dirty room observes the download as external', async () => {
  const seen = {};
  const authority = exactAuthority(seen, { dirty: true });
  const { host, filePath, calls } = makeHost({
    ctx: { localAuthority: authority },
    logicalDocument: async (baseDir, name, stored) => {
      calls.push('logicalDocument');
      return '<html><body>composed</body></html>';
    },
  });
  const target = { canonicalPath: filePath };

  const result = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath,
    bytes: '<html><body>transport</body></html>', context: { target, token: 'tok' },
  });

  expect(result.outcome).toBe('committed');
  expect(seen.observed).toEqual({ target, html: '<html><body>composed</body></html>', token: 'tok' });
  expect(seen.confirmed).toBe(undefined);
});

test('the data-loss guard sees the previous body and the root live object', async () => {
  const { host, filePath, dir, live, deps } = makeHost();
  fs.writeFileSync(filePath, 'old document');
  const html = '<html><body>new</body></html>';

  await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: html });

  expect(deps.dataGuard.runDataLossGuard).toHaveBeenCalledWith({
    baseDir: dir, name: 'page.html', newHtml: html, prevContent: 'old document', prov: 'external', live,
  });
});

test('a utimes failure is indeterminate and leaves the new bytes on disk', async () => {
  jest.spyOn(fs.promises, 'utimes').mockRejectedValueOnce(new Error('utimes failed'));
  const { host, filePath } = makeHost();
  const html = '<html><body>new</body></html>';

  const result = await host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: html, modifiedAt: 1000 })
    .catch((error) => error);

  expect(result.outcome).toBe('indeterminate');
  expect(fs.readFileSync(filePath, 'utf8')).toBe(html);
});

test('a failing authority confirm is indeterminate and leaves the new bytes on disk', async () => {
  const authority = {
    rooms: { get: () => null },
    roomIsDirty: () => false,
    confirmKnownWrite: async () => { throw new Error('confirm failed'); },
    observeExternal: async () => {},
  };
  const { host, filePath } = makeHost({ ctx: { localAuthority: authority } });
  const html = '<html><body>new</body></html>';

  const result = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes: html,
    context: { target: { canonicalPath: filePath }, token: 'tok' },
  }).catch((error) => error);

  expect(result.outcome).toBe('indeterminate');
  expect(fs.readFileSync(filePath, 'utf8')).toBe(html);
});

test('a failure before the replacement rejects and leaves the old bytes', async () => {
  const { host, filePath } = makeHost({
    createBackupIfExists: async () => { throw new Error('backup failed'); },
  });
  fs.writeFileSync(filePath, 'old document');

  await expect(host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: '<html><body>new</body></html>' }))
    .rejects.toThrow('backup failed');
  expect(fs.readFileSync(filePath, 'utf8')).toBe('old document');
});

test('a wrong expected checksum refuses without touching the file', async () => {
  const { host, calls, filePath } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');
  const bytes = Buffer.from('new bytes');

  const result = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes,
    expected: { type: 'checksum', value: 'wrong' },
  });

  expect(result).toEqual({ outcome: 'refused', reason: 'changed', etag: null, stored: null, content: null });
  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');
  expect(calls).not.toContain('createBackup');
});

test('expected absent refuses an existing file and commits a missing one', async () => {
  const { host, filePath } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');
  const bytes = Buffer.from('new bytes');

  const refused = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes, expected: { type: 'absent' },
  });
  expect(refused.outcome).toBe('refused');
  expect(refused.reason).toBe('changed');
  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');

  fs.rmSync(filePath);
  const committed = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes, expected: { type: 'absent' },
  });
  expect(committed.outcome).toBe('committed');
  expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
});

test('the current checksum as expected commits', async () => {
  const { host, filePath } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');
  const checksum = await calculateChecksum(fs.readFileSync(filePath));
  const bytes = Buffer.from('new bytes');

  const result = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes,
    expected: { type: 'checksum', value: checksum },
  });

  expect(result.outcome).toBe('committed');
  expect(fs.readFileSync(filePath).equals(bytes)).toBe(true);
});

test('create writes the bytes through page-state storage and commits', async () => {
  const { host, calls, filePath, state } = makeHost();
  const html = '<html><body>new</body></html>';

  const result = await host.commit({
    kind: 'create', name: 'page.html', filePath, bytes: html, expected: { type: 'absent' },
  });

  expect(result.outcome).toBe('committed');
  expect(calls).toContain('storePageState');
  expect(state.contentAtStore).toBeNull();
  expect(fs.readFileSync(filePath, 'utf8')).toBe(html);
});

test('create over an existing file with expected absent refuses and leaves it unchanged', async () => {
  const { host, filePath } = makeHost();
  fs.writeFileSync(filePath, 'occupant');

  const result = await host.commit({
    kind: 'create', name: 'page.html', filePath, bytes: '<html>new</html>', expected: { type: 'absent' },
  });

  expect(result.outcome).toBe('refused');
  expect(result.reason).toBe('changed');
  expect(fs.readFileSync(filePath, 'utf8')).toBe('occupant');
});

function structureHost(root) {
  let ids = 0;
  const authority = createLocalAuthority({
    withDocument: (resolveTarget, fn) => Promise.resolve().then(async () => fn(await resolveTarget())),
    readSaved: async () => '<html></html>',
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  authority.registerRoot({ id: 'root-a', canonicalPath: root, path: root }, { owner: 'server' });
  const { host } = makeHost({ baseDir: root, ctx: { localAuthority: authority }, assertStructureContext });
  return { authority, host };
}

test('a structure transaction whose second rename fails commits the first step and releases', async () => {
  const root = tempDir();
  const from = upath.join(root, 'a.html');
  const renamed = upath.join(root, 'c.html');
  const missing = upath.join(root, 'missing.html');
  const untouched = upath.join(root, 'd.html');
  fs.writeFileSync(from, 'a');
  const { authority, host } = structureHost(root);
  const release = jest.spyOn(authority, 'releaseStructure');
  const before = authority.captureAdmission({ rootId: 'root-a', logicalPath: 'd.html', canonicalPath: untouched });

  const result = await withStructureChange(token => host.restructure({
    kind: 'move',
    rootId: 'root-a',
    steps: [{ from: 'a.html', to: 'c.html' }, { from: 'missing.html', to: 'd.html' }],
    context: {
      token,
      entries: [
        { from: { location: from, canonical: from, isDir: false, isSymlink: false }, to: { location: renamed, canonical: renamed } },
        { from: { location: missing, canonical: missing, isDir: false, isSymlink: false }, to: { location: untouched, canonical: untouched } },
      ],
    },
  }));

  expect(result.outcome).toBe('partial');
  expect(result.completed).toBe(1);
  expect(result.reason).toBe('ENOENT');
  expect(result.error.code).toBe('ENOENT');
  expect(fs.existsSync(renamed)).toBe(true);
  expect(fs.existsSync(from)).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
  expect(authority.captureAdmission({ rootId: 'root-a', logicalPath: 'd.html', canonicalPath: untouched })).toEqual(before);
});

test('a retired structure step gives the authority to null while the file reaches .trash/', async () => {
  const root = tempDir();
  fs.mkdirSync(upath.join(root, '.trash'));
  const from = upath.join(root, 'gone.html');
  const trashed = upath.join(root, '.trash', 'gone.html');
  fs.writeFileSync(from, 'gone');
  const { authority, host } = structureHost(root);
  const prepare = jest.spyOn(authority, 'prepareStructure');
  const release = jest.spyOn(authority, 'releaseStructure');

  const result = await withStructureChange(token => host.restructure({
    kind: 'trash',
    rootId: 'root-a',
    steps: [{ from: 'gone.html', to: '.trash/gone.html' }],
    context: {
      token,
      entries: [{ from: { location: from, canonical: from, isDir: false, isSymlink: false }, to: { location: trashed, canonical: trashed } }],
    },
  }));

  expect(result).toMatchObject({ outcome: 'committed', completed: 1, reason: null });
  expect(prepare).toHaveBeenCalledTimes(1);
  const plan = prepare.mock.results[0].value;
  expect(plan.preview.steps[0].to).toBeNull();
  expect(plan.preview.steps[0].toRel).toBeNull();
  expect(fs.readFileSync(trashed, 'utf8')).toBe('gone');
  expect(fs.existsSync(from)).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
});

test('a real sync-move puts the file at its destination and removes it from the source', async () => {
  const root = tempDir();
  const source = upath.join(root, 'page.html');
  const destination = upath.join(root, 'blog', 'page.html');
  fs.writeFileSync(source, '<p>moved</p>');
  const host = createRootDocumentHost({ ctx: { root: { id: 'root-a', path: root }, localAuthority: null } });

  const result = await host.restructure({
    kind: 'sync-move',
    rootId: 'root-a',
    steps: [{ from: 'page.html', to: 'blog/page.html' }],
    context: {
      token: null,
      entries: [{
        from: { location: source, canonical: source, isDir: false, isSymlink: false },
        to: { location: destination, canonical: destination },
      }],
    },
  });

  expect(result).toMatchObject({ outcome: 'committed', completed: 1, reason: null });
  expect(fs.readFileSync(destination, 'utf8')).toBe('<p>moved</p>');
  expect(fs.existsSync(source)).toBe(false);
});

test('two racing writes with the same expected checksum: one commits, one is refused', async () => {
  const { host, filePath } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');
  const checksum = await calculateChecksum(fs.readFileSync(filePath));
  const first = Buffer.from('first bytes');
  const second = Buffer.from('second bytes');
  const expected = { type: 'checksum', value: checksum };

  const results = await Promise.all([
    withFileLock(filePath, () => host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: first, expected })),
    withFileLock(filePath, () => host.commit({ kind: 'sync-download', name: 'page.html', filePath, bytes: second, expected })),
  ]);

  const committed = results.filter((result) => result.outcome === 'committed');
  const refusedResults = results.filter((result) => result.outcome === 'refused');
  expect(committed).toHaveLength(1);
  expect(refusedResults).toHaveLength(1);
  expect(refusedResults[0].reason).toBe('changed');
  expect(fs.readFileSync(filePath).equals(committed[0].stored)).toBe(true);
});

test('restore formats in the documented order and places bytes after the backup', async () => {
  const { host, calls, filePath, state } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');
  const html = '<html>new</html>';

  const result = await host.commit({ kind: 'restore', name: 'page.html', filePath, bytes: html });

  expect(calls.indexOf('stripSaveToken')).toBeLessThan(calls.indexOf('canonicalForWrite'));
  expect(calls.indexOf('canonicalForWrite')).toBeLessThan(calls.indexOf('scopeTailwindLink'));
  expect(calls.indexOf('scopeTailwindLink')).toBeLessThan(calls.indexOf('formatHtml'));
  expect(state.backupArgs[2]).toBe('<html>new</html>');
  expect(state.contentAtStore.toString()).toBe('old bytes');
  expect(state.contentAtMark.toString()).toBe(html);
  expect(result.outcome).toBe('committed');
  expect(result.content).toBe(html);
  expect(result.stored).toBe(html);
  expect(result.etag).toBe('etag:' + html);
});

test('restore and guard-restore never run the data-loss guard', async () => {
  const { host, calls, filePath } = makeHost();

  await host.commit({ kind: 'restore', name: 'page.html', filePath, bytes: '<html>restore</html>' });
  await host.commit({ kind: 'guard-restore', name: 'page.html', filePath, bytes: '<html>guard</html>' });

  expect(calls).not.toContain('runDataLossGuard');
});

test('a safety replace the room cannot back up refuses without a backup or a write', async () => {
  const { host, calls, filePath } = makeHost({
    ctx: { localCheckpoint: { safetyBackup: async () => { throw new Error('no room backup'); } } },
  });
  fs.writeFileSync(filePath, 'old bytes');

  const result = await host.commit({
    kind: 'restore', name: 'page.html', filePath, bytes: '<html>new</html>', safety: true,
  });

  expect(result.outcome).toBe('refused');
  expect(result.reason).toBe('room-unavailable');
  expect(calls).not.toContain('createBackup');
  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');
});

test('a safety replace whose safety backup fails refuses without a write', async () => {
  const { host, calls, filePath } = makeHost({ createBackup: async () => null });
  fs.writeFileSync(filePath, 'old bytes');

  const result = await host.commit({
    kind: 'restore', name: 'page.html', filePath, bytes: '<html>new</html>', safety: true,
  });

  expect(result.outcome).toBe('refused');
  expect(result.reason).toBe('backup-failed');
  expect(calls).not.toContain('storePageState');
  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');
});

test('without an authority the write broadcasts once on the saved lane', async () => {
  const { host, live, filePath } = makeHost();

  await host.commit({ kind: 'restore', name: 'page.html', filePath, bytes: '<html>new</html>' });

  expect(live.broadcast).toHaveBeenCalledTimes(1);
  expect(live.broadcast).toHaveBeenCalledWith(
    'page.html',
    { html: '<html>new</html>', sender: 'server-save' },
    { lane: 'saved' },
  );
});

test('with an authority the write reserves, commits and releases the page', async () => {
  const calls = [];
  const state = {};
  const dir = tempDir();
  const canonicalPath = upath.join(dir, 'page.html');
  const requestedPath = upath.join(dir, 'requested.html');
  const checkedPaths = [];
  const authority = authorityStub(calls, canonicalPath, state);
  const { host } = makeHost({
    calls,
    baseDir: dir,
    filePath: canonicalPath,
    ctx: { localAuthority: authority },
    assertWriteContext: (token, targetPath) => {
      calls.push('assertWriteContext');
      checkedPaths.push(targetPath);
    },
  });
  const target = { canonicalPath, identity: 'node-1' };
  const token = 'token-1';

  const result = await host.commit({
    kind: 'restore', name: 'page.html', filePath: requestedPath, bytes: '<html>new</html>',
    context: { target, token },
  });

  expect(result.outcome).toBe('committed');
  expect(calls).toContain('assertWriteContext');
  expect(checkedPaths).toEqual([canonicalPath]);
  expect(fs.readFileSync(canonicalPath, 'utf8')).toBe('<html>new</html>');
  expect(fs.existsSync(requestedPath)).toBe(false);
  expect(calls.indexOf('reservePageReplacement')).toBeLessThan(calls.indexOf('createBackup'));
  expect(calls.indexOf('markBrowserSave')).toBeLessThan(calls.indexOf('commitPage'));
  expect(calls.indexOf('commitPage')).toBeLessThan(calls.indexOf('confirmKnownWrite'));
  expect(state.contentAtCommit.toString()).toBe('<html>new</html>');
  expect(calls).toContain('releasePage');
});

test('an edit under an authority reserves nothing', async () => {
  const calls = [];
  const state = {};
  const dir = tempDir();
  const canonicalPath = upath.join(dir, 'page.html');
  const { host } = makeHost({
    calls,
    baseDir: dir,
    filePath: canonicalPath,
    ctx: { localAuthority: authorityStub(calls, canonicalPath, state) },
  });
  const target = { canonicalPath, identity: 'node-1' };

  const result = await host.commit({
    kind: 'restore', name: 'page.html', filePath: canonicalPath, bytes: '<html>edited</html>',
    edit: true,
    context: { target, token: 'token-1' },
  });

  expect(result.outcome).toBe('committed');
  expect(calls).not.toContain('reservePageReplacement');
  expect(calls).toContain('confirmKnownWrite');
  expect(calls).not.toContain('releasePage');
});

test('a failing write under an authority releases the page and propagates', async () => {
  const calls = [];
  const state = {};
  const dir = tempDir();
  const canonicalPath = upath.join(dir, 'page.html');
  const { host } = makeHost({
    calls,
    baseDir: dir,
    filePath: canonicalPath,
    atomicWriteFile: async () => { throw new Error('disk full'); },
    ctx: { localAuthority: authorityStub(calls, canonicalPath, state) },
  });
  const target = { canonicalPath, identity: 'node-1' };

  await expect(host.commit({
    kind: 'restore', name: 'page.html', filePath: canonicalPath, bytes: '<html>new</html>',
    context: { target, token: 'token-1' },
  })).rejects.toThrow('disk full');

  expect(calls).toContain('releasePage');
  expect(calls).not.toContain('commitPage');
});

test('a failing tailwind compile does not fail a restore and logs nothing', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { host, filePath } = makeHost({
      getTailwindCssName: () => 'page',
      compileTailwind: async () => { throw new Error('tailwind is missing'); },
    });

    const result = await host.commit({ kind: 'restore', name: 'page.html', filePath, bytes: '<html>new</html>' });

    expect(result.outcome).toBe('committed');
    expect(result.content).toBe('<html>new</html>');
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test('browser-save formats in the documented order and never strips a save token', async () => {
  const { host, calls, filePath } = makeHost();

  const result = await host.commit({
    kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>', userDriven: true, saveId: 'save-1',
  });

  expect(result.outcome).toBe('committed');
  expect(calls.indexOf('scopeTailwindLink')).toBeLessThan(calls.indexOf('formatHtml'));
  expect(calls.indexOf('formatHtml')).toBeLessThan(calls.indexOf('canonicalForWrite'));
  expect(calls).not.toContain('stripSaveToken');
});

test('browser-save stores the page state before the bytes land and marks after them', async () => {
  const { host, calls, filePath, state } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');

  await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>' });

  expect(state.contentAtStore.toString()).toBe('old bytes');
  expect(state.contentAtMark.toString()).toBe('<html>saved</html>');
  expect(calls.indexOf('storePageState')).toBeLessThan(calls.indexOf('markBrowserSave'));
});

test('browser-save returns the file part of the document as `file`', async () => {
  const { host, filePath } = makeHost({
    splitWrite: async (baseDir, name, formatted) => ({ file: `${formatted}-file`, logical: `${formatted}-logical` }),
  });

  const result = await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>' });

  expect(result.file).toBe('<html>saved</html>-file');
  expect(result.content).toBe('<html>saved</html>-logical');
});

test('commit refuses a caller still passing hooks', async () => {
  const { host, filePath } = makeHost();

  await expect(host.commit({
    kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>', hooks: {},
  })).rejects.toThrow('hooks ended in M16');
});

test('every commit and restructure result survives a JSON round trip and hides its cause', async () => {
  const pick = (result) => ({
    outcome: result.outcome, reason: result.reason, etag: result.etag, checksum: result.checksum,
  });
  const entry = (from, to) => ({
    from: { location: from, canonical: from, isDir: false, isSymlink: false },
    to: { location: to, canonical: to },
  });
  const dir = tempDir();
  const filePath = upath.join(dir, 'page.html');
  fs.writeFileSync(filePath, 'old bytes');
  const { host } = makeHost({ baseDir: dir, filePath });

  const committed = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes: Buffer.from('new bytes'),
  });
  const refusedResult = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes: Buffer.from('third bytes'),
    expected: { type: 'checksum', value: 'wrong' },
  });
  jest.spyOn(fs.promises, 'utimes').mockRejectedValueOnce(new Error('utimes failed'));
  const indeterminate = await host.commit({
    kind: 'sync-download', name: 'page.html', filePath, bytes: Buffer.from('fourth bytes'), modifiedAt: 1000,
  });
  const movedTo = upath.join(dir, 'moved.html');
  const movedStructure = await host.restructure({
    kind: 'sync-move',
    steps: [{ from: 'page.html', to: 'moved.html' }],
    context: { token: null, entries: [entry(filePath, movedTo)] },
  });
  const missing = upath.join(dir, 'missing.html');
  const partialStructure = await host.restructure({
    kind: 'move',
    steps: [{ from: 'moved.html', to: 'partial.html' }, { from: 'missing.html', to: 'other.html' }],
    context: {
      token: null,
      entries: [entry(movedTo, upath.join(dir, 'partial.html')), entry(missing, upath.join(dir, 'other.html'))],
    },
  });
  const failedStructure = await host.restructure({
    kind: 'move',
    steps: [{ from: 'missing.html', to: 'never.html' }],
    context: { token: null, entries: [entry(missing, upath.join(dir, 'never.html'))] },
  });

  const results = [committed, refusedResult, indeterminate, movedStructure, partialStructure, failedStructure];

  expect(results.map((result) => result.outcome))
    .toEqual(['committed', 'refused', 'indeterminate', 'committed', 'partial', 'failed']);
  expect(indeterminate.reason).toBe('after-rename');
  for (const result of results) {
    expect(JSON.parse(JSON.stringify(pick(result)))).toEqual(pick(result));
    expect(Object.keys(result)).not.toContain('error');
  }
});

test('a page conversion rebases nothing and splits without keeping state', async () => {
  const { host, filePath, deps, state } = makeHost({
    rebaseStaleSave: jest.fn(async () => ({ html: '<html>rebased</html>' })),
  });

  await host.commit({
    kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>converted</html>', pageConversion: { to: 2 },
  });

  expect(deps.rebaseStaleSave).not.toHaveBeenCalled();
  expect(state.splitWriteOptions).toEqual({ keepState: false });
});

test('browser-save records the stamp, the mtime, the writer and the save id', async () => {
  const { host, filePath, deps } = makeHost();

  await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>', userDriven: true, saveId: 'save-1' });

  const record = deps.store.etags.get(filePath);
  expect(record.etag).toBe('etag:<html>saved</html>');
  expect(record.mtimeNs).not.toBeNull();
  expect(record.writer).toBe('save');
  expect(record.saveId).toBe('save-1');
});

test('a file already holding the same bytes writes no new version', async () => {
  const dir = tempDir();
  const filePath = upath.join(dir, 'page.html');
  const html = '<html>same</html>';
  fs.mkdirSync(upath.join(dir, '.hyperclay', 'versions', 'page'), { recursive: true });
  fs.writeFileSync(upath.join(dir, '.hyperclay', 'versions', 'page', 'page.html'), 'v1');
  fs.writeFileSync(filePath, html);
  const backups = [];
  const { host } = makeHost({
    baseDir: dir,
    filePath,
    createBackup: async (...args) => { backups.push(args); return true; },
  });

  await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: html });

  expect(backups).toHaveLength(0);
});

test('a first save of an existing file backs up the existing bytes first', async () => {
  const dir = tempDir();
  const filePath = upath.join(dir, 'page.html');
  fs.writeFileSync(filePath, 'old bytes');
  const backups = [];
  const { host } = makeHost({
    baseDir: dir,
    filePath,
    createBackup: async (...args) => { backups.push(args); return true; },
  });

  await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>new</html>' });

  expect(backups[0][2]).toBe('old bytes');
  expect(backups[1][2]).toBe('<html>new</html>');
});

test('the guard runs with the save provenance, an external one for the data API, and never fails a save', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { host, deps, filePath } = makeHost();

    await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>a</html>', userDriven: true });
    expect(deps.dataGuard.runDataLossGuard).toHaveBeenCalledWith(expect.objectContaining({ prov: 'prov:true' }));

    await host.commit({ kind: 'data-api', name: 'page.html', filePath, bytes: '<html>b</html>' });
    expect(deps.dataGuard.runDataLossGuard).toHaveBeenLastCalledWith(expect.objectContaining({ prov: 'external' }));

    const rejecting = makeHost({
      dataGuard: mockExports('src/main/data-loss-guard', {
        provenanceForLocalSave: (userDriven) => 'prov:' + userDriven,
        runDataLossGuard: () => Promise.reject(new Error('guard blew up')),
      }),
    });
    const result = await rejecting.host.commit({
      kind: 'browser-save', name: 'page.html', filePath: rejecting.filePath, bytes: '<html>c</html>', userDriven: false,
    });
    expect(result.outcome).toBe('committed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test('a data API write reloads edit-mode tabs and each origin broadcasts with its own sender', async () => {
  const { host, live, filePath } = makeHost();

  await host.commit({ kind: 'data-api', name: 'page.html', filePath, bytes: '<html>api</html>' });

  expect(live.notify).toHaveBeenCalledWith('page.html', expect.objectContaining({
    action: 'reload',
    data: expect.objectContaining({ kind: 'external-change' }),
  }));
  expect(live.broadcast).toHaveBeenCalledWith('page.html', { html: '<html>api</html>', sender: 'data-api' }, { lane: 'saved' });

  await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>tab</html>' });

  expect(live.notify).toHaveBeenCalledTimes(1);
  expect(live.broadcast).toHaveBeenLastCalledWith('page.html', { html: '<html>tab</html>', sender: 'server-save' }, { lane: 'saved' });
});

test('the snapshot keeps an earlier html and takes the new userDriven bit', async () => {
  const { host, filePath, deps } = makeHost();
  deps.store.snapshots.set('page.html', { html: '<html>earlier</html>', userDriven: false, timestamp: 1 });

  await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>', userDriven: true });

  const snapshot = deps.store.snapshots.get('page.html');
  expect(snapshot.html).toBe('<html>earlier</html>');
  expect(snapshot.userDriven).toBe(true);
});

test('a tailwind failure does not fail a browser save and is logged', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { host, filePath } = makeHost({
      getTailwindCssName: () => 'page',
      compileTailwind: async () => { throw new Error('tailwind is missing'); },
    });

    const result = await host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>saved</html>' });

    expect(result.outcome).toBe('committed');
    expect(result.content).toBe('<html>saved</html>');
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test('a read identity that no longer matches the file rejects and writes nothing', async () => {
  const { host, filePath } = makeHost();
  fs.writeFileSync(filePath, 'old bytes');

  await expect(host.commit({
    kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>new</html>',
    readIdentity: { dev: 1n, ino: 1n, size: 1n, mtimeNs: 1n },
  })).rejects.toMatchObject({ code: 'moved-or-deleted' });

  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');
});

test('a checkpoint refuses when the room it was asked for is no longer the one at its key', async () => {
  const room = { nodeId: 'node-1' };
  const authority = {
    captureAdmission: () => ({}),
    validateAdmission: () => {},
    rooms: { get: () => ({ nodeId: 'node-1' }) },
    reconcileDisk: jest.fn(),
  };
  const { host, filePath } = makeHost({
    ctx: { localAuthority: authority },
    withDocument: async (resolveTarget, fn) => fn(await resolveTarget(), 'tok'),
    loadCheckpoint: async () => ({ captureCheckpoint: () => ({}) }),
  });
  fs.writeFileSync(filePath, '<html>old</html>');

  const result = await host.checkpoint(
    { name: 'page.html', filePath },
    { roomIdentity: 'node-1', generation: null },
    { target: { identity: 'node-1', canonicalPath: filePath }, room },
  );

  expect(result).toEqual({ kind: 'refused', reason: 'invalid-identity' });
  expect(authority.reconcileDisk).not.toHaveBeenCalled();
  expect(fs.readFileSync(filePath, 'utf8')).toBe('<html>old</html>');
});

test('a durable checkpoint that fails its directory sync is indeterminate, a plain save is not', async () => {
  const dir = tempDir();
  const checkpointPath = upath.join(dir, 'checkpoint.html');
  const browserPath = upath.join(dir, 'browser.html');
  fs.writeFileSync(checkpointPath, '<html>old</html>');
  const original = writeQueue.syncDirectory;
  const spy = jest.spyOn(writeQueue, 'syncDirectory')
    .mockRejectedValue(Object.assign(new Error('x'), { code: 'EIO' }));
  try {
    const room = { nodeId: 'node-1' };
    const authority = {
      rooms: { get: () => room, markSaved: () => {} },
      roomIsDirty: () => true,
      captureAdmission: () => ({}),
      validateAdmission: () => {},
      reconcileDisk: async () => ({ kind: 'current' }),
      admittedFormats: () => [],
      confirmKnownWrite: async () => {},
    };
    const checkpoint = makeHost({
      baseDir: dir, filePath: checkpointPath,
      ctx: { localAuthority: authority },
      withDocument: writeQueue.withDocumentWrite,
      loadCheckpoint: async () => ({
        captureCheckpoint: () => ({}),
        isCheckpointCurrent: () => false,
        renderCheckpoint: () => ({ kind: 'ok', html: '<html>cp</html>', revision: 'rev-1' }),
      }),
    });

    const result = await checkpoint.host.checkpoint(
      { name: 'checkpoint.html', filePath: checkpointPath },
      { roomIdentity: 'node-1', generation: null },
      { target: { identity: 'node-1', canonicalPath: checkpointPath }, room },
    ).catch((error) => error);

    expect(result.indeterminate).toBe(true);
    expect(fs.readFileSync(checkpointPath, 'utf8')).toBe('<html>cp</html>');

    const browser = makeHost({ baseDir: dir, filePath: browserPath });

    const committed = await browser.host.commit({
      kind: 'browser-save', name: 'browser.html', filePath: browserPath, bytes: '<html>br</html>',
    });

    expect(committed.outcome).toBe('committed');
    expect(fs.readFileSync(browserPath, 'utf8')).toBe('<html>br</html>');
  } finally {
    spy.mockRestore();
  }
  expect(writeQueue.syncDirectory).toBe(original);
});

test('a save whose temp file cannot be synced writes nothing and leaves no temp file', async () => {
  const dir = tempDir();
  const filePath = upath.join(dir, 'page.html');
  const { host } = makeHost({ baseDir: dir, filePath });
  fs.writeFileSync(filePath, 'old bytes');
  const failure = Object.assign(new Error('sync failed'), { code: 'EIO' });
  const realOpen = fs.promises.open;
  const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (target, ...args) => {
    const handle = await realOpen(target, ...args);
    if (typeof target === 'string' && target.endsWith('.tmp')) {
      return {
        writeFile: (...rest) => handle.writeFile(...rest),
        sync: async () => { throw failure; },
        chmod: (...rest) => handle.chmod(...rest),
        close: (...rest) => handle.close(...rest),
      };
    }
    return handle;
  });
  try {
    await expect(host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>new</html>' }))
      .rejects.toBe(failure);
  } finally {
    spy.mockRestore();
  }

  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');
  expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('a page-state failure after the rename is not an indeterminate document write', async () => {
  const { host, filePath } = makeHost({
    storePageState: async () => { throw Object.assign(new Error('sidecar failed'), { afterRename: true }); },
  });
  fs.writeFileSync(filePath, 'old bytes');

  await expect(host.commit({ kind: 'browser-save', name: 'page.html', filePath, bytes: '<html>new</html>' }))
    .rejects.toThrow('sidecar failed');

  expect(fs.readFileSync(filePath, 'utf8')).toBe('old bytes');
});

test('events subscribe through the observer and report a gap first when given a cursor', () => {
  const listeners = [];
  const observer = { subscribe: (listener) => { listeners.push(listener); return () => {}; } };
  const { host } = makeHost({ getObserver: () => observer });
  const seen = [];

  const dispose = host.events('cursor-1', (event) => seen.push(event));
  expect(seen).toEqual([{ type: 'gap', since: 'cursor-1' }]);
  listeners[0]({ event: 'change', rel: 'page.html' });
  expect(seen[1]).toEqual({ type: 'change', event: 'change', rel: 'page.html' });
  expect(typeof dispose).toBe('function');
});

test('events subscribe without a gap when the cursor is null', () => {
  const listeners = [];
  const observer = { subscribe: (listener) => { listeners.push(listener); return () => {}; } };
  const { host } = makeHost({ getObserver: () => observer });
  const seen = [];

  host.events(null, (event) => seen.push(event));
  listeners[0]({ event: 'unlink', rel: 'page.html' });
  expect(seen).toEqual([{ type: 'change', event: 'unlink', rel: 'page.html' }]);
});

test('a host without an observer refuses to subscribe', () => {
  const { host } = makeHost();
  expect(() => host.events(null, () => {})).toThrow('This document host has no observer');
});
