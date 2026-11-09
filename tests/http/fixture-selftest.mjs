import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', 'helpers', 'host-http-fixture.cjs');
const created = [];

async function makeTempDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function waitForManifest(manifestPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(manifestPath)) {
      const text = await fsp.readFile(manifestPath, 'utf8');
      if (text.trim()) {
        try { return JSON.parse(text); } catch {}
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function spawnLauncher(manifestPath, extra = []) {
  const child = spawn(process.execPath, [launcher, '--manifest', manifestPath, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function control(manifest, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token !== false) headers.authorization = `Bearer ${manifest.control.token}`;
  return fetch(`${manifest.control.url}${route}`, { ...options, headers });
}

async function refusesConnections(url) {
  try {
    await fetch(url);
    return false;
  } catch (error) {
    return error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
  }
}

const tempDir = await makeTempDir('fixture-selftest-');
const manifestPath = path.join(tempDir, 'manifest.json');

const first = spawnLauncher(manifestPath);
let firstExited = null;
first.child.once('exit', (code, signal) => { firstExited = { code, signal }; });

const manifest = await waitForManifest(manifestPath, 25000);
if (!manifest) {
  first.child.kill('SIGKILL');
  console.error(`selftest: manifest did not appear within 25s\n${first.logs.join('')}`);
  for (const dir of created) await fsp.rm(dir, { recursive: true, force: true });
  process.exit(1);
}

try {
  const mode = (await fsp.stat(manifestPath)).mode & 0o777;
  assert.equal(mode, 0o600, `manifest mode is ${mode.toString(8)}, expected 600`);

  const rootA = manifest.roots.find((root) => root.id === 'root-a');
  const rootB = manifest.roots.find((root) => root.id === 'root-b');
  assert.ok(rootA && rootB, 'manifest names both roots');
  assert.notEqual(rootA.url, rootB.url, 'root urls differ');

  const html = '<!doctype html><html><head></head><body><p>hello</p></body></html>';
  const seeded = await control(manifest, '/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: 'root-a', path: 'doc.html', base64: Buffer.from(html).toString('base64') }),
  });
  assert.equal(seeded.status, 200, `seed status ${seeded.status}`);
  assert.match((await seeded.json()).sha256, /^[0-9a-f]{64}$/);

  const served = await fetch(`${rootA.url}/doc.html`);
  assert.equal(served.status, 200, `root-a doc.html status ${served.status}`);
  assert.ok((await served.text()).includes('hello'), 'root-a serves the seeded document');

  const other = await fetch(`${rootB.url}/doc.html`);
  assert.equal(other.status, 404, `root-b doc.html status ${other.status}`);

  const meta = await fetch(`${rootA.url}/_/meta`, { headers: { 'document-url': `${rootA.url}/doc.html` } });
  assert.equal(meta.status, 200, `meta status ${meta.status}`);
  const metaBody = await meta.json();
  assert.ok(Array.isArray(metaBody.extensions), 'meta lists extensions');
  assert.ok(metaBody.extensions.includes('live-data'), `meta extensions ${JSON.stringify(metaBody.extensions)} lack live-data`);

  const unauthorized = await control(manifest, '/stop', { method: 'POST', token: false });
  assert.equal(unauthorized.status, 401, `unauthenticated control status ${unauthorized.status}`);

  const stopped = await control(manifest, '/stop', { method: 'POST' });
  assert.equal(stopped.status, 200, `stop status ${stopped.status}`);

  const exit = await new Promise((resolve) => {
    if (firstExited) return resolve(firstExited);
    first.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0, `launcher exit ${exit.code} ${exit.signal || ''}\n${first.logs.join('')}`);

  assert.ok(await refusesConnections(`${rootA.url}/doc.html`), 'root-a refuses connections after stop');
  assert.ok(await refusesConnections(`${rootB.url}/doc.html`), 'root-b refuses connections after stop');
  assert.equal(fs.existsSync(path.dirname(rootA.fixtureRoot)), false, 'fixture temp directory removed');

  const expiredDir = await makeTempDir('fixture-selftest-expired-');
  const expiredManifest = path.join(expiredDir, 'manifest.json');
  const second = spawnLauncher(expiredManifest, ['--deadline-ms', '1']);
  const expiredExit = await waitForExit(second.child);
  assert.equal(expiredExit.code, 3, `expired launcher exit ${expiredExit.code} ${expiredExit.signal || ''}\n${second.logs.join('')}`);
  assert.ok(second.logs.join('').includes('fixture: boot exceeded 1 ms'), 'deadline message printed');
  assert.equal(fs.existsSync(expiredManifest), false, 'no manifest written when the deadline expires');

  console.log('fixture selftest: ok');
} catch (error) {
  console.error(error);
  first.child.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  if (!firstExited) first.child.kill('SIGKILL');
  for (const dir of created) await fsp.rm(dir, { recursive: true, force: true });
}
