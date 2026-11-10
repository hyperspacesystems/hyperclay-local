const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createRootDocumentHost } = require('../../src/main/document-host');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'document-host-root-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const FORMATTABLE = '<!DOCTYPE html><html formathtml="true"><head><title>x</title></head><body><div><p>caf\u00e9\r\nhi</p></div></body></html>';

test('a root alone builds the host with the real formatters', async () => {
  const path = tempDir();
  const ctx = { root: { id: 'r', path } };
  const host = createRootDocumentHost({ ctx });
  const filePath = upath.join(path, 'page.html');

  const result = await host.commit({
    kind: 'browser-save', name: 'page.html', filePath, bytes: FORMATTABLE, userDriven: true,
  });

  expect(result.outcome).toBe('committed');
  const stored = fs.readFileSync(filePath);
  expect(stored.equals(Buffer.from(FORMATTABLE))).toBe(false);
  expect(stored.toString('utf8')).not.toBe(FORMATTABLE);
});

const store = require('../../src/main/page-state-store');

const RECORD = { v: 1, rev: 'rev-a', tag: '<p>merge</p>' };
const sidecar = (dir, name) => upath.join(dir, '.hyperclay', 'page-state', `${name}.json`);

function hostFor(dir) {
  return createRootDocumentHost({ ctx: { root: { id: 'r', path: dir } } });
}

test('pageState write writes the sidecar the store writes', async () => {
  const path = tempDir();
  const direct = tempDir();
  const host = hostFor(path);

  await host.pageState({ op: 'write', name: 'page.html', record: RECORD });
  await store.writePageState(direct, 'page.html', RECORD);

  const written = JSON.parse(fs.readFileSync(sidecar(path, 'page.html'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(sidecar(direct, 'page.html'), 'utf8'));
  expect({ ...written, generation: null }).toEqual({ ...expected, generation: null });
  expect(written.generation).toMatch(/^[0-9a-f]{32}$/);
  expect(written).toMatchObject(RECORD);
  expect(await store.readPageState(path, 'page.html')).toMatchObject(RECORD);
});

test('pageState move moves one page sidecar', async () => {
  const path = tempDir();
  const host = hostFor(path);
  await store.writePageState(path, 'A.html', RECORD);

  await host.pageState({ op: 'move', name: 'A.html', to: 'B.html' });

  expect(fs.existsSync(sidecar(path, 'A.html'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(sidecar(path, 'B.html'), 'utf8'))).toMatchObject(RECORD);
  expect(await store.readPageState(path, 'A.html')).toBeNull();
  expect(await store.readPageState(path, 'B.html')).toMatchObject(RECORD);
});

test('pageState moveDir moves the folder mirror', async () => {
  const path = tempDir();
  const host = hostFor(path);
  await store.writePageState(path, 'Notes/A.html', RECORD);

  await host.pageState({ op: 'moveDir', name: 'Notes', to: 'Archive' });

  expect(fs.existsSync(upath.join(path, '.hyperclay', 'page-state', 'Notes'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(sidecar(path, 'Archive/A.html'), 'utf8'))).toMatchObject(RECORD);
  expect(await store.readPageState(path, 'Archive/A.html')).toMatchObject(RECORD);
});

test('pageState drop drops one page sidecar', async () => {
  const path = tempDir();
  const host = hostFor(path);
  await store.writePageState(path, 'A.html', RECORD);

  await host.pageState({ op: 'drop', name: 'A.html' });

  expect(fs.existsSync(sidecar(path, 'A.html'))).toBe(false);
  expect(await store.readPageState(path, 'A.html')).toBeNull();
});

test('pageState dropDir drops the folder mirror', async () => {
  const path = tempDir();
  const host = hostFor(path);
  await store.writePageState(path, 'Notes/A.html', RECORD);

  await host.pageState({ op: 'dropDir', name: 'Notes' });

  expect(fs.existsSync(upath.join(path, '.hyperclay', 'page-state', 'Notes'))).toBe(false);
  expect(await store.readPageState(path, 'Notes/A.html')).toBeNull();
});

test('pageState refuses an unknown operation', async () => {
  const path = tempDir();
  const host = hostFor(path);

  await expect(host.pageState({ op: 'rename', name: 'A.html', to: 'B.html' })).rejects.toThrow(TypeError);
});
