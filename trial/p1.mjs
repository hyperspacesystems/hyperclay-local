#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PAGE, PROBE, PROBE_HTML, READY_TIMEOUT_MS, REQUIRED_EXTENSIONS, STOP_GRACE_MS,
  assertManifest, fixtureArgs, packageArgs, packageDir, seed, stopFixture, waitForManifest,
} from '../scripts/conformance.mjs';
import { DROPBOX_ROOT, GITHUB_ROOT, LOCAL_APPS, isInside, realOrNearest } from './setup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARBALL = path.join(REPO, 'vendor', 'host-conformance.tgz');
const WAIVERS_DEFAULT = path.join(REPO, 'trial', 'trial-waivers.json');
const TARGETS = ['local', 'go'];

// AD1: the Go trial host may leave out these extensions while it is being built. The
// list is subtracted from Local's own, so the trial can never ask for less than Local
// does anywhere else.
export const ALLOWED_DIFFERENCE = ['format', 'scoped-stylesheet', 'presence'];

export const GO_EXTENSIONS = REQUIRED_EXTENSIONS.filter(
  (name) => !ALLOWED_DIFFERENCE.includes(name) && !name.startsWith('live-'),
);

class Infrastructure extends Error {}

const remaining = (deadline) => Math.max(deadline - Date.now(), 0);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function parseArgs(argv) {
  const options = {
    target: null, goBin: null, report: null, waivers: WAIVERS_DEFAULT, skipLocalGate: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const [name, inline] = flag.startsWith('--') && flag.includes('=')
      ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)]
      : [flag, undefined];
    if (name === '--skip-local-gate') {
      options.skipLocalGate = true;
      continue;
    }
    if (name !== '--target' && name !== '--go-bin' && name !== '--report' && name !== '--waivers') {
      throw new Error(`unknown argument ${flag} (this trial takes --target local|go, --go-bin, --report, --waivers, --skip-local-gate)`);
    }
    const value = inline ?? argv[(i += 1)];
    if (typeof value !== 'string' || !value) throw new Error(`${name} needs a value`);
    if (name === '--target') options.target = value;
    else if (name === '--go-bin') options.goBin = value;
    else if (name === '--report') options.report = value;
    else options.waivers = value;
  }
  if (!TARGETS.includes(options.target)) throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
  if (!options.report) throw new Error('--report is required');
  if (options.target === 'go' && !options.goBin) throw new Error('--target go needs --go-bin');
  return options;
}

export function waiverCount(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Infrastructure(`cannot read the waiver file ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Infrastructure(`the waiver file ${file} is not JSON: ${error.message}`);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.waivers)) {
    throw new Infrastructure(`the waiver file ${file} needs {"version":1,"waivers":[...]}`);
  }
  return parsed.waivers.length;
}

export function makeRoots({ tmp = os.tmpdir() } = {}) {
  const scratch = realpathSync(mkdtempSync(path.join(tmp, 'hyperclay-p1-')));
  for (const parent of [LOCAL_APPS, GITHUB_ROOT, DROPBOX_ROOT].map(realOrNearest)) {
    if (isInside(scratch, parent)) {
      throw new Infrastructure(`the scratch folder ${scratch} is inside ${parent}`);
    }
  }
  const roots = ['root-a', 'root-b'].map((id) => {
    const dir = path.join(scratch, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  return { scratch, roots };
}

export function placeDocuments({ dir, root }) {
  writeFileSync(path.join(root, PAGE), readFileSync(path.join(dir, 'page', 'host-test.html')));
  writeFileSync(path.join(root, PROBE), PROBE_HTML);
}

export function startLocal({
  cwd = REPO, scratch, roots, env = process.env, timeoutMs = READY_TIMEOUT_MS, graceMs = STOP_GRACE_MS,
}) {
  const logPath = path.join(scratch, 'fixture.log');
  const manifestPath = path.join(scratch, 'manifest.json');
  writeFileSync(logPath, '');
  const args = [
    ...fixtureArgs({ cwd, scratch }),
    '--root', `root-a=${roots[0]}`,
    '--root', `root-b=${roots[1]}`,
  ];
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
    child, exitPromise, control, graceMs,
  });

  return waitForManifest({ child, exitPromise, manifestPath, timeoutMs }).then((manifest) => {
    const target = assertManifest(manifest);
    control = target.control;
    return {
      url: target.url, root: target.root, control, child, logPath, stop, manifest,
    };
  }).catch(async (error) => {
    await stop();
    throw error instanceof Infrastructure ? error : new Infrastructure(error?.message || String(error));
  });
}

async function waitForReady({
  child, exitPromise, logPath, timeoutMs = READY_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no READY line';
  for (;;) {
    if (exited(child)) {
      const { code, signal } = await exitPromise;
      throw new Infrastructure(`the go host exited before printing READY (${signal ?? `exit ${code}`})`);
    }
    let text = '';
    try {
      text = readFileSync(logPath, 'utf8');
    } catch {
      text = '';
    }
    const match = /^READY (\{.*\})$/m.exec(text);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (error) {
        last = `the READY line is not JSON: ${error.message}`;
      }
    }
    if (remaining(deadline) <= 0) {
      throw new Infrastructure(`the go host printed no READY line within ${timeoutMs}ms (${last})`);
    }
    await wait(Math.min(50, Math.max(remaining(deadline), 1)));
  }
}

export function assertReady(ready, root) {
  const roots = Array.isArray(ready?.roots) ? ready.roots : [];
  const first = roots[0];
  if (roots.length !== 2 || !first) {
    throw new Infrastructure(`the go host's READY line names ${roots.length} root(s), not 2`);
  }
  if (typeof first.url !== 'string') throw new Infrastructure('the go host names no URL for root-0');
  let url;
  try {
    url = new URL(first.url);
  } catch {
    throw new Infrastructure(`the go host names ${JSON.stringify(first.url)} for root-0, which is not a URL`);
  }
  if (url.protocol !== 'http:') {
    throw new Infrastructure(`the go host names ${url.protocol} for root-0, not http`);
  }
  let real;
  try {
    real = realpathSync(first.path);
  } catch (error) {
    throw new Infrastructure(`the go host names no folder for root-0: ${error.message}`);
  }
  if (real !== realpathSync(root)) {
    throw new Infrastructure(`the go host serves ${real} for root-0, not ${root}`);
  }
  return { url: url.href.replace(/\/+$/, ''), root: real };
}

