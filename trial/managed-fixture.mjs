#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startManaged } from './supervisor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_APPS = path.join(os.homedir(), 'Documents', 'GitHub', 'hyper', 'LOCAL_APPS');

function realOrNearest(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function parseRoot(value) {
  const text = String(value ?? '');
  const at = text.indexOf('=');
  if (at <= 0) throw new Error(`--root needs <id>=<dir>, got: ${text}`);
  const id = text.slice(0, at);
  const dir = text.slice(at + 1);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`--root id must match [a-z0-9-]+: ${id}`);
  if (!dir) throw new Error(`--root ${id} needs a directory`);
  const resolved = path.resolve(dir);
  const realLocalApps = realOrNearest(LOCAL_APPS);
  const realDir = realOrNearest(resolved);
  if (realDir === realLocalApps || realDir.startsWith(realLocalApps + path.sep)) {
    throw new Error(`--root ${id} refuses ${resolved}: its real path is inside LOCAL_APPS (${LOCAL_APPS})`);
  }
  let stat = null;
  try { stat = fs.statSync(resolved); } catch {}
  if (!stat || !stat.isDirectory()) throw new Error(`--root ${id} is not an existing directory: ${resolved}`);
  return { id, dir: resolved };
}

function parseArgs(argv) {
  const args = { manifest: null, goBin: null, deadlineMs: 20000, roots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--manifest') { args.manifest = value; i += 1; }
    else if (flag === '--go-bin') { args.goBin = value; i += 1; }
    else if (flag === '--deadline-ms') { args.deadlineMs = Number(value); i += 1; }
    else if (flag === '--root') {
      const root = parseRoot(value);
      if (args.roots.some((entry) => entry.id === root.id)) throw new Error(`--root id repeated: ${root.id}`);
      args.roots.push(root);
      i += 1;
    }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.manifest) throw new Error('--manifest is required');
  if (!args.goBin) throw new Error('--go-bin is required');
  if (!Number.isFinite(args.deadlineMs) || args.deadlineMs < 0) throw new Error('--deadline-ms must be a number');
  return args;
}

const args = parseArgs(process.argv.slice(2));

let fixtureDir = null;
const scratchDirs = [];
let session = null;
let controlServer = null;
let shuttingDown = false;
let deadlineTimer = null;
let token = null;
let manifest = null;

function removeFixtureDir() {
  for (const dir of scratchDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  if (!fixtureDir) return;
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  fixtureDir = null;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
  if (session) { try { await session.stop(); } catch {} session = null; }
  if (controlServer) {
    await new Promise((resolve) => controlServer.close(resolve));
    controlServer = null;
  }
  removeFixtureDir();
  process.exit(code);
}

process.on('SIGTERM', () => { shutdown(0); });
process.on('SIGINT', () => { shutdown(0); });

deadlineTimer = setTimeout(() => {
  process.stderr.write(`managed fixture: boot exceeded ${args.deadlineMs} ms\n`);
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

// A port the pair can have: Go gives root i the port `port + i`, so both P and
// P+1 must be free on loopback before the hosts start.
function probePort(port) {
  return new Promise((resolve) => {
    const first = net.createServer();
    first.once('error', () => resolve(false));
    first.listen(port, '127.0.0.1', () => {
      first.close(() => {
        const second = net.createServer();
        second.once('error', () => resolve(false));
        second.listen(port + 1, '127.0.0.1', () => second.close(() => resolve(true)));
      });
    });
  });
}

async function chooseBasePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 39999);
    if (await probePort(port)) return port;
  }
  throw new Error('no free base port in 20000..60000');
}

function headOf(repo) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const rootDirs = {};
  let rootIds;
  if (args.roots.length > 0) {
    for (const root of args.roots) rootDirs[root.id] = root.dir;
    rootIds = args.roots.map((root) => root.id);
  } else {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-fixture-'));
    rootIds = ['root-a', 'root-b'];
    for (const id of rootIds) rootDirs[id] = path.join(fixtureDir, id);
    for (const dir of Object.values(rootDirs)) fs.mkdirSync(dir, { recursive: true });
  }

  const port = await chooseBasePort();
  const bin = path.resolve(args.goBin);
  const env = { ...process.env, HYPERCLAY_PAGE_COMPACTION: '0' };

  async function bootHosts() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-fixture-scratch-'));
    scratchDirs.push(scratch);
    return startManaged({
      bin,
      scratch,
      roots: rootIds.map((id) => rootDirs[id]),
      port,
      env,
    });
  }

  // Go numbers its roots root-0, root-1; the manifest and every case name them
  // root-a, root-b.
  const goIdFor = (id) => {
    const index = rootIds.indexOf(id);
    return index === -1 ? null : `root-${index}`;
  };

  function manifestRoots() {
    const named = new Map((session?.readyRoots ?? []).map((root) => [root.id, root]));
    return rootIds.map((id, index) => {
      const entry = named.get(`root-${index}`);
      if (!entry) throw new Error(`the go host names no root-${index}`);
      return { id, url: entry.url, fixtureRoot: rootDirs[id] };
    });
  }

  // Local's in-process fixture runs its authority with pageCompaction: false,
  // and the baseline was recorded that way, so compaction stays off here.
  session = await bootHosts();

  if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }

  token = crypto.randomBytes(24).toString('hex');
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

      // The wait is answered where the rooms live: in the service process.
      if (req.method === 'POST' && url.pathname === '/checkpoint-wait') {
        const body = await readJsonBody(req);
        const rootId = goIdFor(body.root);
        if (!rootId) { sendJson(res, 400, { error: 'bad-request' }); return; }
        const answer = await fetch(`${session.service.url}/v1/checkpoint-wait`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.service.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ root: rootId, name: body.path, timeoutMs: body.timeoutMs }),
        });
        const text = await answer.text();
        res.writeHead(answer.status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/restart') {
        await readJsonBody(req);
        await session.stop();
        try {
          session = await bootHosts();
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          roots: manifestRoots().map((root) => ({
            id: root.id, url: root.url, port: Number(new URL(root.url).port),
          })),
        });
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

  manifest = {
    schema: 1,
    hostBuild: { version: 'managed-trial', source: `${sha256(fs.readFileSync(bin))}@${headOf(REPO)}` },
    roots: manifestRoots(),
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

main().catch(async (error) => {
  process.stderr.write(`managed fixture: ${error && error.stack ? error.stack : error}\n`);
  await shutdown(1);
});
