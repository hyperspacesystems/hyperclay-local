// ClayJS 1.24.0 renamed the block editor's saved format from `page` to
// `blockeditor`: the live tag, the article's attributes, the sidecar folder and the
// capability names all changed together. These tests hold Local to the new names: it
// stores a 1.24 document under them, refuses a document written by an old tab under
// the old ones, leaves a document's own `page` names alone, and advertises only the
// renamed capabilities.

jest.mock('../../src/main/data-loss-guard', () => ({
  ...jest.requireActual('../../src/main/data-loss-guard'),
  runDataLossGuard: jest.fn().mockResolvedValue(null)
}));

const fsSync = require('fs');
const fs = require('fs').promises;
const path = require('upath');
const os = require('os');
const { execFileSync } = require('child_process');
const request = require('supertest');

const { splitPage, oldFormatRefusal, createRooms } = require('@panphora/clayjs/server/rooms');
const { createApp } = require('../../src/main/server.js');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { RootObserver } = require('../../src/main/root-observer');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');
const { createRootLive } = require('../../src/main/utils/root-live');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');
const { documentEtag } = require('../../src/main/spec-wire.js');
const { pageStatePath } = require('../../src/main/page-state-store');
const { withoutInjectedDocumentEtag } = require('../helpers/served-metadata');
const VECTORS = require('@panphora/host-conformance/vectors/blockeditor-lineage.json');

// A Block document exactly as ClayJS 1.24 writes it: the real template with its live tag.
const BODY = VECTORS.writes.map((write) => write.body).find((html) => typeof html === 'string' && html.includes('merge="blockeditor" clay="live"'));
// The same document as a tab on the runtime from before the rename would save it.
const OLD = BODY
  .replace('merge="blockeditor" clay="live"', 'merge="page" clay="live"')
  .replace(/data-blockeditor=/g, 'data-page=')
  .replace('class="blockeditor"', 'class="page"');
const AUTHOR_STORE = '<!DOCTYPE html><html lang="en"><body><script type="application/json" merge="page" clay="live">{"current":3}</script><p>x</p></body></html>';
const PAGINATION = '<!DOCTYPE html><html lang="en"><body><article data-page="2"><p>two</p></article></body></html>';

const NAME = 'doc.html';

