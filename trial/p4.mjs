#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageDir } from '../scripts/conformance.mjs';
import { compare } from './differential.mjs';
import { makeRoots, startGo, startLocal } from './p1.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'hyperclay-local';
const TIMEOUT_MS = 30000;
const SAVE_GAP_MS = 40;
const CASES = [
  'p4.cookie-lane-frozen-client',
  'p4.root-relative-upload',
  'p4.versions-reader',
  'p4.iframe',
  'p4.forged-document-url',
];
const FROZEN_ROWS = [
  'frozen.cookie-lane-save',
  'frozen.marked-save-route',
  'frozen.bare-save-route',
  'frozen.oldest-cookie-lane',
];
const EXPECTATIONS = path.join(
  REPO, 'node_modules', '@panphora', 'host-conformance', 'frozen', 'expectations.json',
);
// A 1x1 PNG: the bytes are not a document, so an uploaded file can never be
// mistaken for one on the way back.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c63000100000500010d0a2db4', 'hex',
);
const VERSION_FILE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}(Z|[+-]\d{4})?(-\d{3})?\.[A-Za-z0-9]+$/;
const COMPARED_HEADERS = ['content-type', 'etag', 'location', 'cache-control', 'vary'];

class Infrastructure extends Error {}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function document(inner) {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>p4</title></head>\n<body>${inner}</body>\n</html>\n`;
}

function stripSavetoken(html) {
  const match = /<html(?=[\s>])[^>]*>/i.exec(html);
  if (!match) return html;
  const tag = match[0];
  const stripped = tag.replace(/\ssavetoken\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
  if (stripped === tag) return html;
  return html.slice(0, match.index) + stripped + html.slice(match.index + tag.length);
}

function rootAttributes(html) {
  const match = /<html(?=[\s>])([^>]*)>/i.exec(html);
  if (!match) return [];
  const names = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  let hit = pattern.exec(match[1]);
  while (hit) {
    names.push(hit[1].toLowerCase());
    hit = pattern.exec(match[1]);
  }
  return names;
}

// What a restore is allowed to change: the token is refused on every write, and
// the format floor marker is canonical by construction (page-format.js's
// withPageFormatFloor). Everything else is the version's own bytes.
function restoreNormalized(html) {
  return stripSavetoken(html).replace(/<meta\b[^>]*\bname\s*=\s*["']?clay-blockeditor-format["']?[^>]*>\s*/gi, '');
}

function sideOf(rawUrl) {
  const url = new URL(rawUrl);
  const hosts = new Set([url.hostname]);
  if (url.hostname === '127.0.0.1') hosts.add('localhost');
  if (url.hostname === 'localhost') hosts.add('127.0.0.1');
  const origins = [];
  for (const host of hosts) origins.push(`http://${host}${url.port ? `:${url.port}` : ''}`);
  return { origins: origins.sort((x, y) => y.length - x.length) };
}

