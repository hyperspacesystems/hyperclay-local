#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', 'helpers', 'host-http-fixture.cjs');
const runner = path.join(here, 'run.mjs');
const created = [];

function parseArgs(argv) {
  const args = { profile: 'local-full', report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--profile') { args.profile = value; i += 1; }
    else if (flag === '--report') { args.report = value; i += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.profile) throw new Error('--profile needs a value');
  return args;
}

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

function spawnLauncher(manifestPath) {
  const child = spawn(process.execPath, [launcher, '--manifest', manifestPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

function runRunner(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function startEtagProxy(targetUrl) {
  const server = http.createServer(async (req, res) => {
    try {
      const headers = { ...req.headers };
      for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) delete headers[name];
      const upstream = await fetch(`${targetUrl}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const out = {};
      for (const [name, value] of upstream.headers) {
        if (['etag', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'set-cookie'].includes(name)) {
          continue;
        }
        out[name] = value;
      }
      const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
      if (cookies.length) out['set-cookie'] = cookies;
      out.etag = '"0000000000000000"';
      res.writeHead(upstream.status, out);
      res.end(bytes);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(error && error.message));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startCredentialStrippingProxy(targetUrl) {
  const server = http.createServer(async (req, res) => {
    try {
      const headers = { ...req.headers };
      for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) delete headers[name];
      const upstream = await fetch(`${targetUrl}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      let bytes = Buffer.from(await upstream.arrayBuffer());
      const type = upstream.headers.get('content-type') || '';
      if (type.includes('text/html')) {
        bytes = Buffer.from(bytes.toString('latin1').replace(/\s+documentetag="[^"]*"/g, ''), 'latin1');
      }
      const out = {};
      for (const [name, value] of upstream.headers) {
        if (['content-length', 'connection', 'keep-alive', 'transfer-encoding'].includes(name)) continue;
        out[name] = value;
      }
      const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(upstream.status, out);
      res.end(bytes);
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(error && error.message));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const tempDir = await makeTempDir('http-self-test-');
const manifestPath = path.join(tempDir, 'manifest.json');
const reportPath = args.report ? path.resolve(args.report) : path.join(tempDir, 'run-report.json');

const fixture = spawnLauncher(manifestPath);
let fixtureExit = null;
fixture.child.once('exit', (code, signal) => { fixtureExit = { code, signal }; });

const manifest = await waitForManifest(manifestPath, 30000);
if (!manifest) {
  fixture.child.kill('SIGKILL');
  console.error(`http self test: manifest did not appear within 30s\n${fixture.logs.join('')}`);
  for (const dir of created) await fsp.rm(dir, { recursive: true, force: true });
  process.exit(1);
}

try {
  const full = await runRunner([
    '--fixtures', manifestPath,
    '--profile', args.profile,
    '--report', reportPath,
  ]);
  assert.equal(full.code, 0, `full run exit ${full.code} ${full.signal || ''}\n${full.stdout}${full.stderr}`);

  const report = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
  assert.ok(report.summary.pass > 0, `report pass count is ${report.summary.pass}`);
  assert.equal(report.summary.fail, 0, `report fail count is ${report.summary.fail}`);
  assert.ok(report.summary.pass >= 30, `report pass count is ${report.summary.pass}`);
  assert.equal(report.summary.pending, 0, `report pending count is ${report.summary.pending}`);
  assert.equal(report.complete, true, `report complete is ${report.complete}`);
  assert.ok(Array.isArray(report.cases) && report.cases.length >= 30, `report has ${report.cases?.length} cases`);
  for (const entry of report.cases) {
    assert.equal(entry.status, 'pass', `case ${entry.id} is ${entry.status}: ${entry.detail}`);
  }
  console.log(
    `http self test: summary pass=${report.summary.pass} fail=${report.summary.fail} ` +
    `pending=${report.summary.pending} cases=${report.cases.length} complete=${report.complete}`,
  );

  const completeRun = await runRunner(['--fixtures', manifestPath, '--profile', args.profile, '--require-complete']);
  assert.equal(completeRun.code, 0,
    `--require-complete exit ${completeRun.code} (${completeRun.stderr.trim()})\n${completeRun.stdout}`);

  // A partial selection never covers the profile, so the run is not complete and
  // --require-complete refuses it even with nothing pending.
  const partial = await runRunner([
    '--fixtures', manifestPath,
    '--profile', args.profile,
    '--case', 'alias.frozen-client',
    '--require-complete',
  ]);
  assert.equal(partial.code, 3,
    `partial --require-complete exit ${partial.code} (${partial.stderr.trim()})\n${partial.stdout}`);

  const schemaTwoPath = path.join(tempDir, 'manifest-schema-2.json');
  await fsp.writeFile(schemaTwoPath, `${JSON.stringify({ ...manifest, schema: 2 }, null, 2)}\n`);
  const badSchema = await runRunner(['--fixtures', schemaTwoPath, '--profile', args.profile]);
  assert.equal(badSchema.code, 3, `schema 2 exit ${badSchema.code} (${badSchema.stderr.trim()})`);

  const unknownCase = await runRunner(['--fixtures', manifestPath, '--profile', args.profile, '--case', 'no.such.case']);
  assert.equal(unknownCase.code, 3, `unknown case exit ${unknownCase.code} (${unknownCase.stderr.trim()})`);

  const rootA = manifest.roots.find((root) => root.id === 'root-a');
  assert.ok(rootA, 'manifest names root-a');
  const proxy = await startEtagProxy(rootA.url);
  try {
    const proxyReportPath = path.join(tempDir, 'proxy-report.json');
    const proxyRun = await runRunner([
      '--fixtures', manifestPath,
      '--profile', args.profile,
      '--url', proxy.url,
      '--case', 'precondition.competing-saves',
      '--case', 'precondition.unchanged-save',
      '--report', proxyReportPath,
    ]);
    assert.equal(proxyRun.code, 1, `ETag proxy run exit ${proxyRun.code}\n${proxyRun.stdout}${proxyRun.stderr}`);
    const proxyReport = JSON.parse(await fsp.readFile(proxyReportPath, 'utf8'));
    const failing = proxyReport.cases.filter((entry) => entry.status !== 'pass').map((entry) => entry.id);
    assert.ok(failing.length > 0, 'the ETag proxy broke no case');
    const expected = new Set(['precondition.competing-saves', 'precondition.unchanged-save']);
    for (const id of failing) assert.ok(expected.has(id), `unexpected failing case under the ETag proxy: ${id}`);
    console.log(`http self test: ETag proxy failed ${failing.join(', ')}`);
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve));
  }

  const credentialProxy = await startCredentialStrippingProxy(rootA.url);
  try {
    const strippedReportPath = path.join(tempDir, 'stripped-report.json');
    const strippedRun = await runRunner([
      '--fixtures', manifestPath,
      '--profile', args.profile,
      '--url', credentialProxy.url,
      '--case', 'workspace.iframe-credential',
      '--report', strippedReportPath,
    ]);
    assert.equal(strippedRun.code, 1,
      `credential-stripping proxy run exit ${strippedRun.code}\n${strippedRun.stdout}${strippedRun.stderr}`);
    const strippedReport = JSON.parse(await fsp.readFile(strippedReportPath, 'utf8'));
    const broken = strippedReport.cases.find((entry) => entry.id === 'workspace.iframe-credential');
    assert.ok(broken && broken.status !== 'pass',
      'the credential-stripping proxy left workspace.iframe-credential passing');
    console.log(`http self test: credential-stripping proxy failed ${broken.id}: ${broken.detail}`);
  } finally {
    await new Promise((resolve) => credentialProxy.server.close(resolve));
  }

  const stopped = await fetch(`${manifest.control.url}/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${manifest.control.token}` },
  });
  assert.equal(stopped.status, 200, `stop status ${stopped.status}`);
  const exit = await new Promise((resolve) => {
    if (fixtureExit) return resolve(fixtureExit);
    fixture.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0, `launcher exit ${exit.code} ${exit.signal || ''}\n${fixture.logs.join('')}`);

  console.log('http self test: ok');
} catch (error) {
  console.error(error);
  if (!fixtureExit) fixture.child.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  if (!fixtureExit) fixture.child.kill('SIGKILL');
  for (const dir of created) await fsp.rm(dir, { recursive: true, force: true });
}
