#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DROPBOX_ROOT, GITHUB_ROOT, LOCAL_APPS, isInside, realOrNearest, setup,
} from './setup.mjs';
import { startLocal } from './p1.mjs';
import { startManaged } from './supervisor.mjs';
import { REQUIRED_EXTENSIONS } from '../scripts/conformance.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_COMPARED = 50;
const MAX_BUFFER = 64 * 1024 * 1024;

function parseArgs(argv) {
  const options = {
    source: null, goBin: null, out: null, allowLocalApps: false, keepCopies: false,
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
    else if (flag === '--go-bin') options.goBin = value;
    else if (flag === '--out') options.out = value;
    else throw new Error(`unknown argument: ${flag} (this script takes --source, --go-bin, --out, --allow-local-apps, --keep-copies)`);
  }
  for (const name of ['source', 'goBin', 'out']) {
    if (!options[name]) throw new Error(`--${name === 'goBin' ? 'go-bin' : name} is required`);
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

function removeTree(dir, log) {
  if (!fs.existsSync(dir)) return;
  spawnSync('chmod', ['-R', 'u+w', dir], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  log(`removed copy ${dir}`);
}

export function judgeP8({ p1, p2, missingExtensions }) {
  const reasons = [];
  const one = p1 ?? {};
  const two = p2 ?? {};
  if (one.exit !== 0) reasons.push(`P1 exit ${one.exit ?? '(none)'}, not 0`);
  if (one.verdict !== 'pass') reasons.push(`P1 verdict ${one.verdict ?? '(none)'}, not pass`);
  if (two.exit !== 0) reasons.push(`differential exit ${two.exit ?? '(none)'}, not 0`);
  if (!(typeof two.compared === 'number' && two.compared >= MIN_COMPARED)) {
    reasons.push(`differential compared ${two.compared ?? '(none)'} request(s), need at least ${MIN_COMPARED}`);
  }
  const allowances = two.allowances ?? {};
  if (allowances.AD1 !== 0) reasons.push(`AD1 applied ${allowances.AD1 ?? '(none)'} time(s), not 0`);
  if (allowances.AD3 !== 0) reasons.push(`AD3 applied ${allowances.AD3 ?? '(none)'} time(s), not 0`);
  const missing = Array.isArray(missingExtensions) ? missingExtensions : [];
  if (missing.length) reasons.push(`${missing.length} required extension(s) missing: ${missing.join(', ')}`);
  return { verdict: reasons.length ? 'FAIL' : 'PASS', reasons };
}

export async function p8({
  source, goBin, out, allowLocalApps = false, keepCopies = false,
} = {}) {
  const sourceReal = realOrNearest(source);
  if (!fs.existsSync(sourceReal) || !fs.statSync(sourceReal).isDirectory()) {
    throw new Error(`--source is not a directory: ${source}`);
  }
  if (!allowLocalApps && isInside(sourceReal, realOrNearest(LOCAL_APPS))) {
    throw new Error(`refusing to read ${sourceReal}: it is inside LOCAL_APPS (${LOCAL_APPS}); pass --allow-local-apps only for an approved trial run`);
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

  const logPath = path.join(outReal, 'p8.log');
  const log = (line) => fs.appendFileSync(logPath, `${line}\n`);
  log(`source: ${sourceReal}`);
  log(`go-bin: ${goBin}`);
  log(`out: ${outReal}`);

  const copies = [];
  let p1 = { exit: null, verdict: null, failing: [] };
  let p2 = {
    exit: null, compared: null, families: [], allowances: null,
  };
  let missingExtensions = [];
  let extraExtensions = [];
  let flushed = null;
  let unexpected = 0;
  let demonstrate = true;

  try {
    const p1Report = path.join(outReal, 'p1.json');
    const run = spawnSync(process.execPath, [
      path.join(REPO, 'trial', 'p1.mjs'),
      '--target', 'managed',
      '--go-bin', goBin,
      '--report', p1Report,
    ], {
      cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    });
    fs.writeFileSync(path.join(outReal, 'p1.log'), `${run.stdout || ''}${run.stderr || ''}`);
    const report = readJson(p1Report);
    const failing = [];
    const packageReportPath = report && typeof report.packageReport === 'string'
      ? report.packageReport
      : p1Report.replace(/\.json$/, '.package.json');
    const packageReport = readJson(packageReportPath);
    if (packageReport && Array.isArray(packageReport.checks)) {
      for (const check of packageReport.checks) {
        if (check && check.status === 'fail') failing.push(check.id);
      }
    }
    const verdict = report ? report.verdict : null;
    p1 = { exit: run.error ? null : run.status, verdict, failing };
    if (run.error || verdict === 'could-not-demonstrate') demonstrate = false;
    log(`P1 exit ${p1.exit} verdict ${verdict} failing ${failing.length}`);
  } catch (error) {
    p1 = { exit: null, verdict: 'could-not-demonstrate', failing: [] };
    demonstrate = false;
    log(`P1 could not run: ${error.message}`);
  }

  const p2Dir = path.join(outReal, 'p2');
  try {
    const work = path.join(outReal, 'p2-work');
    fs.mkdirSync(work, { recursive: true });
    const made = setup({
      src: sourceReal, run: p2Dir, allowLocalApps, log,
    });
    const runDir = made.runDir;
    copies.push(path.join(runDir, 'A'), path.join(runDir, 'B'), path.join(runDir, 'C'));
    const spare = (name) => {
      const dir = path.join(work, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const localScratch = spare('local');
    const managedScratch = spare('managed');
    let local = null;
    let managed = null;
    let differential = null;
    try {
      local = await startLocal({
        scratch: localScratch, roots: [path.join(runDir, 'A'), spare('local-spare')],
      });
      managed = await startManaged({
        bin: goBin, scratch: managedScratch, roots: [path.join(runDir, 'B'), spare('managed-spare')], localSource: REPO,
      });
      log(`p2 hosts: local ${local.url} managed ${managed.url}`);
      const metaAnswer = await fetch(`${managed.url}/_/meta`);
      const meta = await metaAnswer.json();
      const announced = Array.isArray(meta.extensions) ? meta.extensions : [];
      missingExtensions = REQUIRED_EXTENSIONS.filter((name) => !announced.includes(name));
      extraExtensions = announced.filter((name) => !REQUIRED_EXTENSIONS.includes(name));
      log(`extensions: ${announced.length} announced, ${missingExtensions.length} missing, ${extraExtensions.length} extra`);
      differential = spawnSync(process.execPath, [
        path.join(REPO, 'trial', 'differential.mjs'),
        '--a', local.url,
        '--b', managed.url,
        '--root', path.join(runDir, 'C'),
        '--out', runDir,
        '--stage', 'full',
      ], {
        cwd: REPO, encoding: 'utf8', maxBuffer: MAX_BUFFER,
      });
      fs.writeFileSync(
        path.join(runDir, 'differential.log'),
        `${differential.stdout || ''}${differential.stderr || ''}`,
      );
      if (differential.error) throw differential.error;
    } finally {
      if (managed) {
        try {
          await managed.stop();
        } catch {
          // A host that cannot stop is still a host this run no longer uses.
        }
        flushed = managed.flushed ?? null;
      }
      if (local) {
        try {
          await local.stop();
        } catch {
          // Same.
        }
      }
    }
    const judged = readJson(path.join(runDir, 'differences.json'));
    const compared = judged && typeof judged.compared === 'number' ? judged.compared : null;
    const families = judged && Array.isArray(judged.differences)
      ? [...new Set(judged.differences.map((entry) => entry.family))].sort()
      : [];
    const allowances = judged && judged.allowances ? judged.allowances : null;
    unexpected = judged && Array.isArray(judged.differences) ? judged.differences.length : 0;
    p2 = {
      exit: differential.status, compared, families, allowances,
    };
    log(`P2 exit ${differential.status} compared ${compared} families ${families.length ? families.join(', ') : 'none'}`);
  } catch (error) {
    demonstrate = false;
    log(`P2 could not run: ${error.message}`);
  }

  const judged = judgeP8({ p1, p2, missingExtensions });
  let verdict = judged.verdict;
  if (!demonstrate) verdict = 'could-not-demonstrate';
  const exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;

  const document = {
    p1,
    p2,
    missingExtensions,
    extraExtensions,
    flushed,
    verdict,
  };
  fs.writeFileSync(path.join(outReal, 'p8.json'), `${JSON.stringify(document, null, 2)}\n`);

  for (const reason of judged.reasons) log(`fail: ${reason}`);
  if (verdict === 'PASS') {
    console.log(`P8 PASS missingExtensions=${missingExtensions.length} unexpected=${unexpected}`);
  } else if (verdict === 'FAIL') {
    console.log(`P8 FAIL missingExtensions=${missingExtensions.length} unexpected=${unexpected}`);
    for (const reason of judged.reasons) console.log(`  ${reason}`);
  } else {
    console.log(`P8 could-not-demonstrate missingExtensions=${missingExtensions.length} unexpected=${unexpected}`);
  }
  log(`verdict ${verdict} exit ${exitCode}`);

  if (!keepCopies) {
    for (const copy of copies) {
      try {
        removeTree(copy, log);
      } catch (error) {
        log(`cannot remove ${copy}: ${error.message}`);
      }
    }
    try {
      removeTree(path.join(outReal, 'p2-work'), log);
    } catch (error) {
      log(`cannot remove the scratch folders: ${error.message}`);
    }
  } else {
    log('--keep-copies: the copies are left in place');
  }

  return {
    out: outReal, document, verdict, exitCode,
  };
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await p8(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`[p8] ${error.message}`);
    process.exitCode = 2;
  }
}