function request(baseUrl, {
  method = 'GET', path: requestPath = '/', headers = {}, body = null,
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, `${baseUrl.replace(/\/+$/, '')}/`);
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['content-length'] = String(payload.length);
    const req = http.request(target, { method, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const collected = {};
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const key = res.rawHeaders[i].toLowerCase();
          collected[key] = collected[key] === undefined ? res.rawHeaders[i + 1] : `${collected[key]}, ${res.rawHeaders[i + 1]}`;
        }
        resolve({
          ok: true, status: res.statusCode, headers: collected, body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => {
      const error = new Error(`timeout after ${TIMEOUT_MS} ms`);
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    req.on('error', (error) => reject(new Infrastructure(`${method} ${requestPath} on ${baseUrl} failed: ${error.message}`)));
    req.end(payload ?? undefined);
  });
}

function textOf(response) {
  return response.body.toString('utf8');
}

function jsonOf(response) {
  try {
    return JSON.parse(textOf(response));
  } catch {
    return null;
  }
}

// The differential's own normalization, applied to one answer: this side's
// origins become <origin>, a savetoken on the root element is removed, and the
// blockeditor-revision header is dropped (AD3/AD4).
function normalizedAnswer(response, side) {
  let body = textOf(response);
  for (const origin of side.origins) body = body.split(origin).join('<origin>');
  if (String(response.headers['content-type'] || '').toLowerCase().includes('text/html')) {
    body = stripSavetoken(body);
  }
  const headers = {};
  for (const name of COMPARED_HEADERS) {
    if (response.headers[name] !== undefined) headers[name] = response.headers[name];
  }
  return { status: response.status, headers, body };
}

// Null when the two answers are equal after that normalization, else a sentence
// naming the first field that differs.
function answerDifference(a, b) {
  if (a.status !== b.status) return `status ${a.status} vs ${b.status}`;
  for (const [name, value] of Object.entries(a.headers)) {
    if (b.headers[name] !== value) return `${name} ${JSON.stringify(value)} vs ${JSON.stringify(b.headers[name])}`;
  }
  for (const name of Object.keys(b.headers)) {
    if (a.headers[name] === undefined) return `${name} <absent> vs ${JSON.stringify(b.headers[name])}`;
  }
  if (a.body !== b.body) {
    return `body differs: ${JSON.stringify(a.body.slice(0, 200))} vs ${JSON.stringify(b.body.slice(0, 200))}`;
  }
  return null;
}

async function compareGet(aUrl, bUrl, requestPath, headers = {}, family = 'document') {
  const result = await compare({
    a: aUrl,
    b: bUrl,
    requests: [{
      family, method: 'GET', path: requestPath, headers, judged: true,
    }],
  });
  return result.judged.differences;
}

function describe(differences) {
  return differences
    .map((entry) => `${entry.field} ${JSON.stringify(entry.a)} vs ${JSON.stringify(entry.b)}`)
    .join('; ');
}

function walkFiles(root) {
  const found = [];
  const visit = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) visit(childAbs, childRel);
      else if (entry.isFile()) found.push({ rel: childRel, sha256: sha256(readFileSync(childAbs)) });
    }
  };
  visit(root, '');
  return found;
}

function listVersions(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => VERSION_FILE.test(name) && statSync(path.join(dir, name)).isFile()).sort();
}

function hostRootsOf(kind, session, dirs) {
  if (kind === 'local') {
    const roots = Array.isArray(session.manifest?.roots) ? session.manifest.roots : [];
    return roots.map((root, index) => ({ id: root.id, url: root.url, dir: dirs[index] ?? root.fixtureRoot }));
  }
  const roots = Array.isArray(session.readyRoots) ? session.readyRoots : [];
  return roots.map((root, index) => ({ id: `root-${index}`, url: root.url, dir: dirs[index] ?? root.path }));
}

function writeRootFile(dir, rel, bytes) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

// ---- the five cases -------------------------------------------------------

