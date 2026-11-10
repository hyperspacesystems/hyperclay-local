'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { randomBytes } = require('crypto');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const DOCUMENT = /\.(html|htmlclay)$/i;
const UNTITLED_NAME = 'untitled.html';
const AUTO_NAMED = 'p3-auto-named.html';
const CANARY_NAME = 'canary.html';
const TAILWIND_HREF = /href\s*=\s*["']([^"']+)["']/gi;
const TAILWIND_NAME = /^(?:https?:\/\/[^/]+)?\/tailwindcss\/([^?#]+)\.css(?:[?#].*)?$/;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    run: null, roots: [], goBin: null, localSource: null,
    host: 'go', canary: false, serverUrl: null, apiKeyFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--canary') {
      options.canary = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--root') options.roots.push(value);
    else if (flag === '--run') options.run = value;
    else if (flag === '--go-bin') options.goBin = value;
    else if (flag === '--local-source') options.localSource = value;
    else if (flag === '--host') options.host = value;
    else if (flag === '--server-url') options.serverUrl = value;
    else if (flag === '--api-key-file') options.apiKeyFile = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.run) throw new Error('--run is required');
  if (options.roots.length !== 2) throw new Error('exactly two --root arguments are required');
  if (options.host !== 'go' && options.host !== 'in-process') throw new Error('--host must be go or in-process');
  if (options.host === 'go' && !options.goBin) throw new Error('--host go needs --go-bin');
  if (options.host === 'go' && !options.localSource) throw new Error('--host go needs --local-source');
  if (Boolean(options.serverUrl) !== Boolean(options.apiKeyFile)) {
    throw new Error('--server-url and --api-key-file are given together or not at all');
  }
  return options;
}

function stemOf(rel) {
  return rel.replace(DOCUMENT, '');
}

function tailwindEdits(html) {
  const names = [];
  TAILWIND_HREF.lastIndex = 0;
  let hit = TAILWIND_HREF.exec(html);
  while (hit) {
    const name = TAILWIND_NAME.exec(hit[1]);
    if (name) names.push(name[1]);
    hit = TAILWIND_HREF.exec(html);
  }
  return names.map((name) => `.hyperclay/tailwindcss/${name}.css`);
}

// The paths one document write may change, computed from the action and never
// from the host's answer: the document, its versions folder, its guard record
// and recover copy, its page-state and data sidecars, and the stylesheet it
// links.
function editsFor(rel, html = '') {
  const stem = stemOf(rel);
  return [
    rel,
    `.hyperclay/versions/${stem}/`,
    `.hyperclay/guard/${stem}.json`,
    `.hyperclay/guard/${stem}.recover.html`,
    `.hyperclay/page-state/${rel}.json`,
    `.hyperclay/api-v2/${rel}.json`,
    ...tailwindEdits(html),
  ];
}

