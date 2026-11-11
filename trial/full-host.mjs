#!/usr/bin/env node
import { fork, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pageDocument } from '../tests/http/fixtures/page-document.mjs';
import { joinLiveClient } from '../tests/http/cases/live-client.mjs';
import {
  DROPBOX_ROOT, GITHUB_ROOT, LOCAL_APPS, isInside, realOrNearest,
} from './setup.mjs';
import { startManaged } from './supervisor.mjs';
import { REQUIRED_EXTENSIONS } from '../scripts/conformance.mjs';

const require = createRequire(import.meta.url);
const { createWorkspaceLifecycle } = require('../src/main/workspace/lifecycle.js');
const { compileTailwind } = require('tailwind-hyperclay');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'trial', 'managed-fixture.mjs');
const HTTP_FIXTURE = path.join(REPO, 'tests', 'helpers', 'host-http-fixture.cjs');
const HTTP_RUN = path.join(REPO, 'tests', 'http', 'run.mjs');
const CONDITIONS = ['p9', 'p10', 'p11', 'p12', 'p13'];
const MEASURES = ['deadline'];
const PROFILE = 'local-full';
const DOC = 'p9.html';
const TW_DOC = 'tw.html';
const TW_STYLESHEET = 'tw';
const GUARD_DOC = 'guard.html';
const MANIFEST_DEADLINE_MS = 90000;

// The deadline the managed trial's Go host waits for each answer from the JS
// service (hyperclay/internal/managedtrial/service.go), and the shape of the
// measurement taken against it.
const CONSULT_DEADLINE_MS = 10000;
const DEADLINE_DOC = 'big.html';
const DEADLINE_HOSTS = ['managed', 'in-process'];
const DEADLINE_OPS = ['save', 'api-write', 'checkpoint', 'observe', 'meta-visible', 'read'];
const DEADLINE_SAMPLES = 10;
const DEADLINE_PAGE_MIN = 300000;
const DEADLINE_PAGE_MAX = 310000;
const DEADLINE_SEED_MS = 300;
const DEADLINE_CHECKPOINT_MS = 10000;
const DEADLINE_OBSERVE_MS = 10000;

const P10_CASES = [
  'page.api-requires-both-preconditions',
  'page.api-stale-refused',
  'page.api-preserves-dirty-room',
];
const P9_CASES = ['checkpoint.last-participant-leaves', 'checkpoint.survives-restart'];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function couldNotDemonstrate(message) {
  const error = new Error(message);
  error.code = 'could-not-demonstrate';
  return error;
}

function parseArgs(argv) {
  const args = {
    condition: null, measure: null, goBin: null, out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== '--condition' && flag !== '--measure' && flag !== '--go-bin' && flag !== '--out') {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--condition') args.condition = value;
    else if (flag === '--measure') args.measure = value;
    else if (flag === '--go-bin') args.goBin = value;
    else args.out = value;
  }
  if (args.condition && args.measure) {
    throw new Error('pass --condition or --measure, not both');
  }
  if (!args.condition && !args.measure) {
    throw new Error('--condition or --measure is required (p9, p10, p11, p12, p13 or deadline)');
  }
  if (args.condition && !CONDITIONS.includes(args.condition)) {
    throw new Error(`unknown --condition: ${args.condition} (p9, p10, p11, p12 or p13)`);
  }
  if (args.measure && !MEASURES.includes(args.measure)) {
    throw new Error(`unknown --measure: ${args.measure} (deadline)`);
  }
  if (!args.goBin) throw new Error('--go-bin is required');
  if (!args.out) throw new Error('--out is required');
  return args;
}