describe('the Block editor rename reaches Local', () => {
  let dir;
  let authority;
  let observer;
  let live;
  let server;
  let opened;

  const filePath = () => path.join(dir, NAME);
  const onDisk = () => fs.readFile(filePath(), 'utf8');

  const save = (html, headers = {}, name = NAME) => {
    const req = request(server)
      .post('/save')
      .set('Page-URL', `http://127.0.0.1:${server.address().port}/${name}`)
      .set('Content-Type', 'text/plain');
    for (const [key, value] of Object.entries(headers)) req.set(key, value);
    return req.send(html);
  };

  const getRaw = (name = NAME) => request(server).get(`/${name}`).buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  const versionFiles = async () => {
    const versionsDir = path.join(dir, '.hyperclay', 'versions', 'doc');
    const names = await fs.readdir(versionsDir).catch(() => []);
    return names.sort();
  };

  beforeEach(async () => {
    dir = path.resolve(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blockeditor-rename-'))));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const core = createRooms({});
    opened = [];
    const rooms = {
      ...core,
      open(key, html, opts) {
        opened.push({ key, html });
        return core.open(key, html, opts);
      }
    };
    authority = createLocalAuthority({ rooms, withDocument: withDocumentWrite });
    const root = { id: 'root-a', kind: 'personal', path: dir, port: 0 };
    live = createRootLive(root);
    observer = new RootObserver(root, { live, localAuthority: authority });
    jest.spyOn(live, 'notify');
    jest.spyOn(live, 'broadcast');
    server = await listenLoopback(createApp({
      root, live, observer, localAuthority: authority, devHooks: null, isKnownPath: null
    }));
  });

  afterEach(async () => {
    await closeLoopback();
    await observer.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    jest.restoreAllMocks();
  });

  test('the fixture is a 1.24 Block document', () => {
    expect(typeof BODY).toBe('string');
    expect(OLD).not.toBe(BODY);
    expect(splitPage(BODY).state).toBeTruthy();
  });

  test('a Block document from ClayJS 1.24 round-trips through a save', async () => {
    // An initialization is the one save ClayJS admits only against a stamp for the
    // bytes it replaces, so the document the Block editor adopts is written first.
    await fs.writeFile(filePath(), AUTHOR_STORE);
    const res = await save(BODY, { 'If-Match': documentEtag(await fs.readFile(filePath())) });
    expect(res.status).toBe(200);

    const stored = await onDisk();
    expect(stored).not.toContain('merge="blockeditor" clay="live"');
    expect(stored).toContain('data-blockeditor=');

    const sidecar = pageStatePath(dir, NAME);
    await expect(fs.access(sidecar)).resolves.toBeUndefined();
    expect(sidecar).toContain('/.hyperclay/blockeditor-state/');
    const record = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    expect(record.rev).toBe(splitPage(BODY).state.rev);
    expect(record.tag).toBe(splitPage(BODY).state.tag);

    const served = withoutInjectedDocumentEtag((await getRaw()).body).toString('utf8');
    expect(served).toContain('merge="blockeditor" clay="live"');
    expect(served).toContain(splitPage(BODY).state.tag);
  });

  test('an old-format write is refused before every other check', async () => {
    await fs.writeFile(filePath(), BODY);
    const versionsBefore = await versionFiles();

    const res = await save(OLD, { 'If-Match': '"stale-stamp"' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('blockeditor-old-format');
    expect(res.body.reason).toBe('blockeditor-old-format');
    expect(res.body.msgType).toBe('error');
    expect(res.body.msg).toBe(oldFormatRefusal().message);

    const after = await fs.readFile(filePath());
    expect(after.equals(Buffer.from(BODY, 'utf8'))).toBe(true);
    expect(await versionFiles()).toEqual(versionsBefore);
  });

  test('a data API write to an old-format document is refused with 409, not 500', () => {
    // The data API write applies its JSON through a pure ESM engine, whose dynamic
    // import cannot run inside jest's CommonJS VM, so the same real app runs in a
    // child process over real HTTP, as the page format test's data API write does.
    const rules = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"body":"p"}</script>';
    const document = OLD.replace('</head>', `${rules}</head>`);
    const script = `
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const http = require('http');
(async () => {
  const { createApp } = require(process.cwd() + '/src/main/server.js');
  const { createLocalAuthority } = require(process.cwd() + '/src/main/local-authority');
  const { withDocumentWrite } = require(process.cwd() + '/src/main/utils/write-queue');
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blockeditor-rename-api-')));
  const file = path.join(dir, 'doc.html');
  await fs.writeFile(file, process.env.OLD_DOC);
  const authority = createLocalAuthority({ withDocument: withDocumentWrite });
  const root = { id: 'rename-api-root', kind: 'personal', path: dir, port: 0 };
  const server = http.createServer(createApp({ root, localAuthority: authority, devHooks: null }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const res = await fetch(origin + '/_/api/doc.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'new' }),
    });
    let body = null;
    try { body = await res.json(); } catch {}
    const after = await fs.readFile(file);
    console.log(JSON.stringify({ status: res.status, body, unchanged: after.equals(Buffer.from(process.env.OLD_DOC, 'utf8')) }));
  } finally {
    await new Promise((done) => server.close(done));
    await new Promise((done) => setTimeout(done, 50));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
})().catch((error) => { console.error(error); process.exit(1); });
`;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, OLD_DOC: document },
      encoding: 'utf8',
    });
    const result = JSON.parse(out.trim().split('\n').pop());

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('blockeditor-old-format');
    expect(result.body.reason).toBe('blockeditor-old-format');
    expect(result.body.msg).toBe(oldFormatRefusal().message);
    expect(result.unchanged).toBe(true);
  });

  test("an author's own page store and a pagination article are ordinary writes", async () => {
    const res = await save(AUTHOR_STORE);
    expect(res.status).toBe(200);
    expect(await onDisk()).toContain('merge="page"');

    const list = await save(PAGINATION, {}, 'list.html');
    expect(list.status).toBe(200);
    expect(await fs.readFile(path.join(dir, 'list.html'), 'utf8')).toContain('data-page="2"');
  });

  test('an ordinary write keeps the stored state of a document it does not recognize', async () => {
    await fs.writeFile(filePath(), AUTHOR_STORE);
    const first = await save(BODY, { 'If-Match': documentEtag(await fs.readFile(filePath())) });
    expect(first.status).toBe(200);
    const sidecar = pageStatePath(dir, NAME);
    await expect(fs.access(sidecar)).resolves.toBeUndefined();

    const second = await save(PAGINATION);
    expect(second.status).toBe(200);
    await expect(fs.access(sidecar)).resolves.toBeUndefined();
  });

  test('the meta answer advertises only the renamed Block editor names', async () => {
    const res = await request(server).get('/_/meta');
    expect(res.status).toBe(200);

    const { extensions } = res.body;
    expect(extensions).toContain('blockeditor');
    expect(extensions).toContain('blockeditor-recovery-v1');
    expect(extensions).toContain('blockeditor-format-v1');
    expect(extensions.filter((name) => /^page/.test(name))).toEqual([]);
  });
});