async function frozenClient({ a, b, scratch }) {
  const dir = packageDir(REPO);
  const expectedRows = readJsonFile(EXPECTATIONS).rows;
  const expected = {};
  for (const id of FROZEN_ROWS) {
    const answer = expectedRows?.[id]?.hosts?.[HOST]?.answer;
    if (typeof answer !== 'string') {
      throw new Infrastructure(`expectations.json names no answer for ${id} on ${HOST}`);
    }
    expected[id] = answer;
  }

  const runOne = async (host, label) => {
    const reportPath = path.join(scratch, `frozen-${label}.json`);
    const child = spawn(process.execPath, [
      path.join(dir, 'bin', 'host-conformance.js'),
      '--engine', 'frozen',
      '--only', FROZEN_ROWS.join(','),
      '--host', HOST,
      '--url', host.url,
      '--root', host.roots[0],
      '--report', reportPath,
    ], { cwd: REPO, stdio: ['ignore', 'ignore', 'ignore'] });
    const exit = await new Promise((resolve, reject) => {
      child.on('error', (error) => reject(new Infrastructure(`the conformance package could not start: ${error.message}`)));
      child.on('exit', (code, signal) => resolve(signal ? { signal } : { code: code ?? 3 }));
    });
    let report;
    try {
      report = readJsonFile(reportPath);
    } catch (error) {
      throw new Infrastructure(`the conformance package wrote no report at ${reportPath}: ${error.message}`);
    }
    const answers = { exit: exit.signal ? null : exit.code, rows: {} };
    for (const id of FROZEN_ROWS) {
      const check = Array.isArray(report.checks) ? report.checks.find((entry) => entry?.id === id) : null;
      if (!check) throw new Infrastructure(`the package report names no row ${id}`);
      answers.rows[id] = { answer: check.answer ?? null, status: check.status ?? null };
    }
    return answers;
  };

  const aAnswers = await runOne(a, 'a');
  const bAnswers = await runOne(b, 'b');

  const problems = [];
  for (const [label, answers] of [['a', aAnswers], ['b', bAnswers]]) {
    for (const id of FROZEN_ROWS) {
      const got = answers.rows[id].answer;
      if (got !== expected[id]) {
        problems.push(`${label} answered ${JSON.stringify(got)} for ${id}, not ${JSON.stringify(expected[id])}`);
      }
    }
  }
  return {
    pass: problems.length === 0,
    why: problems.join('; '),
    a: aAnswers,
    b: bAnswers,
  };
}

async function rootRelativeUpload({ a, b }) {
  const boundary = '----p4-upload-boundary';
  const part = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p4.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const uploadTo = async (host) => {
    const answer = await request(host.url, {
      method: 'POST',
      path: '/_/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'document-url': `${host.url}/apps/x.html`,
      },
      body: part,
    });
    const parsed = jsonOf(answer);
    const url = parsed?.uploads?.[0]?.url ?? null;
    return {
      upload: answer,
      body: parsed,
      url,
      msgType: parsed?.msgType ?? null,
      sameBytes: false,
      fetched: null,
    };
  };

  const aSide = await uploadTo(a);
  const bSide = await uploadTo(b);

  for (const [label, host, side] of [['a', a, aSide], ['b', b, bSide]]) {
    if (side.upload.status !== 200 || side.msgType !== 'success' || typeof side.url !== 'string') {
      side.problem = `the upload answered ${side.upload.status} ${JSON.stringify(side.body)}`;
      continue;
    }
    // The way a page in other/ resolves the URL the answer handed it.
    const resolved = new URL(side.url, `${host.url}/other/y.html`);
    side.resolvedPath = `${resolved.pathname}${resolved.search}`;
    const fetched = await request(host.url, { path: side.resolvedPath });
    side.fetched = { status: fetched.status, sha256: sha256(fetched.body) };
    side.sameBytes = fetched.status === 200 && fetched.body.equals(PNG);
    if (!side.sameBytes) {
      side.problem = `the uploaded URL served ${fetched.status} and ${fetched.body.length} bytes, not the uploaded file`;
    } else if (!side.url.startsWith('/')) {
      side.problem = `the upload URL ${JSON.stringify(side.url)} is not root-relative`;
    }
  }

  const problems = [];
  for (const [label, side] of [['a', aSide], ['b', bSide]]) {
    if (side.problem) problems.push(`${label} ${side.problem}`);
  }
  if (!problems.length) {
    const difference = answerDifference(
      normalizedAnswer(aSide.upload, sideOf(a.url)),
      normalizedAnswer(bSide.upload, sideOf(b.url)),
    );
    if (difference) problems.push(`the two upload answers differ: ${difference}`);
    if (aSide.resolvedPath !== bSide.resolvedPath) {
      problems.push(`the two hosts served the upload at different paths: ${aSide.resolvedPath} vs ${bSide.resolvedPath}`);
    } else if (aSide.fetched.sha256 !== bSide.fetched.sha256) {
      problems.push(`the two hosts served different bytes at ${aSide.resolvedPath}`);
    }
  }

  const project = (side) => ({
    status: side.upload.status,
    body: side.body,
    url: side.url,
    fetched: side.fetched,
    sameBytes: side.sameBytes,
  });
  return {
    pass: problems.length === 0,
    why: problems.join('; '),
    a: project(aSide),
    b: project(bSide),
  };
}

