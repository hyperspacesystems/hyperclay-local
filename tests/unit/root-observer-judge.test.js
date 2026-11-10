// M4b/S3: the observer's authority half as two callable steps. The managed
// trial's full-host stage has a Go host holding the document's lock and a JS
// service that constructs a RootObserver it never starts: the service asks it
// what the room makes of the bytes Go read, and Go makes the rebase write itself
// when the answer says `rebase`. Everything here is that service's view — real
// files, direct calls, no watcher.

const fs = require('fs').promises;
const os = require('os');
const path = require('upath');
const { splitPage } = require('@panphora/clayjs/server/rooms');
const { createBackup } = require('../../src/main/utils/backup');
const { RootObserver } = require('../../src/main/root-observer');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');
const { storePageState, logicalBytes } = require('../../src/main/page-state-store');
const { newestVersionFiles } = require('../../src/main/page-rebase');
const { withReader } = require('../../src/main/document-reader');
const { calculateChecksum } = require('../../src/sync-engine/utils');
const { pageFixture } = require('../helpers/page-fixture');

const NAME = 'A.html';

// A reader that answers for one directory while the files live in another: the
// managed trial's service runs each handler against the snapshot Go sent, and a
// read that went to the disk finds nothing.
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
    readFile: async (file, encoding) => fs.readFile(swap(file), encoding),
    stat: async (file, options) => fs.stat(swap(file), options),
    versionFiles: async (dir, baseDir) => newestVersionFiles(swap(dir), swap(baseDir)),
  };
}

describe('the observer judges a document and reports an outside edit', () => {
  let dir;
  let authority;
  let observer;
  let live;
  let root;

  const file = (name = NAME) => path.join(dir, name);

  // A page whose stored version is the one the authority last confirmed and whose
  // older version is on disk as a backup, so a copy based on that older version is
  // the stale save the observer rebases.
  const pageWithHistory = async () => {
    const older = pageFixture('abc');
    const stored = pageFixture('xyz');
    await fs.writeFile(file(), await storePageState(dir, NAME, older.html));
    await createBackup(dir, 'A', splitPage(older.html).file);
    await fs.writeFile(file(), await storePageState(dir, NAME, stored.html));
    await createBackup(dir, 'A', splitPage(stored.html).file);
    return { older, stored };
  };

  // The writer's own path, as a server save takes it: the sidecar is stored, the
  // file is written without the merge state, and the stamp is confirmed for the
  // logical document inside the document boundary the save holds.
  const confirmWrite = async (html) => {
    const target = authority.bindTarget({ rootId: root.id, logicalPath: NAME, canonicalPath: file() });
    const stored = await storePageState(dir, NAME, html);
    const logical = await logicalBytes(dir, NAME, stored);
    await withDocumentWrite(async () => target, async (resolved, token) => {
      await fs.writeFile(resolved.canonicalPath, stored);
      return authority.confirmKnownWrite(resolved, logical, token);
    });
    return target;
  };

  // What Go hands the service: the canonical path, its target, the bytes it read
  // and the stable stat it saw around them.
  const judge = async (instance = observer, name = NAME, canonicalPath = file(name)) => {
    const before = await fs.stat(canonicalPath, { bigint: true });
    const bytes = await fs.readFile(canonicalPath);
    const target = authority.bindTarget({ rootId: root.id, logicalPath: name, canonicalPath });
    return instance._judgeHtml(canonicalPath, name, target, bytes, before);
  };

  beforeEach(async () => {
    dir = path.resolve(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'root-observer-judge-'))));
    authority = createLocalAuthority({ withDocument: withDocumentWrite, pageCompaction: false });
    live = { notify: jest.fn(), broadcast: jest.fn() };
    root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };
    observer = new RootObserver(root, { live, localAuthority: authority });
  });

  afterEach(async () => {
    await observer.stop();
    jest.clearAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  test('the bytes and stat the authority just confirmed are self', async () => {
    const { stored } = await pageWithHistory();
    await confirmWrite(stored.html);

    expect(await judge()).toEqual({ kind: 'self' });
  });

  test('an outside edit is external, with the logical document the room should observe', async () => {
    const { stored } = await pageWithHistory();
    await confirmWrite(stored.html);

    const outside = Buffer.from(splitPage(stored.html).file.replace('>xyz<', '>outside<'));
    await fs.writeFile(file(), outside);

    const judged = await judge();
    expect(judged.kind).toBe('external');
    expect(judged.observed.equals(await logicalBytes(dir, NAME, outside))).toBe(true);
    expect(judged.observed.toString('utf8')).toContain('>outside<');
  });

  test('an older copy of a page is a rebase, with the checksum of the bytes Go read, and nothing is written', async () => {
    const { older, stored } = await pageWithHistory();
    await confirmWrite(stored.html);

    const stale = Buffer.from(splitPage(older.html).file.replace('>abc<', '>outside<'));
    await fs.writeFile(file(), stale);
    const before = await fs.stat(file(), { bigint: true });
    const bytes = await fs.readFile(file());

    const judged = await judge();

    expect(judged.kind).toBe('rebase');
    expect(judged.expected).toEqual({ type: 'checksum', value: await calculateChecksum(bytes) });
    expect(judged.observed.toString('utf8')).toContain('>outside<');
    // Rebased onto the stored page, not composed with the older copy's own state.
    expect(judged.observed.equals(await logicalBytes(dir, NAME, stale))).toBe(false);

    const after = await fs.stat(file(), { bigint: true });
    expect((await fs.readFile(file())).equals(stale)).toBe(true);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  test('the same rebase answer comes from a reader serving the sidecar and versions elsewhere', async () => {
    const { older, stored } = await pageWithHistory();
    await confirmWrite(stored.html);

    const stale = Buffer.from(splitPage(older.html).file.replace('>abc<', '>outside<'));
    await fs.writeFile(file(), stale);

    const onDisk = await judge();
    expect(onDisk.kind).toBe('rebase');

    const empty = path.resolve(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'root-observer-judge-served-'))));
    try {
      const served = new RootObserver({ ...root, path: empty }, { live, localAuthority: authority });
      const viaReader = await withReader(mirrorReader(dir, empty), () => judge(served));
      expect(viaReader.kind).toBe(onDisk.kind);
      expect(viaReader.expected).toEqual(onDisk.expected);
      expect(viaReader.observed.equals(onDisk.observed)).toBe(true);
    } finally {
      await fs.rm(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('the removal notice is the one an unlink sent before', () => {
    observer._notifyRemoved(NAME, null);

    expect(live.notify).toHaveBeenCalledTimes(1);
    const [rel, notice] = live.notify.mock.calls[0];
    expect(rel).toBe(NAME);
    expect(notice.msgType).toBe('warning');
    expect(notice.msg).toBe('A.html was removed on disk outside this tab');
    expect(notice.action).toBe('reload');
    expect(notice.data).toEqual({
      kind: 'external-change', sender: 'file-system', reason: 'external-replacement',
    });

    live.notify.mockClear();
    observer._notifyRemoved(NAME, { recovered: 'abc123.html' });
    expect(live.notify.mock.calls[0][1].data).toEqual({
      kind: 'external-change', sender: 'file-system', reason: 'external-replacement', recovered: 'abc123.html',
    });
  });
});
