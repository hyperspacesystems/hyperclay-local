#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const expressEtag = createRequire(import.meta.url)('etag');

const JUDGED_FAMILIES = ['document', 'document-source', 'meta', 'api', 'upload'];
const EXTENDED_FAMILIES = ['listing', 'asset', 'versions'];
const MIN_COMPARED = 50;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;
const TRUNCATE = 2000;

const COMPARED_HEADERS = [
  'content-type',
  'etag',
  'location',
  'cache-control',
  'vary',
  'retry-after',
  'page-revision',
  'x-content-type-options',
  'set-cookie',
  'content-disposition',
  'last-modified',
  'accept-ranges',
  'x-powered-by',
];

const SKIP_NAMES = new Set(['.hyperclay', '.trash', '.git']);
// AD1: the extensions the native Go trial host may leave out. It has no rooms, so it
// announces nothing that needs one: no `live-*` name, and no `sync-worker-data`, whose
// worker carries each editing tab's room events and roster. The list is subtracted from
// Local's own, so the trial can never ask for less than Local does anywhere else.
const AD1_DROP = new Set(['format', 'scoped-stylesheet', 'presence', 'sync-worker-data']);

export function ad1Allows(name) {
  return AD1_DROP.has(name) || (typeof name === 'string' && name.startsWith('live-'));
}

export { JUDGED_FAMILIES, EXTENDED_FAMILIES };

function encodePath(rel) {
  return rel.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function walk(root) {
  const files = [];
  const dirs = [];
  const visit = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_NAMES.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push(childRel);
        visit(path.join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  visit(root, '');
  return { files, dirs };
}

export function buildRequests(root) {
  const { files, dirs } = walk(root);
  const requests = [];
  const push = (family, urlPath, headers = {}) => {
    requests.push({
      family,
      method: 'GET',
      path: urlPath,
      headers,
      judged: JUDGED_FAMILIES.includes(family),
    });
  };

  const documents = files.filter((rel) => /\.(html|htmlclay)$/i.test(rel));
  const uploads = files.filter((rel) => rel.startsWith('uploads/'));
  const assets = files.filter((rel) => !documents.includes(rel) && !rel.startsWith('uploads/'));

  for (const rel of documents) {
    const encoded = encodePath(rel);
    const urlPath = `/${encoded}`;
    push('document', urlPath, {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    });
    push('document-source', urlPath, {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Clay-Source': '1',
    });
    push('meta', '/_/meta', { 'Document-URL': `<origin>/${encoded}` });
    push('api', `/_/api/${encoded}`);
  }

  for (const rel of uploads) {
    push('upload', `/_/uploads/${encodePath(rel.slice('uploads/'.length))}`);
  }

  push('listing', '/');
  for (const dir of dirs) push('listing', `/${encodePath(dir)}/`);
  for (const rel of assets) push('asset', `/${encodePath(rel)}`);
  for (const rel of documents) push('versions', `/_/versions/${encodePath(rel)}`);

  const rank = (request) => {
    const familyRank = request.judged
      ? JUDGED_FAMILIES.indexOf(request.family)
      : JUDGED_FAMILIES.length + EXTENDED_FAMILIES.indexOf(request.family);
    return [request.judged ? 0 : 1, familyRank, request.path];
  };
  requests.sort((x, y) => {
    const rx = rank(x);
    const ry = rank(y);
    for (let i = 0; i < rx.length; i += 1) {
      if (rx[i] < ry[i]) return -1;
      if (rx[i] > ry[i]) return 1;
    }
    return 0;
  });
  return requests;
}

function listSha256(requests) {
  const lines = requests
    .filter((request) => request.judged)
    .map((request) => `${request.method} ${request.path} ${JSON.stringify(request.headers)}`);
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function sideOrigins(rawUrl) {
  const url = new URL(rawUrl);
  const hosts = new Set([url.hostname]);
  if (url.hostname === '127.0.0.1') hosts.add('localhost');
  if (url.hostname === 'localhost') hosts.add('127.0.0.1');
  const origins = [];
  for (const host of hosts) origins.push(`http://${host}${url.port ? `:${url.port}` : ''}`);
  return origins.sort((x, y) => y.length - x.length);
}

function sideOf(rawUrl) {
  return { url: rawUrl.replace(/\/+$/, ''), origin: new URL(rawUrl).origin, origins: sideOrigins(rawUrl) };
}

function fetchSide(side, request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = value.replaceAll('<origin>', side.origin);
    }
    const target = new URL(side.url + request.path);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { method: request.method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const collected = {};
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const key = res.rawHeaders[i].toLowerCase();
          if (key === 'set-cookie') continue;
          const value = res.rawHeaders[i + 1];
          collected[key] = collected[key] === undefined ? value : `${collected[key]}, ${value}`;
        }
        const cookies = res.headers['set-cookie'];
        if (Array.isArray(cookies) && cookies.length) {
          collected['set-cookie'] = cookies.slice().sort().join('\n');
        }
        finish({
          ok: true,
          status: res.statusCode,
          headers: collected,
          body: Buffer.concat(chunks).toString('latin1'),
        });
      });
      res.on('error', (error) => finish({ ok: false, error }));
    });
    req.setTimeout(TIMEOUT_MS, () => {
      const error = new Error(`timeout after ${TIMEOUT_MS} ms`);
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    req.on('error', (error) => finish({ ok: false, error }));
    req.end();
  });
}

