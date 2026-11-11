#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_APPS, isInside, realOrNearest } from './setup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'trial', 'test', 'fixtures', 'p3-root');
const GOLDENS = [
  ['serve-golden', 'serve'],
  ['meta-golden', 'meta'],
  ['api-golden', 'api'],
  ['upload-golden', 'uploads-case'],
];
const STORES = new Set(['.hyperclay/blockeditor-state', '.hyperclay/api-v2']);
// P2 judges uploads only under `uploads/`, so the root carries real upload bytes
// there: binary, text, a stylesheet, a nested folder and a Unicode name, each
// copied from a serve-golden file. [serve-golden path, path under uploads/]
const UPLOADS = [
  ['img.png', 'img.png'],
  ['x.svg', 'x.svg'],
  ['style.css', 'style.css'],
  ['folder/notes.txt', 'notes/notes.txt'],
  ['folder/sub/deep/note.txt', 'café-notes.txt'],
];

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function entriesOf(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
}

// The bytes are copied, never read and rewritten: P2 compares the two hosts on
// exactly these files, so a re-encoded copy would compare a root nobody has.
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

export function buildSyntheticRoot({ out, htmlclay } = {}) {
  if (typeof out !== 'string' || !out) throw new Error('--out is required');
  if (typeof htmlclay !== 'string' || !htmlclay) throw new Error('--htmlclay is required');

  const outReal = realOrNearest(out);
  if (isInside(outReal, realOrNearest(LOCAL_APPS))) {
    throw new Error(`refusing to build a synthetic root inside LOCAL_APPS (${LOCAL_APPS})`);
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

  const written = new Set();
  const put = (from, rel) => {
    if (written.has(rel)) throw new Error(`two sources want the same path: ${rel}`);
    copyFile(from, path.join(outReal, rel));
    written.add(rel);
  };

  const visitFixture = (dir, rel) => {
    for (const entry of entriesOf(dir)) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visitFixture(abs, relPath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`refusing to copy non-regular entry: ${abs}`);
      put(abs, relPath);
    }
  };
  visitFixture(FIXTURE, '');

  for (const [name, prefix] of GOLDENS) {
    const root = path.join(htmlclay, 'internal', 'managedtrial', 'testdata', name, 'root');
    if (!fs.existsSync(root)) throw new Error(`the golden root is missing: ${root}`);
    const visit = (dir, rel) => {
      for (const entry of entriesOf(dir)) {
        const abs = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          visit(abs, relPath);
          continue;
        }
        if (!entry.isFile()) throw new Error(`refusing to copy non-regular entry: ${abs}`);
        const segments = relPath.split('/');
        if (segments.includes('node_modules')) continue;
        if (segments[0] === '.hyperclay' && STORES.has(`${segments[0]}/${segments[1]}`)) {
          if (segments.length < 3) throw new Error(`stored state is a directory, not a file: ${abs}`);
          put(abs, `${segments[0]}/${segments[1]}/${prefix}/${segments.slice(2).join('/')}`);
          continue;
        }
        if (segments.some((segment) => segment.startsWith('.'))) continue;
        put(abs, `${prefix}/${relPath}`);
      }
    };
    visit(root, '');
  }

  const serveRoot = path.join(htmlclay, 'internal', 'managedtrial', 'testdata', 'serve-golden', 'root');
  for (const [from, to] of UPLOADS) put(path.join(serveRoot, ...from.split('/')), `uploads/${to}`);

  return { root: outReal, files: [...written].sort() };
}

function parseArgs(argv) {
  const options = { out: null, htmlclay: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--out') options.out = value;
    else if (flag === '--htmlclay') options.htmlclay = value;
    else throw new Error(`unknown argument: ${flag} (this script takes --out, --htmlclay)`);
  }
  if (!options.out) throw new Error('--out is required');
  if (!options.htmlclay) throw new Error('--htmlclay is required');
  return options;
}

function main() {
  try {
    const built = buildSyntheticRoot(parseArgs(process.argv.slice(2)));
    console.log(`synthetic root: ${built.files.length} files at ${built.root}`);
  } catch (error) {
    console.error(`[synthetic-root] ${error.message}`);
    process.exitCode = 2;
  }
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main();
