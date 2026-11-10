// The runtime half of the document-write proof. It wraps every mutating method
// of require('fs').promises (the same object as require('fs/promises')) and
// records the paths each call touched, then reads back which paths the action
// named by calling a document host's commit, restructure or checkpoint. A
// document path is one under the served root, outside .hyperclay and .trash,
// that ends in .html or .htmlclay, or the temp name atomicWriteFile makes for
// one. A rename of a directory that holds a document counts as a mutation of
// that document, on both the source and the destination.
const fs = require('fs');
const nodePath = require('path');

// method -> the argument index of each path it names. Every two-path mutator
// takes the existing path first and the path it lands on second.
const SHAPES = {
  writeFile: { to: 0 },
  appendFile: { to: 0 },
  utimes: { to: 0 },
  truncate: { to: 0 },
  unlink: { to: 0 },
  rm: { to: 0 },
  rename: { from: 0, to: 1 },
  copyFile: { from: 0, to: 1 },
  cp: { from: 0, to: 1 },
  link: { from: 0, to: 1 },
  symlink: { from: 0, to: 1 },
};

const promises = fs.promises;
const originals = new Map();
let records = [];
let calls = [];
let rootPath = null;
let snapshot = new Set();

for (const [method, indexes] of Object.entries(SHAPES)) {
  const original = promises[method];
  if (typeof original !== 'function') continue;
  originals.set(method, original);
  promises[method] = function recorded(...args) {
    // Outside a begin/stop window nothing is recorded, so the wrapper left on the
    // shared core module is inert for every other test file in this worker.
    if (!rootPath) return original.apply(this, args);
    records.push({
      method,
      from: indexes.from === undefined ? null : args[indexes.from],
      to: indexes.to === undefined ? null : args[indexes.to],
    });
    return original.apply(this, args);
  };
}

const isInside = (file, dir) => file === dir || file.startsWith(dir + nodePath.sep);

// `.page.html.412.7.tmp` beside a document is that document's unpublished bytes.
function documentBehind(file) {
  const base = nodePath.basename(file);
  const match = /^\.(.+\.(?:html|htmlclay))\.\d+\.\d+\.tmp$/i.exec(base);
  return match ? nodePath.join(nodePath.dirname(file), match[1]) : file;
}

function isDocumentPath(file) {
  if (typeof file !== 'string' || !nodePath.isAbsolute(file)) return false;
  if (!rootPath || !isInside(file, rootPath)) return false;
  const relative = nodePath.relative(rootPath, file);
  if (!relative) return false;
  const first = relative.split(nodePath.sep)[0];
  if (first === '.hyperclay' || first === '.trash') return false;
  return /\.(html|htmlclay)$/i.test(documentBehind(file));
}

function walk(dir, found) {
  let dirents;
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const dirent of dirents) {
    const full = nodePath.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === '.hyperclay' || dirent.name === '.trash') continue;
      walk(full, found);
    } else if (isDocumentPath(full)) {
      found.add(full);
    }
  }
  return found;
}

function namedPathsOf(call) {
  const request = call.request ?? {};
  if (call.method === 'restructure') {
    return (request.context?.entries ?? []).flatMap((entry) => [
      entry.from?.location, entry.from?.canonical, entry.to?.canonical,
    ]).filter((file) => typeof file === 'string');
  }
  const named = request.context?.target?.canonicalPath ?? request.filePath;
  return typeof named === 'string' ? [named] : [];
}

// The document paths one host call names, with a directory expanded to the
// documents it holds and to where each of them lands.
function documentsNamedBy(call, pool) {
  const found = new Set();
  if (call.method !== 'restructure') {
    for (const file of namedPathsOf(call)) {
      const document = documentBehind(file);
      if (isDocumentPath(document)) found.add(document);
    }
    return found;
  }
  for (const entry of call.request?.context?.entries ?? []) {
    const from = entry.from?.location;
    const to = entry.to?.canonical;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    const rels = entry.from?.isDir || docRelsUnder(from, pool).length ? docRelsUnder(from, pool) : null;
    if (rels) {
      for (const rel of rels) {
        for (const candidate of [nodePath.join(from, rel), nodePath.join(to, rel)]) {
          if (isDocumentPath(candidate)) found.add(candidate);
        }
      }
    } else {
      for (const candidate of [from, to]) {
        const document = documentBehind(candidate);
        if (isDocumentPath(document)) found.add(document);
      }
    }
  }
  return found;
}