function isUnreachable(error) {
  const codes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN']);
  if (error && codes.has(error.code)) return true;
  let cause = error && error.cause;
  const seen = new Set();
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    if (cause.code && codes.has(cause.code)) return true;
    cause = cause.cause;
  }
  return false;
}

function isHtml(headers) {
  return String(headers['content-type'] || '').toLowerCase().includes('text/html');
}

function stripSavetoken(body) {
  const match = /<html(?=[\s>])[^>]*>/i.exec(body);
  if (!match) return body;
  const start = match.index;
  const tag = match[0];
  const stripped = tag.replace(/\ssavetoken\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
  if (stripped === tag) return body;
  return body.slice(0, start) + stripped + body.slice(start + tag.length);
}

function stripMetaExtensions(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.extensions)) return null;
  const before = parsed.extensions.length;
  parsed.extensions = parsed.extensions.filter(
    (name) => !ad1Allows(name),
  );
  if (parsed.extensions.length === before) return null;
  return JSON.stringify(parsed);
}

function truncate(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.length <= TRUNCATE) return text;
  return `${text.slice(0, TRUNCATE)}…[${text.length - TRUNCATE} more characters]`;
}

// Express derives a JSON or text answer's ETag from its body, so when a normalization
// rewrites the body, an ETag that was the hash of the original body is recomputed over
// the normalized one. Any other ETag is left as the host sent it.
function followBodyEtag(response, original) {
  if (!response.ok || original === null || response.body === original) return;
  const tag = response.headers.etag;
  if (!tag) return;
  for (const weak of [true, false]) {
    if (tag === expressEtag(Buffer.from(original, 'latin1'), { weak })) {
      response.headers.etag = expressEtag(Buffer.from(response.body, 'latin1'), { weak });
      return;
    }
  }
}

function applyNormalization(request, responseA, responseB, sideA, sideB, allowances, stage) {
  const originalA = responseA.ok ? responseA.body : null;
  const originalB = responseB.ok ? responseB.body : null;
  normalizeBodies(request, responseA, responseB, sideA, sideB, allowances, stage);
  followBodyEtag(responseA, originalA);
  followBodyEtag(responseB, originalB);
}

function normalizeBodies(request, responseA, responseB, sideA, sideB, allowances, stage) {
  for (const [response, side] of [[responseA, sideA], [responseB, sideB]]) {
    if (!response.ok) continue;
    let changed = false;
    for (const origin of side.origins) {
      if (response.body.includes(origin)) {
        response.body = response.body.split(origin).join('<origin>');
        changed = true;
      }
      const location = response.headers.location;
      if (location && location.includes(origin)) {
        response.headers.location = location.split(origin).join('<origin>');
        changed = true;
      }
    }
    if (changed) allowances.origin += 1;
  }

  for (const response of [responseA, responseB]) {
    if (!response.ok || !isHtml(response.headers)) continue;
    const stripped = stripSavetoken(response.body);
    if (stripped !== response.body) {
      response.body = stripped;
      allowances.AD4 += 1;
    }
  }

  if (stage === 'native') {
    if (request.family === 'meta') {
      const stripped = responseA.ok ? stripMetaExtensions(responseA.body) : null;
      if (stripped !== null) {
        responseA.body = stripped;
        allowances.AD1 += 1;
      }
    }

    if (responseA.ok && Object.prototype.hasOwnProperty.call(responseA.headers, 'page-revision')) {
      delete responseA.headers['page-revision'];
      allowances.AD3 += 1;
    }
  }
}

function addDifference(list, request, field, a, b) {
  list.push({
    family: request.family,
    path: request.path,
    field,
    a: truncate(a),
    b: truncate(b),
  });
}

function compareOne(request, responseA, responseB, sideA, sideB, allowances, differences, stage) {
  if (!responseA.ok || !responseB.ok) {
    addDifference(
      differences,
      request,
      'transport',
      responseA.ok ? `ok ${responseA.status}` : String(responseA.error && responseA.error.message),
      responseB.ok ? `ok ${responseB.status}` : String(responseB.error && responseB.error.message),
    );
    return;
  }
  applyNormalization(request, responseA, responseB, sideA, sideB, allowances, stage);
  if (responseA.status !== responseB.status) {
    addDifference(differences, request, 'status', responseA.status, responseB.status);
  }
  if (responseA.body !== responseB.body) {
    addDifference(differences, request, 'body', responseA.body, responseB.body);
  }
  for (const name of COMPARED_HEADERS) {
    const valueA = responseA.headers[name];
    const valueB = responseB.headers[name];
    if (valueA === valueB) continue;
    addDifference(differences, request, name, valueA === undefined ? '<absent>' : valueA, valueB === undefined ? '<absent>' : valueB);
  }
}