function stopGo({ child, exitPromise, graceMs = STOP_GRACE_MS }) {
  if (exited(child)) return exitPromise.then(() => {});
  try {
    child.stdin.end();
  } catch {
    // A stdin that is already gone is one the host has already stopped on.
  }
  return Promise.race([exitPromise, wait(graceMs).then(() => null)]).then(async (gone) => {
    if (gone) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // A signal to a gone child is the same as a child that has gone.
    }
    const afterTerm = await Promise.race([exitPromise, wait(graceMs).then(() => null)]);
    if (afterTerm) return;
    child.kill('SIGKILL');
    await exitPromise;
  });
}

export function startGo({
  bin, cwd = REPO, scratch, roots, localSource = cwd, env = process.env,
  timeoutMs = READY_TIMEOUT_MS, graceMs = STOP_GRACE_MS,
}) {
  const logPath = path.join(scratch, 'go-host.log');
  writeFileSync(logPath, '');
  const child = spawn(bin, [
    '--root', roots[0],
    '--root', roots[1],
    '--port', '0',
    '--local-source', localSource,
    '--control-fd', '3',
  ], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  });
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    try {
      appendFileSync(logPath, chunk);
    } catch {
      // The READY line already passed through this buffer; a log is only a witness.
    }
  });
  child.stdin.on('error', () => {});
  const secret = randomBytes(32).toString('hex');
  const channel = child.stdio[3];
  if (channel) {
    channel.on('error', () => {});
    channel.write(`${secret}\n`);
    channel.end();
  }
  const stop = () => stopGo({ child, exitPromise, graceMs });
  return waitForReady({ child, exitPromise, logPath, timeoutMs }).then((ready) => {
    const target = assertReady(ready, roots[0]);
    if (typeof ready.control !== 'string' || !ready.control) {
      throw new Infrastructure('the go host names no control URL');
    }
    return { ...target, secret, control: ready.control, readyRoots: ready.roots, child, logPath, stop };
  }).catch(async (error) => {
    await stop();
    throw error instanceof Infrastructure ? error : new Infrastructure(error?.message || String(error));
  });
}

export function trialPackageArgs({
  dir, baseURL, root, reportPath, extensions, waivers,
}) {
  const args = packageArgs({
    dir, baseURL, root, engine: 'all', reportPath,
  });
  args[args.indexOf('--require-extensions') + 1] = extensions.join(',');
  args.splice(args.indexOf('--report'), 0, '--waivers', waivers);
  return args;
}

