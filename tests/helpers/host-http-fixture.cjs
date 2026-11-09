const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

function parseArgs(argv) {
  const args = { manifest: null, deadlineMs: 20000, source: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--manifest') { args.manifest = value; i += 1; }
    else if (flag === '--deadline-ms') { args.deadlineMs = Number(value); i += 1; }
    else if (flag === '--source') { args.source = value; i += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.manifest) throw new Error('--manifest is required');
  if (!Number.isFinite(args.deadlineMs) || args.deadlineMs < 0) throw new Error('--deadline-ms must be a number');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const source = path.resolve(args.source ?? process.env.HOST_FIXTURE_SOURCE ?? path.join(__dirname, '..', '..'));

let fixtureDir = null;
let shuttingDown = false;
let deadlineTimer = null;
let pool = null;
let observers = new Map();
let controlServer = null;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
  if (pool) { try { await pool.stopAll(); } catch {} }
  for (const observer of observers.values()) {
    try { observer.stop(); } catch {}
  }
  if (controlServer) {
    await new Promise((resolve) => controlServer.close(resolve));
    controlServer = null;
  }
  removeFixtureDir();
  process.exit(code);
}

process.on('SIGTERM', () => { shutdown(0); });
process.on('SIGINT', () => { shutdown(0); });

function removeFixtureDir() {
  if (!fixtureDir) return;
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  fixtureDir = null;
}

deadlineTimer = setTimeout(() => {
  process.stderr.write(`fixture: boot exceeded ${args.deadlineMs} ms\n`);
  removeFixtureDir();
  process.exit(3);
}, args.deadlineMs);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function insideRoot(rootDir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (path.isAbsolute(rel)) return null;
  const canonicalRoot = path.resolve(rootDir);
  const target = path.resolve(canonicalRoot, rel);
  if (target === canonicalRoot) return null;
  if (!target.startsWith(canonicalRoot + path.sep)) return null;
  return target;
}

async function readJsonBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function main() {
  const { createLocalAuthority } = require(path.join(source, 'src/main/local-authority'));
  const { createLocalCheckpoint } = require(path.join(source, 'src/main/local-checkpoint'));
  const { withDocumentWrite } = require(path.join(source, 'src/main/utils/write-queue'));
  const { RootServerPool } = require(path.join(source, 'src/main/root-servers'));
  const { RootObserver } = require(path.join(source, 'src/main/root-observer'));
  const { createRootLive } = require(path.join(source, 'src/main/utils/root-live'));
  const hostVersion = require(path.join(source, 'package.json')).version;

  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-http-fixture-'));
  const rootDirs = {
    'root-a': path.join(fixtureDir, 'root-a'),
    'root-b': path.join(fixtureDir, 'root-b'),
  };
  for (const dir of Object.values(rootDirs)) fs.mkdirSync(dir, { recursive: true });

  const authority = createLocalAuthority({ withDocument: withDocumentWrite, pageCompaction: false });
  const checkpoint = createLocalCheckpoint({ authority, withDocument: withDocumentWrite });
  authority.setCheckpointService(checkpoint);

  const roots = ['root-a', 'root-b'].map((id) => ({ id, kind: 'personal', path: rootDirs[id], port: 0 }));
  for (const root of roots) {
    const observer = new RootObserver(root, { live: createRootLive(root), localAuthority: authority });
    observers.set(root.id, observer);
    observer.start();
  }

  pool = new RootServerPool({
    devHooks: null,
    isKnownPath: null,
    observerFor: (id) => observers.get(id),
    helpersFor: () => null,
    syncEngineForRoot: () => null,
    person: () => ({ me: null }),
    localAuthority: authority,
    localCheckpoint: checkpoint,
  });

  await pool.sync(roots, { enabled: true });
  for (const root of roots) {
    const server = pool.get(root.id);
    if (!server || !server.server) throw new Error(`root ${root.id} did not start`);
    root.port = server.server.address().port;
  }

  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }

  // Stop every root server and start it again on the same folders and, when the
  // launcher can, the same ports, so a manifest URL a client already holds keeps
  // naming the same host.
  async function restartHost() {
    const ports = new Map(roots.map((root) => [root.id, root.port]));
    await pool.stopAll();
    const deadline = Date.now() + 10000;
    let states = [];
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      for (const root of roots) root.port = ports.get(root.id);
      await pool.sync(roots, { enabled: true });
      states = pool.states();
      if (states.length === roots.length && states.every((entry) => entry.state === 'running')) break;
      await pool.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const ok = states.length === roots.length && states.every((entry) => entry.state === 'running');
    return {
      ok,
      attempts,
      roots: roots.map((root) => ({ id: root.id, url: `http://127.0.0.1:${root.port}`, port: root.port })),
      states,
    };
  }

  const token = crypto.randomBytes(24).toString('hex');

  const authorized = (req) => req.headers.authorization === `Bearer ${token}`;

  controlServer = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname === '/seed') {
        const body = await readJsonBody(req);
        const rootDir = rootDirs[body.root];
        if (!rootDir) { sendJson(res, 400, { error: 'unknown-root' }); return; }
        const target = insideRoot(rootDir, body.path);
        if (!target) { sendJson(res, 400, { error: 'path-escapes-root' }); return; }
        const bytes = Buffer.from(String(body.base64 ?? ''), 'base64');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        sendJson(res, 200, { sha256: sha256(bytes) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/read') {
        const rootDir = rootDirs[url.searchParams.get('root')];
        const target = rootDir ? insideRoot(rootDir, url.searchParams.get('path')) : null;
        if (!target) { sendJson(res, 400, { error: 'bad-request' }); return; }
        if (!fs.existsSync(target)) { sendJson(res, 200, { exists: false }); return; }
        const bytes = fs.readFileSync(target);
        sendJson(res, 200, { exists: true, base64: bytes.toString('base64'), sha256: sha256(bytes) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/list') {
        const rootDir = rootDirs[url.searchParams.get('root')];
        const target = rootDir ? insideRoot(rootDir, url.searchParams.get('path')) : null;
        if (!target) { sendJson(res, 400, { error: 'bad-request' }); return; }
        let entries;
        try {
          entries = fs.readdirSync(target).sort();
        } catch (error) {
          if (error.code === 'ENOENT') { sendJson(res, 200, { exists: false, entries: [] }); return; }
          throw error;
        }
        sendJson(res, 200, { exists: true, entries });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/checkpoint-wait') {
        const body = await readJsonBody(req);
        const rootDir = rootDirs[body.root];
        const target = rootDir ? insideRoot(rootDir, body.path) : null;
        if (!target) { sendJson(res, 400, { error: 'bad-request' }); return; }
        let key;
        try { key = fs.realpathSync(target); } catch { key = target; }
        const timeoutMs = Number.isFinite(body.timeoutMs) ? Math.max(0, body.timeoutMs) : 10000;
        const started = Date.now();
        const deadline = started + timeoutMs;
        let observed = false;
        for (;;) {
          const pending = checkpoint.pending(key);
          if (pending) {
            observed = true;
            try { await pending; } catch {}
            continue;
          }
          const room = authority.rooms.get(key);
          if (room && authority.roomIsDirty(room)) {
            observed = true;
            if (Date.now() >= deadline) {
              sendJson(res, 504, { error: 'checkpoint-timeout', detail: `room still dirty after ${Date.now() - started} ms`, observed });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          sendJson(res, 200, { ok: true, dirty: false, observed, waitedMs: Date.now() - started });
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/restart') {
        await readJsonBody(req);
        const answer = await restartHost();
        sendJson(res, answer.ok ? 200 : 500, answer);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/stop') {
        const payload = JSON.stringify({ ok: true });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          connection: 'close',
        });
        res.end(payload);
        setTimeout(() => { shutdown(0); }, 100);
        return;
      }

      sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: error.message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', resolve);
  });

  const manifest = {
    schema: 1,
    hostBuild: { version: hostVersion, source },
    roots: roots.map((root) => ({
      id: root.id,
      url: `http://127.0.0.1:${root.port}`,
      fixtureRoot: rootDirs[root.id],
    })),
    documents: [],
    control: { url: `http://127.0.0.1:${controlServer.address().port}`, token },
    expectedProfile: 'local-full',
  };

  const manifestPath = path.resolve(args.manifest);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, manifestPath);
}

main().catch((error) => {
  process.stderr.write(`fixture: ${error && error.stack ? error.stack : error}\n`);
  removeFixtureDir();
  process.exit(1);
});
