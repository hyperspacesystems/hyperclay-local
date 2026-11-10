'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { realpathSync } = require('node:fs');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = process.env.HTMLCLAY_SOURCE;
const SKIP = SOURCE
  ? false
  : 'HTMLCLAY_SOURCE is unset: these tests build and drive the Go managed-trial binary from the htmlclay source tree';

const { createTrialService } = require('../service.cjs');
const { clearConnection } = require('../go-process.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeout = 10000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await wait(interval);
  }
}

function document(inner) {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>go host</title></head>\n<body>${inner}</body>\n</html>\n`;
}

function request(target, { method = 'GET', headers = {}, body = null } = {}) {
  const payload = body === null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: { ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function save(rootUrl, name, html, headers = {}) {
  return request(`${rootUrl}/_/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html', 'Document-URL': `${rootUrl}/${name}`, ...headers },
    body: html,
  });
}

// The managed-trial binary built from the htmlclay source tree, at `tmp`.
function buildTrialBinary(tmp) {
  const bin = path.join(tmp, 'managed-trial');
  const build = spawnSync('go', ['build', '-tags', 'managedtrial', '-o', bin, './cmd/managed-trial'], {
    cwd: SOURCE,
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
    timeout: 600000,
  });
  assert.equal(build.status, 0, `the managed-trial build failed:\n${build.stderr || build.stdout}`);
  return bin;
}

// The two served roots a pair is booted over, created under `tmp`.
function makeRoots(tmp) {
  return ['root-a', 'root-b'].map((name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  });
}

async function bootPair(bin, roots) {
  const service = createTrialService({ logError: () => {} });
  const serviceUrl = await service.listen();
  const goSecret = randomBytes(32).toString('hex');
  const child = spawn(bin, ['--root', roots[0], '--root', roots[1], '--port', '0', '--local-source', REPO, '--bootstrap-stdin'], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: process.env,
  });
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ v: 1, secret: goSecret, service: { url: serviceUrl, secret: service.secret, epoch: service.epoch } })}\n`);
  let out = '';
  child.stdout.setEncoding('utf8');
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no READY line: ${out}`)), 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /^READY (\{.*\})$/m.exec(out);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`go exited ${code}: ${out}`)); });
  });
  await service.attachGo({ url: ready.control, secret: goSecret, epoch: ready.epoch, roots: ready.roots });
  const stop = async () => {
    clearConnection();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
    await service.close();
  };
  return { service, child, ready, stop, url: serviceUrl };
}

// Wraps the service's handlers for `pathnames` so each call is recorded with the
// body's `path`, `lane`, `origin`, `name` and `event`, then passed through.
function trackCalls(service, pathnames, calls = []) {
  for (const pathname of pathnames) {
    const original = service.handlers.get(pathname);
    service.handlers.set(pathname, (body, reply) => {
      calls.push({ path: pathname, lane: body.lane, origin: body.origin, name: body.name, event: body.event });
      original(body, reply);
    });
  }
  return calls;
}

module.exports = {
  REPO, SOURCE, SKIP, wait, until, document, request, save,
  buildTrialBinary, makeRoots, bootPair, trackCalls,
};
