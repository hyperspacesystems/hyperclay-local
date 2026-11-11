// Hyperclay Local's standalone conformance gate. It boots M5's authority-backed fixture
// server on a scratch folder, seeds the package's page and the HTTP probe into that
// local-full root through the fixture's own control endpoint, hands the host to the
// installed @panphora/host-conformance package, and answers with the package's exit
// codes: 0 nothing failed, 1 a check failed, 3 the run could not answer. 3 is also this
// launcher's answer for a setup step that never reached a verdict, so a caller can tell
// "the host failed" from "the gate could not run".
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOST = 'hyperclay-local';
export const PACKAGE = '@panphora/host-conformance';
export const PAGE = '_mhf-host-test.html';
export const PROBE = '_conformance-probe.html';
export const REPORT_DEFAULT = '.conformance/latest.json';
export const FIXTURE = path.join('tests', 'helpers', 'host-http-fixture.cjs');
export const ROOT_ID = 'root-a';
export const PROFILE = 'local-full';
export const READY_TIMEOUT_MS = 20000;
export const STOP_GRACE_MS = 10000;
export const ENGINES = ['all', 'http', 'page'];

// The capability set this host must announce. Local serves real roots through the same
// runtime the app ships, so the full standalone list applies: `people` comes from the
// app's profile hooks, presence from the real authority, and the format and stylesheet
// rows from the vendored client.
export const REQUIRED_EXTENSIONS = [
  'conditional', 'data-guard-v1', 'data-read', 'data-write', 'format', 'live-data', 'live-provenance', 'page',
  'page-awareness-v1', 'page-format-v1', 'page-recovery-v1', 'people', 'presence', 'receipts',
  'record-awareness-v1', 'scoped-stylesheet', 'sync', 'sync-worker', 'sync-worker-data', 'upload', 'wire',
];

const PROBE_TITLE = 'Conformance probe \u00b7 Hyperclay Local';
export const PROBE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  `<head><meta charset="utf-8"><title>${PROBE_TITLE}</title></head>`,
  '<body>',
  `<h1>${PROBE_TITLE}</h1>`,
  '<p>Written by Hyperclay Local\u2019s conformance gate; the suite overwrites it on every run.</p>',
  '</body>',
  '</html>',
  '',
].join('\n');

// The control token is a credential: it authorizes seeding and stopping this fixture, and
// nothing this launcher prints may carry it. It is never handed to the package.
export function scrub(text, token) {
  let value = String(text);
  if (token) value = value.split(token).join('<token>');
  return value.replace(/\bBearer\s+\S+/g, 'Bearer <token>');
}

// Every guard failure below is this: the gate never reached a verdict.
class Infrastructure extends Error {}

const remaining = (deadline) => Math.max(deadline - Date.now(), 0);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

export function packageDir(cwd) {
  const require = createRequire(path.join(cwd, 'package.json'));
  return path.dirname(require.resolve(`${PACKAGE}/package.json`));
}

function packageVersion(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

export function parseArgs(argv) {
  const attach = {};
  let engine = 'all';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const [name, inline] = flag.startsWith('--') && flag.includes('=')
      ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)]
      : [flag, undefined];
    if (name === '--engine') {
      const value = inline ?? argv[(i += 1)];
      if (!ENGINES.includes(value)) throw new Error(`--engine must be one of ${ENGINES.join(', ')}`);
      engine = value;
      continue;
    }
    if (name === '--url' || name === '--root' || name === '--page' || name === '--doc' || name === '--target') {
      const value = inline ?? argv[(i += 1)];
      if (typeof value !== 'string' || !value) throw new Error(`${name} needs a value`);
      attach[name.slice(2)] = value;
      continue;
    }
    throw new Error(`unknown argument ${flag} (this gate takes --engine ${ENGINES.join('|')} or attach options --url, --root, --page, --doc, --target)`);
  }
  if (!Object.keys(attach).length) return { engine, attach: null };
  const missing = ['url', 'root', 'page', 'doc'].filter((name) => !attach[name]);
  if (missing.length) throw new Error(`attach mode needs ${missing.map((name) => `--${name}`).join(', ')}`);
  return { engine, attach };
}