function docRelsUnder(dir, pool) {
  const rels = [];
  for (const doc of pool) {
    if (doc === dir) rels.push('');
    else if (doc.startsWith(dir + nodePath.sep)) rels.push(doc.slice(dir.length + 1));
  }
  return rels;
}

function poolOf() {
  const pool = new Set(snapshot);
  for (const record of records) {
    for (const file of [record.to, record.from]) {
      if (typeof file !== 'string') continue;
      const document = documentBehind(file);
      if (isDocumentPath(document)) pool.add(document);
    }
  }
  for (const call of calls) {
    for (const file of namedPathsOf(call)) {
      const document = documentBehind(file);
      if (isDocumentPath(document)) pool.add(document);
    }
  }
  return pool;
}

function begin(root) {
  rootPath = root;
  records = [];
  calls = [];
  snapshot = walk(root, new Set());
  return { documents: [...snapshot] };
}

function stop() {
  rootPath = null;
}

// A real host, with its publishing methods recorded. The implementation is the
// host's own: the recorder only watches what it was asked to do.
function spy(host) {
  for (const method of ['commit', 'restructure', 'checkpoint', 'pageState']) {
    const original = host[method];
    if (typeof original !== 'function') continue;
    host[method] = async function recordedHostCall(...args) {
      const call = { method, request: args[0], args, result: null, error: null };
      calls.push(call);
      try {
        call.result = await original.apply(this, args);
      } catch (error) {
        call.error = error;
        throw error;
      }
      return call.result;
    };
  }
  return host;
}

const callsTo = (method) => calls.filter((call) => call.method === method);

// The document paths one recorded host call named, a directory expanded to the
// documents it holds and to where each of them lands.
function requestedPaths(call) {
  return [...documentsNamedBy(call, poolOf())];
}
const commitsOfKind = (kind) => callsTo('commit').filter((call) => call.request?.kind === kind);

function documentsTouched() {
  const pool = poolOf();
  const touched = new Set();
  for (const record of records) {
    const [source, destination] = [record.from, record.to];
    if (record.method === 'rename' && typeof source === 'string' && typeof destination === 'string' &&
        !isDocumentPath(source) && docRelsUnder(source, pool).length) {
      for (const rel of docRelsUnder(source, pool)) {
        touched.add(nodePath.join(source, rel));
        const landing = nodePath.join(destination, rel);
        if (isDocumentPath(landing)) touched.add(landing);
      }
      continue;
    }
    for (const file of [source, destination]) {
      if (typeof file !== 'string') continue;
      const document = documentBehind(file);
      if (isDocumentPath(document)) touched.add(document);
    }
  }
  return touched;
}

