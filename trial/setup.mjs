#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCAL_APPS = path.join(os.homedir(), 'Documents', 'GitHub', 'hyper', 'LOCAL_APPS');
export const GITHUB_ROOT = path.join(os.homedir(), 'Documents', 'GitHub');
export const DROPBOX_ROOT = path.join(os.homedir(), 'Dropbox');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const COPY_FLAGS = fs.constants.COPYFILE_FICLONE;

export const EXCLUDED = [
  'personal',
  '.git',
  '.hyperclay/*/personal',
  '.hyperclay/versions/journal',
  '.hyperclay/guard/journal.json',
  '.hyperclay/versions/journal-save-test',
  '.hyperclay/guard/journal-save-test.json',
];

function isEmptyGuardRecord(bytes) {
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    return record !== null && typeof record === 'object' && !Array.isArray(record)
      && record.baseline === null && record.event === null;
  } catch {
    return false;
  }
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function realOrNearest(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

// Whether dir holds target; a filesystem root holds every path.
function holds(dir, target) {
  return dir === path.parse(dir).root ? target.startsWith(dir) : isInside(target, dir);
}

function matchesPattern(segments, pattern) {
  const wanted = pattern.split('/');
  if (wanted.length > segments.length) return false;
  for (let i = 0; i < wanted.length; i += 1) {
    if (wanted[i] !== '*' && wanted[i] !== segments[i]) return false;
  }
  return true;
}

function isExcluded(segments, excluded) {
  return excluded.some((pattern) => matchesPattern(segments, pattern));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
}

function collectJournalHashes(src, excluded) {
  const hashes = new Set();
  const visit = (absDir, segments) => {
    for (const entry of listEntries(absDir)) {
      const segs = [...segments, entry.name];
      if (segs.length === 1 && entry.name === '.git') continue;
      const abs = path.join(absDir, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        visit(abs, segs);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!isExcluded(segs, excluded)) continue;
      const bytes = fs.readFileSync(abs);
      if (isEmptyGuardRecord(bytes)) continue;
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (hash !== EMPTY_SHA256) hashes.add(hash);
    }
  };
  visit(src, []);
  return [...hashes].sort();
}

function copyTree(from, to, { excluded = EXCLUDED, onFile = () => {} } = {}) {
  const visit = (fromDir, toDir, segments) => {
    fs.mkdirSync(toDir, { recursive: true });
    for (const entry of listEntries(fromDir)) {
      const segs = [...segments, entry.name];
      if (isExcluded(segs, excluded)) continue;
      const fromPath = path.join(fromDir, entry.name);
      const toPath = path.join(toDir, entry.name);
      const stat = fs.lstatSync(fromPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing to copy symlink: ${fromPath}`);
      }
      if (stat.isDirectory()) {
        visit(fromPath, toPath, segs);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`refusing to copy non-regular entry: ${fromPath}`);
      }
      fs.copyFileSync(fromPath, toPath, COPY_FLAGS);
      fs.utimesSync(toPath, stat.atime, stat.mtime);
      onFile(toPath);
    }
  };
  visit(from, to, []);
}

function makeReadOnly(root) {
  const visit = (absDir) => {
    for (const entry of listEntries(absDir)) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        fs.chmodSync(abs, 0o555);
        continue;
      }
      fs.chmodSync(abs, 0o444);
    }
  };
  visit(root);
  fs.chmodSync(root, 0o555);
}

function findSuspectPaths(root, label) {
  const found = [];
  const visit = (absDir, segments) => {
    for (const entry of listEntries(absDir)) {
      const segs = [...segments, entry.name];
      if (segs.includes('personal') || segs[0] === '.git') {
        found.push(`${label}/${segs.join('/')}`);
      }
      if (entry.isDirectory()) visit(path.join(absDir, entry.name), segs);
    }
  };
  visit(root, []);
  return found;
}

function findMatchingHashes(root, journalHashes) {
  const found = [];
  const visit = (absDir, segments) => {
    for (const entry of listEntries(absDir)) {
      const segs = [...segments, entry.name];
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(abs, segs);
        continue;
      }
      if (!entry.isFile()) continue;
      const hash = sha256File(abs);
      if (journalHashes.has(hash)) {
        found.push({ path: segs.join('/'), sha256: hash });
      }
    }
  };
  visit(root, []);
  return found;
}

export function writeBeforeHashes(copyDir, target) {
  const rows = [];
  const visit = (absDir, segments) => {
    for (const entry of listEntries(absDir)) {
      const segs = [...segments, entry.name];
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(abs, segs);
        continue;
      }
      if (!entry.isFile()) continue;
      rows.push([segs.join('/'), sha256File(abs)]);
    }
  };
  visit(copyDir, []);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const body = rows.map(([rel, hash]) => `${hash}  ./${rel}`).join('\n');
  const content = body.length ? `${body}\n` : '';
  fs.writeFileSync(target, content);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeProof(runDir, proof) {
  const target = path.join(runDir, 'exclusion-proof.json');
  fs.writeFileSync(target, `${JSON.stringify(proof, null, 2)}\n`);
  return target;
}

export function setup({ src, run, allowLocalApps = false, excluded = EXCLUDED, log = () => {} } = {}) {
  if (typeof src !== 'string' || !src) throw new Error('--src is required');
  if (typeof run !== 'string' || !run) throw new Error('--run is required');

  const srcReal = realOrNearest(src);
  const liveReal = realOrNearest(LOCAL_APPS);
  if (srcReal !== liveReal && holds(srcReal, liveReal)) {
    throw new Error(`refusing to read ${srcReal}: it contains LOCAL_APPS (${LOCAL_APPS}), which syncs to hyperclay.com; copy LOCAL_APPS itself with --allow-local-apps, or a folder that does not hold it`);
  }
  if (!allowLocalApps && isInside(srcReal, liveReal)) {
    throw new Error(`refusing to read ${srcReal}: it is inside LOCAL_APPS (${LOCAL_APPS}); pass --allow-local-apps only for an approved trial run`);
  }
  let srcStat;
  try {
    srcStat = fs.statSync(srcReal);
  } catch (error) {
    throw new Error(`--src is not a directory: ${src}`);
  }
  if (!srcStat.isDirectory()) throw new Error(`--src is not a directory: ${src}`);

  const runReal = realOrNearest(run);
  if (isInside(runReal, GITHUB_ROOT)) {
    throw new Error(`refusing --run inside ${GITHUB_ROOT}: the ferried copies would be mirrored into git; use a temp directory`);
  }
  if (isInside(runReal, DROPBOX_ROOT)) {
    throw new Error(`refusing --run inside ${DROPBOX_ROOT}: Dropbox would mirror the copies; use a temp directory`);
  }
  if (fs.existsSync(runReal)) {
    if (!fs.statSync(runReal).isDirectory()) {
      throw new Error(`--run exists and is not a directory: ${runReal}`);
    }
    if (fs.readdirSync(runReal).length > 0) {
      throw new Error(`--run must be an empty directory: ${runReal} already has entries`);
    }
  }
  if (isInside(runReal, srcReal)) throw new Error(`--run must not be inside --src: ${runReal}`);
  if (isInside(srcReal, runReal)) throw new Error(`--src must not be inside --run: ${srcReal}`);

  fs.mkdirSync(runReal, { recursive: true });
  const runDir = fs.realpathSync(runReal);
  log(`source: ${srcReal}`);
  log(`run: ${runDir}`);
  log(`excluded: ${excluded.join(', ')}`);

  const journalHashes = collectJournalHashes(srcReal, excluded);
  fs.writeFileSync(path.join(runDir, 'journal.sha256'), journalHashes.length ? `${journalHashes.join('\n')}\n` : '');
  log(`journal fingerprints: ${journalHashes.length} hashes in journal.sha256`);

  const copyC = path.join(runDir, 'C');
  let fileCount = 0;
  copyTree(srcReal, copyC, { excluded, onFile: () => { fileCount += 1; } });
  log(`copied C: ${fileCount} files`);

  for (const label of ['A', 'B']) {
    copyTree(copyC, path.join(runDir, label), { excluded: [] });
    log(`copied ${label}: from C`);
  }

  makeReadOnly(copyC);
  log('C is read-only');

  const journalSet = new Set(journalHashes);
  const pathsFound = [
    ...findSuspectPaths(copyC, 'C'),
    ...findSuspectPaths(path.join(runDir, 'A'), 'A'),
    ...findSuspectPaths(path.join(runDir, 'B'), 'B'),
  ];
  const hashesFound = findMatchingHashes(copyC, journalSet);
  const proof = {
    excluded: [...excluded],
    journalHashes,
    pathsFound,
    hashesFound,
    pass: pathsFound.length === 0 && hashesFound.length === 0,
  };
  const proofPath = writeProof(runDir, proof);
  log(`proof written: ${proofPath}`);

  if (!proof.pass) {
    fs.writeFileSync(path.join(runDir, 'PROOF-FAILED'), `${JSON.stringify(proof, null, 2)}\n`);
    for (const offender of pathsFound) log(`  excluded path in copy: ${offender}`);
    for (const offender of hashesFound) log(`  journal content in copy: ${offender.path} (${offender.sha256})`);
    log('the copies must not be uploaded; they stay on this Mac only');
    const error = new Error('exclusion proof failed: journal content or excluded paths reached the copies');
    error.code = 'PROOF_FAILED';
    throw error;
  }

  const beforeSha256 = writeBeforeHashes(copyC, path.join(runDir, 'before.sha256'));
  log(`before.sha256 written: ${beforeSha256}`);
  log('exclusion proof passed');

  return { runDir, journalHashes, proof, beforeSha256 };
}

function parseArgs(argv) {
  const options = { src: null, run: null, allowLocalApps: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--src' || arg === '--run') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a directory argument`);
      }
      options[arg === '--src' ? 'src' : 'run'] = value;
      i += 1;
      continue;
    }
    if (arg === '--allow-local-apps') {
      options.allowLocalApps = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    setup({ ...options, log: (line) => console.log(line) });
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