async function versionsReader({ a, b }) {
  const read = async (host) => {
    const answer = {
      saves: [], list: null, entries: [], disk: null, restored: null, documentMatches: null,
    };
    for (const number of [1, 2, 3]) {
      const response = await request(host.url, {
        method: 'POST',
        path: '/_/save',
        headers: { 'content-type': 'text/html', 'document-url': `${host.url}/notes.html` },
        body: document(`<p>notes version ${number}</p>`),
      });
      answer.saves.push({ status: response.status, msgType: jsonOf(response)?.msgType ?? null });
      if (response.status !== 200) {
        answer.problem = `save ${number} answered ${response.status}`;
        return answer;
      }
      await wait(SAVE_GAP_MS);
    }

    const listResponse = await request(host.url, { path: '/_/versions/notes.html' });
    const list = jsonOf(listResponse);
    if (listResponse.status !== 200 || !list || !Array.isArray(list.versions)) {
      answer.problem = `GET /_/versions/notes.html answered ${listResponse.status}`;
      return answer;
    }
    answer.list = list;

    const versionsDir = path.join(host.roots[0], '.hyperclay', 'versions', 'notes');
    const recoveredDir = path.join(host.roots[0], '.hyperclay', 'recovered', 'notes');
    const onDisk = new Map();
    for (const name of listVersions(versionsDir)) onDisk.set(name, sha256(readFileSync(path.join(versionsDir, name))));
    for (const name of listVersions(recoveredDir)) onDisk.set(`recovered-${name}`, sha256(readFileSync(path.join(recoveredDir, name))));
    answer.disk = { count: onDisk.size, names: [...onDisk.keys()].sort() };

    for (const entry of list.versions) {
      const stored = String(entry?.name ?? '');
      const fetched = await request(host.url, { path: `/_/version/notes.html/${encodeURIComponent(stored)}` });
      const digest = fetched.status === 200 ? sha256(fetched.body) : null;
      answer.entries.push({
        name: stored,
        size: entry?.size ?? null,
        status: fetched.status,
        sha256: digest,
        diskSha256: onDisk.get(stored) ?? null,
      });
    }

    answer.problem = null;
    if (answer.entries.length !== answer.disk.count) {
      answer.problem = `the list holds ${answer.entries.length} version(s) where the store holds ${answer.disk.count}`;
      return answer;
    }
    for (const entry of answer.entries) {
      if (entry.status !== 200) {
        answer.problem = `GET a version answered ${entry.status} for ${entry.name}`;
        return answer;
      }
      if (entry.sha256 !== entry.diskSha256) {
        answer.problem = `the version ${entry.name} served ${entry.sha256} where the store holds ${entry.diskSha256}`;
        return answer;
      }
    }

    if (answer.entries.length < 2) {
      answer.problem = `only ${answer.entries.length} version(s): no second-newest version to restore`;
      return answer;
    }
    const target = answer.entries[1];
    const restoreResponse = await request(host.url, {
      method: 'POST',
      path: `/_/restore/notes.html/${encodeURIComponent(target.name)}`,
    });
    answer.restored = { name: target.name, status: restoreResponse.status, body: jsonOf(restoreResponse) };
    if (restoreResponse.status !== 200 || answer.restored.body?.ok !== true) {
      answer.problem = `POST /_/restore answered ${restoreResponse.status} ${JSON.stringify(answer.restored.body)}`;
      return answer;
    }

    const documentPath = path.join(host.roots[0], 'notes.html');
    const documentText = restoreNormalized(readFileSync(documentPath, 'utf8'));
    const versionResponse = await request(host.url, { path: `/_/version/notes.html/${encodeURIComponent(target.name)}` });
    const versionText = restoreNormalized(textOf(versionResponse));
    answer.documentMatches = documentText === versionText;
    if (!answer.documentMatches) {
      answer.problem = 'the restored notes.html is not the version it restored';
    }
    return answer;
  };

  const aSide = await read(a);
  const bSide = await read(b);

  const problems = [];
  if (aSide.problem) problems.push(`a ${aSide.problem}`);
  if (bSide.problem) problems.push(`b ${bSide.problem}`);
  if (!problems.length) {
    // Version names carry each host's own save instant, so the answers are
    // compared as what they mean: the same count, in the same order, of the same
    // bytes at the same size.
    const projection = (side) => JSON.stringify({
      ok: side.list.ok,
      name: side.list.name,
      versions: side.entries.map((entry) => ({ size: entry.size, sha256: entry.sha256 })),
    });
    if (projection(aSide) !== projection(bSide)) {
      problems.push(`the two version lists differ: ${projection(aSide)} vs ${projection(bSide)}`);
    }
    if (aSide.restored.status !== bSide.restored.status) {
      problems.push(`the two restores answered ${aSide.restored.status} and ${bSide.restored.status}`);
    }
  }

  const project = (side) => ({
    saves: side.saves,
    count: side.list?.versions?.length ?? null,
    entries: side.entries.map((entry) => ({
      size: entry.size, status: entry.status, sha256: entry.sha256, diskSha256: entry.diskSha256,
    })),
    disk: side.disk,
    restored: side.restored,
    documentMatches: side.documentMatches,
  });
  return {
    pass: problems.length === 0,
    why: problems.join('; '),
    a: project(aSide),
    b: project(bSide),
  };
}