function runChild({ cwd, env, args }) {
  const child = spawn(process.execPath, args, {
    cwd, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Infrastructure(`a child process could not start: ${error.message}`)));
    child.on('exit', (code, signal) => resolve(signal ? { signal } : { code: code ?? 3 }));
  });
}

export function judge({
  packageExit, packageSignal, waivers, gateProblem,
}) {
  if (packageSignal) {
    return { verdict: 'could-not-demonstrate', code: 3, message: `the conformance package was killed by ${packageSignal}` };
  }
  if (gateProblem) return { verdict: 'could-not-demonstrate', code: 3, message: gateProblem };
  if (packageExit !== 0 && packageExit !== 1) {
    return { verdict: 'could-not-demonstrate', code: 3, message: `the conformance package exited ${packageExit ?? '(none)'}, which is not a verdict` };
  }
  if (waivers > 0) {
    return { verdict: 'fail', code: 1, message: `the waiver file holds ${waivers} waiver(s); this trial allows none` };
  }
  if (packageExit === 1) {
    return { verdict: 'fail', code: 1, message: 'the conformance package exited 1: see its report' };
  }
  return { verdict: 'pass', code: 0, message: null };
}

export async function main({
  env = process.env,
  cwd = REPO,
  argv = process.argv.slice(2),
  log = console,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log.error(`[p1] ${error.message}`);
    return 3;
  }
  const reportPath = path.resolve(cwd, options.report);
  const packageReport = path.join(
    path.dirname(reportPath),
    `${path.basename(reportPath, path.extname(reportPath))}.package.json`,
  );
  const report = {
    target: options.target,
    engine: 'all',
    package: { version: null, tarballSha256: null },
    waivers: null,
    packageExit: null,
    packageReport,
    localGateExit: null,
    verdict: 'could-not-demonstrate',
  };

  let scratch = '';
  const stops = [];
  let outcome = { verdict: 'could-not-demonstrate', code: 3, message: null };
  try {
    const dir = packageDir(cwd);
    report.package.version = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    report.package.tarballSha256 = sha256File(TARBALL);
    report.waivers = waiverCount(options.waivers);

    const made = makeRoots();
    scratch = made.scratch;
    const { roots } = made;

    mkdirSync(path.dirname(reportPath), { recursive: true });
    rmSync(packageReport, { force: true });

    let session;
    if (options.target === 'local') {
      session = await startLocal({
        cwd, env, scratch, roots,
      });
      await seed({
        control: session.control,
        root: 'root-a',
        files: [
          [PAGE, readFileSync(path.join(dir, 'page', 'host-test.html'))],
          [PROBE, Buffer.from(PROBE_HTML, 'utf8')],
        ],
      });
    } else {
      placeDocuments({ dir, root: roots[0] });
      session = await startGo({
        bin: options.goBin, cwd, env, scratch, roots, localSource: cwd,
      });
    }
    stops.push(session.stop);

    const packageRun = await runChild({
      cwd,
      env,
      args: trialPackageArgs({
        dir,
        baseURL: session.url,
        root: session.root,
        reportPath: packageReport,
        extensions: options.target === 'go' ? GO_EXTENSIONS : REQUIRED_EXTENSIONS,
        waivers: options.waivers,
      }),
    });
    report.packageExit = packageRun.code ?? null;

    let gateProblem = null;
    if (!options.skipLocalGate) {
      const gate = await runChild({
        cwd,
        env,
        args: [path.join(cwd, 'scripts', 'conformance.mjs'), '--engine', 'all'],
      });
      report.localGateExit = gate.code ?? null;
      if (gate.signal) gateProblem = `the pinned Local gate was killed by ${gate.signal}`;
      else if (gate.code !== 0) gateProblem = `the pinned Local gate exited ${gate.code}`;
    }

    outcome = judge({
      packageExit: Number(report.packageExit),
      packageSignal: packageRun.signal,
      waivers: report.waivers,
      gateProblem,
    });
  } catch (error) {
    outcome = { verdict: 'could-not-demonstrate', code: 3, message: error?.message || String(error) };
  } finally {
    for (const stop of stops) {
      try {
        await stop();
      } catch {
        // stop() resolves once the child is gone; teardown cannot change a verdict.
      }
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    report.verdict = outcome.verdict;
    try {
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      log.error(`[p1] cannot write ${reportPath}: ${error.message}`);
      outcome = { verdict: 'could-not-demonstrate', code: 3, message: outcome.message };
    }
  }
  if (outcome.message) log.error(`[p1] ${outcome.message}`);
  return outcome.code;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = await main();
