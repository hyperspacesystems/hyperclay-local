// Nothing writes a document outside the document host. This is the static half
// of the proof: every mutator call in src/main and src/sync-engine is named
// below with a reason and the number of calls it makes. The call-through test
// (document-write-call-through.test.js) is the other half, because a scan cannot
// tell a call that writes the wrong path from one that writes the right path,
// and a runtime trace cannot see a writer no test exercises.
//
// Regenerate the counts with:
//   rg -c "atomicWriteFile\(|handle\.writeFile\(|(fs|fsSync|fsPromises|fsModule)\.(writeFile|appendFile|rename|copyFile|cp|rm|unlink|utimes|truncate|link|symlink)(Sync)?\(" src/main src/sync-engine -g '!src/main/offline-runtime/**'

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['src/main', 'src/sync-engine'].map((dir) => path.join(REPO_ROOT, dir));
const EXCLUDED = path.join(REPO_ROOT, 'src', 'main', 'offline-runtime');

// The one scan. A named primitive on any of the four receivers Node exposes, with
// or without the Sync suffix, plus the two handles that write a document's bytes
// once a file is already open.
const NAMED = ['writeFile', 'appendFile', 'rename', 'copyFile', 'cp', 'rm', 'unlink', 'utimes', 'truncate', 'link', 'symlink'];
const RECEIVERS = ['fs', 'fsSync', 'fsPromises', 'fsModule'];
const SCANNER = new RegExp(
  'atomicWriteFile\\(|handle\\.writeFile\\(|' +
  `(?:${RECEIVERS.join('|')})\\.(${NAMED.join('|')})(?:Sync)?\\(`,
  'g'
);

const primitiveOf = (match) => (
  match.startsWith('atomicWriteFile') ? 'atomicWriteFile'
    : match.startsWith('handle.') ? 'handle.writeFile'
      : match.replace(/^[a-zA-Z]+\./, '').replace(/Sync\($/, '').replace(/\($/, '')
);

function collectFiles(dir, found = []) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) { if (full !== EXCLUDED) collectFiles(full, found); }
    else if (dirent.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function scan() {
  const counts = new Map();
  const primitives = new Map();
  for (const file of SCAN_DIRS.flatMap((dir) => collectFiles(dir))) {
    const source = fs.readFileSync(file, 'utf8');
    const hits = [...source.matchAll(SCANNER)];
    if (!hits.length) continue;
    counts.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), hits.length);
    for (const hit of hits) {
      const name = primitiveOf(hit[0]);
      primitives.set(name, (primitives.get(name) ?? 0) + 1);
    }
  }
  return { counts, primitives };
}

// Every file the scan finds, with why it is allowed to write and how many writes
// it makes. One map: a second one would let a new writer hide in the gap.
const WRITERS = {
  // The document host: the only module that writes a document's bytes.
  'src/main/document-host.js': { count: 13, reason: 'the document host publishes documents through placeBytes, commitExact, commitReplace and commitCreate, moves entries in restructure, and writes the generated stylesheet in refreshTailwind' },
  // The primitive every host write goes through: temp file plus rename.
  'src/main/utils/write-queue.js': { count: 5, reason: 'the atomic write primitive itself: temp file, rename into place, and the directory fsync' },

  // State files: none of these is a document.
  'src/main/page-state-store.js': { count: 6, reason: 'state: the page merge-state sidecar beside a document' },
  'src/main/served-roots-file.js': { count: 2, reason: 'state: the served roots list' },
  'src/main/settings-file.js': { count: 4, reason: 'state: the app settings file' },
  'src/sync-engine/node-map.js': { count: 1, reason: 'state: the sync node map' },
  'src/sync-engine/state/upload-blocks.js': { count: 1, reason: 'state: the per-file upload block list' },
  'src/sync-engine/root-marker.js': { count: 3, reason: 'state: the root marker under .hyperclay' },
  'src/sync-engine/reconcile/conflicts.js': { count: 2, reason: 'state: conflicts.json and the parked remote copy' },
  'src/sync-engine/reconcile/legacy-import.js': { count: 2, reason: 'state: the legacy import record' },
  'src/sync-engine/reconcile/first-bind.js': { count: 3, reason: 'state: the first-bind record' },
  'src/main/workspace/auto-name.js': { count: 1, reason: 'state: the auto-name record under the app data folder' },
  'src/main/workspace/search-worker.js': { count: 2, reason: 'state: the search index cache' },
  'src/main/main.js': { count: 6, reason: 'state: profile and window state under the app data folder' },

  // Sidecars and derived files: written beside a document, never as one.
  'src/main/utils/api-sidecar.js': { count: 2, reason: 'sidecar: the received-data sidecar beside a document' },
  'src/main/utils/derived-artifacts.js': { count: 1, reason: 'derived: the compiled Tailwind stylesheet under .hyperclay' },
  'src/main/server.js': { count: 2, reason: 'derived and uploads: the Tailwind compile on a read, and the wx upload write, whose name cannot end in a document extension' },

  // History and logs: outside every served document path.
  'src/main/utils/backup.js': { count: 4, reason: 'history: version backups under .hyperclay/versions' },
  'src/main/utils/prune-versions.js': { count: 1, reason: 'history: pruning old versions' },
  'src/main/data-loss-guard.js': { count: 3, reason: 'history: the guarded event and recovered copy under .hyperclay/guard' },
  'src/sync-engine/logger.js': { count: 2, reason: 'log: the sync log file' },
  'src/main/error-logger.js': { count: 2, reason: 'log: the error log file' },

  // Structure and non-document bytes.
  'src/sync-engine/reconcile/execute.js': { count: 2, reason: 'the parked remote copy and its removal under .hyperclay/conflicts, and the delete fallback' },
  'src/main/workspace/commands.js': { count: 1, reason: 'workspace: fs.rm of the entries in .trash on empty-trash (mkdir is not a mutator here)' },
  'src/main/export-zip.js': { count: 2, reason: 'export: the zip written beside its final name, then renamed into place' },
  'src/main/helpers/ai-edit.js': { count: 2, reason: 'helper: removing the scratch folder an AI edit ran in' },
  'src/main/helpers/page-tool.js': { count: 3, reason: 'helper: the prompt file and scratch folder a page tool runs in, under os.tmpdir()' },
  'src/main/appimage-update.js': { count: 7, reason: 'update: the AppImage download and swap outside any served root' },
};

