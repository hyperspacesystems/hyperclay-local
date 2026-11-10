#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCAL_APPS, realOrNearest, isInside } from './setup.mjs';

const IDENTITY_ATTRIBUTES = ['htmlclayid', 'savetoken', 'documentetag'];
const SKIP_DIRS = new Set(['.hyperclay', '.trash']);

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseBefore(text) {
  const entries = new Map();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const match = /^([0-9a-fA-F]{64})  (.*)$/.exec(raw);
    if (!match) throw new Error(`bad line in before.sha256: ${raw}`);
    let rel = match[2];
    if (rel.startsWith('./')) rel = rel.slice(2);
    entries.set(rel, match[1].toLowerCase());
  }
  return entries;
}

function parseIntended(text) {
  const exact = new Set();
  const folders = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const rel = line.startsWith('./') ? line.slice(2) : line;
    if (rel.endsWith('/')) folders.push(rel);
    else exact.add(rel);
  }
  return { exact, folders };
}

function isCovered(rel, intended) {
  if (intended.exact.has(rel)) return true;
  return intended.folders.some((folder) => rel.startsWith(folder));
}

function walkRoot(root) {
  const files = [];
  const nonRegular = [];
  const visit = (absDir, segments) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort(byName)) {
      const segs = [...segments, entry.name];
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(abs, segs);
        continue;
      }
      if (entry.isFile()) {
        files.push(segs.join('/'));
        continue;
      }
      nonRegular.push({
        path: segs.join('/'),
        detail: entry.isSymbolicLink() ? 'symlink' : 'non-regular entry',
      });
    }
  };
  visit(root, []);
  return { files, nonRegular };
}

function findTagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function parseAttributeNames(inner) {
  const names = new Set();
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (/\s/.test(ch) || ch === '/') {
      i += 1;
      continue;
    }
    const start = i;
    while (i < inner.length && !/[\s=/>]/.test(inner[i])) i += 1;
    const name = inner.slice(start, i).toLowerCase();
    if (name) names.add(name);
    while (i < inner.length && /\s/.test(inner[i])) i += 1;
    if (inner[i] !== '=') continue;
    i += 1;
    while (i < inner.length && /\s/.test(inner[i])) i += 1;
    const quote = inner[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      while (i < inner.length && inner[i] !== quote) i += 1;
      if (i < inner.length) i += 1;
      continue;
    }
    while (i < inner.length && !/[\s>]/.test(inner[i])) i += 1;
  }
  return names;
}

function rootAttributes(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) return new Set();
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return new Set();
      i = end + 3;
      continue;
    }
    const lead = text[lt + 1] || '';
    if (lead === '!' || lead === '?' || lead === '/') {
      const end = findTagEnd(text, lt + 1);
      if (end === -1) return new Set();
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    while (j < text.length && /[A-Za-z0-9-]/.test(text[j])) j += 1;
    const name = text.slice(lt + 1, j).toLowerCase();
    const end = findTagEnd(text, j);
    if (end === -1) return new Set();
    if (name === 'html') return parseAttributeNames(text.slice(j, end));
    i = end + 1;
  }
  return new Set();
}

function identityAttributes(file) {
  const names = rootAttributes(fs.readFileSync(file, 'utf8'));
  return IDENTITY_ATTRIBUTES.filter((name) => names.has(name));
}

function isDocument(rel) {
  return /\.(html|htmlclay)$/i.test(rel);
}

function isOutsideState(rel) {
  return !SKIP_DIRS.has(rel.split('/')[0]);
}

function refuseInsideLocalApps(label, target) {
  const real = realOrNearest(target);
  if (isInside(real, LOCAL_APPS)) {
    throw new Error(`refusing ${label} ${real}: it is inside LOCAL_APPS (${LOCAL_APPS})`);
  }
}

