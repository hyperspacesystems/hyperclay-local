const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createRootDocumentHost } = require('../../src/main/document-host');

const VARIABLE = 'HYPERCLAY_LOCAL_DOCUMENT_HOST';
const original = process.env[VARIABLE];

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'document-host-trial-')));
  dirs.push(dir);
  return dir;
}

function ctx() {
  return { root: { id: 'r', path: tempDir() } };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
  if (original === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = original;
});

test('the variable unset builds the in-process host', () => {
  delete process.env[VARIABLE];
  const host = createRootDocumentHost({ ctx: ctx() });
  expect(typeof host.commit).toBe('function');
  expect(typeof host.read).toBe('function');
  expect(typeof host.restructure).toBe('function');
});

const ADAPTER = upath.join(__dirname, '..', '..', 'trial', 'go-document-host.cjs');

test('the variable set to go builds the trial adapter', () => {
  process.env[VARIABLE] = 'go';
  const adapter = { trial: true };
  let host = null;
  jest.isolateModules(() => {
    jest.doMock(ADAPTER, () => ({ createGoDocumentHost: () => adapter }));
    host = require('../../src/main/document-host').createRootDocumentHost({ ctx: ctx() });
  });
  jest.dontMock(ADAPTER);
  expect(host).toBe(adapter);
});

test('the variable set to go fails closed when the trial adapter is not packed', () => {
  process.env[VARIABLE] = 'go';
  let error = null;
  jest.isolateModules(() => {
    jest.doMock(ADAPTER, () => {
      const missing = new Error(`Cannot find module '${ADAPTER}'`);
      missing.code = 'MODULE_NOT_FOUND';
      throw missing;
    });
    try {
      require('../../src/main/document-host').createRootDocumentHost({ ctx: ctx() });
    } catch (thrown) {
      error = thrown;
    }
  });
  jest.dontMock(ADAPTER);
  expect(error).not.toBe(null);
  expect(error.code).toBe('MODULE_NOT_FOUND');
  expect(error.message).toContain('trial/go-document-host.cjs');
});

test('any other value builds the in-process host', () => {
  for (const value of ['GO', 'node', 'go ', '']) {
    process.env[VARIABLE] = value;
    const host = createRootDocumentHost({ ctx: ctx() });
    expect(typeof host.commit).toBe('function');
    expect(typeof host.read).toBe('function');
    expect(typeof host.restructure).toBe('function');
  }
});

test('the packaged files list never packs the trial adapter', () => {
  const pkg = JSON.parse(fs.readFileSync(upath.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const files = pkg.build.files;
  expect(Array.isArray(files)).toBe(true);
  const prefixes = ['src/', 'assets/', 'dist/'];
  for (const entry of files) {
    expect(entry.startsWith('trial')).toBe(false);
    expect(entry.startsWith('**')).toBe(false);
    expect(prefixes.some((prefix) => entry.startsWith(prefix))).toBe(true);
  }
});
