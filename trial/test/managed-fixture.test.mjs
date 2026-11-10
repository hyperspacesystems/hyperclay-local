import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import harness from './service-harness.cjs';

const { SKIP, request, buildTrialBinary } = harness;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'managed-fixture.mjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const gone = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode });
    return;
  }
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

function within(promise, ms, what) {
  return Promise.race([
    promise,
    wait(ms).then(() => { throw new Error(`${what} did not happen within ${ms}ms`); }),
  ]);
}

async function waitForManifest(manifestPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(manifestPath)) {
      const text = fs.readFileSync(manifestPath, 'utf8');
      if (text.trim()) {
        try { return JSON.parse(text); } catch {}
      }
    }
    await wait(100);
  }
  return null;
}

const json = (target, body, headers = {}) => request(target, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('the managed fixture answers what the http suite asks of a fixture', { skip: SKIP }, async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-managed-fixture-')));
  const bin = buildTrialBinary(tmp);
  const manifestPath = path.join(tmp, 'manifest.json');
  const child = spawn(process.execPath, [FIXTURE, '--manifest', manifestPath, '--go-bin', bin], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const exit = gone(child);

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await within(exit, 15000, 'the fixture\u2019s exit').catch(() => { child.kill('SIGKILL'); });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const manifest = await waitForManifest(manifestPath, 60000);
  assert.ok(manifest, `no manifest within 60s:\n${logs.join('')}`);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.expectedProfile, 'local-full');
  const rootA = manifest.roots.find((root) => root.id === 'root-a');
  assert.ok(rootA, 'the manifest names root-a');
  const control = manifest.control;
  const bearer = { authorization: `Bearer ${control.token}` };

  await t.test('a control request with no bearer answers 401', async () => {
    const answer = await request(`${control.url}/read?root=root-a&path=a/b.html`);
    assert.equal(answer.status, 401);
  });

  const document = '<!doctype html>\n<html><head><meta charset="utf-8"><title>fixture</title></head><body><p>seed</p></body></html>\n';
  const sha = crypto.createHash('sha256').update(Buffer.from(document, 'utf8')).digest('hex');

  await t.test('a seeded document round-trips through read', async () => {
    const seeded = await json(`${control.url}/seed`, {
      root: 'root-a', path: 'a/b.html', base64: Buffer.from(document, 'utf8').toString('base64'),
    }, bearer);
    assert.equal(seeded.status, 200);
    assert.equal(JSON.parse(seeded.body).sha256, sha);
    const read = await request(`${control.url}/read?root=root-a&path=a/b.html`, { headers: bearer });
    assert.equal(read.status, 200);
    const answer = JSON.parse(read.body);
    assert.equal(answer.exists, true);
    assert.equal(answer.sha256, sha);
  });

  await t.test('a document with no room waits out nothing', async () => {
    const waited = await json(`${control.url}/checkpoint-wait`, {
      root: 'root-a', path: 'no-room.html', timeoutMs: 2000,
    }, bearer);
    assert.equal(waited.status, 200, waited.body);
    const answer = JSON.parse(waited.body);
    assert.equal(answer.ok, true);
    assert.equal(answer.observed, false);
  });

  await t.test('a restart keeps the address the manifest promised', async () => {
    const restarted = await json(`${control.url}/restart`, {}, bearer);
    assert.equal(restarted.status, 200, restarted.body);
    const answer = JSON.parse(restarted.body);
    assert.equal(answer.ok, true);
    const again = answer.roots.find((root) => root.id === 'root-a');
    assert.ok(again, 'the restart names root-a');
    assert.equal(again.url, rootA.url);
    const served = await request(`${rootA.url}/a/b.html`);
    assert.equal(served.status, 200);
  });

  await t.test('a stop answers and the fixture exits 0', async () => {
    const stopped = await json(`${control.url}/stop`, {}, bearer);
    assert.equal(stopped.status, 200);
    const ended = await within(exit, 15000, 'the fixture\u2019s exit');
    assert.equal(ended.code, 0, `fixture exit ${ended.code} ${ended.signal || ''}\n${logs.join('')}`);
  });
});
