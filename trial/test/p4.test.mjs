import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRoots, startLocal } from '../p1.mjs';
import { runCase } from '../p4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const P4 = path.join(REPO, 'trial', 'p4.mjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runP4(args, tmp) {
  return spawnSync(process.execPath, [P4, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
    timeout: 900000,
  });
}

function report(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function entries(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function leftoverRoots(dir) {
  return entries(dir).filter((name) => name.startsWith('hyperclay-p1-')
    || name.startsWith('hyperclay-p4-')
    || name.startsWith('host-http-fixture-'));
}

function processesUnder(dir) {
  const ps = spawnSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' });
  return ps.stdout.split('\n').filter((line) => line.includes(dir)).map((line) => line.trim());
}

function document(inner) {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>p4</title></head>\n<body>${inner}</body>\n</html>\n`;
}

// A host that forwards to a real one but answers the upload with an absolute
// URL: the one thing p4.root-relative-upload refuses.
function startAbsoluteUploadProxy(target) {
  const server = http.createServer((req, res) => {
    const upstream = http.request(`${target}${req.url}`, {
      method: req.method,
      headers: { ...req.headers, host: new URL(target).host },
    }, (answer) => {
      const chunks = [];
      answer.on('data', (chunk) => chunks.push(chunk));
      answer.on('end', () => {
        let body = Buffer.concat(chunks);
        const headers = { ...answer.headers };
        if (req.method === 'POST' && req.url === '/_/upload') {
          const parsed = JSON.parse(body.toString('utf8'));
          const port = server.address().port;
          parsed.uploads = (parsed.uploads ?? []).map((entry) => ({
            ...entry,
            url: `http://127.0.0.1:${port}${entry.url}`,
          }));
          body = Buffer.from(JSON.stringify(parsed), 'utf8');
          headers['content-length'] = String(body.length);
        }
        res.writeHead(answer.statusCode, headers);
        res.end(body);
      });
    });
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('bad gateway');
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      stop: () => new Promise((done) => server.close(done)),
    }));
  });
}

test('a local run passes all five cases', () => {
  const tmp = tempDir('hcl-p4-local-');
  try {
    const out = path.join(tmp, 'p4.json');
    const result = runP4(['--a', 'local', '--b', 'local', '--out', out], tmp);
    assert.equal(result.status, 0, result.stderr);
    const written = report(out);
    assert.equal(written.verdict, 'pass');
    assert.equal(written.a, 'local');
    assert.equal(written.b, 'local');
    assert.deepEqual(written.cases.map((entry) => entry.name), [
      'p4.cookie-lane-frozen-client',
      'p4.root-relative-upload',
      'p4.versions-reader',
      'p4.iframe',
      'p4.forged-document-url',
    ]);
    for (const entry of written.cases) {
      assert.equal(entry.pass, true, `${entry.name}: ${entry.why}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a host that answers an absolute upload URL fails the root-relative case', async () => {
  const made = makeRoots();
  let session = null;
  let proxy = null;
  try {
    fs.mkdirSync(path.join(made.roots[0], 'apps'), { recursive: true });
    fs.mkdirSync(path.join(made.roots[0], 'other'), { recursive: true });
    fs.writeFileSync(path.join(made.roots[0], 'apps', 'x.html'), document('<p>apps</p>'));
    fs.writeFileSync(path.join(made.roots[0], 'other', 'y.html'), document('<p>other</p>'));
    session = await startLocal({ scratch: made.scratch, roots: made.roots });
    proxy = await startAbsoluteUploadProxy(session.url);

    const result = await runCase('p4.root-relative-upload', {
      aUrl: session.url,
      bUrl: proxy.url,
      aRoots: made.roots,
      bRoots: made.roots,
      tmp: made.scratch,
    });
    assert.equal(result.pass, false);
    assert.match(result.why, /root-relative/);
    assert.match(result.why, /^b /, result.why);
  } finally {
    if (proxy) await proxy.stop();
    if (session) await session.stop();
    fs.rmSync(made.scratch, { recursive: true, force: true });
  }
});

test('a run leaves no process and no temp root behind', () => {
  const tmp = tempDir('hcl-p4-clean-');
  try {
    const out = path.join(tmp, 'p4.json');
    const result = runP4(['--a', 'local', '--b', 'local', '--out', out], tmp);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(leftoverRoots(tmp), []);
    assert.deepEqual(processesUnder(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
