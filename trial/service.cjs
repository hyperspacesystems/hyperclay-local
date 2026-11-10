'use strict';

// The managed trial's JS service (trial/protocol/v1.md): Local's room code run
// beside the Go host. Go is the only writer of a served root and holds a
// document's lock while it consults this process. Each consultation runs
// Local's own lane halves (document-host.js `lanes`) inside this process's own
// document boundary, which stays open from `admit` to `settle` so the write
// token Local's authority asserts is the one the write was admitted under. No
// file is written here: what the room code writes (a safety version, a
// recovered copy) leaves as an artifact that Go writes and receipts.

const http = require('http');
const path = require('path');
const { realpathSync } = require('fs');
const { randomBytes, timingSafeEqual } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { createLocalAuthority } = require(path.join(SRC, 'local-authority.js'));
const { createLocalCheckpoint } = require(path.join(SRC, 'local-checkpoint.js'));
const { createRootDocumentHost } = require(path.join(SRC, 'document-host.js'));
const { withDocumentWrite, withStructureChange } = require(path.join(SRC, 'utils', 'write-queue.js'));
const { withReader, disk } = require(path.join(SRC, 'document-reader.js'));
const { createRootLive } = require(path.join(SRC, 'utils', 'root-live.js'));
const { RootObserver } = require(path.join(SRC, 'root-observer.js'));
const { pageWriteFailure } = require(path.join(SRC, 'server.js'));
const { writeContexts } = require(path.join(SRC, 'write-contexts.js'));
const { documentEtag } = require(path.join(SRC, 'spec-wire.js'));
const { logicalBytes } = require(path.join(SRC, 'page-state-store.js'));
const { newestVersionFiles } = require(path.join(SRC, 'page-rebase.js'));
const { setConnection, getConnection } = require('./go-process.cjs');

const roomsPackage = () => require('@panphora/clayjs/server/rooms');

const BEARER = 'Bearer ';
const MAX_BODY = 64 * 1024 * 1024;
const RECONCILE_MEMORY_MS = 5 * 60 * 1000;

// The consultation a piece of room code is running for, so the authority's
// recovered-copy writer knows where its artifact goes.
const consultScope = new AsyncLocalStorage();

function text(value) {
  if (!value) return null;
  return value.encoding === 'base64' ? Buffer.from(value.data, 'base64').toString('utf8') : value.data;
}

function raw(value) {
  if (!value) return null;
  return value.encoding === 'base64' ? Buffer.from(value.data, 'base64') : Buffer.from(value.data, 'utf8');
}

function encode(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') };
  return { encoding: 'utf8', data: String(value) };
}

function missing(file) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
}