function requireFile(label, target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`${label} does not exist: ${target}`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${target}`);
}

function requireDirectory(label, target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`${label} does not exist: ${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${target}`);
}

export function checkIntegrity({ before, root, intended, reference } = {}) {
  for (const [label, value] of Object.entries({ before, root, intended, reference })) {
    if (typeof value !== 'string' || !value) throw new Error(`--${label} is required`);
  }
  const beforePath = path.resolve(before);
  const rootDir = path.resolve(root);
  const intendedPath = path.resolve(intended);
  const referenceDir = path.resolve(reference);

  refuseInsideLocalApps('--root', rootDir);
  refuseInsideLocalApps('--reference', referenceDir);

  requireFile('--before', beforePath);
  requireFile('--intended', intendedPath);
  requireDirectory('--root', rootDir);
  requireDirectory('--reference', referenceDir);

  const beforeEntries = parseBefore(fs.readFileSync(beforePath, 'utf8'));
  const intendedEdits = parseIntended(fs.readFileSync(intendedPath, 'utf8'));

  const violations = [];

  const changed = [];
  const removed = [];
  for (const [rel, expected] of beforeEntries) {
    const abs = path.join(rootDir, ...rel.split('/'));
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      removed.push(rel);
      continue;
    }
    if (!stat.isFile() || sha256File(abs) !== expected) changed.push(rel);
  }

  const { files, nonRegular } = walkRoot(rootDir);
  const beforePaths = new Set(beforeEntries.keys());
  const added = files.filter((rel) => !beforePaths.has(rel));

  for (const entry of nonRegular) {
    violations.push({ kind: 'non-regular', path: entry.path, detail: entry.detail });
  }

  let covered = 0;
  for (const [kind, list] of [['changed', changed], ['removed', removed], ['added', added]]) {
    for (const rel of list) {
      if (isCovered(rel, intendedEdits)) {
        covered += 1;
        continue;
      }
      const detail = kind === 'changed' ? 'content differs from before.sha256'
        : kind === 'removed' ? 'file is missing'
          : 'file is not in before.sha256';
      violations.push({ kind, path: rel, detail });
    }
  }

  for (const rel of files) {
    if (!isDocument(rel) || !isOutsideState(rel)) continue;
    const abs = path.join(rootDir, ...rel.split('/'));
    const inB = identityAttributes(abs);
    if (!inB.length) continue;
    let inC = [];
    const refAbs = path.join(referenceDir, ...rel.split('/'));
    if (fs.existsSync(refAbs) && fs.statSync(refAbs).isFile()) inC = identityAttributes(refAbs);
    for (const attribute of inB) {
      if (inC.includes(attribute)) continue;
      violations.push({
        kind: 'identity-attribute',
        path: rel,
        detail: `${attribute} on the root element (absent in the reference copy)`,
      });
    }
  }

  violations.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  return {
    pass: violations.length === 0,
    counts: {
      checked: beforeEntries.size,
      changed: changed.length,
      removed: removed.length,
      added: added.length,
      covered,
    },
    violations,
  };
}

function parseArgs(argv) {
  const valued = new Set(['--before', '--root', '--intended', '--reference', '--out']);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!valued.has(token)) return { error: `unknown argument: ${token}` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `${token} needs an argument` };
    args[token.slice(2)] = value;
    i += 1;
  }
  for (const name of ['before', 'root', 'intended', 'reference']) {
    if (!args[name]) return { error: `missing --${name}` };
  }
  return { args };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  let report;
  try {
    report = checkIntegrity(parsed.args);
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(2);
  }
  const out = parsed.args.out
    ? path.resolve(parsed.args.out)
    : path.join(path.dirname(path.resolve(parsed.args.intended)), 'p5.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const violation of report.violations) {
    console.log(`${violation.kind} ${violation.path}: ${violation.detail}`);
  }
  if (report.pass) {
    console.log('P5 PASS');
    process.exit(0);
  }
  console.log(`P5 FAIL ${report.violations.length} violations`);
  process.exit(1);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === self;
  }
}

if (isMainModule()) main();