const { counts, primitives } = scan();

describe('document write boundary', () => {
  it('scans the tree it claims to scan', () => {
    console.log(`[document-writers] scanned ${counts.size} files, ${[...primitives.values()].reduce((a, b) => a + b, 0)} mutator calls`);
    console.log(`[document-writers] per primitive: ${JSON.stringify(Object.fromEntries([...primitives].sort()))}`);
    expect(counts.size).toBeGreaterThan(20);
  });

  // A regex that has lost a primitive would pass every map check below, because
  // the calls it misses simply do not appear in the scan.
  it('finds every named primitive on every receiver', () => {
    const missed = [];
    for (const name of NAMED) {
      for (const receiver of RECEIVERS) {
        for (const suffix of ['', 'Sync']) {
          const sample = `await ${receiver}.${name}${suffix}(a, b)`;
          if (!sample.match(SCANNER)) missed.push(sample);
        }
      }
    }
    for (const handle of ['atomicWriteFile(', 'handle.writeFile(']) {
      const sample = `await ${handle}path, bytes)`;
      if (!sample.match(SCANNER)) missed.push(sample);
    }
    expect(missed).toEqual([]);
    // Every primitive the tree actually uses has a hit, so a regex that silently
    // stopped matching one of them fails here. `truncate` and `symlink` appear
    // nowhere in src/main or src/sync-engine: their coverage is the sample above.
    expect(primitives.get('atomicWriteFile')).toBeGreaterThan(0);
    expect(primitives.get('handle.writeFile')).toBeGreaterThan(0);
    for (const [name, count] of primitives) expect(`${name}: ${count}`).not.toBe(`${name}: 0`);
    expect([...primitives.keys()]).toEqual(expect.arrayContaining(
      ['writeFile', 'appendFile', 'rename', 'copyFile', 'cp', 'rm', 'unlink', 'utimes', 'link']
    ));
  });

  it('writes documents through documentHost.commit', () => {
    const offenders = [];
    for (const [file, count] of counts) {
      const mapped = WRITERS[file];
      if (!mapped) {
        offenders.push(`${file}: ${count} mutator call(s) not in the map — documents are written through documentHost.commit or restructure`);
      } else if (mapped.count !== count) {
        offenders.push(`${file}: map says ${mapped.count}, found ${count} mutator call(s) — documents are written through documentHost.commit or restructure`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the map from going stale', () => {
    const stale = [];
    for (const [file, mapped] of Object.entries(WRITERS)) {
      const actual = counts.get(file) ?? 0;
      if (actual === 0) stale.push(`${file}: mapped as ${mapped.count} but now makes no mutator call`);
      else if (actual !== mapped.count) stale.push(`${file}: mapped as ${mapped.count} but now makes ${actual}`);
    }
    expect(stale).toEqual([]);
  });

  it('names a reason for every mapped file', () => {
    const unexplained = Object.entries(WRITERS).filter(([, mapped]) => !mapped.reason || mapped.reason.length < 10).map(([file]) => file);
    expect(unexplained).toEqual([]);
  });
});

// The modules the migration left: each writes a document through
// documentHost.commit, and none of them keeps a primitive of its own.
const MIGRATED_MODULES = [
  'src/sync-engine/file-operations.js',
  'src/sync-engine/reconcile/execute.js',
  'src/sync-engine/engine-sse.js',
  'src/sync-engine/engine-uploader.js',
];

const sourceOf = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('the sync engine has no write primitive left', () => {
  it('keeps no writeFile, writeFileBuffer or refreshDerivedArtifacts call', () => {
    const offenders = [];
    for (const file of MIGRATED_MODULES) {
      const source = sourceOf(file);
      for (const marker of ['writeFile(', 'writeFileBuffer(', 'refreshDerivedArtifacts(']) {
        if (source.includes(marker)) offenders.push(`${file}: calls ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('publishes a document only inside writeBytes', () => {
    const source = sourceOf('src/sync-engine/reconcile/execute.js');
    const start = source.indexOf('async function writeBytes');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const calls = (text) => text.split('atomicWriteFile(').length - 1;
    expect(calls(body)).toBeGreaterThan(0);
    expect(calls(source)).toBe(calls(body));
  });
});
