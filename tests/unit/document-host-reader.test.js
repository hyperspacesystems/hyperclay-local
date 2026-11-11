// M2/S4 and S5: every read the save lane's halves and the replace lane's
// admission make is answered from the reader in scope, so the managed trial's
// service can run them against the snapshot Go sent and never touch a served
// root. Each fixture keeps the real files under `root` and passes an empty
// directory as the served root, so a read that went to the disk finds nothing.

const fsp = require('fs').promises;
const fs = require('fs');
const os = require('os');
const path = require('upath');
const { createRootDocumentHost } = require('../../src/main/document-host');
const { withReader, disk } = require('../../src/main/document-reader');
const { newestVersionFiles } = require('../../src/main/page-rebase');
const { splitPage } = require('@panphora/clayjs/server/rooms');
const { writePageState, logicalBytes } = require('../../src/main/page-state-store');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { createRooms } = require('@panphora/clayjs/server/rooms');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'document-host-reader-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function hostOn(dir) {
  return createRootDocumentHost({
    ctx: { root: { id: `reader-${path.basename(dir)}`, path: dir }, localAuthority: null },
    live: { markBrowserSave: () => {}, broadcast: jest.fn(), notify: jest.fn() },
  });
}

function mirrorReader(root, empty) {
  const swap = (p) => {
    const rel = path.relative(empty, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const error = new Error(`not in this snapshot: ${p}`);
      error.code = 'ENOENT';
      throw error;
    }
    return path.join(root, rel);
  };
  return {
    readFile: async (file, encoding) => fsp.readFile(swap(file), encoding),
    stat: async (file, options) => fsp.stat(swap(file), options),
    versionFiles: async (dir, baseDir) => newestVersionFiles(swap(dir), swap(baseDir)),
  };
}

const FIXTURE = fs.readFileSync(path.join(__dirname, '../fixtures/ypage-template.html'), 'utf8');
const SPLIT = splitPage(FIXTURE);
const NAME = 'page.html';

const version = (rev, { text = '', title = '' } = {}) => SPLIT.file
  .replace('data-rev="093360993130d818"', `data-rev="${rev}"`)
  .replace('<p data-id="p1"></p>', `<p data-id="p1">${text}</p>`)
  .replace('<h1 data-id="title"></h1>', `<h1 data-id="title">${title}</h1>`);

test('a stale save rebases from the reader alone', async () => {
  const root = tempDir();
  const empty = tempDir();
  fs.writeFileSync(path.join(root, NAME), version('stored-rev', { title: 'stored' }));
  await writePageState(root, NAME, { rev: 'stored-rev', tag: SPLIT.state.tag });
  fs.mkdirSync(path.join(root, '.hyperclay', 'versions', 'page'), { recursive: true });
  fs.writeFileSync(path.join(root, '.hyperclay', 'versions', 'page', '2026-01-01-00-00-00-000+0000.html'),
    version('old-rev', { text: 'base' }));
  const bytes = version('old-rev', { text: 'from the old version' });

  const expected = await hostOn(root).lanes.prepareSave({ name: NAME, bytes });
  const got = await withReader(mirrorReader(root, empty), () => hostOn(empty).lanes.prepareSave({ name: NAME, bytes }));
  const bare = await hostOn(empty).lanes.prepareSave({ name: NAME, bytes });

  expect(got).toEqual(expected);
  expect(expected.content).toContain('<h1 data-id="title">stored</h1>');
  expect(expected.content).toContain('from the old version');
  expect(bare.content).not.toBe(expected.content);
  expect(fs.readdirSync(empty)).toEqual([]);
});

test("the replace lane's current read comes from the reader", async () => {
  const root = tempDir();
  const empty = tempDir();
  fs.writeFileSync(path.join(root, NAME), version('stored-rev', { title: 'stored' }));
  await writePageState(root, NAME, { rev: 'stored-rev', tag: SPLIT.state.tag });
  const content = version('newer-rev', { title: 'newer' });
  const recorded = [];

  const admitted = await withReader(mirrorReader(root, empty), () => hostOn(empty).lanes.admitReplace({
    name: NAME,
    filePath: path.join(empty, NAME),
    content,
    safety: true,
    writeSafetyVersion: async (html) => { recorded.push(html); return true; },
  }));

  expect(admitted.refusal).toBeNull();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toBe((await logicalBytes(root, NAME, fs.readFileSync(path.join(root, NAME)))).toString('utf8'));
  expect(recorded[0]).toContain('merge="blockeditor"');
  expect(fs.readdirSync(empty)).toEqual([]);
});

test("the authority's stamp comes from the reader", async () => {
  const dir = tempDir();
  const file = path.join(dir, NAME);
  const html = '<!doctype html><html><body><p>one</p></body></html>';
  fs.writeFileSync(file, html);
  const rooms = createRooms({});
  const authority = createLocalAuthority({ rooms, withDocument: withDocumentWrite });
  authority.registerRoot({ id: 'root-a', path: dir, canonicalPath: dir }, { owner: 'server' });
  const target = authority.bindTarget({ rootId: 'root-a', logicalPath: NAME, canonicalPath: file });

  const stamp = await withDocumentWrite(async () => ({ canonicalPath: file }), (_target, token) =>
    withReader({ readFile: disk.readFile, stat: async () => ({ dev: 7n, ino: 8n, size: 9n, mtimeNs: 10n }) },
      () => authority.confirmKnownWrite(target, html, token)));

  expect(stamp).toEqual(expect.objectContaining({ dev: 7n, ino: 8n, size: 9n, mtimeNs: 10n }));
});