function resolveOut(out) {
  const outReal = realOrNearest(out);
  for (const [label, parent] of [
    ['GITHUB_ROOT', GITHUB_ROOT],
    ['DROPBOX_ROOT', DROPBOX_ROOT],
    ['LOCAL_APPS', LOCAL_APPS],
  ]) {
    if (isInside(outReal, realOrNearest(parent))) {
      throw new Error(`refusing --out inside ${label} (${parent}); use a temp directory`);
    }
  }
  if (fs.existsSync(outReal)) {
    if (!fs.statSync(outReal).isDirectory()) {
      throw new Error(`--out exists and is not a directory: ${outReal}`);
    }
    if (fs.readdirSync(outReal).length > 0) {
      throw new Error(`--out must be an empty directory: ${outReal} already has entries`);
    }
  }
  fs.mkdirSync(outReal, { recursive: true });
  return outReal;
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function snapshot(rootDir, docPath) {
  return {
    document: sha256File(path.join(rootDir, docPath)),
    sidecar: sha256File(path.join(rootDir, '.hyperclay', 'blockeditor-state', `${docPath}.json`)),
    versions: listNames(path.join(rootDir, '.hyperclay', 'versions', docPath.replace(/\.html$/, ''))),
  };
}

function sidecarText(rootDir, docPath) {
  try {
    return fs.readFileSync(path.join(rootDir, '.hyperclay', 'blockeditor-state', `${docPath}.json`), 'utf8');
  } catch {
    return '';
  }
}

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

function killChild(child, signal = 'SIGTERM') {
  try { child.kill(signal); } catch {}
}

async function waitForManifest(manifestPath, child) {
  const deadline = Date.now() + MANIFEST_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(manifestPath)) {
      const text = fs.readFileSync(manifestPath, 'utf8');
      if (text.trim()) {
        try { return JSON.parse(text); } catch {}
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return null;
    await wait(100);
  }
  return null;
}

async function startFixture({ goBin, dir, logPath }) {
  const manifestPath = path.join(dir, 'manifest.json');
  const child = spawn(process.execPath, [FIXTURE, '--manifest', manifestPath, '--go-bin', goBin], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(logPath);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  child.on('error', () => {});
  const manifest = await waitForManifest(manifestPath, child);
  if (!manifest) {
    killChild(child);
    await Promise.race([exited, wait(10000)]);
    killChild(child, 'SIGKILL');
    await Promise.race([exited, wait(5000)]);
    log.end();
    throw couldNotDemonstrate(`the managed fixture wrote no manifest (log ${logPath})`);
  }
  return {
    child, manifest, manifestPath, exited, log,
  };
}

async function stopFixture(fixture) {
  try {
    await fetch(`${fixture.manifest.control.url}/stop`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.manifest.control.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch {}
  await Promise.race([fixture.exited, wait(15000)]);
  killChild(fixture.child);
  await Promise.race([fixture.exited, wait(5000)]);
  killChild(fixture.child, 'SIGKILL');
  await Promise.race([fixture.exited, wait(5000)]);
  fixture.log.end();
}

async function runHttp({
  manifestPath, reportPath, cases, logPath,
}) {
  const args = [HTTP_RUN, '--fixtures', manifestPath, '--profile', PROFILE];
  for (const id of cases) args.push('--case', id);
  args.push('--report', reportPath);
  const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => { output += `${error.message}\n`; });
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  fs.writeFileSync(logPath, output);
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {}
  return { exit, report, output, logPath, reportPath };
}

export function judgeP10({ cases } = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const passed = (id) => list.some((entry) => entry && entry.id === id && entry.status === 'pass');
  const reasons = [];
  for (const id of P10_CASES) {
    if (!passed(id)) reasons.push(`http case ${id} did not pass`);
  }
  const liveReads = passed('page.api-preserves-dirty-room') ? 1 : 0;
  const preservedDirty = liveReads;
  const staleWrites = passed('page.api-stale-refused') ? 0 : 1;
  return {
    pass: reasons.length === 0,
    liveReads,
    preservedDirty,
    staleWrites,
    reasons,
  };
}

export function judgeP9({
  rendered, cleanWrites, falseClean, quit, repair, flushed,
} = {}) {
  const reasons = [];
  const format = (value) => JSON.stringify(value ?? null);
  if (rendered !== 2) reasons.push(`part A: ${format(rendered)} of 2 http cases passed`);
  if (cleanWrites !== 0) reasons.push(`part B: a second clean checkpoint wrote (${format(cleanWrites)})`);
  if (falseClean !== 0) reasons.push(`part C: the armed durable failure still checkpointed cleanly (${format(falseClean)})`);
  if (!quit || quit.calls !== 2) reasons.push(`part C: the quit flow asked ${format(quit && quit.calls)} times, not twice`);
  if (!quit || quit.cancelled !== true) reasons.push('part C: quit did not answer { ok: false, error: "cancelled" }');
  if (!quit || quit.buttons !== true) reasons.push('part C: the dialog did not offer Retry and Cancel');
  if (!quit || quit.detail !== true) reasons.push(`part C: the dialog did not name ${DOC}`);
  if (!quit || quit.executed !== false) reasons.push('part C: quit executed while edits were unsaved');
  if (!quit || quit.running !== true) reasons.push('part C: a child of the session was not still running');
  if (!repair || repair.status !== 200) reasons.push(`part C: the repaired checkpoint answered ${format(repair && repair.status)}`);
  if (!repair || repair.sidecar !== true) reasons.push('part C: the repaired sidecar does not hold p9-c');
  const empty = flushed && Array.isArray(flushed.unsaved) && flushed.unsaved.length === 0 && flushed.timedOut === false;
  if (!empty) reasons.push(`part C: stop().flushed is ${format(flushed)}, not { unsaved: [], timedOut: false }`);
  return {
    pass: reasons.length === 0,
    rendered: rendered ?? 0,
    falseClean: falseClean ?? 1,
    cleanWrites: cleanWrites ?? 1,
    reasons,
  };
}

export function judgeP11({ outputMatches, saveBeforeCompile, staleInstalls } = {}) {
  const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const matches = count(outputMatches);
  const beforeCompile = count(saveBeforeCompile);
  const stale = count(staleInstalls);
  const reasons = [];
  if (matches !== 3) reasons.push(`the stylesheet matched the expected CSS ${matches} of 3 times`);
  if (beforeCompile !== 1) reasons.push(`the save waited for its compile, or the held compile published before release (saveBeforeCompile=${beforeCompile})`);
  if (stale !== 0) reasons.push(`an older compile replaced the newer stylesheet (staleInstalls=${stale})`);
  return {
    pass: reasons.length === 0,
    outputMatches: matches,
    saveBeforeCompile: beforeCompile,
    staleInstalls: stale,
    reasons,
  };
}

export function judgeP13({ raised, notices, restored } = {}) {
  const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const raisedCount = count(raised);
  const noticeCount = count(notices);
  const restoredCount = count(restored);
  const reasons = [];
  if (raisedCount !== 2) reasons.push(`the guard raised ${raisedCount} of 2 events`);
  if (noticeCount !== 2) reasons.push(`${noticeCount} of 2 data-loss notices reached a live stream`);
  if (restoredCount !== 2) reasons.push(`${restoredCount} of 2 restores brought the three items back`);
  return {
    pass: reasons.length === 0,
    raised: raisedCount,
    notices: noticeCount,
    restored: restoredCount,
    reasons,
  };
}

function p11Summary(verdict) {
  const head = `P11 ${verdict.pass ? 'PASS' : 'FAIL'} ` +
    `outputMatches=${verdict.outputMatches} saveBeforeCompile=${verdict.saveBeforeCompile} staleInstalls=${verdict.staleInstalls}`;
  return verdict.pass ? head : [head, ...verdict.reasons].join('\n');
}

function p13Summary(verdict) {
  const head = `P13 ${verdict.pass ? 'PASS' : 'FAIL'} ` +
    `raised=${verdict.raised} notices=${verdict.notices} restored=${verdict.restored}`;
  return verdict.pass ? head : [head, ...verdict.reasons].join('\n');
}

function p10Summary(verdict) {
  const head = `P10 ${verdict.pass ? 'PASS' : 'FAIL'} ` +
    `liveReads=${verdict.liveReads} preservedDirty=${verdict.preservedDirty} staleWrites=${verdict.staleWrites}`;
  return verdict.pass ? head : [head, ...verdict.reasons].join('\n');
}

function p9Summary(verdict) {
  const head = `P9 ${verdict.pass ? 'PASS' : 'FAIL'} ` +
    `rendered=${verdict.rendered} falseClean=${verdict.falseClean} cleanWrites=${verdict.cleanWrites}`;
  return verdict.pass ? head : [head, ...verdict.reasons].join('\n');
}

function writeReport(out, condition, report) {
  fs.writeFileSync(path.join(out, `${condition}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

function finish(out, condition, report, summary) {
  writeReport(out, condition, report);
  process.stdout.write(`${summary}\n`);
  if (report.exitCode !== undefined) return report.exitCode;
  return report.pass ? 0 : 1;
}

export async function runP10({ goBin, out } = {}) {
  const bin = path.resolve(goBin);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-p10-'));
  let fixture = null;
  try {
    fixture = await startFixture({ goBin: bin, dir: tmp, logPath: path.join(out, 'p10-fixture.log') });
    const http = await runHttp({
      manifestPath: path.join(tmp, 'manifest.json'),
      reportPath: path.join(out, 'p10-http.json'),
      cases: P10_CASES,
      logPath: path.join(out, 'p10-http.log'),
    });
    const verdict = judgeP10({ cases: http.report ? http.report.cases : [] });
    const report = {
      schema: 1,
      condition: 'p10',
      goBin: bin,
      verdict: verdict.pass ? 'pass' : 'fail',
      pass: verdict.pass,
      liveReads: verdict.liveReads,
      preservedDirty: verdict.preservedDirty,
      staleWrites: verdict.staleWrites,
      reasons: verdict.reasons,
      cases: http.report ? http.report.cases.map((entry) => ({
        id: entry.id, status: entry.status, detail: entry.detail,
      })) : [],
      http: { exit: http.exit, report: http.reportPath, log: http.logPath },
      summary: p10Summary(verdict),
    };
    return { report, exitCode: verdict.pass ? 0 : 1 };
  } finally {
    if (fixture) await stopFixture(fixture);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function waitUntil(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await wait(intervalMs);
  }
}

async function fetchText(target, options = {}) {
  const response = await fetch(target, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return {
    status: response.status, body, text, headers: response.headers,
  };
}

function saveDocument(rootUrl, name, html, headers = {}) {
  return fetchText(`${rootUrl}/_/save`, {
    method: 'POST',
    headers: { 'content-type': 'text/html', 'document-url': `${rootUrl}/${name}`, ...headers },
    body: html,
  });
}

function postJson(target, body) {
  return fetchText(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rootUrlAt(session, index) {
  const entry = (session.readyRoots ?? [])[index];
  if (!entry || !entry.url) throw new Error(`the go host names no root at index ${index}`);
  return entry.url;
}

async function startTrialSession({ bin, scratch, roots }) {
  const port = await chooseBasePort();
  try {
    return await startManaged({
      bin, scratch, roots, port, env: { ...process.env, HYPERCLAY_PAGE_COMPACTION: '0' },
    });
  } catch (error) {
    throw couldNotDemonstrate(`the managed session did not start: ${error?.message || String(error)}`);
  }
}

function controlFaultFor(session) {
  return async (body) => {
    const response = await fetch(`${session.control}/v1/fault`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed };
  };
}

// The document a Tailwind save compiles: one link to the site's stylesheet and
// one element carrying the classes under test.
function twDocument(classes) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>tw</title>
    <link rel="stylesheet" href="/tailwindcss/${TW_STYLESHEET}.css">
  </head>
  <body>
    <div class="${classes}">tailwind</div>
  </body>
</html>
`;
}

// trial/test/service-routes.test.cjs's PLAIN, rendered with the list items given.
const GUARD_ITEMS = [
  '      <li><span class="name">alpha</span><input type="checkbox" checked></li>',
  '      <li><span class="name">beta</span><input type="checkbox"></li>',
  '      <li><span class="name">gamma</span><input type="checkbox" checked></li>',
];

function guardDocument(items) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>List</title>
    <script type="application/json" data-rules-name="api" data-rules-version="1">{"title":"h1","items":["ul.items li",{"name":".name","done":"input@checked"}]}</script>
  </head>
  <body>
    <h1>List</h1>
    <ul class="items">
${items.join('\n')}
    </ul>
  </body>
</html>
`;
}

// A tab's live subscription: GET /_/sync for one document, every SSE event's
// data kept for the caller.
async function openLiveStream({
  origin, docPath, lane, clientId, signal,
}) {
  const documentUrl = `${origin}/${docPath}`;
  const query = new URLSearchParams({ 'document-url': documentUrl, lane, 'client-id': clientId });
  const response = await fetch(`${origin}/_/sync?${query}`, {
    headers: { 'document-url': documentUrl },
    signal,
  });
  const events = [];
  if (response.status !== 200) {
    return { status: response.status, lane, events, close: async () => {} };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = { event: 'message', data: '' };
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('data: ')) event.data += line.slice(6);
          }
          events.push(event);
        }
      }
    } catch {}
  })();
  const close = async () => {
    try { await reader.cancel(); } catch {}
    await pump;
  };
  return { status: 200, lane, events, close };
}

export async function runP11({ goBin, out } = {}) {
  const bin = path.resolve(goBin);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-p11-'));
  const rootA = path.join(tmp, 'root-a');
  const rootB = path.join(tmp, 'root-b');
  const docPath = path.join(rootA, TW_DOC);
  const cssPath = path.join(rootA, '.hyperclay', 'tailwindcss', `${TW_STYLESHEET}.css`);
  for (const dir of [rootA, rootB, path.join(tmp, 'scratch-1'), path.join(tmp, 'scratch-2')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const detail = { steps: {} };
  let outputMatches = 0;
  let saveBeforeCompile = 0;
  let staleInstalls = 1;
  let session = null;
  try {
    const readCss = () => {
      try { return fs.readFileSync(cssPath, 'utf8'); } catch { return null; }
    };
    const expectedCss = () => compileTailwind(fs.readFileSync(docPath, 'utf8'));

    session = await startTrialSession({ bin, scratch: path.join(tmp, 'scratch-1'), roots: [rootA, rootB] });
    let urlA = rootUrlAt(session, 0);

    const first = await saveDocument(urlA, TW_DOC, twDocument('text-red-500 p-4'));
    detail.steps.saveFirst = { status: first.status, body: first.body };
    const firstAppeared = await waitUntil(() => readCss() !== null, 15000);
    const firstExpected = await expectedCss();
    const firstCss = readCss();
    detail.steps.first = { appeared: firstAppeared === true, bytes: firstCss === null ? null : firstCss.length };
    if (firstAppeared && firstCss === firstExpected) outputMatches += 1;
    else detail.steps.first.mismatch = 'the stylesheet is not the expected CSS for the saved bytes';

    const second = await saveDocument(urlA, TW_DOC, twDocument('text-red-500 p-4 bg-blue-200'));
    detail.steps.saveSecond = { status: second.status, body: second.body };
    const secondChanged = await waitUntil(() => readCss() !== null && readCss() !== firstCss, 15000);
    const secondExpected = await expectedCss();
    const secondCss = readCss();
    detail.steps.second = { changed: secondChanged === true, bytes: secondCss === null ? null : secondCss.length };
    if (secondChanged && secondCss === secondExpected) outputMatches += 1;
    else detail.steps.second.mismatch = 'the changed stylesheet is not the expected CSS for the new bytes';

    const beforeRestart = await expectedCss();
    await session.stop();
    session = null;
    session = await startTrialSession({ bin, scratch: path.join(tmp, 'scratch-2'), roots: [rootA, rootB] });
    urlA = rootUrlAt(session, 0);
    const served = await fetchText(`${urlA}/tailwindcss/${TW_STYLESHEET}.css`);
    detail.steps.restart = { status: served.status, bytes: served.text.length };
    if (served.status === 200 && served.text === beforeRestart) outputMatches += 1;
    else detail.steps.restart.mismatch = `GET /tailwindcss/${TW_STYLESHEET}.css answered ${served.status} with ${
      served.text === beforeRestart ? 'the expected CSS' : 'other bytes'}`;

    const fault = controlFaultFor(session);
    const heldCount = async () => {
      const answer = await fault({ point: 'held', rel: TW_STYLESHEET });
      return answer.body && answer.body.held;
    };

    const armedHold = await fault({ point: 'tailwind-hold', rel: TW_STYLESHEET, count: 1 });
    const releaseSaved = await saveDocument(urlA, TW_DOC, twDocument('m-8'));
    const becameHeld = await waitUntil(async () => (await heldCount()) === 1, 5000);
    const duringHold = readCss();
    const heldOut = duringHold !== null && !duringHold.includes('.m-8');
    const released = await fault({ point: 'release', rel: TW_STYLESHEET });
    const heldExpected = await expectedCss();
    const afterRelease = await waitUntil(() => {
      const css = readCss();
      return css !== null && css.includes('.m-8') && css === heldExpected;
    }, 15000);
    detail.steps.saveBeforeCompile = {
      armed: armedHold.body,
      save: releaseSaved.status,
      held: becameHeld === true,
      unchangedWhileHeld: heldOut,
      released: released.body,
      installedAfterRelease: afterRelease === true,
    };
    if (releaseSaved.status === 200 && becameHeld && heldOut &&
        released.body && released.body.released === 1 && afterRelease) {
      saveBeforeCompile = 1;
    }

    const armedStale = await fault({ point: 'tailwind-hold', rel: TW_STYLESHEET, count: 1 });
    const finishedBefore = (await fault({ point: 'finished', rel: TW_STYLESHEET })).body?.finished;
    const oldSave = await saveDocument(urlA, TW_DOC, twDocument('underline'));
    const oldHeld = await waitUntil(async () => (await heldCount()) === 1, 5000);
    const newSave = await saveDocument(urlA, TW_DOC, twDocument('italic'));
    const italicExpected = await expectedCss();
    const italicInstalled = await waitUntil(() => readCss() === italicExpected, 15000);
    const releasedStale = await fault({ point: 'release', rel: TW_STYLESHEET });
    const olderFinished = typeof finishedBefore === 'number' && await waitUntil(async () => {
      const answer = await fault({ point: 'finished', rel: TW_STYLESHEET });
      return answer.body && answer.body.finished === finishedBefore + 1;
    }, 15000);
    const afterStaleRelease = readCss();
    const staleRan = oldHeld === true && italicInstalled === true &&
      Boolean(releasedStale.body) && releasedStale.body.released === 1 && olderFinished === true;
    detail.steps.stale = {
      armed: armedStale.body,
      oldSave: oldSave.status,
      held: oldHeld === true,
      newSave: newSave.status,
      installed: italicInstalled === true,
      released: releasedStale.body,
      olderFinished: olderFinished === true,
      ran: staleRan,
      stillNewer: afterStaleRelease === italicExpected,
    };
    staleInstalls = staleRan && afterStaleRelease === italicExpected ? 0 : 1;

    const verdict = judgeP11({ outputMatches, saveBeforeCompile, staleInstalls });
    const report = {
      schema: 1,
      condition: 'p11',
      goBin: bin,
      verdict: verdict.pass ? 'pass' : 'fail',
      pass: verdict.pass,
      outputMatches: verdict.outputMatches,
      saveBeforeCompile: verdict.saveBeforeCompile,
      staleInstalls: verdict.staleInstalls,
      reasons: verdict.reasons,
      detail,
      summary: p11Summary(verdict),
    };
    return { report, exitCode: verdict.pass ? 0 : 1 };
  } finally {
    if (session) {
      try { await session.stop(); } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runP13({ goBin, out } = {}) {
  const bin = path.resolve(goBin);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-p13-'));
  const rootA = path.join(tmp, 'root-a');
  const rootB = path.join(tmp, 'root-b');
  const docPath = path.join(rootA, GUARD_DOC);
  for (const dir of [rootA, rootB, path.join(tmp, 'scratch')]) fs.mkdirSync(dir, { recursive: true });
  const abort = new AbortController();
  const detail = {};
  const streams = [];
  let raised = 0;
  let notices = 0;
  let restored = 0;
  let session = null;
  try {
    session = await startTrialSession({ bin, scratch: path.join(tmp, 'scratch'), roots: [rootA, rootB] });
    const urlA = rootUrlAt(session, 0);

    const seeded = await saveDocument(urlA, GUARD_DOC, guardDocument(GUARD_ITEMS));
    detail.seed = { status: seeded.status, body: seeded.body };
    detail.seedObserved = await waitForWatcherFrame(session, GUARD_DOC);

    streams.push(await openLiveStream({
      origin: urlA, docPath: GUARD_DOC, lane: 'live', clientId: 'tab-live', signal: abort.signal,
    }));
    streams.push(await openLiveStream({
      origin: urlA, docPath: GUARD_DOC, lane: 'saved', clientId: 'tab-saved', signal: abort.signal,
    }));
    detail.streams = streams.map((stream) => ({ lane: stream.lane, status: stream.status }));
    await wait(200);

    const raisedNotices = () => streams.reduce((total, stream) => total + stream.events.filter((event) => {
      if (!event.data) return false;
      let parsed = null;
      try { parsed = JSON.parse(event.data); } catch { return false; }
      return Boolean(parsed) && parsed.msgType === 'data-loss' && parsed.action === 'raised';
    }).length, 0);

    const step = async (label, mutate) => {
      const noticesBefore = raisedNotices();
      const mutation = await mutate();

      const notified = await waitUntil(() => raisedNotices() > noticesBefore, 10000);
      if (notified) notices += 1;

      const event = await waitUntil(async () => {
        const answer = await fetchText(`${urlA}/_/data-loss?file=${encodeURIComponent(GUARD_DOC)}`);
        const body = answer.body;
        return body && body.event && typeof body.event.id === 'string' ? body.event : null;
      }, 10000);
      if (event) raised += 1;

      let restore = { status: null, body: null };
      if (event) {
        restore = await postJson(`${urlA}/_/data-loss/${encodeURIComponent(event.id)}`, {
          file: GUARD_DOC, id: event.id, choice: 'restore',
        });
      }

      const back = await waitUntil(async () => {
        const answer = await fetchText(`${urlA}/_/api/${encodeURIComponent(GUARD_DOC)}`);
        const body = answer.body;
        return body && Array.isArray(body.items) && body.items.length === 3 ? body : null;
      }, 10000);
      if (restore.status === 200 && restore.body && restore.body.status === 'restored' && back) restored += 1;

      detail[label] = {
        mutation,
        event: event ? { id: event.id, status: event.status, restorable: event.restorable } : null,
        notice: notified === true,
        noticeData: streams.flatMap((stream) => stream.events)
          .map((entry) => { try { return JSON.parse(entry.data); } catch { return null; } })
          .filter((parsed) => parsed && parsed.msgType === 'data-loss')
          .map((parsed) => parsed.action),
        restore: { status: restore.status, body: restore.body },
        items: back ? back.items.length : null,
      };
    };

    // A browser save that drops two of the three items, with the provenance
    // header a person's save carries (Save-Trigger: user, ui-gestured).
    await step('browserSave', async () => {
      const saved = await saveDocument(urlA, GUARD_DOC, guardDocument(GUARD_ITEMS.slice(0, 1)), { 'save-trigger': 'user' });
      return { status: saved.status, body: saved.body, headers: { 'save-trigger': 'user' } };
    });

    // Another program writing the same loss straight to disk.
    await step('outsideEdit', async () => {
      fs.writeFileSync(docPath, guardDocument(GUARD_ITEMS.slice(0, 1)));
      return { wrote: docPath };
    });

    const verdict = judgeP13({ raised, notices, restored });
    const report = {
      schema: 1,
      condition: 'p13',
      goBin: bin,
      verdict: verdict.pass ? 'pass' : 'fail',
      pass: verdict.pass,
      raised: verdict.raised,
      notices: verdict.notices,
      restored: verdict.restored,
      reasons: verdict.reasons,
      detail,
      summary: p13Summary(verdict),
    };
    return { report, exitCode: verdict.pass ? 0 : 1 };
  } finally {
    abort.abort();
    for (const stream of streams) {
      try { await stream.close(); } catch {}
    }
    if (session) {
      try { await session.stop(); } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runPartA({ goBin, out }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-p9-http-'));
  let fixture = null;
  try {
    fixture = await startFixture({ goBin, dir: tmp, logPath: path.join(out, 'p9-fixture.log') });
    const http = await runHttp({
      manifestPath: path.join(tmp, 'manifest.json'),
      reportPath: path.join(out, 'p9-http.json'),
      cases: P9_CASES,
      logPath: path.join(out, 'p9-http.log'),
    });
    const cases = http.report && Array.isArray(http.report.cases) ? http.report.cases : [];
    return {
      cases: cases.map((entry) => ({ id: entry.id, status: entry.status, detail: entry.detail })),
      rendered: cases.filter((entry) => entry && entry.status === 'pass').length,
      http: { exit: http.exit, report: http.reportPath, log: http.logPath },
    };
  } finally {
    if (fixture) await stopFixture(fixture);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runLiveParts({ goBin }) {
  const measured = {
    cleanWrites: 1,
    falseClean: 1,
    quit: {
      calls: 0, cancelled: false, buttons: false, detail: false, executed: true, running: false,
    },
    repair: { status: null, sidecar: false },
    flushed: null,
  };
  const detail = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-p9-live-'));
  const rootA = path.join(tmp, 'root-a');
  const rootB = path.join(tmp, 'root-b');
  const scratch = path.join(tmp, 'scratch');
  for (const dir of [rootA, rootB, scratch]) fs.mkdirSync(dir, { recursive: true });
  const abort = new AbortController();
  let session = null;
  try {
    const port = await chooseBasePort();
    try {
      session = await startManaged({
        bin: path.resolve(goBin),
        scratch,
        roots: [rootA, rootB],
        port,
        env: { ...process.env, HYPERCLAY_PAGE_COMPACTION: '0' },
      });
    } catch (error) {
      throw couldNotDemonstrate(`the managed session did not start: ${error?.message || String(error)}`);
    }

    const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
    fs.writeFileSync(path.join(rootA, DOC), doc.html);
    await wait(300);

    const rootUrl = (rootId) => {
      const index = rootId === 'root-a' ? 0 : rootId === 'root-b' ? 1 : -1;
      const entry = (session.readyRoots ?? [])[index];
      if (!entry) throw new Error(`the go host names no ${rootId}`);
      return entry.url;
    };
    const ctx = { rootUrl, signal: abort.signal };
    const goRoot = (session.readyRoots?.[0] ?? {}).id;
    if (!goRoot) throw couldNotDemonstrate('the go host names no root-0');

    const checkpointWait = async (timeoutMs) => {
      const response = await fetch(`${session.service.url}/v1/checkpoint-wait`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.service.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ root: goRoot, name: DOC, timeoutMs }),
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: response.status, body };
    };

    const controlFault = async (body) => {
      const response = await fetch(`${session.control}/v1/fault`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: response.status, body: parsed };
    };

    const page = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'blockeditor-a' });
    const store = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'game-b' });
    const pageEdit = await page.edit('blockeditor', [{ op: 'set', path: ['y', 'http-a-1'], value: doc.update }]);
    const storeEdit = await store.edit('game', [{ op: 'add', path: ['score'], n: 1 }]);
    detail.partB = { pageEdit, storeEdit };
    if (pageEdit.status !== 200) throw new Error(`the live page edit answered ${pageEdit.status}`);
    if (storeEdit.status !== 200) throw new Error(`the live store edit answered ${storeEdit.status}`);
    await page.close();
    await store.close();
    const first = await checkpointWait(10000);
    detail.partB.first = first;
    if (first.status !== 200) throw new Error(`the last participant\u2019s leave did not checkpoint: ${JSON.stringify(first.body)}`);
    const s1 = snapshot(rootA, DOC);

    const third = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'quiet-c' });
    await third.ready();
    await third.close();
    const second = await checkpointWait(10000);
    detail.partB.second = second;
    if (second.status !== 200) throw new Error(`the third participant\u2019s leave did not answer a clean checkpoint: ${JSON.stringify(second.body)}`);
    await wait(1500);
    const s2 = snapshot(rootA, DOC);
    measured.cleanWrites = JSON.stringify(s1) === JSON.stringify(s2) ? 0 : 1;
    detail.partB.snapshot1 = s1;
    detail.partB.snapshot2 = s2;

    const armed = await controlFault({ point: 'durable-fail', rel: DOC, count: 100 });
    detail.partC = { armed };
    if (armed.status !== 200) throw new Error(`the durable fault was not armed: ${JSON.stringify(armed.body)}`);

    const cPage = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'blockeditor-c' });
    const cEdit = await cPage.edit('blockeditor', [{ op: 'set', path: ['y', 'p9-c'], value: doc.update }]);
    detail.partC.edit = cEdit;
    await cPage.close();
    const dirty = await checkpointWait(2500);
    detail.partC.dirty = dirty;
    measured.falseClean = dirty.status === 504 ? 0 : 1;

    const messages = [];
    const executed = [];
    const showMessage = async (options) => {
      messages.push(options);
      return { response: messages.length === 1 ? 0 : 1 };
    };
    const execute = async (...args) => { executed.push(args); };
    const workspace = {
      hasWindow: () => false,
      hasFlushListener: () => false,
      requestFlush: () => { throw new Error('a workspace without a window was asked to flush'); },
      show: () => {},
    };
    const flushDirty = async () => {
      const response = await fetch(`${session.service.url}/v1/flush`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.service.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ deadlineMs: 3000 }),
      });
      const answer = await response.json();
      if (!answer || !Array.isArray(answer.unsaved)) {
        throw new Error(`the service\u2019s flush answered ${response.status}: ${JSON.stringify(answer)}`);
      }
      return { unsaved: answer.unsaved.map((entry) => entry.name), timedOut: answer.timedOut };
    };
    const lifecycle = createWorkspaceLifecycle({
      workspace, checkpoint: { flushDirty }, showMessage, execute,
    });
    let quitAnswer = null;
    let quitError = null;
    try {
      quitAnswer = await lifecycle.requestTransition('quit');
    } catch (error) {
      quitError = error?.message || String(error);
    }
    measured.quit = {
      answer: quitAnswer,
      error: quitError,
      calls: messages.length,
      cancelled: Boolean(quitAnswer && quitAnswer.ok === false && quitAnswer.error === 'cancelled'),
      buttons: messages.length > 0 && messages.every((message) => Array.isArray(message.buttons) &&
        message.buttons.length === 2 && message.buttons[0] === 'Retry' && message.buttons[1] === 'Cancel'),
      detail: messages.length > 0 && messages.every((message) =>
        typeof message.detail === 'string' && message.detail.includes(DOC)),
      executed: executed.length > 0,
      running: session.child.exitCode === null && session.service.child.exitCode === null,
    };
    detail.partC.messages = messages;

    // The scheduler's retries may be spent by now, so the repair is what the
    // dialog's Retry does once the disk recovers: one more flush.
    const cleared = await controlFault({ point: 'clear' });
    detail.partC.retried = await flushDirty();
    const repaired = await checkpointWait(10000);
    measured.repair = {
      status: repaired.status,
      body: repaired.body,
      sidecar: sidecarText(rootA, DOC).includes('p9-c'),
    };
    detail.partC.cleared = cleared;
    detail.partC.repaired = repaired;

    await session.stop();
    measured.flushed = session.flushed;
    session = null;
    return { measured, detail };
  } finally {
    abort.abort();
    if (session) {
      try { await session.stop(); } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runP9({ goBin, out } = {}) {
  const bin = path.resolve(goBin);
  const report = {
    schema: 1,
    condition: 'p9',
    goBin: bin,
    verdict: 'fail',
    pass: false,
    rendered: 0,
    falseClean: 1,
    cleanWrites: 1,
    reasons: [],
    cases: [],
    detail: {},
    summary: '',
  };
  const partA = await runPartA({ goBin: bin, out });
  report.cases = partA.cases;
  report.http = partA.http;
  report.rendered = partA.rendered;

  let live = { measured: null, detail: {} };
  try {
    live = await runLiveParts({ goBin: bin });
  } catch (error) {
    if (error && error.code === 'could-not-demonstrate') throw error;
    report.detail.liveError = error?.message || String(error);
  }

  const verdict = judgeP9({
    rendered: report.rendered,
    cleanWrites: live.measured ? live.measured.cleanWrites : 1,
    falseClean: live.measured ? live.measured.falseClean : 1,
    quit: live.measured ? live.measured.quit : null,
    repair: live.measured ? live.measured.repair : null,
    flushed: live.measured ? live.measured.flushed : null,
  });
  if (live.measured) {
    report.falseClean = live.measured.falseClean;
    report.cleanWrites = live.measured.cleanWrites;
    report.quit = live.measured.quit;
    report.repair = live.measured.repair;
    report.flushed = live.measured.flushed;
    report.detail = live.detail;
  }
  report.verdict = verdict.pass ? 'pass' : 'fail';
  report.pass = verdict.pass;
  report.reasons = verdict.reasons;
  report.summary = p9Summary(verdict);
  return { report, exitCode: verdict.pass ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// P12: crash and loss. Five parts, each on its own fresh roots and session, each
// counting that it ran to its end (`completed`) and that none of its safety
// checks failed (`unsafe`).
// ---------------------------------------------------------------------------

const P12_DOC = 'p12.html';
const P12_OTHER_DOC = 'p12-other.html';
const P12_PARTS = ['a', 'b', 'c', 'd', 'e'];
export const P12_CHECKS = {
  a: [
    'Go died at the fault, and the save failed with it',
    'the old file is complete',
    'the document is not refused afterwards',
  ],
  b: [
    'Go died at the fault, and the save failed with it',
    'the new file is complete',
    'no falsely confirmed room',
  ],
  c: [
    'Go dropped the reply',
    'the write answers 200',
    'written once',
  ],
  d: [
    'the save is refused recoverably',
    'the page API write is refused recoverably',
    'nothing is written',
    'no capability is downgraded',
    'it recovers',
  ],
  e: [
    'the restart gives a cursor gap',
    'the gap reconcile uploads free.html and leaves held.html held',
  ],
};
const P12_SEED_MS = 300;
const P12_DRIVER = path.join(REPO, 'trial', 'sync-driver.cjs');
const P12_CONNECTION_PROBE = path.join(REPO, 'trial', 'p12-connection-probe.cjs');

export function judgeP12({ parts } = {}) {
  const reasons = [];
  let completed = 0;
  let unsafe = 0;
  for (const letter of P12_PARTS) {
    const part = parts && parts[letter];
    if (!part) {
      reasons.push(`part ${letter.toUpperCase()}: did not run`);
      unsafe += 1;
      continue;
    }
    if (part.completed) completed += 1;
    else reasons.push(`part ${letter.toUpperCase()}: ${part.error ?? 'did not run to its end'}`);
    if (part.unsafe) {
      unsafe += 1;
      for (const reason of part.reasons ?? []) reasons.push(`part ${letter.toUpperCase()}: ${reason}`);
    }
    const checked = part.checks ?? {};
    const missing = (P12_CHECKS[letter] ?? [])
      .filter((label) => !Object.prototype.hasOwnProperty.call(checked, label));
    if (missing.length > 0) {
      if (!part.unsafe) unsafe += 1;
      for (const label of missing) reasons.push(`part ${letter.toUpperCase()}: did not check "${label}"`);
    }
  }
  return {
    pass: completed === P12_PARTS.length && unsafe === 0,
    completed,
    unsafe,
    reasons,
  };
}

function p12Summary(verdict) {
  const head = `P12 ${verdict.pass ? 'PASS' : 'FAIL'} completed=${verdict.completed} unsafe=${verdict.unsafe}`;
  return verdict.pass ? head : [head, ...verdict.reasons].join('\n');
}

function p12Part() {
  return {
    completed: false, unsafe: true, reasons: [], checks: {}, detail: {},
  };
}

// One check of a part: recorded whether it held, and counted against the part
// when it did not.
function p12Check(part, label, ok, detail = undefined) {
  part.checks[label] = ok === true;
  if (detail !== undefined) part.detail[label] = detail;
  if (ok !== true) part.reasons.push(label);
  return ok === true;
}

async function p12MarkedDocument(doc, marker) {
  const store = JSON.stringify({ score: 0 });
  if (!doc.html.includes(store)) throw new Error(`the page fixture carries no ${store} store to mark`);
  return doc.html.replace(store, JSON.stringify({ score: 0, mark: marker }));
}

async function p12Meta(rootUrl, name) {
  const answer = await fetchText(`${rootUrl}/_/meta`, {
    headers: { 'document-url': `${rootUrl}/${name}` },
  });
  const document_ = answer.body && typeof answer.body === 'object' ? answer.body.document : null;
  return {
    status: answer.status,
    etag: document_ && typeof document_.etag === 'string' ? document_.etag : null,
    extensions: answer.body && Array.isArray(answer.body.extensions) ? answer.body.extensions : null,
  };
}

async function p12Save(rootUrl, name, html, etag) {
  try {
    return await saveDocument(rootUrl, name, html, etag ? { 'if-match': etag } : {});
  } catch (error) {
    return { status: null, body: null, text: '', headers: null, error: error?.message || String(error) };
  }
}

function p12Refused(answer) {
  const failedTransport = Boolean(answer.error) || answer.status === null || answer.status >= 500;
  return {
    failedTransport,
    status: answer.status ?? null,
    retryAfter: answer.headers ? answer.headers.get('retry-after') : null,
    body: answer.body,
  };
}

async function p12DataRead(rootUrl, name) {
  const answer = await fetchText(`${rootUrl}/_/api/${encodeURIComponent(name)}`);
  return {
    status: answer.status,
    etag: answer.headers ? answer.headers.get('etag') : null,
    revision: answer.headers ? answer.headers.get('blockeditor-revision') : null,
    body: answer.body,
  };
}

async function p12DataWrite(rootUrl, name, data, { etag, revision } = {}) {
  return fetchText(`${rootUrl}/_/api/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(etag ? { 'if-match': etag } : {}),
      ...(revision ? { 'blockeditor-if-match': revision } : {}),
    },
    body: JSON.stringify(data),
  });
}

function p12Versions(rootDir, stem) {
  return listNames(path.join(rootDir, '.hyperclay', 'versions', stem));
}

async function p12ServiceCall(session, pathname, body) {
  const response = await fetch(`${session.service.url}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.service.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

// A part's own roots, its own session, and its own scratch folder.
async function p12WithSession({ bin, name }, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `full-host-p12-${name}-`));
  const rootA = path.join(tmp, 'root-a');
  const rootB = path.join(tmp, 'root-b');
  const scratch = path.join(tmp, 'scratch');
  for (const dir of [rootA, rootB, scratch]) fs.mkdirSync(dir, { recursive: true });
  const abort = new AbortController();
  let session = null;
  try {
    session = await startTrialSession({ bin, scratch, roots: [rootA, rootB] });
    const ctx = {
      rootUrl: (rootId) => {
        const index = rootId === 'root-a' ? 0 : rootId === 'root-b' ? 1 : -1;
        if (index < 0) throw new Error(`the part names no ${rootId}`);
        return rootUrlAt(session, index);
      },
      signal: abort.signal,
    };
    return await run({
      session, ctx, rootA, rootB, scratch, tmp,
      get goRoot() { return (session.readyRoots?.[0] ?? {}).id; },
    });
  } finally {
    abort.abort();
    if (session) {
      try { await session.stop(); } catch { }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A: Go killed before the replace, then a save that is not refused.
async function p12PartA({ bin, part }) {
  await p12WithSession({ bin, name: 'a' }, async ({ session, rootA }) => {
    let urlA = rootUrlAt(session, 0);
    const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
    const docPath = path.join(rootA, P12_DOC);
    fs.writeFileSync(docPath, doc.html);
    await wait(P12_SEED_MS);

    const etag = (await p12Meta(urlA, P12_DOC)).etag;
    const before = sha256File(docPath);
    const armed = await controlFaultFor(session)({ point: 'kill-before-rename', rel: P12_DOC, count: 1 });
    part.detail.armed = armed;
    part.detail.etag = etag;

    const killed = await p12Save(urlA, P12_DOC, await p12MarkedDocument(doc, 'p12-a'), etag);
    part.detail.save = p12Refused(killed);
    part.detail.saveFailedAtTransport =
      Boolean(killed.error) || killed.status === null || killed.status >= 500;
    await waitUntil(() => session.child.signalCode !== null || session.child.exitCode !== null, 5000);
    part.detail.child = { exitCode: session.child.exitCode, signalCode: session.child.signalCode };
    p12Check(part, 'Go died at the fault, and the save failed with it',
      part.detail.child.signalCode === 'SIGKILL' && part.detail.saveFailedAtTransport === true,
      { child: part.detail.child, saveFailedAtTransport: part.detail.saveFailedAtTransport });

    const oldComplete = sha256File(docPath) === before;
    p12Check(part, 'the old file is complete', oldComplete,
      { before, after: sha256File(docPath) });

    await session.restartGo();
    urlA = rootUrlAt(session, 0);
    const after = await p12Save(urlA, P12_DOC, await p12MarkedDocument(doc, 'p12-a2'), etag);
    part.detail.afterRestart = { status: after.status, body: after.body };
    const text = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
    p12Check(part, 'the document is not refused afterwards',
      after.status === 200 && text.includes('p12-a2'),
      { status: after.status, body: after.body, marker: text.includes('p12-a2') });
  });
}

// B: Go killed after the replace, with a live room open.
async function p12PartB({ bin, part }) {
  await p12WithSession({ bin, name: 'b' }, async ({ session, ctx, rootA }) => {
    let urlA = rootUrlAt(session, 0);
    const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
    const docPath = path.join(rootA, P12_DOC);
    fs.writeFileSync(docPath, doc.html);
    await wait(P12_SEED_MS);

    const first = await joinLiveClient(ctx, { rootId: 'root-a', docPath: P12_DOC, clientId: 'p12-b-1' });
    try {
      const joined = await first.ready();
      part.detail.firstJoin = { stores: Object.keys(joined.stores ?? {}), conn: typeof joined.conn };

      const etag = (await p12Meta(urlA, P12_DOC)).etag;
      const armed = await controlFaultFor(session)({ point: 'kill-after-rename', rel: P12_DOC, count: 1 });
      part.detail.armed = armed;
      const killed = await p12Save(urlA, P12_DOC, await p12MarkedDocument(doc, 'p12-b'), etag);
      part.detail.save = p12Refused(killed);
      part.detail.saveFailedAtTransport =
        Boolean(killed.error) || killed.status === null || killed.status >= 500;
      await waitUntil(() => session.child.signalCode !== null || session.child.exitCode !== null, 5000);
      part.detail.child = { exitCode: session.child.exitCode, signalCode: session.child.signalCode };
      p12Check(part, 'Go died at the fault, and the save failed with it',
        part.detail.child.signalCode === 'SIGKILL' && part.detail.saveFailedAtTransport === true,
        { child: part.detail.child, saveFailedAtTransport: part.detail.saveFailedAtTransport });

      const killedText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
      p12Check(part, 'the new file is complete',
        killedText.includes('p12-b') && /<\/html>\s*$/.test(killedText),
        { marker: killedText.includes('p12-b'), closes: /<\/html>\s*$/.test(killedText) });

      await session.restartGo();
      urlA = rootUrlAt(session, 0);
      const second = await joinLiveClient(ctx, { rootId: 'root-a', docPath: P12_DOC, clientId: 'p12-b-2' });
      try {
        const joined = await second.ready();
        part.detail.secondJoin = {
          stores: Object.keys(joined.stores ?? {}),
          game: joined.stores && joined.stores.game ? joined.stores.game.value : null,
        };
        const edit = await second.edit('blockeditor', [{ op: 'set', path: ['y', 'p12-b-edit'], value: doc.update }]);
        part.detail.edit = { status: edit.status, body: edit.body };
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }

    const checkpoint = await p12ServiceCall(session, '/v1/checkpoint-wait', {
      root: (session.readyRoots?.[0] ?? {}).id, name: P12_DOC, timeoutMs: 10000,
    });
    part.detail.checkpoint = checkpoint;
    const text = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
    const sidecar = sidecarText(rootA, P12_DOC);
    p12Check(part, 'no falsely confirmed room',
      checkpoint.status === 200 && text.includes('p12-b') && sidecar.includes('p12-b-edit'),
      {
        checkpoint: checkpoint.status,
        file: text.includes('p12-b'),
        sidecar: sidecar.includes('p12-b-edit'),
      });
  });
}

// C: a commit whose reply Go dropped, reconciled through /v1/op.
async function p12PartC({ bin, part }) {
  await p12WithSession({ bin, name: 'c' }, async ({ session, rootA }) => {
    const urlA = rootUrlAt(session, 0);
    const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
    const other = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
    const docPath = path.join(rootA, P12_DOC);
    const otherPath = path.join(rootA, P12_OTHER_DOC);
    fs.writeFileSync(docPath, doc.html);
    fs.writeFileSync(otherPath, other.html);
    await wait(P12_SEED_MS);

    // The count one page API write adds, measured on a document with no fault.
    const otherRead = await p12DataRead(urlA, P12_OTHER_DOC);
    const otherBefore = p12Versions(rootA, 'p12-other').length;
    const otherWrite = await p12DataWrite(urlA, P12_OTHER_DOC, { second: 'p12-c' },
      { etag: otherRead.etag, revision: otherRead.revision });
    const otherAfter = p12Versions(rootA, 'p12-other').length;
    const grown = otherAfter - otherBefore;
    part.detail.measured = {
      read: otherRead.status, write: otherWrite.status, before: otherBefore, after: otherAfter, grown,
    };

    const armed = await controlFaultFor(session)({ point: 'drop-reply', rel: P12_DOC, count: 1 });
    part.detail.armed = armed;
    const read = await p12DataRead(urlA, P12_DOC);
    const before = p12Versions(rootA, 'p12').length;
    const write = await p12DataWrite(urlA, P12_DOC, { second: 'p12-c' },
      { etag: read.etag, revision: read.revision });
    part.detail.write = { status: write.status, body: write.body };
    const remaining = await controlFaultFor(session)({ point: 'remaining', rel: P12_DOC });
    part.detail.remaining = remaining.body;
    p12Check(part, 'Go dropped the reply', remaining.status === 200 && remaining.body && remaining.body.remaining === 0,
      { status: remaining.status, body: remaining.body });
    await wait(500);
    const after = p12Versions(rootA, 'p12').length;
    part.detail.versions = { before, after, grown: after - before };
    p12Check(part, 'the write answers 200', write.status === 200,
      { status: write.status, body: write.body });

    const text = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
    const sidecar = sidecarText(rootA, P12_DOC);
    p12Check(part, 'written once',
      (text.includes('p12-c') || sidecar.includes('p12-c')) && grown > 0 && after - before === grown,
      { file: text.includes('p12-c'), sidecar: sidecar.includes('p12-c'), grown, wrote: after - before });
  });
}

// D: the JS service down: a recoverable refusal, nothing written, no capability
// downgraded, and recovery once the service is back.
async function p12PartD({ bin, part }) {
  await p12WithSession({ bin, name: 'd' }, async ({ session, ctx, rootA }) => {
    let urlA = rootUrlAt(session, 0);
    const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
    const docPath = path.join(rootA, P12_DOC);
    fs.writeFileSync(docPath, doc.html);
    await wait(P12_SEED_MS);

    const client = await joinLiveClient(ctx, { rootId: 'root-a', docPath: P12_DOC, clientId: 'p12-d-1' });
    await client.ready();
    await client.close();
    const clean = await p12ServiceCall(session, '/v1/checkpoint-wait', {
      root: (session.readyRoots?.[0] ?? {}).id, name: P12_DOC, timeoutMs: 10000,
    });
    part.detail.clean = clean;

    await session.kill('service');
    await waitUntil(() => session.service.child.exitCode !== null || session.service.child.signalCode !== null, 5000);
    part.detail.serviceExit = {
      exitCode: session.service.child.exitCode, signalCode: session.service.child.signalCode,
    };
    const before = sha256File(docPath);

    const refused = p12Refused(await p12Save(urlA, P12_DOC, await p12MarkedDocument(doc, 'p12-d')));
    part.detail.save = refused;
    const retryable = refused.body && typeof refused.body === 'object' && refused.body.retryable === true;
    p12Check(part, 'the save is refused recoverably',
      refused.status === 503 && Boolean(refused.retryAfter) && retryable,
      { status: refused.status, retryAfter: refused.retryAfter, body: refused.body });

    const api = p12Refused(await p12DataWrite(urlA, P12_DOC, { second: 'p12-d' }));
    part.detail.api = api;
    const apiRetryable = api.body && typeof api.body === 'object' && api.body.retryable === true;
    p12Check(part, 'the page API write is refused recoverably',
      api.status === 503 && Boolean(api.retryAfter) && apiRetryable,
      { status: api.status, retryAfter: api.retryAfter, body: api.body });

    p12Check(part, 'nothing is written', sha256File(docPath) === before,
      { before, after: sha256File(docPath) });

    const meta = await p12Meta(urlA, P12_DOC);
    const required = [...REQUIRED_EXTENSIONS].sort();
    const announced = Array.isArray(meta.extensions) ? [...meta.extensions] : null;
    p12Check(part, 'no capability is downgraded',
      meta.status === 200 && announced !== null && JSON.stringify(announced) === JSON.stringify(required),
      { status: meta.status, extensions: meta.extensions });

    await session.restartService();
    urlA = rootUrlAt(session, 0);
    const after = await p12Save(urlA, P12_DOC, await p12MarkedDocument(doc, 'p12-d'));
    part.detail.afterRestart = { status: after.status, body: after.body };
    p12Check(part, 'it recovers', after.status === 200, { status: after.status, body: after.body });
  });
}

// The platform's sync routes, in memory: discovery with every feature on, one
// personal account, the whole inventory, content reads and writes, page state
// and the session stream. Every upload it takes is recorded by path.
function p12FakeSyncServer() {
  const nodes = new Map();
  const calls = [];
  const streams = new Set();
  let nextId = 1;
  const checksumOf = (content) => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const pathOf = (node) => (node.parentId && nodes.get(node.parentId)
    ? `${pathOf(nodes.get(node.parentId))}/${node.name}` : node.name);
  const valueOf = (node) => ({
    id: node.id,
    type: node.type,
    name: node.name,
    parentId: node.parentId,
    path: null,
    size: node.content === null ? undefined : Buffer.byteLength(node.content),
    modifiedAt: node.modifiedAt,
    checksum: node.content === null ? null : checksumOf(node.content),
    etag: node.content === null ? null : checksumOf(node.content),
    structureVersion: String(node.id),
  });
  const announce = (body) => {
    for (const stream of streams) {
      try { stream.write(`data: ${JSON.stringify(body)}\n\n`); } catch { }
    }
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = url.pathname;
      calls.push({ method: request.method, path: route });
      const answer = (status, value) => {
        const payload = Buffer.from(JSON.stringify(value));
        response.writeHead(status, {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        });
        response.end(payload);
      };

      if (route === '/_/sync/accounts') {
        answer(200, {
          success: true,
          protocol: 2,
          features: {
            accountScopes: true,
            accountEvents: true,
            conditionalContent: true,
            conditionalStructure: true,
            completeInventory: true,
          },
          accounts: [{
            id: 'p12-account',
            kind: 'personal',
            sync: { enabled: true },
            limits: { uploadBytes: 10 * 1024 * 1024 },
          }],
        });
        return;
      }
      if (route === '/_/sync/status') {
        answer(200, { serverTime: new Date().toISOString(), protocol: 2 });
        return;
      }
      if (route === '/_/sync/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        response.write(': open\n\n');
        response.write(`data: ${JSON.stringify({ type: 'sync-ready', sync: { enabled: true, reason: null } })}\n\n`);
        streams.add(response);
        request.on('close', () => streams.delete(response));
        return;
      }
      if (route === '/_/sync/control') {
        answer(200, { delivered: true });
        return;
      }
      if (route === '/_/sync/nodes' && request.method === 'GET') {
        answer(200, {
          nodes: [...nodes.values()].map(valueOf),
          complete: true,
          structureVersion: String(nodes.size),
        });
        return;
      }
      if (route === '/_/sync/nodes' && request.method === 'POST') {
        const node = {
          id: nextId,
          type: body.type,
          name: body.name,
          parentId: body.parentId === 'root' ? 0 : Number(body.parentId) || 0,
          content: body.content === undefined ? null : body.content,
          modifiedAt: body.modifiedAt || new Date().toISOString(),
        };
        nextId += 1;
        nodes.set(node.id, node);
        const value = valueOf(node);
        answer(200, {
          node: { id: node.id, type: node.type, name: node.name, parentId: node.parentId },
          etag: value.etag,
          checksum: value.checksum,
          structureVersion: value.structureVersion,
        });
        announce({ type: 'node-created', nodeId: node.id, nodeType: node.type });
        return;
      }
      const content = /^\/_\/sync\/nodes\/(\d+)\/content$/.exec(route);
      if (content) {
        const node = nodes.get(Number(content[1]));
        if (!node) {
          answer(404, { error: 'not found' });
          return;
        }
        if (request.method === 'GET') {
          answer(200, { ...valueOf(node), nodeType: node.type, content: node.content });
          return;
        }
        if (request.method === 'PUT') {
          const name = pathOf(node);
          node.content = body.content;
          node.modifiedAt = body.modifiedAt || new Date().toISOString();
          calls.push({ method: 'UPLOAD', path: name, name });
          const value = valueOf(node);
          answer(200, {
            nodeId: node.id,
            checksum: value.checksum,
            etag: value.etag,
            structureVersion: value.structureVersion,
          });
          return;
        }
      }
      if (/^\/_\/sync\/nodes\/\d+\/blockeditor-state$/.test(route)) {
        if (request.method === 'GET') {
          answer(404, { error: 'no page state' });
          return;
        }
        answer(200, { ok: true });
        return;
      }
      answer(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      calls,
      uploads: () => calls.filter((call) => call.method === 'UPLOAD').map((call) => call.name),
      close: () => new Promise((done) => {
        for (const stream of streams) {
          try { stream.end(); } catch { }
        }
        server.close(() => done());
      }),
    }));
  });
}

// The connection the driver's Go watcher resumes from: `GET /v1/events` from the
// epoch's first sequence answers the current cursor first, and every frame
// replayed after it carries its own.
async function p12ReadCursor(connection, waitMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  const cursors = [];
  let status = null;
  try {
    const response = await fetch(`${connection.url}/v1/events?since=0`, {
      headers: { authorization: `Bearer ${connection.secret}`, accept: 'application/x-ndjson' },
      signal: controller.signal,
    });
    status = response.status;
    if (response.status === 200) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          let frame = null;
          try { frame = JSON.parse(line); } catch { frame = null; }
          if (frame && typeof frame.cursor === 'string') {
            cursors.push({ cursor: frame.cursor, type: frame.type ?? null, rel: frame.rel ?? null });
          }
        }
      }
    }
  } catch {
    // A stream that ends by deadline holds every frame it was going to send.
  } finally {
    clearTimeout(timer);
  }
  const sequence = (cursor) => {
    const raw = String(cursor).split(':')[1];
    const value = Number(raw);
    return Number.isFinite(value) ? value : -1;
  };
  cursors.sort((left, right) => sequence(left.cursor) - sequence(right.cursor));
  return {
    status,
    frames: cursors,
    cursor: cursors.length ? cursors[cursors.length - 1].cursor : null,
  };
}

// Waits until Go's watcher has published `rel`. Both hosts report a document
// they have not seen yet as added and run the outside-edit guard on a change
// only, so a document must have been seen before an outside program rewrites it.
async function waitForWatcherFrame(session, rel, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const read = await p12ReadCursor({ url: session.control, secret: session.secret }, 500);
    if (read.frames.some((frame) => frame.type === 'change' && frame.rel === rel)) return true;
    await wait(200);
  }
  return false;
}

// The first frame a `since` cursor is answered with.
async function p12FirstFrame(connection, since) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${connection.url}/v1/events?since=${encodeURIComponent(since)}`, {
      headers: { authorization: `Bearer ${connection.secret}`, accept: 'application/x-ndjson' },
      signal: controller.signal,
    });
    if (response.status !== 200) return { status: response.status, frame: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let frame = null;
        try { frame = JSON.parse(line); } catch { frame = null; }
        reader.cancel().catch(() => { });
        return { status: response.status, frame };
      }
    }
    return { status: response.status, frame: null };
  } catch {
    return { status: null, frame: null };
  } finally {
    clearTimeout(timer);
  }
}

