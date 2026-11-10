'use strict';

const http = require('http');
const { realpathSync } = require('fs');
const { randomBytes } = require('crypto');
const { getConnection } = require('./go-process.cjs');

// Local's KINDS: the write kinds its document host knows, and refuses the rest
// with the same message the in-process host uses.
const KINDS = {
  'browser-save': true,
  'data-api': true,
  restore: true,
  'guard-restore': true,
  'sync-download': true,
  'external-rebase': true,
  workspace: true,
  create: true,
};

// Local's STRUCTURE_KINDS: the restructure kinds its host knows.
const STRUCTURE_KINDS = {
  move: true,
  trash: true,
  duplicate: true,
  'sync-move': true,
  'sync-trash': true,
};

// Request fields the Go host resolves itself, so no request carries them.
const UNSENDABLE = new Set(['context', 'filePath', 'hooks']);

const tally = { kinds: {} };

function countKind(kind) {
  if (!tally.kinds[kind]) tally.kinds[kind] = { adapter: 0, committed: 0 };
  return tally.kinds[kind];
}

// P3's adapter-counts.json: what this process sent, and how many of the
// stream's commit frames for the kind it saw committed.
function adapterCounts() {
  const kinds = {};
  for (const [kind, counts] of Object.entries(tally.kinds)) {
    kinds[kind] = { adapter: counts.adapter, committed: counts.committed };
  }
  return { kinds };
}

function encodeBytes(value) {
  if (typeof value === 'string') return { encoding: 'utf8', data: value };
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') };
  return null;
}

// An answer's bytes: text comes back as a string, anything else as a Buffer,
// the way the caller handed them in.
function decodeBytes(value) {
  if (!value) return null;
  if (value.encoding === 'base64') return Buffer.from(value.data, 'base64');
  return value.data;
}

// A document's bytes are always a Buffer to a reader, whatever the answer said.
function decodeReadBytes(value) {
  if (!value) return null;
  if (value.encoding === 'base64') return Buffer.from(value.data, 'base64');
  return Buffer.from(value.data, 'utf8');
}

function sendable(value) {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return false;
  return value !== undefined;
}

function bodyFor(request) {
  const body = {};
  for (const [key, value] of Object.entries(request)) {
    if (UNSENDABLE.has(key) || !sendable(value)) continue;
    body[key] = key === 'bytes' ? encodeBytes(value) : value;
  }
  return body;
}

function transportError(error, opId) {
  const failure = new Error(`the Go document host is unreachable: ${error && error.message ? error.message : error}`);
  failure.code = 'host-unreachable';
  if (opId) failure.opId = opId;
  return failure;
}

function answerError(answer, opId) {
  let message = `the Go document host answered ${answer.status}`;
  try {
    const parsed = JSON.parse(answer.body.toString('utf8'));
    if (parsed && typeof parsed.error === 'string') message = parsed.error;
  } catch {
    // A body that is not JSON leaves the status as the message.
  }
  const error = new Error(message);
  error.status = answer.status;
  if (opId) error.opId = opId;
  return error;
}

