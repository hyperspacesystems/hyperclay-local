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