// Every mutation at a document path has to be one a host call named: a
// publication (temp file renamed into a path a commit named), a move the host
// named on both sides, or a duplicate's copy into the destination it named.
function violations() {
  const pool = poolOf();
  const published = new Set();
  const moved = new Set();
  const copied = new Set();
  for (const call of calls) {
    const named = documentsNamedBy(call, pool);
    if (call.method === 'restructure') {
      for (const document of named) (call.request?.kind === 'duplicate' ? copied : moved).add(document);
    } else {
      for (const document of named) published.add(document);
    }
  }

  const found = [];
  for (const record of records) {
    const destination = typeof record.to === 'string' ? documentBehind(record.to) : null;
    const source = typeof record.from === 'string' ? documentBehind(record.from) : null;

    if (record.method === 'rename' && record.from === record.to) continue;

    // link() gives an inode a second name; symlink() creates a link at `to` to a
    // target that need not exist. Neither is how a document is written here, so
    // either one at a document path is a violation.
    if (record.method === 'link' || record.method === 'symlink') {
      if (isDocumentPath(destination)) {
        found.push(`${record.method} created ${destination}, which no host call named`);
      }
      continue;
    }

    if (record.method === 'rename' && typeof record.to === 'string' && typeof record.from === 'string' &&
        !isDocumentPath(record.from) && docRelsUnder(record.from, pool).length) {
      for (const rel of docRelsUnder(record.from, pool)) {
        const from = nodePath.join(record.from, rel);
        const to = nodePath.join(record.to, rel);
        if (!moved.has(from)) found.push(`rename of the folder ${record.from} moved ${from}, which no host call named`);
        else if (isDocumentPath(to) && !moved.has(to)) found.push(`rename of the folder ${record.from} put ${to}, which no host call named`);
      }
      continue;
    }

    if (record.method === 'rename') {
      if (!isDocumentPath(destination)) {
        if (isDocumentPath(source) && !moved.has(source)) {
          found.push(`rename moved ${source}, which no host call named`);
        }
        continue;
      }
      const temp = typeof record.from === 'string' ? documentBehind(record.from) === destination : false;
      if (temp && published.has(destination)) continue;
      if (moved.has(destination)) continue;
      found.push(`rename wrote ${destination}, which no host call named`);
      continue;
    }

    if (record.method === 'utimes') {
      if (isDocumentPath(destination) && !published.has(destination)) {
        found.push(`utimes touched ${destination}, which no host call named`);
      }
      continue;
    }

    if (record.method === 'copyFile' || record.method === 'cp') {
      if (isDocumentPath(destination) && !copied.has(destination)) {
        found.push(`${record.method} wrote ${destination}, which no host call named`);
      }
      continue;
    }

    if (record.method === 'writeFile') {
      if (isDocumentPath(destination) && !copied.has(destination)) {
        found.push(`writeFile wrote ${destination}, which no host call named`);
      }
      continue;
    }

    if (record.method === 'unlink' || record.method === 'rm' || record.method === 'appendFile' || record.method === 'truncate') {
      if (isDocumentPath(destination)) {
        found.push(`${record.method} changed ${destination}, which no host call named`);
      }
    }
  }
  return found;
}

// The bytes a document ends up with are the bytes its host call said it stored:
// a host action that answered `committed` without writing fails here.
function finalByteMismatches() {
  const found = [];
  for (const call of calls) {
    // A restructure has no stored bytes of its own: its documents are asserted
    // where they land. A checkpoint reports the composed document rather than the
    // file it stored, so the scenario that runs one asserts the room's edits
    // reached the document and its page state instead.
    if (call.method !== 'commit') continue;
    if (call.error) continue;
    const stored = call.result?.stored;
    if (call.result?.outcome !== 'committed') continue;
    const document = namedPathsOf(call).map(documentBehind).find((file) => isDocumentPath(file));
    if (!document) continue;
    if (stored === undefined || stored === null) {
      found.push(`${call.method} ${call.request?.kind ?? ''} named ${document} but reported no stored bytes`);
      continue;
    }
    const expected = Buffer.isBuffer(stored) ? stored : Buffer.from(String(stored), 'utf8');
    let onDisk = null;
    try { onDisk = fs.readFileSync(document); } catch { onDisk = null; }
    if (!onDisk || !onDisk.equals(expected)) {
      found.push(`${call.method} ${call.request?.kind ?? ''} named ${document} but the bytes on disk are not the bytes it stored`);
    }
  }
  return found;
}

module.exports = {
  begin, stop, spy,
  calls, callsTo, commitsOfKind, requestedPaths,
  documentsTouched, violations, finalByteMismatches,
  isDocumentPath, documentBehind, namedPathsOf,
  records: () => records,
};