function createGoDocumentHost({ ctx }) {
  function rootId(root = ctx.root) {
    const connection = getConnection();
    if (typeof root === 'string') {
      if (!Object.values(connection.roots).includes(root)) {
        throw new Error(`the Go document host does not serve ${root}`);
      }
      return root;
    }
    const real = realpathSync(root.path);
    const id = connection.roots[real] ?? connection.roots[root.path];
    if (!id) throw new Error(`the Go document host does not serve ${root.path}`);
    return id;
  }

  async function request(method, pathname, { body = null, opId = null } = {}) {
    const connection = getConnection();
    const url = new URL(pathname, connection.url);
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    let answer;
    try {
      answer = await new Promise((resolve, reject) => {
        const headers = { authorization: `Bearer ${connection.secret}` };
        if (payload) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(payload.length);
        }
        const req = http.request(url, { method, headers }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    } catch (error) {
      throw transportError(error, opId);
    }
    if (answer.status !== 200) throw answerError(answer, opId);
    if (answer.body.length === 0) return null;
    return JSON.parse(answer.body.toString('utf8'));
  }

  async function commit(request_) {
    if (!request_ || !Object.hasOwn(KINDS, request_.kind)) {
      throw new TypeError(`Unknown document write kind: ${request_ && request_.kind}`);
    }
    if (request_.hooks) throw new TypeError('hooks ended in M16');
    const opId = randomBytes(16).toString('hex');
    countKind(request_.kind).adapter += 1;
    const answer = await request('POST', '/v1/commit', {
      body: { opId, root: rootId(), ...bodyFor(request_) },
      opId,
    });
    const result = {
      outcome: answer.outcome,
      reason: answer.reason ?? null,
      etag: answer.etag ?? null,
      stored: decodeBytes(answer.stored),
      content: decodeBytes(answer.content),
    };
    if (answer.checksum !== null && answer.checksum !== undefined) result.checksum = answer.checksum;
    if (result.outcome === 'indeterminate') {
      const error = new Error(`${request_.kind} of ${request_.name} may not have landed`);
      error.code = result.reason ?? 'after-rename';
      error.opId = opId;
      Object.defineProperty(result, 'error', { value: error, enumerable: false });
    }
    return result;
  }

  async function read(name) {
    const query = `?root=${encodeURIComponent(rootId())}&name=${encodeURIComponent(name)}`;
    const answer = await request('GET', `/v1/read${query}`);
    if (!answer || answer.exists !== true) return null;
    return { bytes: decodeReadBytes(answer.bytes), checksum: answer.checksum ?? null };
  }

  async function restructure({ kind, steps = [] } = {}) {
    if (!Object.hasOwn(STRUCTURE_KINDS, kind)) throw new TypeError(`Unknown structure kind: ${kind}`);
    const opId = randomBytes(16).toString('hex');
    const answer = await request('POST', '/v1/restructure', {
      body: {
        opId,
        root: rootId(),
        kind,
        steps: steps.map((step) => ({ from: step.from, to: step.to })),
      },
      opId,
    });
    const result = { outcome: answer.outcome, completed: answer.completed, reason: answer.reason ?? null };
    if (result.outcome !== 'committed') {
      const error = new Error(`restructure ${kind} did not complete: ${result.reason}`);
      error.code = result.reason ?? 'failed';
      error.opId = opId;
      Object.defineProperty(result, 'error', { value: error, enumerable: false });
    }
    return result;
  }

  async function pageState({ op, name, to = null, record = null } = {}) {
    const opId = randomBytes(16).toString('hex');
    await request('POST', '/v1/page-state', {
      body: { opId, root: rootId(), op, name, to, record },
      opId,
    });
  }

  // G9b: what this root's server owes platform sync for one document, cleared as
  // it is read, the same shape getAndClearSnapshot answers in-process.
  async function takeSnapshot(name, root = ctx.root) {
    let answer;
    try {
      answer = await request('POST', '/v1/snapshot/take', {
        body: { root: rootId(root), name },
      });
    } catch (error) {
      if (error.status !== 404) throw error;
      const pending = new Error('pending G9b: Go has no /v1/snapshot/take yet');
      pending.code = 'pending-g9b';
      pending.status = 404;
      throw pending;
    }
    if (!answer) return null;
    if (answer.html === null || answer.html === undefined) {
      if (answer.userDriven === undefined) return null;
    }
    return { html: answer.html ?? null, userDriven: answer.userDriven };
  }

  async function checkpoint() {
    const error = new Error('checkpoint needs rooms');
    error.code = 'unsupported';
    throw error;
  }

  // One newline-delimited stream of the host's frames, resumed from the last
  // cursor it delivered after a drop, a restart or a failed connection.
  function events(since, listener) {
    let cursor = since ?? null;
    let served = null;
    let closed = false;
    let timer = null;
    let open = null;

    function schedule() {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, 250);
    }

    function handle(line) {
      if (!line.trim()) return;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      if (typeof frame.cursor === 'string') cursor = frame.cursor;
      if (frame.type === 'gap') {
        listener({ type: 'gap', since: frame.cursor });
        return;
      }
      if (frame.root !== undefined && frame.root !== served) return;
      if (frame.type === 'change') {
        listener({ type: 'change', event: frame.event, rel: frame.rel });
        return;
      }
      if (frame.type === 'commit' && frame.outcome === 'committed') {
        countKind(frame.kind).committed += 1;
      }
    }

    function connect() {
      if (closed) return;
      let connection;
      try {
        connection = getConnection();
        served = rootId();
      } catch {
        schedule();
        return;
      }
      const url = new URL('/v1/events', connection.url);
      if (cursor !== null) url.searchParams.set('since', cursor);
      const req = http.request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${connection.secret}`, accept: 'application/x-ndjson' },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          schedule();
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            handle(line);
            index = buffer.indexOf('\n');
          }
        });
        response.on('error', schedule);
        response.on('close', schedule);
        response.on('end', schedule);
      });
      open = req;
      req.on('error', schedule);
      req.end();
    }

    connect();

    return function unsubscribe() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (open) {
        open.destroy();
        open = null;
      }
    };
  }

  return {
    commit, read, restructure, checkpoint, events, pageState, takeSnapshot, isGoDocumentHost: true,
  };
}

module.exports = { createGoDocumentHost, adapterCounts };