export async function compare({ a, b, requests, stage = 'native' }) {
  const sideA = sideOf(a);
  const sideB = sideOf(b);
  const allowances = { origin: 0, AD1: 0, AD3: 0, AD4: 0 };
  const judged = { compared: 0, families: {}, differences: [] };
  const extended = { compared: 0, families: {}, differences: [] };
  for (const family of JUDGED_FAMILIES) judged.families[family] = 0;
  for (const family of EXTENDED_FAMILIES) extended.families[family] = 0;

  const list = requests;
  for (const request of list) {
    if (request.judged) judged.compared += 1;
    else extended.compared += 1;
  }

  const responses = new Array(list.length);
  const probe = async (index) => {
    const request = list[index];
    const responseA = await fetchSide(sideA, request);
    if (!responseA.ok && isUnreachable(responseA.error)) {
      const error = new Error(`cannot reach A at ${a}: ${responseA.error.message}`);
      error.exitCode = 2;
      throw error;
    }
    const responseB = await fetchSide(sideB, request);
    if (!responseB.ok && isUnreachable(responseB.error)) {
      const error = new Error(`cannot reach B at ${b}: ${responseB.error.message}`);
      error.exitCode = 2;
      throw error;
    }
    responses[index] = { responseA, responseB };
  };

  if (list.length) await probe(0);

  let cursor = 1;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      const request = list[index];
      responses[index] = {
        responseA: await fetchSide(sideA, request),
        responseB: await fetchSide(sideB, request),
      };
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, Math.max(list.length - 1, 0)); i += 1) workers.push(worker());
  await Promise.all(workers);

  list.forEach((request, index) => {
    const { responseA, responseB } = responses[index];
    const bucket = request.judged ? judged : extended;
    if (request.judged) judged.families[request.family] += 1;
    else extended.families[request.family] += 1;
    compareOne(request, responseA, responseB, sideA, sideB, allowances, bucket.differences, stage);
  });

  return {
    requestListSha256: listSha256(list),
    judged,
    extended,
    allowances,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--a' || token === '--b' || token === '--root' || token === '--out' || token === '--stage') {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      return { error: `unknown argument ${token}` };
    }
  }
  for (const name of ['a', 'b', 'root', 'out']) {
    if (!args[name]) return { error: `missing --${name}` };
  }
  args.stage = args.stage ?? 'native';
  if (args.stage !== 'native' && args.stage !== 'full') {
    return { error: `--stage must be native or full, not ${args.stage}` };
  }
  let baseA;
  let baseB;
  try {
    baseA = new URL(args.a);
    baseB = new URL(args.b);
  } catch {
    return { error: '--a and --b must be absolute URLs' };
  }
  if (!/^https?:$/.test(baseA.protocol) || !/^https?:$/.test(baseB.protocol)) {
    return { error: '--a and --b must be http or https URLs' };
  }
  let stat;
  try {
    stat = fs.statSync(args.root);
  } catch {
    return { error: `root does not exist: ${args.root}` };
  }
  if (!stat.isDirectory()) return { error: `root is not a directory: ${args.root}` };
  return { args };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  const { a, b, root, out, stage } = parsed.args;
  const requests = buildRequests(root);
  let result;
  try {
    result = await compare({ a, b, requests, stage });
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(error.exitCode || 2);
  }

  fs.mkdirSync(out, { recursive: true });
  const base = {
    a, b, root, stage, requestListSha256: result.requestListSha256,
  };
  const judgedDoc = {
    ...base,
    compared: result.judged.compared,
    families: result.judged.families,
    allowances: result.allowances,
    differences: result.judged.differences,
  };
  const extendedDoc = {
    ...base,
    compared: result.extended.compared,
    families: result.extended.families,
    allowances: result.allowances,
    differences: result.extended.differences,
  };
  fs.writeFileSync(path.join(out, 'differences.json'), `${JSON.stringify(judgedDoc, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'differences-extended.json'), `${JSON.stringify(extendedDoc, null, 2)}\n`);

  const reasons = [];
  if (judgedDoc.differences.length) {
    reasons.push(`${judgedDoc.differences.length} difference(s) in judged families`);
  }
  if (judgedDoc.compared < MIN_COMPARED) {
    reasons.push(`only ${judgedDoc.compared} requests compared (need at least ${MIN_COMPARED})`);
  }
  for (const family of JUDGED_FAMILIES) {
    if (!judgedDoc.families[family]) reasons.push(`judged family ${family} had no requests`);
  }
  if (reasons.length) {
    for (const reason of reasons) console.log(reason);
    process.exit(1);
  }
  console.log(`ok: ${judgedDoc.compared} requests compared, no differences`);
  process.exit(0);
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
