#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup } from './setup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = path.join(REPO, 'trial', 'driver.cjs');
const GUARD = path.join(REPO, 'trial', 'fs-guard.cjs');
const LABELS = ['go', 'baseline', 'canary'];
const COMMIT_KINDS = new Set([
  'browser-save', 'data-api', 'restore', 'guard-restore', 'external-rebase', 'create', 'sync-download',
]);
const NOT_RUN = 'not-run (needs the box)';

function parseArgs(argv) {
  const options = {
    run: null, source: null, goBin: null, localSource: null, serverUrl: null, apiKeyFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--run') options.run = value;
    else if (flag === '--source') options.source = value;
    else if (flag === '--go-bin') options.goBin = value;
    else if (flag === '--local-source') options.localSource = value;
    else if (flag === '--server-url') options.serverUrl = value;
    else if (flag === '--api-key-file') options.apiKeyFile = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.run) throw new Error('--run is required');
  if (!options.source) throw new Error('--source is required');
  if (!options.goBin) throw new Error('--go-bin is required');
  if (!options.localSource) throw new Error('--local-source is required');
  if (Boolean(options.serverUrl) !== Boolean(options.apiKeyFile)) {
    throw new Error('--server-url and --api-key-file are given together or not at all');
  }
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The copier leaves its first copy read-only, which is P5's premise and not
// P3's: these copies are scratch and have to be removable afterwards.
function makeWritable(dir) {
  const open = (target) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o755);
      for (const entry of fs.readdirSync(target)) open(path.join(target, entry));
    } else if (stat.isFile()) {
      fs.chmodSync(target, 0o644);
    }
  };
  open(dir);
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function runDriver({ label, runDir, copies, args }) {
  const logPath = path.join(runDir, label, 'driver.log');
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require=${GUARD}`,
    FS_GUARD_ROOTS: JSON.stringify(copies),
    FS_GUARD_OUT: path.join(runDir, label, 'driver', 'fs-guard.json'),
  };
  const child = spawnSync(process.execPath, [
    DRIVER,
    '--run', path.join(runDir, label, 'driver'),
    '--root', copies[0],
    '--root', copies[1],
    ...args,
  ], { env, encoding: 'utf8', timeout: 900000 });
  fs.writeFileSync(logPath, `${child.stdout || ''}${child.stderr || ''}`);
  return { status: child.status, signal: child.signal, logPath };
}

function makeRun(options, runDir, label, mode, extraArgs) {
  const labelDir = path.join(runDir, label);
  const made = setup({ src: options.source, run: labelDir, log: () => {} });
  const copies = [path.join(made.runDir, 'B'), path.join(made.runDir, 'A')];
  makeWritable(path.join(made.runDir, 'C'));
  const driven = runDriver({ label, runDir, copies, args: extraArgs });
  return {
    label,
    mode,
    args: extraArgs,
    copies,
    driverExit: driven.status,
    driverSignal: driven.signal,
    log: driven.logPath,
    fsGuard: readJson(path.join(runDir, label, 'driver', 'fs-guard.json')),
    writers: readJson(path.join(runDir, label, 'driver', 'writers.json')),
    counts: readJson(path.join(runDir, label, 'driver', 'adapter-counts.json')),
    canary: readJson(path.join(runDir, label, 'driver', 'canary.json')),
  };
}

function covers(edit, target) {
  if (edit.endsWith('/')) return target.startsWith(edit);
  return target === edit;
}

function forbiddenPaths(guard) {
  const entries = guard && Array.isArray(guard.forbidden) ? guard.forbidden : [];
  return entries.map((entry) => entry.path);
}

function coveredBy(forbidden, edits) {
  return forbidden.some((target) => edits.some((edit) => covers(edit, target)));
}

function judge({ runs }) {
  const problems = [];
  const controlProblems = [];
  const pending = [];
  const notRun = [];
  const go = runs.go;
  const baseline = runs.baseline;
  const canary = runs.canary;

  if (!go.fsGuard || !baseline.fsGuard || !canary.fsGuard) {
    const missing = [go, baseline, canary].filter((run) => !run.fsGuard).map((run) => run.label);
    controlProblems.push(`the guard wrote no fs-guard.json for: ${missing.join(', ')}`);
  }

  const canaryPaths = forbiddenPaths(canary.fsGuard);
  const canaryName = canary.canary && canary.canary.path ? canary.canary.path : 'canary.html';
  if (!canaryPaths.includes(canaryName)) {
    controlProblems.push(`the canary run lists no write to ${canaryName}`);
  }

  const baselineWriters = baseline.writers && Array.isArray(baseline.writers.writers)
    ? baseline.writers.writers
    : [];
  const baselineForbidden = forbiddenPaths(baseline.fsGuard);
  if (baselineForbidden.length === 0) {
    controlProblems.push('the baseline run lists no forbidden write at all');
  }
  const nodeWriters = baselineWriters.filter((writer) => writer.origin === 'node'
    && writer.kind !== 'external-rebase'
    && writer.outcome === 'committed');
  for (const writer of nodeWriters) {
    const edits = Array.isArray(writer.edits) ? writer.edits : [];
    if (!coveredBy(baselineForbidden, edits)) {
      controlProblems.push(`the baseline lists no write from the ${writer.kind} caller`);
    }
  }
  const refusedRebase = baselineWriters.find((writer) => writer.kind === 'external-rebase');
  if (refusedRebase && !['refused', 'failed'].includes(refusedRebase.outcome)) {
    controlProblems.push(`the in-process external rebase answered ${refusedRebase.outcome}, not a refusal`);
  }

  if (controlProblems.length) {
    return {
      verdict: 'could-not-demonstrate', code: 3, controlProblems, problems, pending, notRun,
    };
  }

  const goForbidden = go.fsGuard.forbidden.length === 0 ? [] : go.fsGuard.forbidden.map((entry) => `${entry.op} ${entry.path}`);
  for (const offender of goForbidden) problems.push(`the Node process wrote ${offender} in the go run`);

  const counts = (go.counts && go.counts.kinds) || {};
  const goWriters = go.writers && Array.isArray(go.writers.writers) ? go.writers.writers : [];
  if (goWriters.length === 0) problems.push('the go run recorded no writer');
  for (const writer of goWriters) {
    if (writer.outcome === NOT_RUN) {
      notRun.push({ kind: writer.kind, reason: writer.reason || NOT_RUN });
      continue;
    }
    if (writer.outcome === 'not-node') continue;
    if (writer.outcome === 'pending') {
      pending.push({ kind: writer.kind, reason: writer.reason || 'pending' });
      continue;
    }
    if (writer.outcome !== 'committed') {
      problems.push(`the ${writer.kind} writer ${writer.outcome}: ${writer.error || writer.reason || 'no reason given'}`);
      continue;
    }
    if (COMMIT_KINDS.has(writer.kind)) {
      const committed = (counts[writer.kind] && counts[writer.kind].committed) || 0;
      if (committed < 1) problems.push(`the ${writer.kind} writer has no committed count in adapter-counts.json`);
      continue;
    }
    if (!writer.evidence) problems.push(`the ${writer.kind} writer has no evidence Go performed it`);
  }

  if (problems.length) {
    return { verdict: 'fail', code: 1, controlProblems, problems, pending, notRun };
  }
  return {
    verdict: notRun.length ? 'pass (sync not run)' : 'pass',
    code: 0,
    controlProblems,
    problems,
    pending,
    notRun,
  };
}

export async function main({
  argv = process.argv.slice(2), log = console, cwd = REPO,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log.error(`[p3] ${error.message}`);
    return 3;
  }
  const runDir = path.resolve(cwd, options.run);
  const source = path.resolve(cwd, options.source);
  const reportPath = path.join(runDir, 'p3.json');
  const report = {
    driver: path.relative(cwd, DRIVER),
    source,
    runs: {},
    verdict: 'could-not-demonstrate',
    code: 3,
  };
  let outcome = { verdict: 'could-not-demonstrate', code: 3, controlProblems: [], problems: [], pending: [], notRun: [] };
  try {
    if (fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0) {
      throw new Error(`--run must be an empty directory: ${runDir} already has entries`);
    }
    fs.mkdirSync(runDir, { recursive: true });

    const goArgs = ['--go-bin', options.goBin, '--local-source', options.localSource, '--host', 'go'];
    if (options.serverUrl) goArgs.push('--server-url', options.serverUrl, '--api-key-file', options.apiKeyFile);
    const runs = {
      go: makeRun(options, runDir, 'go', 'go', goArgs),
      baseline: makeRun(options, runDir, 'baseline', 'in-process', ['--host', 'in-process']),
      canary: makeRun(options, runDir, 'canary', 'go', [...goArgs, '--canary']),
    };
    for (const run of Object.values(runs)) {
      report.runs[run.label] = {
        mode: run.mode,
        args: run.args,
        copies: run.copies.map((copy) => path.relative(cwd, copy)),
        driverExit: run.driverExit,
        driverSignal: run.driverSignal,
        log: path.relative(cwd, run.log),
        forbidden: run.fsGuard ? run.fsGuard.forbidden.length : null,
        writers: run.writers ? run.writers.writers.map((writer) => ({
          kind: writer.kind, outcome: writer.outcome, how: writer.how,
        })) : null,
        counts: run.counts ? run.counts.kinds : null,
      };
    }
    outcome = judge({ runs });
  } catch (error) {
    outcome = {
      verdict: 'could-not-demonstrate',
      code: 3,
      controlProblems: [error?.message || String(error)],
      problems: [],
      pending: [],
      notRun: [],
    };
  }

  report.verdict = outcome.verdict;
  report.code = outcome.code;
  report.controlProblems = outcome.controlProblems;
  report.problems = outcome.problems;
  report.pending = outcome.pending;
  report.notRun = outcome.notRun;
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    log.error(`[p3] cannot write ${reportPath}: ${error.message}`);
    return 3;
  }

  log.log(`[p3] ${report.verdict}`);
  for (const problem of report.controlProblems) log.error(`[p3] control: ${problem}`);
  for (const problem of report.problems) log.error(`[p3] ${problem}`);
  for (const entry of report.pending) log.log(`[p3] pending: ${entry.kind} (${entry.reason})`);
  for (const entry of report.notRun) log.log(`[p3] not run: ${entry.kind} (${entry.reason || NOT_RUN})`);
  return report.code;
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) process.exitCode = await main();
