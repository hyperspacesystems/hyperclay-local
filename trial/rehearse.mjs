#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DROPBOX_ROOT, GITHUB_ROOT, LOCAL_APPS, isInside, realOrNearest, setup,
} from './setup.mjs';
import { startGo, startLocal } from './p1.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_COMPARED = 50;
const ORDER = ['P7', 'P1', 'P2', 'P3', 'P5', 'P4'];
const MAX_BUFFER = 64 * 1024 * 1024;

function parseArgs(argv) {
  const options = {
    source: null, htmlclay: null, out: null, allowLocalApps: false, keepCopies: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-local-apps') {
      options.allowLocalApps = true;
      continue;
    }
    if (flag === '--keep-copies') {
      options.keepCopies = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--source') options.source = value;
    else if (flag === '--htmlclay') options.htmlclay = value;
    else if (flag === '--out') options.out = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const name of ['source', 'htmlclay', 'out']) {
    if (!options[name]) throw new Error(`--${name} is required`);
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

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitField(dir, args) {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout : '';
}

function countLines(text) {
  return text.split('\n').filter((line) => line.trim()).length;
}

function walkFiles(dir, segments = []) {
  const found = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const entry of entries) {
    const segs = [...segments, entry.name];
    if (segs.includes('.git') || segs.includes('node_modules') || segs.includes('personal')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(abs, segs));
      continue;
    }
    if (entry.isFile()) found.push(segs.join('/'));
  }
  return found;
}

