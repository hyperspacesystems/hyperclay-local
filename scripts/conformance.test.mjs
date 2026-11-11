import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HOST, PAGE, PROBE, REQUIRED_EXTENSIONS, assertManifest, main, packageArgs, packageDir, parseArgs,
  scrub, startFixture, verdict,
} from './conformance.mjs';

// Everything here drives the launcher with a fake fixture or a fake package: the real
// gate is the all-engine run in CI, and a browser has no business in a unit test. What
// these cover is the part that decides whether a run reached a verdict at all.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIR = packageDir(REPO);
const VERSION = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).version;
const TOKEN = 'b4c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7081';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-launcher-test-'));
}

function rows(statuses) {
  return statuses.map((status, index) => ({
    id: `http.h${index + 1}`,
    title: 'a row',
    engine: 'http',
    status,
    detail: null,
    blocking: status === 'na',
  }));
}

function report({
  checks = rows(['pass']), host = HOST, version = VERSION, schema = 1, packageName = '@panphora/host-conformance',
} = {}) {
  const count = (status) => checks.filter((check) => check.status === status).length;
  const unanswered = checks.filter((check) => check.status === 'na' && check.blocking).length;
  return {
    schema,
    package: packageName,
    version,
    host,
    url: 'http://127.0.0.1:1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    checks,
    summary: {
      pass: count('pass'), fail: count('fail'), skip: count('skip'), waived: 0, unused: 0, unanswered,
    },
    ok: count('fail') === 0 && unanswered === 0,
  };
}

function quiet() {
  const lines = [];
  return { lines, error: (line) => lines.push(String(line)), log: () => {}, warn: () => {} };
}

// The fixture's control endpoint, faked at the HTTP layer only: seeding and stopping go
// over the wire exactly as they do against the real fixture, and nothing here reads back
// a document or boots a host.
async function control() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}

// main's scratch root, a control endpoint that answers, and a package that answers with
// `outcome` plus whatever report it would have written. The fixture boot is replaced, so
// nothing here needs a browser or a real root.
async function run({
  exit = 0, body = report(), reportPath = null, argv = [], start, run: answer,
} = {}) {
  const dir = scratch();
  const log = quiet();
  const server = await control();
  const seen = {
    scratch: null, root: null, url: null, reportPath: reportPath ?? path.join(dir, 'conformance.json'),
  };
  const code = await main({
    cwd: REPO,
    env: { CONFORMANCE_REPORT: seen.reportPath },
    argv,
    log,
    start: start ?? (async ({ scratch: root }) => {
      seen.scratch = root;
      const fixtureRoot = path.join(root, 'root-a');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      seen.url = server.url;
      seen.root = fixtureRoot;
      const logPath = path.join(root, 'fixture.log');
      fs.writeFileSync(logPath, 'fixture: listening\n');
      return {
        url: server.url,
        root: fixtureRoot,
        control: { url: server.url, token: TOKEN },
        logPath,
        stop: async () => {},
      };
    }),
    run: answer ?? (async ({ reportPath: where }) => {
      if (body !== null) fs.writeFileSync(where, JSON.stringify(body));
      return { code: exit };
    }),
  });
  await server.close();
  return {
    code, log, dir, seen, requests: server.requests,
  };
}

test('a package that exits 1 with a failed row stays 1', async () => {
  const outcome = await run({ exit: 1, body: report({ checks: rows(['pass', 'fail']) }) });
  assert.equal(outcome.code, 1);
  assert.deepEqual(outcome.log.lines, []);
});

test('a package that exits 0 with a failed row is a harness fault, not a pass', async () => {
  const outcome = await run({ exit: 0, body: report({ checks: rows(['pass', 'fail']) }) });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /exited 0 .* names 1 failed/);
});

test('a package exit of 1 with no failed row is a harness fault', async () => {
  const outcome = await run({ exit: 1, body: report() });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /exited 1 .* names no failed check/);
});