async function iframe({ a, b }) {
  const readDocument = async (host, dest) => request(host.url, {
    path: '/x.html',
    headers: {
      'sec-fetch-dest': dest, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
    },
  });

  const probe = async (host) => {
    const answer = { iframe: null, document: null, saved: null };
    for (const dest of ['iframe', 'document']) {
      const response = await readDocument(host, dest);
      const text = textOf(response);
      answer[dest] = {
        status: response.status,
        sha256: sha256(text),
        savetoken: rootAttributes(text).includes('savetoken'),
      };
    }
    return answer;
  };

  const aSide = await probe(a);
  const bSide = await probe(b);

  const problems = [];
  for (const [label, side] of [['a', aSide], ['b', bSide]]) {
    for (const dest of ['iframe', 'document']) {
      if (side[dest].status !== 200) problems.push(`${label} answered ${side[dest].status} for the ${dest} GET`);
      if (side[dest].savetoken) problems.push(`${label}'s ${dest} answer carries a savetoken on the root element`);
    }
    if (side.iframe.sha256 !== side.document.sha256) {
      problems.push(`${label}'s iframe and document answers are different bytes`);
    }
  }
  if (!problems.length) {
    for (const dest of ['iframe', 'document']) {
      const differences = await compareGet(a.url, b.url, '/x.html', {
        'sec-fetch-dest': dest, 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
      });
      if (differences.length) problems.push(`the ${dest} answers differ: ${describe(differences)}`);
    }
  }

  const savedBody = document('<p>saved through the tokenless lane</p>');
  for (const [label, host, side] of [['a', a, aSide], ['b', b, bSide]]) {
    const response = await request(host.url, {
      method: 'POST',
      path: '/_/save',
      headers: { 'content-type': 'text/html', 'document-url': `${host.url}/x.html` },
      body: savedBody,
    });
    side.saved = { status: response.status, msgType: jsonOf(response)?.msgType ?? null };
    const onDisk = readFileSync(path.join(host.roots[0], 'x.html'), 'utf8');
    if (response.status !== 200 || onDisk !== savedBody) {
      problems.push(`${label}'s tokenless save did not land (answered ${response.status})`);
    }
  }

  const project = (side) => ({
    iframe: side.iframe, document: side.document, saved: side.saved,
  });
  return {
    pass: problems.length === 0,
    why: problems.join('; '),
    a: project(aSide),
    b: project(bSide),
  };
}