// The reader a handler runs under while Go holds the document's lock (S5): the
// document, its page-state sidecar and the version files Go sent come from the
// call's snapshot, and the version list is exactly the names Go sent. Any other
// path (a legacy sidecar probe, a sibling's stat) is read from the disk,
// read-only. Once Go has written the document (`settled`), the document and its
// sidecar are read from the disk Go just wrote under the lock it still holds,
// and the document's stat answers with the identity Go reported, so the stamp a
// confirmation records is the written file's.
function snapshotReader(root, body) {
  const current = body.current ?? null;
  const document = path.resolve(body.canonicalPath);
  const sidecar = path.resolve(root.path, '.hyperclay', 'page-state', `${body.name}.json`);
  const versionsDir = path.resolve(root.path, '.hyperclay', 'versions', body.name.replace(/\.(html|htmlclay)$/i, ''));
  const versions = new Map((body.versions ?? []).map((version) => [version.name, raw(version.bytes)]));
  // `done` once the handler that made this reader has finished: work Local
  // scheduled inside it (a checkpoint wake, a timer) inherits the reader's
  // scope and from then on reads the disk, read-only, like any other read
  // outside a consultation.
  const state = { settled: false, done: false, identity: current?.identity ?? null };
  return {
    state,
    async readFile(file, encoding) {
      if (state.done) return disk.readFile(file, encoding);
      const resolved = path.resolve(file);
      let bytes;
      if (!state.settled && resolved === document) {
        if (!current || !current.exists) throw missing(file);
        bytes = raw(current.bytes);
      } else if (!state.settled && resolved === sidecar && current) {
        if (!current.sidecar) throw missing(file);
        bytes = Buffer.from(JSON.stringify(current.sidecar), 'utf8');
      } else if (path.dirname(resolved) === versionsDir && versions.has(path.basename(resolved))) {
        bytes = versions.get(path.basename(resolved));
      } else {
        return disk.readFile(file, encoding);
      }
      return encoding ? bytes.toString(encoding) : bytes;
    },
    async stat(file, options) {
      if (state.done || path.resolve(file) !== document) return disk.stat(file, options);
      if (!state.identity) throw missing(file);
      const big = Boolean(options && options.bigint);
      const field = (value) => (big ? BigInt(value) : Number(value));
      const { dev, ino, size, mtimeNs } = state.identity;
      return {
        dev: field(dev), ino: field(ino), size: field(size), mtimeNs: field(mtimeNs),
        isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
      };
    },
    versionFiles: async (dir, baseDir) => (state.done ? newestVersionFiles(dir, baseDir) : [...versions.keys()]),
  };
}

// One consultation: a handler running in this process while Go holds the
// document's lock, answering each of Go's calls in turn. `reply` is the answer
// function of the call Go is waiting on. An artifact the handler needs written
// is sent as a pending batch on that call, and the handler stays suspended
// until Go's receipt arrives on the next one.
class Consultation {
  constructor(id, reply) {
    this.id = id;
    this.reply = reply;
    this.batch = [];
    this.waiting = new Map();
    this.resume = null;
    this.aborted = null;
    this.flushing = false;
  }

  answer(body) {
    const reply = this.reply;
    this.reply = null;
    if (reply) reply(body);
  }

  // Artifacts written in the same turn leave as one batch, on whichever of Go's
  // calls is waiting for this consultation's answer.
  flush() {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      if (this.batch.length && this.reply) this.answer({ pending: true, artifacts: this.batch.splice(0) });
    });
  }

  write(artifact) {
    if (this.aborted) return Promise.resolve({ artifactId: null, error: `aborted: ${this.aborted}` });
    const artifactId = randomBytes(8).toString('hex');
    const receipt = new Promise((resolve) => this.waiting.set(artifactId, resolve));
    this.batch.push({ artifactId, ...artifact });
    this.flush();
    return receipt;
  }

  receive(receipts, reply) {
    this.reply = reply;
    for (const receipt of receipts ?? []) {
      const resolve = this.waiting.get(receipt.artifactId);
      this.waiting.delete(receipt.artifactId);
      if (resolve) resolve(receipt);
    }
    if (this.batch.length) this.flush();
  }

  // The handler's wait for Go's settle or abort. An abort that came first
  // answers at once, so a handler never holds its boundary for a write Go gave up.
  next() {
    if (this.aborted) return Promise.resolve({ abort: this.aborted });
    return new Promise((resolve) => { this.resume = resolve; });
  }

  continueWith(step, reply) {
    if (reply) this.reply = reply;
    const resume = this.resume;
    this.resume = null;
    if (resume) resume(step);
    if (this.batch.length) this.flush();
  }

  abort(reason) {
    this.aborted = reason;
    for (const [artifactId, resolve] of this.waiting) resolve({ artifactId, error: `aborted: ${reason}` });
    this.waiting.clear();
    this.batch = [];
    this.continueWith({ abort: reason }, null);
  }
}