test('an exit the package never promises is infrastructure', async () => {
  const outcome = await run({ exit: 7 });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /exited 7, which is not a verdict/);
});

test('a signal is infrastructure, never a verdict', async () => {
  const outcome = await run({ run: async () => ({ signal: 'SIGKILL' }) });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /killed by SIGKILL/);
});

test('a missing report is infrastructure', async () => {
  const outcome = await run({ body: null });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /wrote no report/);
});

test('a malformed report is infrastructure', async () => {
  const outcome = await run({
    run: async ({ reportPath: where }) => {
      fs.writeFileSync(where, '{ not json');
      return { code: 0 };
    },
  });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /is not JSON/);
});

test('a report for another host, package or schema is infrastructure', async () => {
  for (const [body, reason] of [
    [report({ host: 'htmlclay' }), /names host "htmlclay"/],
    [report({ schema: 2 }), /names schema 2/],
    [report({ version: '0.0.1' }), /names package version "0.0.1"/],
    [report({ packageName: '@panphora/other' }), /names package "@panphora\/other"/],
    [report({ checks: [] }), /holds no checks/],
  ]) {
    const outcome = await run({ body });
    assert.equal(outcome.code, 3, reason.source);
    assert.match(outcome.log.lines.join('\n'), reason);
  }
});

test('a stale report is removed before the run', async () => {
  const dir = scratch();
  const reportPath = path.join(dir, 'conformance.json');
  fs.writeFileSync(reportPath, JSON.stringify(report()));
  let stale = true;
  const outcome = await run({
    reportPath,
    body: null,
    run: async ({ reportPath: where }) => {
      stale = fs.existsSync(where);
      fs.writeFileSync(where, JSON.stringify(report()));
      return { code: 0 };
    },
  });
  assert.equal(stale, false);
  assert.equal(outcome.code, 0);
});

test('the scratch root is removed after a red verdict and a green one', async () => {
  const red = await run({ exit: 1, body: report({ checks: rows(['fail']) }) });
  assert.equal(red.code, 1);
  assert.ok(red.seen.scratch, 'the launcher made no scratch root');
  assert.equal(fs.existsSync(red.seen.scratch), false);
  const green = await run();
  assert.equal(green.code, 0);
  assert.ok(green.seen.scratch, 'the launcher made no scratch root');
  assert.equal(fs.existsSync(green.seen.scratch), false);
});

test('a run that could not answer keeps its fixture log and says where', async () => {
  const outcome = await run({
    run: async () => {
      throw new Error('the package never started');
    },
  });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /the package never started/);
  assert.ok(outcome.seen.scratch, 'the launcher made no scratch root');
  const kept = fs.readdirSync(outcome.seen.scratch);
  assert.ok(kept.includes('fixture.log'), 'the fixture log is gone');
  assert.ok(outcome.log.lines.join('\n').includes(outcome.seen.scratch), 'the launcher never named the log');
});

test('the package is handed root-a and the folder the fixture serves', async () => {
  let seen = null;
  const outcome = await run({
    run: async (options) => {
      seen = options;
      fs.writeFileSync(options.reportPath, JSON.stringify(report()));
      return { code: 0 };
    },
  });
  assert.equal(outcome.code, 0);
  assert.equal(seen.baseURL, outcome.seen.url);
  assert.equal(seen.root, outcome.seen.root);
});

test('the page and the probe are seeded through the control endpoint', async () => {
  const outcome = await run();
  assert.equal(outcome.code, 0);
  const seeds = outcome.requests.filter((request) => request.url === '/seed');
  assert.equal(seeds.length, 2);
  for (const request of seeds) {
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.parse(request.body).root, 'root-a');
  }
  const bodies = seeds.map((request) => JSON.parse(request.body));
  const page = bodies.find((body) => body.path === PAGE);
  const probe = bodies.find((body) => body.path === PROBE);
  assert.ok(page, 'the package page was never seeded');
  assert.equal(
    Buffer.from(page.base64, 'base64').toString('utf8'),
    fs.readFileSync(path.join(DIR, 'page', 'host-test.html'), 'utf8'),
  );
  assert.ok(probe, 'the probe was never seeded');
  assert.match(Buffer.from(probe.base64, 'base64').toString('utf8'), /Conformance probe/);
});