// The manifest is a whole file written by atomic rename, so a complete read is a complete
// manifest. `--source` names this repo: the fixture loads the host from here and keeps its
// disposable roots under its own temporary folder.
export function fixtureArgs({ cwd, scratch, fixture = path.join(cwd, FIXTURE) }) {
  return [fixture, '--manifest', path.join(scratch, 'manifest.json'), '--source', cwd];
}

export async function waitForManifest({
  child, exitPromise, manifestPath, timeoutMs = READY_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    if (exited(child)) {
      const { code, signal } = await exitPromise;
      throw new Infrastructure(`the fixture exited before writing ${path.basename(manifestPath)} (${signal ?? `exit ${code}`})`);
    }
    let text = null;
    try {
      text = readFileSync(manifestPath, 'utf8');
    } catch {
      last = 'no manifest';
    }
    if (text !== null) {
      try {
        return JSON.parse(text);
      } catch (error) {
        last = `the manifest is not JSON: ${error.message}`;
      }
    }
    if (remaining(deadline) <= 0) {
      throw new Infrastructure(`the fixture wrote no manifest within ${timeoutMs}ms (${last})`);
    }
    await wait(Math.min(50, Math.max(remaining(deadline), 1)));
  }
}

// A real root, started by the real host, and the control endpoint that owns it. Anything
// else is a different host wearing this host's name.
export function assertManifest(manifest) {
  if (manifest?.schema !== 1) {
    throw new Infrastructure(`the fixture's manifest names schema ${JSON.stringify(manifest?.schema ?? null)}, not 1`);
  }
  if (manifest.expectedProfile !== PROFILE) {
    throw new Infrastructure(`the fixture's manifest names profile ${JSON.stringify(manifest.expectedProfile ?? null)}, not ${PROFILE}`);
  }
  const roots = Array.isArray(manifest.roots) ? manifest.roots : [];
  const root = roots.find((entry) => entry?.id === ROOT_ID);
  if (!root) throw new Infrastructure(`the fixture's manifest names no ${ROOT_ID}`);
  let url;
  try {
    url = new URL(root.url);
  } catch {
    throw new Infrastructure(`the fixture's manifest names no URL for ${ROOT_ID}`);
  }
  if (url.protocol !== 'http:') {
    throw new Infrastructure(`the fixture's manifest names ${url.protocol} for ${ROOT_ID}, not http`);
  }
  if (typeof root.fixtureRoot !== 'string' || !root.fixtureRoot) {
    throw new Infrastructure(`the fixture's manifest names no folder for ${ROOT_ID}`);
  }
  const control = manifest.control;
  if (!control || typeof control.url !== 'string' || !control.url
    || typeof control.token !== 'string' || !control.token) {
    throw new Infrastructure('the fixture\'s manifest names no control endpoint');
  }
  return { url: url.href.replace(/\/+$/, ''), root: root.fixtureRoot, control };
}

async function terminate(child, exitPromise, { graceMs = STOP_GRACE_MS } = {}) {
  const gone = await Promise.race([exitPromise, wait(graceMs).then(() => null)]);
  if (gone) return;
  child.kill('SIGKILL');
  await exitPromise;
}