// Local's answer to a write its admission refused, shaped exactly as the route
// the write came through answers it: the data API's catch (server.js
// `handleApiWrite`) for lane `api`, /save's catch otherwise. `stamp` is the
// ETag /save adds to a stale-lineage or nothing-to-write refusal: the stored
// document's, as /save computes it. The replace lane's refusal codes are mapped
// by Go's restore routes themselves, as Local's are.
function refusalFor(lane, error, stamp = null) {
  const message = error && error.message ? error.message : String(error);
  const movedOrDeleted = { status: 409, code: 'moved-or-deleted', body: { msg: message, msgType: 'error', code: 'moved-or-deleted' } };
  if (lane === 'api') {
    if (error && error.code === 'moved-or-deleted') return movedOrDeleted;
    if (error && error.name === 'PersistentReservationError') {
      const status = error.code === 'checkpointing' ? 503 : 409;
      return { status, code: error.code, body: { code: error.code, error: error.message } };
    }
    const failure = pageWriteFailure(error);
    if (failure) {
      return {
        status: failure.statusCode, code: failure.code,
        body: { code: failure.code, reason: failure.reason, minimum: failure.minimum, msg: failure.message },
      };
    }
    return { status: 500, code: 'failed', body: { error: 'Internal server error', message: 'An unexpected error occurred' } };
  }
  const failure = pageWriteFailure(error);
  if (failure) {
    const headers = {};
    if (failure.retryAfter !== undefined) headers['Retry-After'] = String(failure.retryAfter);
    const etag = failure.code === 'page-lineage-stale' || failure.code === 'page-nothing-to-write' ? stamp : null;
    if (etag) headers.ETag = etag;
    return {
      status: failure.statusCode,
      code: failure.code,
      headers,
      body: {
        msg: failure.message,
        msgType: 'error',
        code: failure.code,
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
        ...(failure.minimum === undefined ? {} : { minimum: failure.minimum }),
        ...(etag ? { etag } : {}),
      },
    };
  }
  if (error && error.code === 'moved-or-deleted') return movedOrDeleted;
  if (error && error.code === 'unsaved-edits') {
    return { status: 409, code: 'unsaved-edits', body: { msg: message, msgType: 'error', code: 'unsaved-edits' } };
  }
  return { status: 500, code: 'failed', body: { msg: `Server error saving file: ${message}`, msgType: 'error' } };
}

// The stamp /save puts on a stale-lineage refusal: the stored document's
// logical bytes, read from the call's snapshot (run inside its reader scope).
async function storedStamp(root, body) {
  const current = body.current;
  if (!current || !current.exists) return null;
  try {
    return documentEtag(await logicalBytes(root.path, body.name, raw(current.bytes)));
  } catch {
    return null;
  }
}

// Local's own in-process host, whose lane halves the handlers run. It is built
// with the trial switch off for this one call, whatever the process sets for
// the routes, which write through Go.
function inProcessLanes(ctx) {
  const saved = process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
  delete process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST;
  try {
    return createRootDocumentHost({ ctx, live: ctx.live, getObserver: () => ctx.observer }).lanes;
  } finally {
    if (saved !== undefined) process.env.HYPERCLAY_LOCAL_DOCUMENT_HOST = saved;
  }
}

function saveOrigin(lane, origin) {
  if (origin === 'checkpoint') return 'checkpoint';
  return lane === 'api' ? 'api' : 'save';
}