test('the control bearer token reaches neither the package nor any output', async () => {
  const outcome = await run({ exit: 1, body: report({ checks: rows(['fail']) }) });
  assert.equal(outcome.code, 1);
  let seen = null;
  const second = await run({
    run: async (options) => {
      seen = options;
      fs.writeFileSync(options.reportPath, JSON.stringify(report({ checks: rows(['fail']) })));
      return { code: 1 };
    },
  });
  assert.equal(second.code, 1);
  const printed = [...outcome.log.lines, ...second.log.lines].join('\n');
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(JSON.stringify(seen).includes(TOKEN), false);
  assert.equal(process.execPath.includes(TOKEN), false);
  const args = packageArgs({
    dir: DIR, baseURL: 'http://127.0.0.1:1', root: '/tmp/root-a', engine: 'all', reportPath: '/tmp/report.json',
  });
  assert.equal(args.join(' ').includes(TOKEN), false);
});

test('a fixture failure that quotes a bearer token is redacted', async () => {
  const outcome = await run({
    start: async () => {
      throw new Error(`the control endpoint refused Bearer ${TOKEN}`);
    },
  });
  assert.equal(outcome.code, 3);
  assert.match(outcome.log.lines.join('\n'), /refused Bearer <token>/);
  assert.equal(outcome.log.lines.join('\n').includes(TOKEN), false);
});

test('a fixture that never writes a manifest exits 3 within the deadline', async () => {
  const dir = scratch();
  const fixture = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(fixture, "process.stdout.write('booting\\n');\nsetInterval(() => {}, 1000);\n");
  const log = quiet();
  let root = null;
  const code = await main({
    cwd: REPO,
    env: { CONFORMANCE_REPORT: path.join(dir, 'conformance.json') },
    log,
    fixture,
    start: (options) => startFixture({
      ...options, timeoutMs: 2000, graceMs: 200,
    }),
    run: async () => {
      throw new Error('the package must not run without a host');
    },
  });
  assert.equal(code, 3);
  assert.match(log.lines.join('\n'), /wrote no manifest within 2000ms/);
  assert.match(log.lines.join('\n'), /booting/);
  root = log.lines.join('\n').match(/the fixture log is (\/\S+?)(?::|$)/m)?.[1];
  assert.ok(root, 'the launcher never named the fixture log');
  assert.equal(fs.existsSync(root), true);
});

test('a fixture that exits before writing a manifest is infrastructure', async () => {
  const dir = scratch();
  const fixture = path.join(dir, 'fixture.cjs');
  fs.writeFileSync(fixture, "process.stderr.write('fixture: cannot load the host\\n');\nprocess.exit(4);\n");
  const log = quiet();
  const code = await main({
    cwd: REPO,
    env: { CONFORMANCE_REPORT: path.join(dir, 'conformance.json') },
    log,
    fixture,
    start: (options) => startFixture({ ...options, timeoutMs: 5000, graceMs: 200 }),
    run: async () => {
      throw new Error('the package must not run without a host');
    },
  });
  assert.equal(code, 3);
  assert.match(log.lines.join('\n'), /exited before writing manifest\.json \(exit 4\)/);
  assert.match(log.lines.join('\n'), /cannot load the host/);
});

