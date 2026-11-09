// A document is written through documentHost.commit, and nowhere else. Every
// module under src/main and src/sync-engine that calls atomicWriteFile is named
// below with the number of calls it makes: the ones writing a document are the
// sites M15 and M16 will migrate, the rest write state files, sidecars or
// derived CSS. Reads the tree itself so two maps cannot hide a new writer.
//
// Regenerate the counts with:
//   rg -c "atomicWriteFile\(" src/main src/sync-engine -g '!src/main/offline-runtime/**'

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['src/main', 'src/sync-engine'].map((dir) => path.join(REPO_ROOT, dir));
const EXCLUDED = path.join(REPO_ROOT, 'src', 'main', 'offline-runtime');
const MARKER = 'atomicWriteFile(';

// Writes that are not a document: state files, sidecars and derived CSS.
const NOT_DOCUMENTS = {
  'src/main/page-state-store.js': 1,
  'src/main/served-roots-file.js': 1,
  'src/main/utils/api-sidecar.js': 1,
  'src/main/utils/derived-artifacts.js': 1,
  'src/main/workspace/auto-name.js': 1,
  'src/sync-engine/node-map.js': 1,
  'src/sync-engine/state/upload-blocks.js': 1,
};

// Every other write site, including the implementation of the primitive itself.
const DIRECT_WRITERS = {
  // The primitive: temp file + rename, no path of its own.
  'src/main/utils/write-queue.js': 1,
  // placeBytes and commitExact write the document; refreshTailwind writes the
  // generated stylesheet.
  'src/main/document-host.js': 3,
  // The one remaining call compiles and writes an auto-generated Tailwind
  // stylesheet under .hyperclay/tailwind/.
  'src/main/server.js': 1,
  'src/main/root-observer.js': 1,
  'src/main/workspace/commands.js': 1,
  'src/sync-engine/file-operations.js': 2,
  'src/sync-engine/reconcile/execute.js': 1,
};

function collectFiles(dir, found = []) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) { if (full !== EXCLUDED) collectFiles(full, found); }
    else if (dirent.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function countCalls(file) {
  return fs.readFileSync(file, 'utf8').split(MARKER).length - 1;
}

function scan() {
  const counts = new Map();
  for (const file of SCAN_DIRS.flatMap((dir) => collectFiles(dir))) {
    const count = countCalls(file);
    if (count > 0) counts.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), count);
  }
  return counts;
}

const counts = scan();

describe('document write boundary', () => {
  it('scans the tree it claims to scan', () => {
    console.log(`[document-writers] scanned ${counts.size} files that write`);
    expect(counts.size).toBeGreaterThan(10);
  });

  it('writes documents through documentHost.commit', () => {
    const offenders = [];
    for (const [file, count] of counts) {
      const expected = DIRECT_WRITERS[file] ?? NOT_DOCUMENTS[file];
      if (expected === undefined) {
        offenders.push(`${file}: ${count} atomicWriteFile call(s) not in either map — documents are written through documentHost.commit`);
      } else if (expected !== count) {
        offenders.push(`${file}: map says ${expected}, found ${count} atomicWriteFile call(s) — documents are written through documentHost.commit`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the maps from going stale', () => {
    const stale = [];
    for (const [file, expected] of Object.entries({ ...NOT_DOCUMENTS, ...DIRECT_WRITERS })) {
      const actual = counts.get(file) ?? 0;
      if (actual === 0) stale.push(`${file}: mapped as ${expected} but now makes no atomicWriteFile calls`);
      else if (actual !== expected) stale.push(`${file}: mapped as ${expected} but now makes ${actual}`);
    }
    expect(stale).toEqual([]);
  });
});