async function forgedDocumentUrl({ a, b }) {
  const runOn = async (host) => {
    const answer = { root2Before: null, response: null, root2After: null };
    if (host.roots.length < 2 || host.urls.length < 2) {
      throw new Infrastructure('this case needs a host serving two roots');
    }
    for (const [index, dir] of host.roots.entries()) {
      writeRootFile(dir, 'x.html', document(`<p>root ${index + 1}</p>`));
    }
    answer.root2Before = walkFiles(host.roots[1]);
    const response = await request(host.urls[0], {
      method: 'POST',
      path: '/_/save',
      headers: {
        'content-type': 'text/html',
        'document-url': `${host.urls[1]}/x.html`,
      },
      body: document('<p>forged document url</p>'),
    });
    answer.response = { status: response.status, body: jsonOf(response) };
    answer.root2After = walkFiles(host.roots[1]);
    return answer;
  };

  const aSide = await runOn(a);
  const bSide = await runOn(b);

  const unchanged = (side) => JSON.stringify(side.root2Before) === JSON.stringify(side.root2After);
  const problems = [];
  for (const [label, side] of [['a', aSide], ['b', bSide]]) {
    if (!side.root2Before.length) problems.push(`${label}'s second root held no file to protect`);
    if (!unchanged(side)) {
      const before = side.root2Before.map((entry) => `${entry.rel}:${entry.sha256}`).join(',');
      const after = side.root2After.map((entry) => `${entry.rel}:${entry.sha256}`).join(',');
      problems.push(`${label} wrote to the root its Document-URL did not name (${before} vs ${after})`);
    }
  }
  const project = (side) => ({
    root2Before: side.root2Before, root2After: side.root2After, response: side.response,
  });
  return {
    pass: problems.length === 0,
    why: problems.join('; '),
    a: project(aSide),
    b: project(bSide),
  };
}

const RUNNERS = {
  'p4.cookie-lane-frozen-client': frozenClient,
  'p4.root-relative-upload': rootRelativeUpload,
  'p4.versions-reader': versionsReader,
  'p4.iframe': iframe,
  'p4.forged-document-url': forgedDocumentUrl,
};

const SEEDS = {
  'p4.cookie-lane-frozen-client': [],
  'p4.root-relative-upload': [['apps/x.html', document('<p>apps</p>')], ['other/y.html', document('<p>other</p>')]],
  'p4.versions-reader': [['notes.html', document('<p>notes</p>')]],
  'p4.iframe': [['x.html', document('<p>x</p>')]],
  'p4.forged-document-url': [['x.html', document('<p>root 1</p>')]],
};

function hostOf(label, url, roots, urls) {
  if (typeof url !== 'string' || !url) throw new Infrastructure(`${label} names no URL`);
  const base = url.replace(/\/+$/, '');
  return { label, url: base, roots, urls: urls.length ? urls : [base] };
}

// One case, on two already-running hosts. `roots` are the folders those hosts
// serve, in root order: the cases that check what reached the disk read them
// directly.
export async function runCase(name, {
  aUrl, bUrl, aRoots = [], bRoots = [], aUrls = [], bUrls = [], a = 'a', b = 'b', tmp = os.tmpdir(),
} = {}) {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`unknown case ${name}`);
  const made = makeRoots({ tmp });
  try {
    const result = await runner({
      a: hostOf(a, aUrl, aRoots, aUrls),
      b: hostOf(b, bUrl, bRoots, bUrls),
      scratch: made.scratch,
    });
    return { name, ...result };
  } finally {
    rmSync(made.scratch, { recursive: true, force: true });
  }
}

// ---- hosts, argument parsing, and the report ------------------------------