test('a fixture that names another profile is infrastructure', async () => {
  const dir = scratch();
  const fixture = path.join(dir, 'fixture.cjs');
  const manifest = {
    schema: 1,
    expectedProfile: 'local-minimal',
    roots: [{ id: 'root-a', url: 'http://127.0.0.1:9', fixtureRoot: dir }],
    control: { url: 'http://127.0.0.1:9', token: TOKEN },
  };
  fs.writeFileSync(
    fixture,
    [
      "const fs = require('node:fs');",
      `const manifest = ${JSON.stringify(manifest)};`,
      "const args = process.argv.slice(2);",
      "const at = args.indexOf('--manifest');",
      "fs.writeFileSync(args[at + 1], JSON.stringify(manifest));",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  const log = quiet();
  const code = await main({
    cwd: REPO,
    env: { CONFORMANCE_REPORT: path.join(dir, 'conformance.json') },
    log,
    fixture,
    start: (options) => startFixture({ ...options, timeoutMs: 5000, graceMs: 200 }),
    run: async () => {
      throw new Error('the package must not run against another profile');
    },
  });
  assert.equal(code, 3);
  assert.match(log.lines.join('\n'), /names profile "local-minimal", not local-full/);
});

test('a manifest that names no real root-a is infrastructure', () => {
  const real = {
    schema: 1,
    expectedProfile: 'local-full',
    roots: [
      { id: 'root-b', url: 'http://127.0.0.1:9', fixtureRoot: '/tmp/root-b' },
    ],
    control: { url: 'http://127.0.0.1:8', token: TOKEN },
  };
  assert.throws(() => assertManifest(real), /names no root-a/);
  assert.throws(
    () => assertManifest({ ...real, roots: [{ id: 'root-a', url: 'http://127.0.0.1:9' }] }),
    /names no folder for root-a/,
  );
  assert.throws(() => assertManifest({ ...real, schema: 2 }), /names schema 2, not 1/);
  const rooted = { ...real, roots: [{ id: 'root-a', url: 'http://127.0.0.1:9/', fixtureRoot: '/tmp/root-a' }] };
  assert.throws(
    () => assertManifest({ ...rooted, control: { url: 'http://127.0.0.1:8' } }),
    /names no control endpoint/,
  );
  assert.deepEqual(assertManifest(rooted), {
    url: 'http://127.0.0.1:9', root: '/tmp/root-a', control: real.control,
  });
});

test('the package arguments are the fixed list this host gate runs', () => {
  const args = packageArgs({
    dir: DIR, baseURL: 'http://127.0.0.1:4321', root: '/tmp/root-a', engine: 'all', reportPath: '/tmp/report.json',
  });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], path.join(DIR, 'bin', 'host-conformance.js'));
  assert.equal(value('--engine'), 'all');
  assert.equal(value('--host'), 'hyperclay-local');
  assert.equal(value('--url'), 'http://127.0.0.1:4321');
  assert.equal(value('--root'), '/tmp/root-a');
  assert.equal(value('--page'), '_mhf-host-test.html');
  assert.equal(value('--doc'), '/_conformance-probe.html');
  assert.equal(value('--require-extensions'), REQUIRED_EXTENSIONS.join(','));
  assert.equal(value('--report'), '/tmp/report.json');
  assert.ok(args.includes('--keep'));
  assert.equal(args.includes('--target'), false);
  assert.equal(args.includes('--cookie'), false);
  assert.equal(args.includes('--token'), false);
  assert.equal(args.includes('--token-from-page'), false);
  const attached = packageArgs({
    dir: DIR, baseURL: 'http://127.0.0.1:4321', root: '/tmp/home/apps', engine: 'all', reportPath: '/tmp/report.json',
    page: PAGE, doc: `/${PAGE}`, target: `/${PAGE}`,
  });
  const attachedValue = (flag) => attached[attached.indexOf(flag) + 1];
  assert.equal(attachedValue('--page'), PAGE);
  assert.equal(attachedValue('--doc'), `/${PAGE}`);
  assert.equal(attachedValue('--target'), `/${PAGE}`);
  assert.deepEqual(
    REQUIRED_EXTENSIONS,
    ['conditional', 'data-guard-v1', 'data-read', 'data-write', 'format', 'live-data', 'live-provenance', 'page',
      'page-awareness-v1', 'page-format-v1', 'page-recovery-v1', 'people', 'presence', 'receipts',
      'record-awareness-v1', 'scoped-stylesheet', 'sync', 'sync-worker', 'sync-worker-data', 'upload', 'wire'],
  );
});