function httpRequest(baseUrl, {
  method = 'GET', path: requestPath = '/', headers = {}, body = null,
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, `${baseUrl.replace(/\/+$/, '')}/`);
    const payload = body === null ? null : Buffer.from(String(body), 'utf8');
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['content-length'] = String(payload.length);
    const req = http.request(target, { method, headers: finalHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function answerJson(answer) {
  try {
    return JSON.parse(answer.body);
  } catch {
    return null;
  }
}

function failureOf(answer, where) {
  let message = `${where} answered ${answer.status}`;
  const parsed = answerJson(answer);
  if (parsed && typeof parsed.error === 'string') message = `${message}: ${parsed.error}`;
  else if (parsed && typeof parsed.msg === 'string') message = `${message}: ${parsed.msg}`;
  else if (answer.body) message = `${message}: ${answer.body.slice(0, 200)}`;
  return message;
}

function isNotThere(answer) {
  return [404, 405, 501].includes(answer.status);
}

function liveStub() {
  return { markBrowserSave() {}, broadcast() {} };
}

function settingsStub(roots) {
  const settings = { roots, syncSessions: [], actor: null };
  return { get: () => settings, save() {} };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(options.run);
  fs.mkdirSync(runDir, { recursive: true });

  if (options.host === 'go') process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = 'go';
  else delete process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;

  const intendedPath = path.join(runDir, 'intended-edits.txt');
  fs.writeFileSync(intendedPath, '');
  const seenEdits = new Set();
  const intend = (paths) => {
    for (const rel of paths) {
      if (!rel || seenEdits.has(rel)) continue;
      seenEdits.add(rel);
      fs.appendFileSync(intendedPath, `${rel}\n`);
    }
  };
  intend(['.hyperclay/sync-root.json']);

  const writers = [];
  const record = (entry) => {
    writers.push(entry);
    return entry;
  };
  const writeWriters = () => fs.writeFileSync(
    path.join(runDir, 'writers.json'),
    `${JSON.stringify({ host: options.host, writers }, null, 2)}\n`,
  );

  const rootB = { id: 'p3-root-a', path: fs.realpathSync(path.resolve(options.roots[0])) };
  const rootD = { id: 'p3-root-b', path: fs.realpathSync(path.resolve(options.roots[1])) };

  const { createRootDocumentHost } = require(path.join(REPO, 'src/main/document-host.js'));
  const { executeCommand } = require(path.join(REPO, 'src/main/workspace/commands.js'));
  const { createAutoNamer } = require(path.join(REPO, 'src/main/workspace/auto-name.js'));
  const { adapterCounts } = require(path.join(__dirname, 'go-document-host.cjs'));
  const { setConnection } = require(path.join(__dirname, 'go-process.cjs'));

  const host = createRootDocumentHost({
    ctx: { root: rootB, localAuthority: null }, live: liveStub(), emit() {}, logger: null,
  });

  let go = null;
  let unsubscribe = null;
  let feed = null;
  let crash = null;

  const tree = {
    scan: async () => {},
    refresh: async () => {},
    moved: () => {},
  };
  const onMoved = () => {};
  const onChanged = () => {};

  const command = async (request) => executeCommand({
    root: rootB, authority: null, engine: null, request, tree,
    moved: onMoved, changed: onChanged, documentHost: host,
  });

  async function settleCounts(budgetMs = 5000) {
    if (options.host !== 'go') return;
    let last = JSON.stringify(adapterCounts());
    const deadline = Date.now() + budgetMs;
    for (;;) {
      await wait(250);
      const now = JSON.stringify(adapterCounts());
      if (now === last || Date.now() >= deadline) return;
      last = now;
    }
  }

  async function browserSaveWriter(rel, html, { userDriven = false } = {}) {
    const headers = {
      'Document-URL': `${go.url}/${rel}`,
      'Content-Type': 'text/plain',
    };
    if (userDriven) headers['X-Hyperclay-User-Driven'] = '1';
    return httpRequest(go.url, { method: 'POST', path: '/_/save', headers, body: html });
  }

  async function httpWriters() {
    if (options.host !== 'go') {
      for (const [kind, how] of [
        ['browser-save', 'HTTP POST /_/save to the Go host'],
        ['data-api', 'HTTP POST /<page>?data= and POST /_/api/<page> to the Go host'],
        ['restore', 'HTTP GET /_/versions/<rel> then POST /_/restore/<rel>/<name> to the Go host'],
        ['guard-restore', 'HTTP destructive save, GET /_/data-loss, POST /_/data-loss/<id> to the Go host'],
      ]) {
        record({
          kind, how, outcome: 'not-node', by: 'go', origin: 'go', edits: [], reason: 'the in-process host has no Go HTTP server',
        });
      }
      return;
    }

    const index = fs.readFileSync(path.join(rootB.path, 'index.html'), 'utf8');
    intend(editsFor('index.html', index));
    const saved = await browserSaveWriter('index.html', index);
    record({
      kind: 'browser-save',
      how: 'HTTP POST /_/save to the Go host',
      outcome: saved.status === 200 ? 'committed' : 'failed',
      ...(saved.status === 200 ? {} : { error: failureOf(saved, 'the browser save') }),
      by: 'go', origin: 'go', edits: editsFor('index.html', index),
    });

    const dataBody = JSON.stringify({ title: 'P3 Data Write', items: ['first', 'second'] });
    const dataRules = encodeURIComponent(JSON.stringify({ title: 'h1', items: '.item[]' }));
    const dataEdits = editsFor('index.html', index);
    const dataNotes = [];
    let dataOutcome = 'committed';
    let missingRoute = false;
    for (const [where, requestPath] of [
      ['POST /index.html?data=', `/index.html?data=${dataRules}`],
      ['POST /_/api/index.html', '/_/api/index.html'],
    ]) {
      const answer = await httpRequest(go.url, {
        method: 'POST',
        path: requestPath,
        headers: { 'Content-Type': 'application/json' },
        body: dataBody,
      });
      if (answer.status === 200) continue;
      dataNotes.push(failureOf(answer, where));
      if (isNotThere(answer)) missingRoute = true;
      else dataOutcome = 'failed';
    }
    record({
      kind: 'data-api',
      how: 'HTTP POST /<page>?data= and POST /_/api/<page> to the Go host',
      outcome: dataOutcome,
      ...(dataOutcome === 'failed' ? { error: dataNotes.join('; ') } : {}),
      ...(dataNotes.length ? { notes: dataNotes.join('; ') } : {}),
      ...(missingRoute ? { reason: 'a data route this host does not serve yet (G8b)' } : {}),
      by: 'go', origin: 'go', edits: dataEdits,
    });

    const listed = await httpRequest(go.url, { path: '/_/versions/index.html' });
    const list = answerJson(listed);
    const version = list && Array.isArray(list.versions) ? list.versions[0] : null;
    if (listed.status === 200 && version && typeof version.name === 'string') {
      const restored = await httpRequest(go.url, {
        method: 'POST', path: `/_/restore/index.html/${encodeURIComponent(version.name)}`,
      });
      record({
        kind: 'restore',
        how: 'HTTP GET /_/versions/<rel> then POST /_/restore/<rel>/<name> to the Go host',
        outcome: restored.status === 200 ? 'committed' : 'failed',
        ...(restored.status === 200 ? {} : { error: failureOf(restored, 'the version restore') }),
        by: 'go', origin: 'go', edits: editsFor('index.html', index),
      });
    } else {
      record({
        kind: 'restore',
        how: 'HTTP GET /_/versions/<rel> then POST /_/restore/<rel>/<name> to the Go host',
        outcome: 'failed',
        error: listed.status === 200
          ? 'the version list named no version'
          : failureOf(listed, 'the version list'),
        by: 'go', origin: 'go', edits: editsFor('index.html', index),
      });
    }

    const notes = fs.readFileSync(path.join(rootB.path, 'notes.html'), 'utf8');
    const notesEdits = editsFor('notes.html', notes);
    intend(notesEdits);
    const raised = await guardRestoreWriter(notesEdits);
    record({
      kind: 'guard-restore',
      how: 'HTTP destructive save, GET /_/data-loss, POST /_/data-loss/<id> to the Go host',
      ...raised,
      by: 'go', origin: 'go', edits: notesEdits,
    });
  }

  async function guardRestoreWriter() {
    const source = fs.readFileSync(path.join(rootB.path, 'notes.html'), 'utf8');
    const seeded = await browserSaveWriter('notes.html', source);
    if (seeded.status !== 200) {
      return { outcome: 'failed', error: failureOf(seeded, 'the guard seed save') };
    }
    const clobber = source.replace(/<div id="notes">[^<]*<\/div>/, '<div id="notes"></div>');
    if (clobber === source) return { outcome: 'failed', error: 'the clobbered page is unchanged' };
    const destructive = await browserSaveWriter('notes.html', clobber, { userDriven: true });
    if (destructive.status !== 200) {
      return { outcome: 'failed', error: failureOf(destructive, 'the destructive save') };
    }
    const notice = await httpRequest(go.url, {
      path: '/_/data-loss',
      headers: { 'Document-URL': `${go.url}/notes.html` },
    });
    const event = notice.status === 200 ? answerJson(notice)?.event : null;
    if (!event || typeof event.id !== 'string') {
      return {
        outcome: 'failed',
        error: notice.status === 200
          ? 'the destructive save raised no data-loss event'
          : failureOf(notice, 'the data-loss read'),
      };
    }
    const restored = await httpRequest(go.url, {
      method: 'POST',
      path: `/_/data-loss/${encodeURIComponent(event.id)}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'notes.html', choice: 'restore' }),
    });
    const answer = answerJson(restored);
    if (restored.status !== 200 || !answer || answer.ok !== true) {
      return { outcome: 'failed', error: failureOf(restored, 'the guard restore') };
    }
    return { outcome: 'committed' };
  }

  async function workspaceWriter(kind, how, request, edits) {
    intend(edits);
    const entry = { kind, how, by: 'node', origin: 'node', edits };
    try {
      const result = await command(request);
      intend(editsFor(result.path));
      return record({ ...entry, outcome: 'committed', evidence: { answer: 'committed', path: result.path } });
    } catch (error) {
      return record({ ...entry, outcome: 'failed', error: error?.message || String(error) });
    }
  }

  async function autoNameWriter() {
    const how = 'the real auto-namer on a created Untitled page, fed from the host\'s events';
    const edits = editsFor(UNTITLED_NAME).concat(editsFor(AUTO_NAMED));
    intend(edits);
    const entry = { kind: 'auto-name', how, by: 'node', origin: 'node', edits };
    let appDataPath = path.join(runDir, 'app-data');
    try {
      await command({ command: 'create', parent: '', name: UNTITLED_NAME, template: 'page' });
      const file = path.join(rootB.path, UNTITLED_NAME);
      const current = await host.read(UNTITLED_NAME, file);
      if (!current) throw new Error(`${UNTITLED_NAME} was not created`);
      const html = current.bytes.toString('utf8')
        .replace('<h1 data-id="title"></h1>', '<h1 data-id="title">P3 Auto Named</h1>');
      if (html === current.bytes.toString('utf8')) throw new Error('the page template carries no empty heading');
      const saved = await host.commit({
        kind: 'browser-save',
        name: UNTITLED_NAME,
        filePath: file,
        bytes: html,
        expected: { type: 'checksum', value: current.checksum },
        context: {},
      });
      if (saved.outcome !== 'committed') throw new Error(`the heading save answered ${saved.outcome}`);

      const canonical = fs.realpathSync(file);
      const room = { key: canonical, emptySince: 1, nodeId: 'p3-driver' };
      const authority = {
        rooms: new Map([[canonical, room]]),
        hasParticipatingEditors: () => false,
        checkpointTargets: (key) => (key === canonical
          ? [{ rootId: rootB.id, logicalPath: UNTITLED_NAME }]
          : []),
        identityAt: () => null,
      };
      const autoNamer = createAutoNamer({
        appDataPath,
        authority,
        rootFor: (id) => (id === rootB.id ? rootB : null),
        rename: async (root, from, name) => command({ command: 'rename', path: from, name }),
        logError: () => {},
      });
      if (typeof host.events === 'function') {
        try {
          unsubscribe = host.events(null, ({ type, event, rel }) => {
            if (type === 'change') autoNamer.observe(rootB, event, rel).catch(() => {});
          });
        } catch {
          unsubscribe = null;
        }
      }
      try {
        await autoNamer.record(rootB, UNTITLED_NAME, 'page');
        const deadline = Date.now() + 20000;
        for (;;) {
          await autoNamer.departed(room);
          if (fs.existsSync(path.join(rootB.path, AUTO_NAMED))) {
            return record({ ...entry, outcome: 'committed', evidence: { renamed: AUTO_NAMED } });
          }
          if (Date.now() >= deadline) break;
          await wait(300);
        }
        throw new Error(`the auto-namer did not rename ${UNTITLED_NAME} to ${AUTO_NAMED}`);
      } finally {
        autoNamer.close();
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      }
    } catch (error) {
      return record({ ...entry, outcome: 'failed', error: error?.message || String(error) });
    }
  }

  async function rebaseWriter() {
    const how = 'direct call, no native caller';
    const rel = 'article.html';
    const edits = editsFor(rel);
    intend(edits);
    const entry = { kind: 'external-rebase', how, by: 'node', origin: 'node', edits };
    try {
      const file = path.join(rootB.path, rel);
      const bytes = fs.readFileSync(file, 'utf8');
      const result = await host.commit({
        kind: 'external-rebase',
        name: rel,
        filePath: file,
        bytes,
        expected: { type: 'any' },
        context: {},
      });
      if (result.outcome !== 'committed') {
        return record({ ...entry, outcome: 'failed', error: `the rebase answered ${result.outcome}` });
      }
      return record({ ...entry, outcome: 'committed' });
    } catch (error) {
      return record({ ...entry, outcome: 'refused', error: error?.message || String(error) });
    }
  }

  function passiveObserver() {
    const emitter = new EventEmitter();
    const listeners = new Set();
    emitter.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    emitter.setRemoteApplyCheck = () => {};
    emitter.start = async () => {};
    emitter.stop = async () => {};
    emitter.deliver = (frame) => {
      for (const listener of listeners) listener(frame);
    };
    return emitter;
  }

  async function syncWriters() {
    if (!options.serverUrl) {
      for (const [kind, how] of [
        ['sync-download', 'one SyncManager download pass against the box'],
        ['sync-upload', 'one SyncManager upload pass against the box'],
      ]) {
        record({
          kind, how, outcome: 'not-run (needs the box)', by: 'go', origin: 'go', edits: [], reason: 'no --server-url and --api-key-file',
        });
      }
      return;
    }
    const { SyncManager } = require(path.join(REPO, 'src/main/sync-manager.js'));
    const observer = passiveObserver();
    let feed = null;
    try {
      feed = host.events(null, (frame) => {
        if (frame.type === 'change') observer.deliver({ event: frame.event, rel: frame.rel });
      });
    } catch {
      feed = null;
    }
    const apiKey = fs.readFileSync(options.apiKeyFile, 'utf8').trim();
    if (!apiKey) throw new Error(`no API key in ${options.apiKeyFile}`);
    const manager = new SyncManager({
      userData: path.join(runDir, 'sync'),
      deviceId: randomBytes(16).toString('hex'),
      serverUrl: options.serverUrl,
      getApiKey: () => apiKey,
      settingsStore: settingsStub([{ id: rootB.id, path: rootB.path, kind: 'personal', name: path.basename(rootB.path) }]),
      observerFor: () => observer,
      localAuthority: null,
    });
    const session = {
      id: 'p3-sync', rootId: rootB.id, kind: 'personal', accountId: null, cached: { username: null },
    };
    intend(editsFor('index.html'));
    let started = null;
    try {
      started = await manager.start(session, { id: rootB.id, path: rootB.path, kind: 'personal' }, { firstBind: true });
      if (started && started.success === false) throw new Error(started.error || 'sync did not start');
      await manager.whenAllIdle({ timeoutMs: 120000 });
      const engine = manager.get(session.id);
      const stats = engine && engine.stats ? { ...engine.stats } : null;
      for (const kind of ['sync-download', 'sync-upload']) {
        record({
          kind,
          how: 'one SyncManager pass against the box',
          outcome: 'committed',
          evidence: { stats },
          by: 'go', origin: 'go', edits: [],
        });
      }
    } catch (error) {
      for (const kind of ['sync-download', 'sync-upload']) {
        record({
          kind,
          how: 'one SyncManager pass against the box',
          outcome: 'failed',
          error: error?.message || String(error),
          by: 'go', origin: 'go', edits: [],
        });
      }
    } finally {
      if (feed) feed();
      await manager.stopAll().catch(() => {});
    }
  }

  const COMMIT_KINDS = new Set([
    'browser-save', 'data-api', 'restore', 'guard-restore', 'external-rebase', 'create', 'sync-download',
  ]);

  // The adapter's commit frames are Go's own record of what it wrote. A writer
  // that claims a commit the stream never showed is not a commit.
  function reconcileWithCounts() {
    if (options.host !== 'go') return;
    const kinds = adapterCounts().kinds;
    for (const writer of writers) {
      if (!COMMIT_KINDS.has(writer.kind)) continue;
      const committed = kinds[writer.kind]?.committed ?? 0;
      if (committed > 0) {
        writer.evidence = { ...(writer.evidence || {}), committed };
        continue;
      }
      if (writer.outcome !== 'committed') continue;
      if (writer.kind === 'data-api' || writer.kind === 'sync-download') {
        writer.outcome = writer.kind === 'data-api' ? 'pending' : 'failed';
        writer.reason = `Go recorded no ${writer.kind} commit`;
      } else {
        writer.outcome = 'failed';
        writer.error = `Go recorded no ${writer.kind} commit`;
      }
    }
  }

  try {
    if (options.host === 'go') {
      const { startGo } = await import(pathToFileURL(path.join(__dirname, 'p1.mjs')).href);
      go = await startGo({
        bin: options.goBin,
        cwd: REPO,
        scratch: runDir,
        roots: [rootB.path, rootD.path],
        localSource: options.localSource,
      });
      const served = {};
      for (const root of go.readyRoots) served[fs.realpathSync(root.path)] = root.id;
      setConnection({ url: go.control, secret: go.secret, epoch: go.control, roots: served });
      feed = host.events(null, () => {});
    }

    await httpWriters();

    await workspaceWriter('create', 'executeCommand create from the page template through the host', {
      command: 'create', parent: '', name: 'created.html', template: 'page',
    }, editsFor('created.html'));

    const duplicateEdits = editsFor('article.html').concat(editsFor('article-copy.html'));
    await workspaceWriter('duplicate', 'executeCommand duplicate through the host', {
      command: 'duplicate', path: 'article.html', name: 'article-copy.html',
    }, duplicateEdits);

    const moveEdits = editsFor('sub/page.html').concat(editsFor('page.html'));
    await workspaceWriter('move', 'executeCommand move through the host', {
      command: 'move', path: 'sub/page.html', parent: '',
    }, moveEdits);

    const trashEdits = editsFor('styled.html').concat(editsFor('.trash/styled.html'));
    await workspaceWriter('trash', 'executeCommand trash through the host', {
      command: 'trash', path: 'styled.html',
    }, trashEdits);

    const untrashEdits = editsFor('styled.html').concat(editsFor('.trash/styled.html'));
    await workspaceWriter('restore-trash', 'executeCommand restore-trash through the host', {
      command: 'restore-trash', trashPath: '.trash/styled.html',
    }, untrashEdits);

    await autoNameWriter();
    await rebaseWriter();
    await syncWriters();

    if (options.canary) {
      const canary = path.join(rootB.path, CANARY_NAME);
      intend([CANARY_NAME]);
      await fs.promises.writeFile(canary, '<!doctype html><html><body><h1>canary</h1></body></html>\n');
      fs.writeFileSync(path.join(runDir, 'canary.json'), `${JSON.stringify({ path: CANARY_NAME }, null, 2)}\n`);
    }
  } catch (error) {
    crash = error?.message || String(error);
  } finally {
    await settleCounts();
    reconcileWithCounts();
    writeWriters();
    if (options.host === 'go') {
      fs.writeFileSync(
        path.join(runDir, 'adapter-counts.json'),
        `${JSON.stringify(adapterCounts(), null, 2)}\n`,
      );
    }
    if (feed) {
      feed();
      feed = null;
    }
    if (go) {
      try {
        await go.stop();
      } catch {
        // stop() resolves once the child is gone; teardown cannot change a verdict.
      }
    }
  }

  if (crash) {
    process.stderr.write(`[p3-driver] ${crash}\n`);
    return 2;
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`[p3-driver] ${error?.message || error}\n`);
  process.exitCode = 2;
});
