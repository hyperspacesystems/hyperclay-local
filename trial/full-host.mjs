#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

const require = createRequire(import.meta.url);
const { createWorkspaceLifecycle } = require('../src/main/workspace/lifecycle.js');
const { compileTailwind } = require('tailwind-hyperclay');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'trial', 'managed-fixture.mjs');
const HTTP_RUN = path.join(REPO, 'tests', 'http', 'run.mjs');
const CONDITIONS = ['p9', 'p10', 'p11', 'p13'];
const PROFILE = 'local-full';
const DOC = 'p9.html';
const TW_DOC = 'tw.html';
const TW_STYLESHEET = 'tw';
const GUARD_DOC = 'guard.html';
const MANIFEST_DEADLINE_MS = 90000;

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
  const args = { condition: null, goBin: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== '--condition' && flag !== '--go-bin' && flag !== '--out') {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--condition') args.condition = value;
    else if (flag === '--go-bin') args.goBin = value;
    else args.out = value;
  }
  if (!args.condition) throw new Error('--condition is required (p9, p10, p11 or p13)');
  if (!CONDITIONS.includes(args.condition)) {
    throw new Error(`unknown --condition: ${args.condition} (p9, p10, p11 or p13)`);
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
    sidecar: sha256File(path.join(rootDir, '.hyperclay', 'page-state', `${docPath}.json`)),
    versions: listNames(path.join(rootDir, '.hyperclay', 'versions', docPath.replace(/\.html$/, ''))),
  };
}

function sidecarText(rootDir, docPath) {
  try {
    return fs.readFileSync(path.join(rootDir, '.hyperclay', 'page-state', `${docPath}.json`), 'utf8');
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
    const oldSave = await saveDocument(urlA, TW_DOC, twDocument('underline'));
    const oldHeld = await waitUntil(async () => (await heldCount()) === 1, 5000);
    const newSave = await saveDocument(urlA, TW_DOC, twDocument('italic'));
    const italicExpected = await expectedCss();
    const italicInstalled = await waitUntil(() => readCss() === italicExpected, 15000);
    const releasedStale = await fault({ point: 'release', rel: TW_STYLESHEET });
    await wait(1500);
    const afterStaleRelease = readCss();
    detail.steps.stale = {
      armed: armedStale.body,
      oldSave: oldSave.status,
      held: oldHeld === true,
      newSave: newSave.status,
      installed: italicInstalled === true,
      released: releasedStale.body,
      stillNewer: afterStaleRelease === italicExpected,
    };
    staleInstalls = afterStaleRelease === italicExpected ? 0 : 1;

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

      const event = await waitUntil(async () => {
        const answer = await fetchText(`${urlA}/_/data-loss?file=${encodeURIComponent(GUARD_DOC)}`);
        const body = answer.body;
        return body && body.event && typeof body.event.id === 'string' ? body.event : null;
      }, 10000);
      if (event) raised += 1;

      const notified = await waitUntil(() => raisedNotices() > noticesBefore, 10000);
      if (notified) notices += 1;

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

    const page = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'page-a' });
    const store = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'game-b' });
    const pageEdit = await page.edit('page', [{ op: 'set', path: ['y', 'http-a-1'], value: doc.update }]);
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

    const cPage = await joinLiveClient(ctx, { rootId: 'root-a', docPath: DOC, clientId: 'page-c' });
    const cEdit = await cPage.edit('page', [{ op: 'set', path: ['y', 'p9-c'], value: doc.update }]);
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

export async function main(argv) {
  const args = parseArgs(argv);
  const out = resolveOut(args.out);
  let result;
  try {
    if (args.condition === 'p11') result = await runP11({ goBin: args.goBin, out });
    else if (args.condition === 'p13') result = await runP13({ goBin: args.goBin, out });
    else if (args.condition === 'p10') result = await runP10({ goBin: args.goBin, out });
    else result = await runP9({ goBin: args.goBin, out });
  } catch (error) {
    if (error && error.code === 'could-not-demonstrate') {
      const report = {
        schema: 1,
        condition: args.condition,
        goBin: path.resolve(args.goBin),
        verdict: 'could-not-demonstrate',
        pass: false,
        reasons: [error.message],
        summary: `${args.condition.toUpperCase()} could-not-demonstrate ${error.message}`,
      };
      writeReport(out, args.condition, report);
      process.stdout.write(`${report.summary}\n`);
      return 3;
    }
    throw error;
  }
  return finish(out, args.condition, result.report, result.report.summary);
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