test('a verdict never prints the token it was handed', () => {
  assert.equal(scrub(`seeding refused ${TOKEN}`, TOKEN), 'seeding refused <token>');
  assert.equal(scrub(`authorization: Bearer ${TOKEN}`, ''), 'authorization: Bearer <token>');
});

test('--engine and the attach options are the launcher\'s only arguments', async () => {
  const http = await run({ argv: ['--engine', 'http'] });
  assert.equal(http.code, 0);
  const bad = await run({ argv: ['--engine', 'browser'] });
  assert.equal(bad.code, 3);
  assert.match(bad.log.lines.join('\n'), /--engine must be one of all, http, page/);
  const incomplete = await run({ argv: ['--url', 'http://127.0.0.1:4321'] });
  assert.equal(incomplete.code, 3);
  assert.match(incomplete.log.lines.join('\n'), /attach mode needs --root, --page, --doc/);
  const unknown = await run({ argv: ['--bogus'] });
  assert.equal(unknown.code, 3);
  assert.match(unknown.log.lines.join('\n'), /unknown argument --bogus/);
  assert.equal(parseArgs([]).engine, 'all');
  assert.equal(parseArgs(['--engine=page']).engine, 'page');
  assert.equal(parseArgs(['--engine', 'http']).attach, null);
});

test('attach mode uses the supplied host, seeds only its root and skips fixture boot', async () => {
  const dir = scratch();
  const log = quiet();
  const root = path.join(dir, 'apps');
  fs.mkdirSync(root, { recursive: true });
  let seen = null;
  const code = await main({
    cwd: REPO,
    env: { CONFORMANCE_REPORT: path.join(dir, 'conformance.json') },
    argv: ['--url', 'http://127.0.0.1:4321', '--root', root, '--page', PAGE,
      '--doc', `/${PAGE}`, '--target', `/${PAGE}`],
    log,
    start: async () => { throw new Error('attach mode must not start a fixture'); },
    run: async (options) => {
      seen = options;
      fs.writeFileSync(options.reportPath, JSON.stringify(report()));
      return { code: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.baseURL, 'http://127.0.0.1:4321');
  assert.equal(seen.root, root);
  assert.equal(seen.page, PAGE);
  assert.equal(seen.doc, `/${PAGE}`);
  assert.equal(seen.target, `/${PAGE}`);
  assert.deepEqual(fs.readdirSync(root), [PROBE]);
  assert.equal(seen.scratch, undefined);
});

test('the retired jest gate cannot come back', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'tests', 'integration', 'host-gate.test.js')), false);
  const literals = ['HOST_GATE_RUNNER', 'HOST_GATE: "1"'];
  const here = fileURLToPath(import.meta.url);
  const offenders = ['tests', 'scripts', '.github']
    .flatMap((tree) => fs.readdirSync(path.join(REPO, tree), { recursive: true })
      .map((entry) => path.join(REPO, tree, entry)))
    .filter((file) => fs.statSync(file).isFile())
    .filter((file) => file !== here)
    .filter((file) => literals.some((literal) => fs.readFileSync(file, 'utf8').includes(literal)));
  assert.deepEqual(offenders, []);
});

test('verdict maps the package codes it is handed', () => {
  const dir = scratch();
  const reportPath = path.join(dir, 'conformance.json');
  const write = (body) => fs.writeFileSync(reportPath, JSON.stringify(body));
  write(report());
  assert.deepEqual(verdict({ reportPath, outcome: { code: 0 }, version: VERSION }), { code: 0, message: null });
  write(report({ checks: rows(['fail']) }));
  assert.equal(verdict({ reportPath, outcome: { code: 1 }, version: VERSION }).code, 1);
  write(report({ checks: rows(['na']) }));
  assert.equal(verdict({ reportPath, outcome: { code: 3 }, version: VERSION }).code, 3);
});