// E: a restart gives a cursor gap and a full inventory that respects a hold.
async function p12PartE({ bin, out, part }) {
  const driverLog = path.join(out ?? os.tmpdir(), 'p12-e-driver.log');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-p12-e-')));
  const runDir = path.join(tmp, 'run');
  const rootA = path.join(tmp, 'root-a');
  const userData = path.join(runDir, 'userData');
  const connectionFile = path.join(tmp, 'connection.json');
  const sessionId = 'p12-sync';
  const settingsRootId = 'p12-root-a';
  let driver = null;
  let fake = null;
  let stderr = '';
  let callId = 0;
  const nextMessage = (timeoutMs = 60000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      driver.off('message', onMessage);
      reject(new Error(`the sync driver sent nothing in ${timeoutMs}ms: ${stderr.slice(-2000)}`));
    }, timeoutMs);
    const onMessage = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    driver.once('message', onMessage);
  });
  const callDriver = async (cmd, args = {}) => {
    callId += 1;
    const id = callId;
    const reply = nextMessage();
    driver.send({ id, cmd, args });
    const message = await reply;
    if (message.id !== id) throw new Error(`the sync driver answered ${JSON.stringify(message)}`);
    if (!message.ok) throw new Error(`${cmd} failed: ${message.error && message.error.message}`);
    return message.result;
  };
  const readConnection = () => {
    try {
      const text = fs.readFileSync(connectionFile, 'utf8');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed.url === 'string' && typeof parsed.secret === 'string' ? parsed : null;
    } catch {
      return null;
    }
  };

  try {
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    for (const name of ['free.html', 'held.html']) {
      fs.writeFileSync(path.join(rootA, name),
        `<!doctype html>\n<html><body><h1>${name}</h1></body></html>\n`);
    }

    fake = await p12FakeSyncServer();
    driver = fork(P12_DRIVER, [], {
      execArgv: ['--require', P12_CONNECTION_PROBE],
      env: {
        ...process.env,
        APP_HOSTNAME: '127.0.0.1',
        APP_PORT: String(fake.port),
        LOCAL_DIR: REPO,
        UNDICI_PATH: require.resolve('undici'),
        MANAGED_TRIAL_GO_BIN: bin,
        MANAGED_TRIAL_RUN: runDir,
        P12_CONNECTION_OUT: connectionFile,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    driver.stderr.setEncoding('utf8');
    driver.stderr.on('data', (chunk) => { stderr += chunk; });
    driver.stdout.setEncoding('utf8');
    driver.stdout.on('data', (chunk) => { stderr += chunk; });
    part.detail.driver = { pid: driver.pid, log: driverLog };

    const ready = await nextMessage();
    if (!ready || ready.ready !== true) throw new Error('the sync driver did not announce itself ready');

    const snapshot = await callDriver('start', {
      userData,
      apiKey: 'p12-key',
      roots: [{ id: settingsRootId, path: rootA, kind: 'personal', name: 'root-a' }],
      sessions: [{ id: sessionId, rootId: settingsRootId, kind: 'personal', accountId: null, cached: { username: null } }],
    });
    part.detail.start = { sessions: snapshot && snapshot.sessions ? snapshot.sessions.map((entry) => entry.status) : null };

    const metaDir = path.join(userData, 'sync-meta', 'v2', sessionId);
    const nodeMapFile = path.join(metaDir, 'node-map.json');
    const firstPass = await waitUntil(() => {
      try {
        const map = JSON.parse(fs.readFileSync(nodeMapFile, 'utf8'));
        const entries = Object.values(map);
        return entries.length === 2 && entries.every((entry) => entry.remoteEtag) ? map : null;
      } catch {
        return null;
      }
    }, 20000);
    if (!firstPass) throw new Error(`the driver's first pass did not finish: ${stderr.slice(-2000)}`);
    part.detail.firstPass = Object.fromEntries(Object.entries(firstPass).map(([id, entry]) => [
      entry.path, { id, remoteEtag: entry.remoteEtag, localChecksum: entry.localChecksum },
    ]));

    const held = Object.entries(firstPass).find(([, entry]) => entry.path === 'held.html');
    if (!held) throw new Error('the first pass tracked no held.html');
    const [heldId, heldEntry] = held;
    const conflictsFile = path.join(metaDir, 'conflicts.json');
    fs.writeFileSync(conflictsFile, `${JSON.stringify({
      [heldId]: {
        kind: 'both-edited',
        path: 'held.html',
        localChecksum: heldEntry.localChecksum,
        remoteEtag: heldEntry.remoteEtag,
        remoteCopy: null,
        detectedAt: Date.now(),
      },
    }, null, 2)}\n`);
    part.detail.hold = { key: heldId, path: 'held.html' };

    const old = await waitUntil(() => readConnection(), 10000);
    if (!old) throw new Error('the driver never recorded the Go connection its watcher uses');
    const before = await p12ReadCursor(old);
    part.detail.cursorBefore = before;
    if (!before.cursor) throw new Error('the old Go answered no event cursor');

    const uploadsBefore = fake.uploads().length;
    fs.writeFileSync(path.join(rootA, 'free.html'),
      '<!doctype html>\n<html><body><h1>free</h1><p>changed</p></body></html>\n');
    fs.writeFileSync(path.join(rootA, 'held.html'),
      '<!doctype html>\n<html><body><h1>held</h1><p>changed</p></body></html>\n');

    await callDriver('restartGoOnly');
    const next = await waitUntil(() => {
      const current = readConnection();
      return current && current.url !== old.url ? current : null;
    }, 15000);
    part.detail.connection = { before: { url: old.url }, after: next ? { url: next.url } : null };
    if (!next) throw new Error('the restarted Go never replaced the connection');

    const gap = await p12FirstFrame(next, before.cursor);
    part.detail.gap = gap;
    p12Check(part, 'the restart gives a cursor gap',
      gap.status === 200 && gap.frame !== null && gap.frame.type === 'gap',
      { status: gap.status, frame: gap.frame });

    const inventory = await waitUntil(() => {
      const uploads = fake.uploads().slice(uploadsBefore);
      return uploads.includes('free.html') ? uploads : null;
    }, 20000);
    const idle = await callDriver('idle', { timeoutMs: 20000 }).then(() => true, (error) => error.message);
    const settled = fake.uploads().slice(uploadsBefore);
    part.detail.uploads = { before: uploadsBefore, after: settled, idle };
    part.detail.conflicts = await callDriver('conflicts', { root: settingsRootId });
    p12Check(part, 'the gap reconcile uploads free.html and leaves held.html held',
      inventory !== null && idle === true && settled.includes('free.html') && !settled.includes('held.html'),
      { uploads: settled, idle });
  } finally {
    fs.writeFileSync(driverLog, stderr);
    if (driver && driver.exitCode === null && driver.signalCode === null) {
      const exited = new Promise((resolve) => driver.once('exit', resolve));
      try { driver.kill(); } catch { }
      await Promise.race([exited, wait(10000)]);
    }
    if (fake) {
      try { await fake.close(); } catch { }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const P12_RUNNERS = {
  a: p12PartA, b: p12PartB, c: p12PartC, d: p12PartD, e: p12PartE,
};

export async function runP12({ goBin, out } = {}) {
  const bin = path.resolve(goBin);
  const parts = {};
  for (const letter of P12_PARTS) {
    const part = p12Part();
    try {
      await P12_RUNNERS[letter]({ bin, out, letter, part });
      part.completed = true;
      part.unsafe = part.reasons.length > 0;
    } catch (error) {
      part.completed = false;
      part.unsafe = true;
      part.error = `${error?.message || String(error)}`;
      if (part.reasons.length === 0) part.reasons.push(part.error);
    }
    parts[letter] = part;
  }
  const verdict = judgeP12({ parts });
  const report = {
    schema: 1,
    condition: 'p12',
    goBin: bin,
    verdict: verdict.pass ? 'pass' : 'fail',
    pass: verdict.pass,
    completed: verdict.completed,
    unsafe: verdict.unsafe,
    reasons: verdict.reasons,
    parts,
    summary: p12Summary(verdict),
  };
  return { report, exitCode: verdict.pass ? 0 : 1 };
}

// The page the deadline is measured on: the fixture's own page grown with plain
// paragraphs in a section of their own, before </body> and outside the article,
// until the file is between 300,000 and 310,000 bytes.
const PAD_MARKER = '<section id="pad"></section>';
const PAD_LINE = `<p>pad 00000 ${'a'.repeat(24)}</p>`;

function padSection(count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(`<p>pad ${String(i).padStart(5, '0')} ${'a'.repeat(24)}</p>`);
  return `<section id="pad">\n${lines.join('\n')}\n</section>`;
}

async function deadlinePage() {
  const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
  if (!doc.html.includes('</body>')) throw new Error('the page fixture has no body to grow');
  const base = doc.html.replace('</body>', `${PAD_MARKER}</body>`);
  const perLine = Buffer.byteLength(PAD_LINE) + 1;
  let count = Math.max(0, Math.ceil((DEADLINE_PAGE_MIN - Buffer.byteLength(base)) / perLine));
  let html = base.replace(PAD_MARKER, padSection(count));
  while (Buffer.byteLength(html) < DEADLINE_PAGE_MIN) {
    count += 10;
    html = base.replace(PAD_MARKER, padSection(count));
  }
  while (Buffer.byteLength(html) > DEADLINE_PAGE_MAX && count > 0) {
    count -= 1;
    html = base.replace(PAD_MARKER, padSection(count));
  }
  const bytes = Buffer.byteLength(html);
  if (bytes < DEADLINE_PAGE_MIN || bytes > DEADLINE_PAGE_MAX) {
    throw new Error(`the page is ${bytes} bytes, outside ${DEADLINE_PAGE_MIN}..${DEADLINE_PAGE_MAX}`);
  }
  return { html, bytes };
}

// One paragraph of the pad rewritten, so the document's bytes change and its
// page tag does not.
function changePad(html, stamp) {
  const pattern = /(<section id="pad">\n<p>)pad [^<]*(<\/p>)/;
  if (!pattern.test(html)) throw new Error('the page has no pad paragraph to change');
  return html.replace(pattern, `$1pad ${stamp}$2`);
}

function formatMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a';
}

export function deadlineSummary({ bytes, hosts } = {}) {
  const measured = hosts ?? {};
  const lines = DEADLINE_HOSTS.map((name) => {
    const host = measured[name] ?? {};
    const terms = DEADLINE_OPS.map((op) => {
      const entry = host[op] ?? {};
      const failed = Array.isArray(entry.failures) ? entry.failures.length : 0;
      return `${op}=${formatMs(entry.p50)}/${formatMs(entry.max)}${failed > 0 ? ` failed=${failed}` : ''}`;
    });
    return `DEADLINE ${name} bytes=${bytes} ${terms.join(' ')} deadlineMs=${CONSULT_DEADLINE_MS}`;
  });
  const managed = measured.managed ?? {};
  const maxima = DEADLINE_OPS
    .filter((op) => op !== 'meta-visible' && op !== 'read')
    .map((op) => (managed[op] && typeof managed[op].max === 'number' ? managed[op].max : null))
    .filter((value) => value !== null);
  const headroom = maxima.length === 0
    ? 'n/a'
    : (CONSULT_DEADLINE_MS / Math.max(...maxima)).toFixed(2);
  const failedSamples = DEADLINE_OPS.reduce((total, op) => {
    const entry = managed[op] ?? {};
    return total + (Array.isArray(entry.failures) ? entry.failures.length : 0);
  }, 0);
  lines.push(`DEADLINE headroom=${headroom} failedSamples=${failedSamples}`);
  return lines.join('\n');
}

function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function postControl(control, pathname, body) {
  return fetch(`${control.url}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${control.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, answer: parsed };
  });
}

// Local's in-process fixture, answering the same control API the managed
// fixture answers, on a root folder this measurement seeds.
async function startInProcessFixture({ dir, rootDir, logPath }) {
  const manifestPath = path.join(dir, 'manifest.json');
  const child = spawn(process.execPath, [
    HTTP_FIXTURE, '--manifest', manifestPath, '--root', `root-a=${rootDir}`,
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(logPath);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  child.on('error', () => {});
  const manifest = await waitForManifest(manifestPath, child);
  if (!manifest) {
    killChild(child);
    await Promise.race([exited, wait(10000)]);
    killChild(child, 'SIGKILL');
    await Promise.race([exited, wait(5000)]);
    log.end();
    throw couldNotDemonstrate(`the in-process fixture wrote no manifest (log ${logPath})`);
  }
  return {
    child, manifest, manifestPath, exited, log,
  };
}

// The five consulted operations, each timed around the whole client call, ten
// times over, against one host.
async function measureDeadlineHost({
  host, initialHtml, docPath, signal,
}) {
  const ctx = { rootUrl: () => host.url, signal };
  const html = { current: initialHtml };
  let example = null;
  let stamp = 0;
  const nextStamp = () => { stamp += 1; return `${host.name}-${stamp}`; };

  const ops = {
    async save() {
      const before = await p12Meta(host.url, DEADLINE_DOC);
      if (before.status !== 200 || !before.etag) {
        return { status: before.status, answer: { error: 'the meta named no document etag' } };
      }
      html.current = changePad(html.current, nextStamp());
      const answer = await saveDocument(host.url, DEADLINE_DOC, html.current, { 'if-match': before.etag });
      return { status: answer.status, answer: answer.body ?? answer.text };
    },
    async 'api-write'() {
      const read = await p12DataRead(host.url, DEADLINE_DOC);
      const answer = await p12DataWrite(host.url, DEADLINE_DOC, { second: nextStamp() },
        { etag: read.etag, revision: read.revision });
      return { status: answer.status, answer: answer.body ?? answer.text };
    },
    async checkpoint() {
      const fileBefore = fs.readFileSync(docPath);
      const client = await joinLiveClient(ctx, {
        rootId: host.rootId, docPath: DEADLINE_DOC, clientId: `checkpoint-${nextStamp()}`,
      });
      let edit;
      try {
        await client.ready();
        edit = await client.edit('game', [{ op: 'add', path: ['score'], n: 1 }]);
      } catch (error) {
        await client.close();
        throw error;
      }
      if (edit.status !== 200) {
        await client.close();
        return { status: edit.status, answer: edit.body };
      }
      const started = performance.now();
      await client.close();
      const answer = await host.checkpointWait(DEADLINE_CHECKPOINT_MS);
      const measuredMs = performance.now() - started;
      if (answer.status === 200 && fs.readFileSync(docPath).equals(fileBefore)) {
        return { status: 'not-written', answer: { error: 'the checkpoint left the file unchanged', wait: answer.answer }, measuredMs };
      }
      return { status: answer.status, answer: answer.answer, measuredMs };
    },
    async observe() {
      const before = observeClient.events.length;
      html.current = changePad(html.current, nextStamp());
      const started = performance.now();
      fs.writeFileSync(docPath, html.current);
      const seen = await waitUntil(() => {
        const events = observeClient.events.slice(before);
        return events.find((event) => event.data && event.data !== '') ?? null;
      }, DEADLINE_OBSERVE_MS, 10);
      if (!seen) {
        return { status: null, answer: `no live event reached the watcher within ${DEADLINE_OBSERVE_MS} ms` };
      }
      const measuredMs = performance.now() - started;
      if (example === null) {
        example = { event: seen.event, data: String(seen.data).slice(0, 200) };
      }
      return { status: 200, answer: { event: seen.event }, measuredMs };
    },
    async 'meta-visible'() {
      const before = await p12Meta(host.url, DEADLINE_DOC);
      if (before.status !== 200 || !before.etag) {
        return { status: before.status, answer: { error: 'the meta named no document etag' } };
      }
      html.current = changePad(html.current, nextStamp());
      fs.writeFileSync(docPath, html.current);
      const seen = await waitUntil(async () => {
        const now = await p12Meta(host.url, DEADLINE_DOC);
        return now.status === 200 && now.etag && now.etag !== before.etag ? now : null;
      }, DEADLINE_OBSERVE_MS, 10);
      if (!seen) {
        return { status: null, answer: `the new bytes were not announced within ${DEADLINE_OBSERVE_MS} ms` };
      }
      return { status: 200, answer: { etag: seen.etag } };
    },
    async read() {
      const answer = await fetchText(`${host.url}/${DEADLINE_DOC}`);
      return { status: answer.status, answer: { bytes: Buffer.byteLength(answer.text) } };
    },
  };

  let observeClient = null;
  const measured = {};
  try {
    for (const op of DEADLINE_OPS) {
      if (op === 'observe') {
        observeClient = await joinLiveClient(ctx, {
          rootId: host.rootId, docPath: DEADLINE_DOC, clientId: 'deadline-observe',
        });
        await observeClient.ready();
      }
      const samples = [];
      const failures = [];
      for (let i = 0; i < DEADLINE_SAMPLES; i += 1) {
        const started = performance.now();
        let answer;
        try {
          answer = await ops[op]();
        } catch (error) {
          answer = { status: null, answer: error?.message || String(error) };
        }
        const elapsed = typeof answer.measuredMs === 'number'
          ? answer.measuredMs
          : performance.now() - started;
        if (answer.status === 200) samples.push(Number(elapsed.toFixed(3)));
        else failures.push({ status: answer.status ?? null, answer: answer.answer ?? null });
      }
      measured[op] = {
        samples,
        p50: percentile(samples, 0.5),
        max: samples.length > 0 ? Math.max(...samples) : null,
        failures,
      };
      if (op === 'observe' && example !== null) measured[op].example = example;
    }
  } finally {
    if (observeClient) await observeClient.close();
  }
  return measured;
}

async function measureManagedHost({ bin, page }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-deadline-managed-'));
  const rootA = path.join(tmp, 'root-a');
  const rootB = path.join(tmp, 'root-b');
  const scratch = path.join(tmp, 'scratch');
  for (const dir of [rootA, rootB, scratch]) fs.mkdirSync(dir, { recursive: true });
  const docPath = path.join(rootA, DEADLINE_DOC);
  const abort = new AbortController();
  let session = null;
  try {
    session = await startTrialSession({ bin, scratch, roots: [rootA, rootB] });
    const url = rootUrlAt(session, 0);
    const goRoot = (session.readyRoots?.[0] ?? {}).id;
    if (!goRoot) throw couldNotDemonstrate('the managed host names no root for the page');
    fs.writeFileSync(docPath, page.html);
    await wait(DEADLINE_SEED_MS);
    return await measureDeadlineHost({
      host: {
        name: 'managed',
        url,
        rootId: 'root-a',
        checkpointWait: async (timeoutMs) => {
          const answer = await p12ServiceCall(session, '/v1/checkpoint-wait',
            { root: goRoot, name: DEADLINE_DOC, timeoutMs });
          return { status: answer.status, answer: answer.body };
        },
      },
      initialHtml: page.html,
      docPath,
      signal: abort.signal,
    });
  } finally {
    abort.abort();
    if (session) {
      try { await session.stop(); } catch { }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function measureInProcessHost({ out, page }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-host-deadline-in-process-'));
  const rootA = path.join(tmp, 'root-a');
  fs.mkdirSync(rootA, { recursive: true });
  const docPath = path.join(rootA, DEADLINE_DOC);
  const abort = new AbortController();
  let fixture = null;
  try {
    fixture = await startInProcessFixture({
      dir: tmp, rootDir: rootA, logPath: path.join(out, 'deadline-in-process.log'),
    });
    const root = (fixture.manifest.roots ?? [])[0];
    if (!root || !root.url) throw couldNotDemonstrate('the in-process fixture names no root');
    const control = fixture.manifest.control;
    fs.writeFileSync(docPath, page.html);
    await wait(DEADLINE_SEED_MS);
    return await measureDeadlineHost({
      host: {
        name: 'in-process',
        url: root.url,
        rootId: root.id,
        checkpointWait: (timeoutMs) => postControl(control, '/checkpoint-wait',
          { root: root.id, path: DEADLINE_DOC, timeoutMs }),
      },
      initialHtml: page.html,
      docPath,
      signal: abort.signal,
    });
  } finally {
    abort.abort();
    if (fixture) await stopFixture(fixture);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The deadline measured on a 300 KB page: how long each consulted operation
// takes through the managed host, beside the same operation run in process.
// It records and passes nothing.
export async function runDeadline({ goBin, out } = {}) {
  const bin = path.resolve(goBin);
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    throw couldNotDemonstrate(`--go-bin is not an executable file: ${bin}`);
  }
  const page = await deadlinePage();
  const hosts = {};
  hosts.managed = await measureManagedHost({ bin, page });
  hosts['in-process'] = await measureInProcessHost({ out, page });
  const report = {
    schema: 1,
    measure: 'deadline',
    goBin: bin,
    bytes: page.bytes,
    deadlineMs: CONSULT_DEADLINE_MS,
    samplesPerOperation: DEADLINE_SAMPLES,
    hosts,
    summary: deadlineSummary({ bytes: page.bytes, hosts }),
    exitCode: 0,
  };
  return { report, exitCode: 0 };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const out = resolveOut(args.out);
  const label = args.measure ?? args.condition;
  let result;
  try {
    if (args.measure === 'deadline') result = await runDeadline({ goBin: args.goBin, out });
    else if (args.condition === 'p11') result = await runP11({ goBin: args.goBin, out });
    else if (args.condition === 'p13') result = await runP13({ goBin: args.goBin, out });
    else if (args.condition === 'p10') result = await runP10({ goBin: args.goBin, out });
    else if (args.condition === 'p12') result = await runP12({ goBin: args.goBin, out });
    else result = await runP9({ goBin: args.goBin, out });
  } catch (error) {
    if (error && error.code === 'could-not-demonstrate') {
      const report = {
        schema: 1,
        ...(args.measure ? { measure: args.measure } : { condition: args.condition }),
        goBin: path.resolve(args.goBin),
        verdict: 'could-not-demonstrate',
        pass: false,
        reasons: [error.message],
        summary: `${label.toUpperCase()} could-not-demonstrate ${error.message}`,
      };
      writeReport(out, label, report);
      process.stdout.write(`${report.summary}\n`);
      return 3;
    }
    throw error;
  }
  return finish(out, label, result.report, result.report.summary);
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`full host: ${error?.message || String(error)}\n`);
    process.exitCode = 2;
  });
}