export function parseArgs(argv) {
  const options = {
    a: 'local', b: null, goBin: null, out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const [name, inline] = flag.startsWith('--') && flag.includes('=')
      ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)]
      : [flag, undefined];
    if (name !== '--a' && name !== '--b' && name !== '--go-bin' && name !== '--out') {
      throw new Error(`unknown argument ${flag} (this trial takes --a local|go, --b local|go, --go-bin, --out)`);
    }
    const value = inline ?? argv[(i += 1)];
    if (typeof value !== 'string' || !value) throw new Error(`${name} needs a value`);
    if (name === '--a') options.a = value;
    else if (name === '--b') options.b = value;
    else if (name === '--go-bin') options.goBin = value;
    else options.out = value;
  }
  for (const name of ['a', 'b']) {
    if (options[name] !== 'local' && options[name] !== 'go') {
      throw new Error(`--${name} must be local or go`);
    }
  }
  if (!options.out) throw new Error('--out is required');
  if ((options.a === 'go' || options.b === 'go') && !options.goBin) throw new Error('a go host needs --go-bin');
  return options;
}

async function bootHost(kind, {
  goBin, cwd, tmp, env,
}) {
  const made = makeRoots({ tmp });
  const stopScratch = () => rmSync(made.scratch, { recursive: true, force: true });
  let session;
  try {
    session = kind === 'local'
      ? await startLocal({ cwd, env, scratch: made.scratch, roots: made.roots })
      : await startGo({ bin: goBin, cwd, env, scratch: made.scratch, roots: made.roots });
  } catch (error) {
    stopScratch();
    throw error instanceof Infrastructure ? error : new Infrastructure(error?.message || String(error));
  }
  return {
    kind,
    roots: hostRootsOf(kind, session, made.roots),
    stop: async () => {
      try {
        await session.stop();
      } finally {
        stopScratch();
      }
    },
  };
}

export async function main({
  env = process.env, cwd = REPO, argv = process.argv.slice(2), log = console, tmp = os.tmpdir(),
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log.error(`[p4] ${error.message}`);
    return 3;
  }
  const outPath = path.resolve(cwd, options.out);
  const report = {
    a: options.a, b: options.b, cases: [], verdict: 'could-not-demonstrate',
  };
  let code = 3;
  try {
    for (const name of CASES) {
      const seeds = SEEDS[name];
      const boot = (kind) => bootHost(kind, {
        goBin: options.goBin, cwd, tmp, env,
      });
      let hostA;
      let hostB;
      let result;
      try {
        hostA = await boot(options.a);
        hostB = await boot(options.b);
        for (const host of [hostA, hostB]) {
          for (const [rel, bytes] of seeds) {
            for (const root of host.roots) writeRootFile(root.dir, rel, bytes);
          }
        }
        result = await runCase(name, {
          aUrl: hostA.roots[0]?.url,
          bUrl: hostB.roots[0]?.url,
          aRoots: hostA.roots.map((root) => root.dir),
          bRoots: hostB.roots.map((root) => root.dir),
          aUrls: hostA.roots.map((root) => root.url),
          bUrls: hostB.roots.map((root) => root.url),
          a: options.a,
          b: options.b,
          tmp,
        });
      } finally {
        for (const host of [hostB, hostA]) {
          if (!host) continue;
          try {
            await host.stop();
          } catch {
            // A host that cannot stop is still a host this run no longer uses.
          }
        }
      }
      report.cases.push(result);
      if (!result.pass) log.error(`[p4] ${name}: ${result.why}`);
    }
    const failed = report.cases.filter((entry) => !entry.pass);
    report.verdict = failed.length ? 'fail' : 'pass';
    code = failed.length ? 1 : 0;
  } catch (error) {
    report.verdict = 'could-not-demonstrate';
    code = 3;
    log.error(`[p4] ${error?.message || String(error)}`);
  } finally {
    try {
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      log.error(`[p4] cannot write ${outPath}: ${error.message}`);
      code = 3;
    }
  }
  return code;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = await main();