function removeTree(dir, log) {
  if (!fs.existsSync(dir)) return;
  spawnSync('chmod', ['-R', 'u+w', dir], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  log(`removed copy ${dir}`);
}

export async function rehearse({
  source, htmlclay, out, allowLocalApps = false, keepCopies = false,
} = {}) {
  const sourceReal = realOrNearest(source);
  if (!fs.existsSync(sourceReal) || !fs.statSync(sourceReal).isDirectory()) {
    throw new Error(`--source is not a directory: ${source}`);
  }
  if (!allowLocalApps && isInside(sourceReal, realOrNearest(LOCAL_APPS))) {
    throw new Error(`refusing to read ${sourceReal}: it is inside LOCAL_APPS (${LOCAL_APPS}); pass --allow-local-apps only for an approved trial run`);
  }
  const htmlclayReal = realOrNearest(htmlclay);
  if (!fs.existsSync(htmlclayReal) || !fs.statSync(htmlclayReal).isDirectory()) {
    throw new Error(`--htmlclay is not a directory: ${htmlclay}`);
  }
  const outReal = realOrNearest(out);
  for (const [label, parent] of [
    ['GITHUB_ROOT', realOrNearest(GITHUB_ROOT)],
    ['DROPBOX_ROOT', realOrNearest(DROPBOX_ROOT)],
    ['LOCAL_APPS', realOrNearest(LOCAL_APPS)],
  ]) {
    if (isInside(outReal, parent)) throw new Error(`refusing --out inside ${label} (${parent}); use a temp directory`);
  }
  if (fs.existsSync(outReal)) {
    if (!fs.statSync(outReal).isDirectory()) {
      throw new Error(`--out exists and is not a directory: ${outReal}`);
    }
    if (fs.readdirSync(outReal).length > 0) {
      throw new Error(`--out must be an empty directory: ${outReal} already has entries`);
    }
  }
  if (isInside(sourceReal, outReal) || isInside(outReal, sourceReal)) {
    throw new Error(`--out and --source must not contain one another: ${outReal} / ${sourceReal}`);
  }
  fs.mkdirSync(outReal, { recursive: true });

  const logPath = path.join(outReal, 'rehearse.log');
  const log = (line) => fs.appendFileSync(logPath, `${line}\n`);
  const conditions = {};
  const copies = [];

  const record = (name, entry) => {
    const pass = entry.pass === true;
    conditions[name] = {
      ...entry, exit: entry.exit ?? null, verdict: entry.verdict ?? null, pass,
    };
    log(`${name} exit ${entry.exit ?? '(none)'} verdict ${entry.verdict ?? '(none)'} ${entry.pass ? 'pass' : 'fail'}`);
    if (entry.detail) log(`${name} detail: ${entry.detail}`);
  };

  log(`source: ${sourceReal}`);
  log(`htmlclay: ${htmlclayReal}`);
  log(`out: ${outReal}`);
  log(`allow-local-apps: ${allowLocalApps ? 'yes' : 'no'}`);

  try {
    fs.writeFileSync(
      path.join(outReal, 'source-files.txt'),
      walkFiles(sourceReal).sort().map((rel) => `${rel}\n`).join(''),
    );
  } catch (error) {
    log(`cannot list the source files: ${error.message}`);
  }

  let bin = path.join(outReal, 'bin', 'managed-trial');
  let pins = null;
  try {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const build = spawnSync(
      'go',
      ['build', '-tags', 'managedtrial', '-o', bin, './cmd/managed-trial'],
      { cwd: htmlclayReal, encoding: 'utf8', env: { ...process.env, CGO_ENABLED: '0' } },
    );
    fs.writeFileSync(path.join(outReal, 'build.log'), `${build.stdout || ''}${build.stderr || ''}`);
    log(`build exit ${build.status}`);
    if (build.status !== 0) {
      log('the host binary did not build: stopping the run');
      return { out: outReal, summaries: conditions, pins: null, exitCode: 2 };
    }
    pins = {
      local: {
        head: gitField(REPO, ['rev-parse', 'HEAD']).trim(),
        changed: countLines(gitField(REPO, ['status', '--porcelain'])),
      },
      htmlclay: {
        head: gitField(htmlclayReal, ['rev-parse', 'HEAD']).trim(),
        changed: countLines(gitField(htmlclayReal, ['status', '--porcelain'])),
      },
      binary: { path: bin, sha256: sha256File(bin) },
      node: process.version,
      go: spawnSync('go', ['version'], { encoding: 'utf8' }).stdout.trim(),
      source: sourceReal,
    };
    fs.writeFileSync(path.join(outReal, 'pins.json'), `${JSON.stringify(pins, null, 2)}\n`);
  } catch (error) {
    log(`cannot build the host binary: ${error?.message || String(error)}`);
    return { out: outReal, summaries: conditions, pins: null, exitCode: 2 };
  }

  try {
    const p7 = spawnSync('bash', [path.join(htmlclayReal, 'cmd', 'managed-trial', 'p7.sh')], {
      cwd: htmlclayReal, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    });
    const output = `${p7.stdout || ''}${p7.stderr || ''}`;
    fs.writeFileSync(path.join(outReal, 'p7.log'), output);
    const lines = `${p7.stdout || ''}`.replace(/\s+$/, '').split('\n');
    const lastLine = lines[lines.length - 1] || '';
    record('P7', {
      exit: p7.status,
      verdict: lastLine === 'P7 PASS' ? 'PASS' : 'FAIL',
      pass: p7.status === 0 && lastLine === 'P7 PASS',
      measured: lastLine,
      reading: `last line "${lastLine || '(empty)'}"`,
      detail: `last line: ${lastLine || '(empty)'}`,
    });
  } catch (error) {
    record('P7', { exit: null, verdict: 'could-not-demonstrate', pass: false, detail: error.message });
  }

  try {
    const p1 = spawnSync(process.execPath, [
      path.join(REPO, 'trial', 'p1.mjs'),
      '--target', 'go',
      '--go-bin', bin,
      '--report', path.join(outReal, 'p1.json'),
    ], {
      cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    });
    fs.writeFileSync(path.join(outReal, 'p1.log'), `${p1.stdout || ''}${p1.stderr || ''}`);
    const report = readJson(path.join(outReal, 'p1.json'));
    const verdict = report ? report.verdict : null;
    record('P1', {
      exit: p1.status,
      verdict,
      pass: p1.status === 0 && verdict === 'pass',
      measured: verdict,
    });
  } catch (error) {
    record('P1', { exit: null, verdict: 'could-not-demonstrate', pass: false, detail: error.message });
  }

  let p2Dir = path.join(outReal, 'p2');
  try {
    const work = path.join(outReal, 'p2-work');
    fs.mkdirSync(work, { recursive: true });
    const made = setup({ src: sourceReal, run: p2Dir, allowLocalApps, log });
    p2Dir = made.runDir;
    copies.push(path.join(p2Dir, 'A'), path.join(p2Dir, 'B'), path.join(p2Dir, 'C'));
    const spare = (name) => {
      const dir = path.join(work, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const localScratch = spare('local');
    const goScratch = spare('go');
    let local = null;
    let go = null;
    let differential = null;
    try {
      local = await startLocal({ scratch: localScratch, roots: [path.join(p2Dir, 'A'), spare('local-spare')] });
      go = await startGo({
        bin, scratch: goScratch, roots: [path.join(p2Dir, 'B'), spare('go-spare')], localSource: REPO,
      });
      log(`p2 hosts: local ${local.url} go ${go.url}`);
      differential = spawnSync(process.execPath, [
        path.join(REPO, 'trial', 'differential.mjs'),
        '--a', local.url,
        '--b', go.url,
        '--root', path.join(p2Dir, 'C'),
        '--out', p2Dir,
      ], {
        cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
      });
      fs.writeFileSync(
        path.join(p2Dir, 'differential.log'),
        `${differential.stdout || ''}${differential.stderr || ''}`,
      );
    } finally {
      if (go) {
        try {
          await go.stop();
        } catch {
          // A host that cannot stop is still a host this run no longer uses.
        }
      }
      if (local) {
        try {
          await local.stop();
        } catch {
          // Same.
        }
      }
    }
    const judged = readJson(path.join(p2Dir, 'differences.json'));
    const compared = judged && typeof judged.compared === 'number' ? judged.compared : null;
    const families = judged && Array.isArray(judged.differences)
      ? [...new Set(judged.differences.map((entry) => entry.family))].sort()
      : [];
    const pass = differential.status === 0 && compared !== null && compared >= MIN_COMPARED;
    record('P2', {
      exit: differential.status,
      verdict: pass ? 'pass' : 'fail',
      pass,
      compared,
      families,
      reading: `${compared === null ? 'no' : compared} requests compared (need at least ${MIN_COMPARED})`,
      detail: `compared ${compared === null ? '(none)' : compared}, families with differences: ${families.length ? families.join(', ') : 'none'}`,
    });
  } catch (error) {
    record('P2', { exit: null, verdict: 'could-not-demonstrate', pass: false, detail: error.message });
  }

  const p3Dir = path.join(outReal, 'p3');
  try {
    const p3 = spawnSync(process.execPath, [
      path.join(REPO, 'trial', 'p3.mjs'),
      '--run', p3Dir,
      '--source', sourceReal,
      '--go-bin', bin,
      '--local-source', REPO,
    ], {
      cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    });
    fs.writeFileSync(path.join(outReal, 'p3.log'), `${p3.stdout || ''}${p3.stderr || ''}`);
    const report = readJson(path.join(p3Dir, 'p3.json'));
    const verdict = report ? report.verdict : null;
    const detail = report && Array.isArray(report.controlProblems) && report.controlProblems.length
      ? report.controlProblems[0]
      : null;
    record('P3', {
      exit: p3.status,
      verdict,
      pass: p3.status === 0 && typeof verdict === 'string' && verdict.startsWith('pass'),
      detail,
    });
  } catch (error) {
    record('P3', { exit: null, verdict: 'could-not-demonstrate', pass: false, detail: error.message });
  }
  for (const label of ['go', 'baseline', 'canary']) {
    for (const label2 of ['A', 'B', 'C']) copies.push(path.join(p3Dir, label, label2));
  }

  const goRun = path.join(p3Dir, 'go');
  const p5Runs = {};
  try {
    const before = path.join(goRun, 'before.sha256');
    const intended = path.join(goRun, 'driver', 'intended-edits.txt');
    const reference = path.join(goRun, 'C');
    for (const label of ['B', 'A']) {
      const reportPath = path.join(outReal, `p5-${label}.json`);
      const p5 = spawnSync(process.execPath, [
        path.join(REPO, 'trial', 'p5.mjs'),
        '--before', before,
        '--root', path.join(goRun, label),
        '--intended', intended,
        '--reference', reference,
        '--out', reportPath,
      ], {
        cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
      });
      fs.writeFileSync(path.join(outReal, `p5-${label}.log`), `${p5.stdout || ''}${p5.stderr || ''}`);
      const report = readJson(reportPath);
      p5Runs[label] = {
        exit: p5.status,
        violations: report && Array.isArray(report.violations) ? report.violations.length : null,
      };
    }
    const exits = [p5Runs.B.exit, p5Runs.A.exit];
    const violations = [p5Runs.B.violations, p5Runs.A.violations];
    record('P5', {
      exit: exits.every((code) => code === 0) ? 0 : (exits.find((code) => code !== 0) ?? null),
      verdict: exits.every((code) => code === 0) ? 'pass' : 'fail',
      pass: exits.every((code) => code === 0),
      runs: p5Runs,
      measured: violations.every((count) => count === 0) ? 0 : violations,
      reading: `copy B exit ${p5Runs.B.exit}, copy A exit ${p5Runs.A.exit}`,
      detail: `copy B exit ${p5Runs.B.exit}, copy A exit ${p5Runs.A.exit}`,
    });
  } catch (error) {
    record('P5', { exit: null, verdict: 'could-not-demonstrate', pass: false, detail: error.message });
  }

  try {
    const p4Report = path.join(outReal, 'p4.json');
    const p4 = spawnSync(process.execPath, [
      path.join(REPO, 'trial', 'p4.mjs'),
      '--a', 'local',
      '--b', 'go',
      '--go-bin', bin,
      '--out', p4Report,
    ], {
      cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    });
    fs.writeFileSync(path.join(outReal, 'p4.log'), `${p4.stdout || ''}${p4.stderr || ''}`);
    const report = readJson(p4Report);
    const verdict = report ? report.verdict : null;
    record('P4', {
      exit: p4.status,
      verdict,
      pass: p4.status === 0 && verdict === 'pass',
      measured: verdict,
    });
  } catch (error) {
    record('P4', { exit: null, verdict: 'could-not-demonstrate', pass: false, detail: error.message });
  }

  conditions.P6 = { exit: null, verdict: 'box', pass: null, box: true };
  log('P6 box: runs on the AWS test box, not here');

  const macPass = ORDER.every((name) => conditions[name] && conditions[name].pass === true);
  const exitCode = macPass ? 0 : 1;

  fs.writeFileSync(
    path.join(outReal, 'summary.json'),
    `${JSON.stringify({ pins, conditions }, null, 2)}\n`,
  );

  const md = [];
  const verdictLine = (name) => {
    const entry = conditions[name];
    const reading = entry.reading ?? `verdict ${entry.verdict ?? '(none)'}`;
    return `- ${name}: ${entry.pass ? 'pass' : 'fail'} \u2014 exit ${entry.exit ?? '(none)'}, ${reading}`;
  };
  md.push(`# Rehearsal ${exitCode === 0 ? 'passed' : 'failed'}`, '');
  for (const name of ORDER) md.push(verdictLine(name));
  md.push('- P6: box \u2014 runs on the AWS test box, not here');
  fs.writeFileSync(path.join(outReal, 'summary.md'), `${md.join('\n')}\n`);

  if (!keepCopies) {
    for (const copy of copies) {
      try {
        removeTree(copy, log);
      } catch (error) {
        log(`cannot remove ${copy}: ${error.message}`);
      }
    }
  } else {
    log('--keep-copies: the copies are left in place');
  }

  log(`summary: ${exitCode === 0 ? 'all Mac conditions passed' : 'at least one Mac condition failed'}`);
  return { out: outReal, summaries: conditions, pins, exitCode };
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await rehearse(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`[rehearse] ${error.message}`);
    process.exitCode = 2;
  }
}