function createTrialService({
  secret = randomBytes(32).toString('hex'),
  epoch = randomBytes(8).toString('hex'),
  logError = (...args) => console.error('[trial-service]', ...args),
} = {}) {
  const roots = new Map();
  const rootsByPath = new Map();
  const consultations = new Map();
  const touched = new Map();
  const tombstones = new Map();
  const handlers = new Map();
  let go = null;

  const authority = createLocalAuthority({ withDocument: withDocumentWrite, publishRecovered });
  const checkpoint = createLocalCheckpoint({ authority });
  authority.setCheckpointService(checkpoint);

  function rootFor(id) {
    const root = roots.get(id);
    if (!root) throw Object.assign(new Error(`unknown root ${id}`), { code: 'unknown-root' });
    return root;
  }

  // The authority's recovered-copy writer: inside a consultation the copy is an
  // artifact of that consultation's next batch; outside one it is a
  // POST /v1/artifact. Either way it counts as published only on Go's receipt.
  async function publishRecovered(rootPath, rel, html) {
    const root = rootsByPath.get(path.resolve(rootPath));
    if (!root) throw new Error(`recovered copy for an unknown root ${rootPath}`);
    const current = openConsultation();
    const receipt = current
      ? await current.write({ type: 'recovered-copy', root: root.id, name: rel, logical: encode(html) })
      : await goCall('POST', '/v1/artifact', {
        opId: randomBytes(16).toString('hex'), root: root.id, name: rel,
        artifactId: randomBytes(8).toString('hex'), type: 'recovered-copy', logical: encode(html),
      });
    if (receipt.error) throw new Error(`recovered copy of ${rel} was not written: ${receipt.error}`);
    return { filename: receipt.version };
  }

  function artifactWriters(consultation, root, name) {
    return {
      safetyVersion: async (html) => {
        const receipt = await consultation.write({ type: 'safety-version', logical: encode(html) });
        return receipt.error ? null : { filename: receipt.version };
      },
      recoveredCopy: async (html) => {
        const receipt = await consultation.write({ type: 'recovered-copy', root: root.id, name, logical: encode(html) });
        if (receipt.error) throw new Error(`recovered copy of ${name} was not written: ${receipt.error}`);
        return { filename: receipt.version };
      },
    };
  }

  // A call to Go's control API. Never made from a handler Go is waiting on:
  // Go holds the document's lock for the whole consultation.
  function goCall(method, pathname, body) {
    const connection = getConnection();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      authorization: `${BEARER}${connection.secret}`,
      'x-trial-epoch': epoch,
      'x-trial-peer-epoch': connection.peerEpoch ?? '',
    };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      const request = http.request(`${connection.url}${pathname}`, { method, headers }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const answer = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            reject(Object.assign(new Error(`Go ${pathname} answered ${response.statusCode}: ${answer}`), { status: response.statusCode }));
            return;
          }
          try {
            resolve(answer ? JSON.parse(answer) : null);
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  function open(consultId, reply) {
    const consultation = new Consultation(consultId, reply);
    consultations.set(consultId, consultation);
    return consultation;
  }

  // Bounded per-consultation memory for the current Go epoch: the document each
  // consultation touched (so a `settle-failed` abort can reconcile it even when
  // its settle never arrived) and the consultations aborted before their admit
  // reached this process.
  function prune(map) {
    const now = Date.now();
    for (const [id, entry] of map) {
      if (now - entry.at > RECONCILE_MEMORY_MS) map.delete(id);
    }
  }

  function touch(body) {
    prune(touched);
    if (!touched.has(body.consultId)) {
      touched.set(body.consultId, { root: body.root, name: body.name, canonicalPath: body.canonicalPath, at: Date.now() });
    }
  }

  // Runs one handler for a consultation, in its scope, and forgets the
  // consultation once the handler is done. A handler that throws before it
  // answered answers with `fallback`.
  function run(consultation, fn, fallback) {
    consultScope.run(consultation, fn).catch((error) => {
      logError(`consultation ${consultation.id} failed:`, error);
      consultation.answer(fallback(error));
    }).finally(() => {
      consultations.delete(consultation.id);
    });
  }

  // The consultation a piece of room code runs for, if it is still open. A
  // timer Local schedules inside a handler inherits that handler's scope; once
  // the handler is done, its work is no longer part of the consultation.
  function openConsultation() {
    const current = consultScope.getStore();
    return current && consultations.get(current.id) === current && !current.aborted ? current : null;
  }

  async function admitLane(consultation, root, body, target, token, context) {
    const { lane, name } = body;
    const filePath = body.canonicalPath;
    const headers = body.headers ?? {};
    const incoming = text(body.incoming);
    const writers = artifactWriters(consultation, root, name);
    if (lane === 'save' || lane === 'api') {
      const pageConversion = headers['page-conversion'] ?? null;
      const prepared = await root.lanes.prepareSave({ name, bytes: incoming, pageConversion });
      return root.lanes.admitSave({
        name, filePath, origin: saveOrigin(lane, body.origin),
        content: prepared.content, fileContent: prepared.fileContent, dataLossPrev: text(body.dataLossPrev),
        ifMatch: headers['if-match'] ?? null, pageConversion, pageWrite: headers['page-write'] ?? null,
        pageFormat: headers['page-format'] ?? null, persistentToken: context?.persistentToken ?? null,
        target, token, writeSafetyVersion: writers.safetyVersion,
      });
    }
    if (lane === 'replace') {
      const prepared = await root.lanes.prepareReplace({ name, bytes: incoming });
      const admitted = await root.lanes.admitReplace({
        name, filePath, content: prepared.content, edit: Boolean(body.edit), safety: Boolean(body.safety),
        target, token, writeSafetyVersion: writers.safetyVersion, writeRecoveredCopy: writers.recoveredCopy,
      });
      return {
        content: prepared.content, fileContent: prepared.fileContent,
        pageToken: admitted.pageToken, refusal: admitted.refusal,
      };
    }
    if (lane === 'rebase') {
      await root.lanes.admitRebase({ target, token });
      return { content: incoming, fileContent: roomsPackage().splitPage(incoming).file, pageToken: null };
    }
    throw new TypeError(`admit: unknown lane ${lane}`);
  }

  async function settleLane(root, body, settle, admitted, target, token, context) {
    const { lane, name } = body;
    const logical = text(settle.logical);
    const file = text(settle.file);
    if (lane === 'save' || lane === 'api') {
      await root.lanes.settleSave({
        name, origin: saveOrigin(lane, body.origin), content: logical, fileContent: file,
        pageToken: admitted.pageToken, target, token, persistentToken: context?.persistentToken ?? null,
      });
      root.lanes.recordSaveProvenance(name, settle.userDriven ?? undefined);
      return;
    }
    if (lane === 'replace') {
      await root.lanes.settleReplace({ name, content: logical, pageToken: admitted.pageToken, target, token });
      return;
    }
    if (lane === 'rebase') {
      // Local's observer writes the rebase, then observes it (root-observer.js
      // `_classifyHtml`): the room continues or is replaced and the tabs are told.
      await root.lanes.settleRebase({ bytes: logical, target, token });
      await root.observer._applyExternal(name, target, token, Buffer.from(logical, 'utf8'));
    }
  }

  // POST /v1/admit: the write's admission, then, in the same boundary, its
  // settle or its abort.
  async function runWrite(consultation, body) {
    const root = rootFor(body.root);
    const filePath = body.canonicalPath;
    const location = { rootId: root.id, logicalPath: body.name, canonicalPath: filePath };
    const reader = snapshotReader(root, body);
    const context = body.opHandle ? writeContexts.get(body.opHandle) ?? null : null;
    const claim = authority.captureAdmission(location);
    await withReader(reader, () => withDocumentWrite(async () => ({ canonicalPath: filePath }), async (_locked, token) => {
      if (consultation.aborted) return;
      let target;
      let admitted;
      try {
        target = authority.admitWriteTarget(claim, { ...location, origin: root.origin, live: root.live }, token,
          { explicitCreate: Boolean(body.explicitCreate) });
        admitted = await admitLane(consultation, root, body, target, token, context);
      } catch (error) {
        const stamp = body.lane === 'save' ? await storedStamp(root, body) : null;
        consultation.answer({ decision: 'refuse', ...refusalFor(body.lane, error, stamp) });
        return;
      }
      try {
        if (admitted.refusal) {
          consultation.answer({ decision: 'refuse', status: 500, code: admitted.refusal, body: {} });
          return;
        }
        if (consultation.aborted) return;
        const next = consultation.next();
        consultation.answer({
          decision: 'proceed', logical: encode(admitted.content), file: encode(admitted.fileContent),
          reservation: admitted.pageToken ? consultation.id : null, artifacts: [],
        });
        const step = await next;
        if (!step.settle) return;
        try {
          if (step.settle.outcome === 'committed') {
            reader.state.settled = true;
            reader.state.identity = step.settle.identity ?? null;
            await settleLane(root, body, step.settle, admitted, target, token, context);
          }
          consultation.answer({ ok: true });
        } catch (error) {
          logError(`settle of ${body.name} failed:`, error);
          consultation.answer({ ok: false, error: error && error.message ? error.message : String(error) });
        }
      } finally {
        if (admitted.pageToken) authority.rooms.releasePage(admitted.pageToken);
      }
    })).finally(() => {
      reader.state.done = true;
    });
  }

  // POST /v1/settle for an `exact` or `create` write, which has no admit.
  async function runSettleOnly(consultation, body) {
    if (body.outcome !== 'committed') {
      consultation.answer({ ok: true });
      return;
    }
    const root = rootFor(body.root);
    const location = { rootId: root.id, logicalPath: body.name, canonicalPath: body.canonicalPath };
    const reader = snapshotReader(root, { ...body, current: null });
    reader.state.settled = true;
    reader.state.identity = body.identity ?? null;
    const claim = authority.captureAdmission(location);
    await withReader(reader, () => withDocumentWrite(async () => ({ canonicalPath: body.canonicalPath }), async (_locked, token) => {
      const target = authority.admitWriteTarget(claim, { ...location, origin: root.origin, live: root.live }, token,
        { explicitCreate: body.lane === 'create' });
      if (body.lane === 'exact') await root.lanes.settleExact({ name: body.name, stored: text(body.file), target, token });
      else await root.lanes.settleCreate({ bytes: text(body.logical), target, token });
      consultation.answer({ ok: true });
    })).finally(() => {
      reader.state.done = true;
    });
  }

  // A document whose settle failed or was lost: Local's room is brought back to
  // what is on disk, read from Go once its lock is free, and Go is told.
  async function reconcile({ root: rootId, name, canonicalPath }) {
    const root = rootFor(rootId);
    const query = `?root=${encodeURIComponent(rootId)}&name=${encodeURIComponent(name)}`;
    const snapshot = await goCall('GET', `/v1/read${query}`);
    const reader = snapshotReader(root, { name, canonicalPath, current: snapshot });
    await withReader(reader, () => withDocumentWrite(async () => ({ canonicalPath }), async (_locked, token) => {
      const target = authority.bindTarget({ rootId, logicalPath: name, canonicalPath, origin: root.origin, live: root.live });
      if (!snapshot.exists) {
        await authority.observeExternal(target, null, token, { removed: true });
        return;
      }
      await authority.reconcileDisk(target, text(snapshot.logical) ?? text(snapshot.bytes), token);
    })).finally(() => {
      reader.state.done = true;
    });
    await goCall('POST', '/v1/reconciled', { root: rootId, name });
  }

  handlers.set('/v1/admit', (body, reply) => {
    prune(tombstones);
    if (tombstones.has(body.consultId)) {
      reply({ error: 'aborted' }, 409);
      return;
    }
    touch(body);
    const consultation = open(body.consultId, reply);
    run(consultation, () => runWrite(consultation, body), (error) => ({
      decision: 'refuse', status: 500, code: 'failed', body: { error: error && error.message ? error.message : String(error) },
    }));
  });

  handlers.set('/v1/artifacts-written', (body, reply) => {
    const consultation = consultations.get(body.consultId);
    if (!consultation) {
      reply({ ok: false, error: 'unknown consultation' });
      return;
    }
    consultation.receive(body.receipts, reply);
  });

  handlers.set('/v1/settle', (body, reply) => {
    touch(body);
    const consultation = consultations.get(body.consultId);
    if (consultation) {
      consultation.continueWith({ settle: body }, reply);
      return;
    }
    if (body.lane !== 'exact' && body.lane !== 'create') {
      reply({ ok: false, error: 'unknown consultation' });
      return;
    }
    const fresh = open(body.consultId, reply);
    run(fresh, () => runSettleOnly(fresh, body), (error) => ({
      ok: false, error: error && error.message ? error.message : String(error),
    }));
  });

  // Releases what the consultation holds (its handler leaves its boundary and
  // releases its reservation), then, for `settle-failed`, reconciles the
  // document from a fresh read, in that order.
  handlers.set('/v1/abort', (body, reply) => {
    reply({ ok: true });
    const consultation = consultations.get(body.consultId);
    if (consultation) consultation.abort(body.reason);
    else {
      prune(tombstones);
      tombstones.set(body.consultId, { at: Date.now() });
    }
    const location = touched.get(body.consultId);
    if (body.reason === 'settle-failed' && location) {
      touched.delete(body.consultId);
      setImmediate(() => reconcile(location).catch((error) => logError(`reconcile of ${location.name} failed:`, error)));
    }
  });

  function authorized(req) {
    const given = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`${BEARER}${secret}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // Go sends its own epoch and the one it knows for this process.
  function epochCurrent(req) {
    return Boolean(go) && req.headers['x-trial-epoch'] === go.epoch && req.headers['x-trial-peer-epoch'] === epoch;
  }

  function send(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length) });
    res.end(payload);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('too-large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(res, 403, { error: 'host' });
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    if (!epochCurrent(req)) return send(res, 409, { error: 'epoch', epoch });
    const { pathname } = new URL(req.url, 'http://service');
    const handler = req.method === 'POST' ? handlers.get(pathname) : null;
    if (!handler) return send(res, 404, { error: 'not found' });
    const body = await readJson(req);
    let answered = false;
    handler(body, (answer, status = 200) => {
      if (answered) return;
      answered = true;
      send(res, status, answer);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) send(res, error.status || 500, { error: error.message });
    });
  });

  return {
    secret,
    epoch,
    authority,
    checkpoint,
    roots,
    consultations,
    handlers,
    server,
    rootFor,
    goCall,
    // Listens on a free loopback port and answers the service URL.
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    },
    // Called once Go is READY: its control URL, secret and epoch, and the roots
    // it serves (`{ id, path, url }` from its READY line).
    async attachGo({ url, secret: goSecret, epoch: goEpoch, roots: served }) {
      go = { url, secret: goSecret, epoch: goEpoch };
      const byPath = {};
      for (const entry of served) byPath[realpathSync(entry.path)] = entry.id;
      setConnection({ url, secret: goSecret, epoch, peerEpoch: goEpoch, roots: byPath });
      for (const entry of served) {
        const canonical = realpathSync(entry.path);
        const root = { id: entry.id, path: canonical };
        const live = createRootLive(root);
        const ctx = { root, live, localAuthority: authority, localCheckpoint: checkpoint };
        ctx.observer = new RootObserver(root, { live, localAuthority: authority });
        await withStructureChange(() => authority.registerRoot({ id: root.id, path: canonical, canonicalPath: canonical }));
        const record = { id: root.id, path: canonical, origin: entry.url, live, ctx, observer: ctx.observer, lanes: inProcessLanes(ctx) };
        roots.set(root.id, record);
        rootsByPath.set(canonical, record);
      }
    },
    close() {
      checkpoint.stopSweep();
      authority.close();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createTrialService, snapshotReader, refusalFor, Consultation };
