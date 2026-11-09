// What this host says about its history: discovery's `document.versions` is true
// when the host keeps restorable version history of the document for the caller, so
// a page can offer a template upgrade knowing the version it replaces can be brought
// back. Absent means no history, and an upgrade then has to ask for a download
// first. The claim is checked against the store the save path writes, not just
// announced: a host that said true and kept nothing would make that offer a lie.

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const request = require('supertest');

const { createApp } = require('../../src/main/server.js');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');

// chmod 0o500 is not a refusal on Windows: there is no mode that makes a
// directory unwritable to its owner, so that case has nothing to prove there.
const describeUnlessWindows = process.platform === 'win32' ? describe.skip : describe;

const ORIGINAL = '<html><body>original</body></html>';
const REPLACEMENT = '<html><body>replacement</body></html>';

async function cleanup(dir) {
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

describe('discovery says this host keeps version history', () => {
  let dir;
  let app;

  const meta = () => request(app)
    .get('/_/meta')
    .set('Host', 'localhost')
    .set('Document-URL', 'http://localhost/index.html');

  const save = (body) => request(app)
    .post('/_/save')
    .set('Host', 'localhost')
    .set('Document-URL', 'http://localhost/index.html')
    .set('Content-Type', 'text/plain; charset=utf-8')
    .send(body);

  const versions = () => request(app)
    .get('/_/versions/index.html')
    .set('Host', 'localhost')
    .set('Document-URL', 'http://localhost/index.html');

  const onDisk = () => fs.readFile(path.join(dir, 'index.html'), 'utf8');

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'metaversions-')));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    app = await listenLoopback(createApp(dir));
    await fs.writeFile(path.join(dir, 'index.html'), ORIGINAL);
  });

  afterEach(async () => {
    await closeLoopback();
    jest.restoreAllMocks();
    await cleanup(dir);
  });

  test('the document block advertises restorable history beside its save limit', async () => {
    const res = await meta();
    expect(res.status).toBe(200);
    expect(res.body.document.versions).toBe(true);
    expect(res.body.document.maxBytes).toBe(20 * 1024 * 1024);
    expect(typeof res.body.document.etag).toBe('string');
  });

  // The store the save path writes keeps the bytes each save put on disk, so the
  // version a later save replaces is the one before it in the list. Reading it back
  // and restoring it is what makes `versions: true` a promise an upgrade can rely on.
  test('the history it advertises is the one a save writes and a restore can put back', async () => {
    expect((await meta()).body.document.versions).toBe(true);

    expect((await save(ORIGINAL)).status).toBe(200);
    expect((await save(REPLACEMENT)).status).toBe(200);
    expect(await onDisk()).toBe(REPLACEMENT);

    const listed = await versions();
    expect(listed.status).toBe(200);
    expect(listed.body.versions.length).toBeGreaterThanOrEqual(2);

    const replaced = listed.body.versions[1];
    const read = await request(app)
      .get(`/_/version/index.html/${replaced.name}`)
      .set('Host', 'localhost')
      .set('Document-URL', 'http://localhost/index.html');
    expect(read.status).toBe(200);
    expect(read.text).toBe(ORIGINAL);

    const restored = await request(app)
      .post(`/_/restore/index.html/${replaced.name}`)
      .set('Host', 'localhost')
      .set('Document-URL', 'http://localhost/index.html');
    expect(restored.status).toBe(200);
    expect(await onDisk()).toBe(ORIGINAL);
  });

  // The safety copy is the one thing a restore must never skip, so both ways it can
  // fail refuse the restore and answer the 500 that says which half failed.
  test('a restore whose live room cannot be backed up is a 500 and writes nothing', async () => {
    expect((await save(ORIGINAL)).status).toBe(200);
    expect((await save(REPLACEMENT)).status).toBe(200);
    const target = (await versions()).body.versions[1];
    const localCheckpoint = {
      registerHost() {},
      safetyBackup: async () => { throw new Error('the room cannot be backed up'); },
    };
    const watched = await listenLoopback(createApp({
      root: { id: 'meta-versions-room', kind: 'personal', path: dir, port: 0 },
      devHooks: null, isKnownPath: null, localCheckpoint,
    }));

    const res = await request(watched)
      .post(`/_/restore/index.html/${target.name}`)
      .set('Host', 'localhost')
      .set('Document-URL', 'http://localhost/index.html');
    await closeLoopback();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('live room cannot be backed up');
    expect(await onDisk()).toBe(REPLACEMENT);
  });

  describeUnlessWindows('a safety backup that cannot be written', () => {
    test('refuses the restore with a 500 and writes nothing', async () => {
      expect((await save(ORIGINAL)).status).toBe(200);
      expect((await save(REPLACEMENT)).status).toBe(200);
      const target = (await versions()).body.versions[1];
      const siteVersions = path.join(dir, '.hyperclay', 'versions', 'index');
      await fs.chmod(siteVersions, 0o500);

      const res = await request(app)
        .post(`/_/restore/index.html/${target.name}`)
        .set('Host', 'localhost')
        .set('Document-URL', 'http://localhost/index.html');

      await fs.chmod(siteVersions, 0o755);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('could not create a safety backup');
      expect(await onDisk()).toBe(REPLACEMENT);
    });
  });

  test('a document that is not there gets no document block, and so no versions claim', async () => {
    const res = await request(app)
      .get('/_/meta')
      .set('Host', 'localhost')
      .set('Document-URL', 'http://localhost/missing.html');
    expect(res.status).toBe(200);
    expect(res.body.document).toBeUndefined();
  });
});