// The fixture shuts itself down, so the launcher asks and waits rather than signalling.
// Only this child is ever killed, and only when the graceful stop runs out of budget.
export async function stopFixture({
  child, exitPromise, control, request = fetch, graceMs = STOP_GRACE_MS,
}) {
  if (exited(child)) {
    await exitPromise;
    return;
  }
  // No control endpoint means no graceful stop was ever offered, so there is nothing to
  // wait for: a fixture that never booted far enough to name one is killed here.
  if (!control?.url || !control.token) {
    child.kill('SIGKILL');
    await exitPromise;
    return;
  }
  try {
    await request(`${control.url}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(graceMs),
    });
  } catch {
    // The exit below is what proves the fixture is gone; a refused stop is not a verdict.
  }
  await terminate(child, exitPromise, { graceMs });
}

// The control endpoint is the only place the bearer token belongs. Nothing seeded here is
// a save token: the loopback listener, the real root context and the authority decide
// what this host permits.
export async function seed({ control, root, files, request = fetch }) {
  for (const [name, bytes] of files) {
    const response = await request(`${control.url}/seed`, {
      method: 'POST',
      headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ root, path: name, base64: Buffer.from(bytes).toString('base64') }),
      signal: AbortSignal.timeout(READY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Infrastructure(`seeding ${name} answered ${response.status}`);
  }
}

function readTail(logPath, limit = 4000) {
  try {
    return readFileSync(logPath, 'utf8').slice(-limit).trim();
  } catch {
    return '';
  }
}

export function startFixture({
  cwd,
  scratch,
  fixture = path.join(cwd, FIXTURE),
  env = process.env,
  timeoutMs = READY_TIMEOUT_MS,
  graceMs = STOP_GRACE_MS,
  request = fetch,
} = {}) {
  const logPath = path.join(scratch, 'fixture.log');
  const manifestPath = path.join(scratch, 'manifest.json');
  writeFileSync(logPath, '');
  const args = fixtureArgs({ cwd, scratch, fixture });
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const record = (chunk) => {
    try {
      appendFileSync(logPath, chunk);
    } catch {
      // A log that cannot be written cannot change a verdict.
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  let control = null;
  const stop = () => stopFixture({
    child, exitPromise, control, request, graceMs,
  });

  return waitForManifest({ child, exitPromise, manifestPath, timeoutMs }).then((manifest) => {
    const target = assertManifest(manifest);
    control = target.control;
    return {
      manifest, url: target.url, root: target.root, control, logPath, child, stop,
    };
  }).catch(async (error) => {
    await stop();
    const tail = readTail(logPath);
    throw tail ? new Infrastructure(`${error.message}: ${tail}`) : error;
  });
}

export function packageArgs({
  dir, baseURL, root, engine, reportPath, page = PAGE, doc = `/${PROBE}`, target = '',
}) {
  const args = [
    path.join(dir, 'bin', 'host-conformance.js'),
    '--engine', engine,
    '--host', HOST,
    '--url', baseURL,
    '--root', root,
    '--page', page,
    '--doc', doc,
    '--keep',
    '--require-extensions', REQUIRED_EXTENSIONS.join(','),
    '--report', reportPath,
  ];
  if (target) args.splice(args.indexOf('--doc') + 2, 0, '--target', target);
  return args;
}

// cwd is the host repo, not this script's directory: the package resolves playwright from
// the caller's directory, and playwright is installed here.
export function runPackage({
  cwd, env = process.env, dir, baseURL, root, engine, reportPath, page, doc, target,
}) {
  const child = spawn(process.execPath, packageArgs({
    dir, baseURL, root, engine, reportPath, page, doc, target,
  }), {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Infrastructure(`the conformance package could not start: ${error.message}`)));
    child.on('exit', (code, signal) => resolve(signal ? { signal } : { code: code ?? 3 }));
  });
}

function readReport(reportPath) {
  let text;
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch {
    throw new Infrastructure(`the conformance package wrote no report at ${reportPath}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Infrastructure(`the report at ${reportPath} is not JSON: ${error.message}`);
  }
}

function reportProblem(report, version) {
  if (report?.schema !== 1) return `names schema ${JSON.stringify(report?.schema ?? null)}, not 1`;
  if (report.package !== PACKAGE) return `names package ${JSON.stringify(report.package ?? null)}, not ${PACKAGE}`;
  if (report.host !== HOST) return `names host ${JSON.stringify(report.host ?? null)}, not ${HOST}`;
  if (report.version !== version) return `names package version ${JSON.stringify(report.version ?? null)}, not the installed ${version}`;
  if (!Array.isArray(report.checks) || !report.checks.length) return 'holds no checks';
  return null;
}

function tally(checks) {
  let fail = 0;
  let unanswered = 0;
  for (const check of checks) {
    if (check?.status === 'fail') fail += 1;
    if (check?.status === 'na' && check.blocking) unanswered += 1;
  }
  return { fail, unanswered };
}

// The package's exit code is the contract, and the report is what a person reads. They
// have to agree: a report that disagrees with the exit is a harness fault, not a verdict.
export function verdict({ reportPath, outcome, version }) {
  if (outcome?.signal) return { code: 3, message: `the conformance package was killed by ${outcome.signal}` };
  const exit = outcome?.code;
  if (![0, 1, 3].includes(exit)) {
    return { code: 3, message: `the conformance package exited ${exit ?? '(none)'}, which is not a verdict` };
  }
  const report = readReport(reportPath);
  const problem = reportProblem(report, version);
  if (problem) return { code: 3, message: `the report at ${reportPath} ${problem}` };

  const { fail, unanswered } = tally(report.checks);
  if (exit === 3) return { code: 3, message: `the run could not answer: ${unanswered} unanswered check(s), see ${reportPath}` };
  if (exit === 1) {
    if (!fail) return { code: 3, message: `the package exited 1 but ${reportPath} names no failed check` };
    return { code: 1, message: null };
  }
  if (fail || unanswered) {
    return { code: 3, message: `the package exited 0 but ${reportPath} names ${fail} failed and ${unanswered} unanswered check(s)` };
  }
  return { code: 0, message: null };
}

export async function main({
  env = process.env,
  cwd = process.cwd(),
  argv = process.argv.slice(2),
  log = console,
  fixture = path.join(cwd, FIXTURE),
  start = startFixture,
  run = runPackage,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log.error(`[conformance] ${error.message}`);
    return 3;
  }
  const { engine, attach } = options;

  let scratch = '';
  let session = null;
  let token = '';
  let code = 3;
  try {
    const reportPath = path.resolve(cwd, env.CONFORMANCE_REPORT || REPORT_DEFAULT);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    rmSync(reportPath, { force: true });

    const dir = packageDir(cwd);
    let root;
    let baseURL;
    if (attach) {
      // The host is already serving: its root is the only thing this run may write to, and
      // the probe goes there because the HTTP engine reads it from the served folder.
      root = attach.root;
      baseURL = attach.url;
      writeFileSync(path.join(root, PROBE), PROBE_HTML);
    } else {
      const page = readFileSync(path.join(dir, 'page', 'host-test.html'));
      scratch = mkdtempSync(path.join(os.tmpdir(), 'hyperclay-local-conformance-'));
      session = await start({ cwd, scratch, fixture, env });
      token = session.control.token;
      await seed({
        control: session.control,
        root: ROOT_ID,
        files: [[PAGE, page], [PROBE, Buffer.from(PROBE_HTML, 'utf8')]],
      });
      root = session.root;
      baseURL = session.url;
    }

    const outcome = await run({
      cwd, env, dir, baseURL, root, engine, reportPath,
      page: attach?.page, doc: attach?.doc, target: attach?.target,
    });
    const answer = verdict({ reportPath, outcome, version: packageVersion(dir) });
    if (answer.message) log.error(`[conformance] ${scrub(answer.message, token)}`);
    code = answer.code;
  } catch (error) {
    log.error(`[conformance] ${scrub(error?.message || String(error), token)}`);
    code = 3;
  } finally {
    // Teardown cannot change a verdict, and the scratch root is this run's alone: the
    // host repo, the report and the package install are all outside it. A run that could
    // not answer keeps its folder, because the fixture's log is the only witness to why.
    try {
      if (session?.stop) await session.stop();
    } catch {
      // stop() resolves once the child is gone; a teardown error cannot change a verdict.
    }
    if (scratch && code === 3) {
      const logPath = session?.logPath ?? path.join(scratch, 'fixture.log');
      const tail = scrub(readTail(logPath), token);
      log.error(`[conformance] the fixture log is ${logPath}${tail ? `:\n${tail}` : ' (empty)'}`);
    } else if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return code;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = await main();
