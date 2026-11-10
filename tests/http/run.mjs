#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CASES, PENDING } from './cases/index.mjs';

const CASE_DEADLINE_MS = 20000;
const RECORDED_HEADERS = [
  'content-type',
  'etag',
  'location',
  'cache-control',
  'vary',
  'retry-after',
  'page-revision',
  'x-content-type-options',
];

function refuse(message) {
  process.stderr.write(`http run: ${message}\n`);
  process.exit(3);
}

function parseArgs(argv) {
  const args = { url: null, fixtures: null, profile: null, report: null, cases: [], requireComplete: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--url' || flag === '--fixtures' || flag === '--profile' || flag === '--report' || flag === '--case') {
      if (value === undefined) refuse(`${flag} needs a value`);
      if (flag === '--case') args.cases.push(value);
      else args[flag.slice(2)] = value;
      i += 1;
    } else if (flag === '--require-complete') {
      args.requireComplete = true;
    } else {
      refuse(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) refuse(`missing manifest: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    refuse(`manifest is not valid JSON: ${manifestPath} (${error.message})`);
  }
  if (!manifest || typeof manifest !== 'object' || manifest.schema !== 1) {
    refuse(`unsupported manifest schema: ${JSON.stringify(manifest && manifest.schema)}`);
  }
  if (!Array.isArray(manifest.roots) || !manifest.control || typeof manifest.control.url !== 'string' ||
      typeof manifest.control.token !== 'string' || !manifest.hostBuild) {
    refuse(`incomplete manifest: ${manifestPath}`);
  }
  return manifest;
}

function selectCases(args, manifest) {
  const profile = args.profile ?? manifest.expectedProfile;
  if (typeof profile !== 'string' || profile.length === 0) refuse('missing profile: pass --profile');

  const byId = new Map();
  for (const definition of CASES) {
    if (!definition || typeof definition.id !== 'string' || !definition.id) refuse('a case has no id');
    if (byId.has(definition.id)) refuse(`duplicate case id: ${definition.id}`);
    byId.set(definition.id, definition);
  }
  const pendingIds = new Set();
  for (const entry of PENDING) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.why !== 'string') {
      refuse('a pending entry is malformed');
    }
    if (pendingIds.has(entry.id)) refuse(`duplicate pending id: ${entry.id}`);
    if (byId.has(entry.id)) refuse(`case id is both in CASES and PENDING: ${entry.id}`);
    pendingIds.add(entry.id);
  }

  for (const id of args.cases) {
    if (!byId.has(id) && !pendingIds.has(id)) refuse(`unknown case id: ${id}`);
  }

  const profileCases = CASES.filter((definition) =>
    Array.isArray(definition.profiles) && definition.profiles.includes(profile));
  const wanted = args.cases.length ? new Set(args.cases) : null;
  const selected = wanted ? profileCases.filter((definition) => wanted.has(definition.id)) : profileCases.slice();
  if (selected.length === 0) refuse(`empty case selection for profile ${profile}`);
  return { profile, selected, profileCases };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileHash(manifest, rootId, docPath) {
  const root = manifest.roots.find((entry) => entry && entry.id === rootId);
  if (!root || typeof root.fixtureRoot !== 'string') return null;
  const base = path.resolve(root.fixtureRoot);
  const target = path.resolve(base, docPath);
  if (!target.startsWith(base + path.sep)) return null;
  try {
    return sha256(fs.readFileSync(target));
  } catch {
    return null;
  }
}

function makeContext({ manifest, overrideUrl, requests, seeded, signal }) {
  const rootUrl = (rootId) => {
    if (rootId === 'root-a' && overrideUrl) return overrideUrl;
    const root = manifest.roots.find((entry) => entry && entry.id === rootId);
    if (!root) throw new Error(`manifest has no root: ${rootId}`);
    return root.url;
  };

  const control = async (route, options = {}) => {
    const response = await fetch(`${manifest.control.url}${route}`, {
      ...options,
      headers: { authorization: `Bearer ${manifest.control.token}`, ...(options.headers || {}) },
      signal,
    });
    if (response.status !== 200) throw new Error(`control ${route} answered ${response.status}`);
    return response.json();
  };

  return {
    manifest,
    signal,
    rootUrl,
    host: 'hyperclay-local',

    // The package engine has no version listing of its own; its alias cases ask the
    // host through this hook.
    async versions(context, dirPath) {
      const answer = await context.controlRequest(
        `/list?root=${encodeURIComponent('root-a')}&path=${encodeURIComponent(dirPath)}`,
      );
      if (answer.status !== 200) throw new Error(`control list of ${dirPath}: ${answer.status}`);
      return answer.body.exists ? answer.body.entries : [];
    },

    async seed(rootId, docPath, text) {
      const bytes = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''), 'utf8');
      const answer = await control('/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: rootId, path: docPath, base64: bytes.toString('base64') }),
      });
      seeded.push({ root: rootId, path: docPath, sha256: answer.sha256 });
      return { sha256: answer.sha256 };
    },

    async read(rootId, docPath) {
      const answer = await control(
        `/read?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(docPath)}`,
      );
      if (!answer.exists) return { exists: false, sha256: null, base64: null, bytes: null, text: null };
      const bytes = Buffer.from(answer.base64, 'base64');
      return { exists: true, sha256: answer.sha256, base64: answer.base64, bytes, text: bytes.toString('utf8') };
    },

    async controlRequest(route, { method = 'GET', body = null } = {}) {
      const response = await fetch(`${manifest.control.url}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${manifest.control.token}`,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      return { status: response.status, body: parsed };
    },

    async http(rootId, method, requestPath, options = {}) {
      const url = `${rootUrl(rootId)}${requestPath}`;
      const response = await fetch(url, {
        method,
        headers: options.headers || {},
        body: options.body,
        signal,
        redirect: 'manual',
      });
      const text = await response.text();
      const headers = {};
      for (const name of RECORDED_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      requests.push({ root: rootId, method, path: requestPath, status: response.status, headers });
      const setCookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
      return {
        status: response.status,
        headers,
        setCookie,
        text,
        header(name) {
          return headers[String(name).toLowerCase()] ?? null;
        },
        json() {
          return text ? JSON.parse(text) : null;
        },
      };
    },
  };
}

async function runCase(definition, env) {
  const requests = [];
  const seeded = [];
  const controller = new AbortController();
  const ctx = makeContext({ ...env, requests, seeded, signal: controller.signal });
  let deadline = null;
  let status = 'pass';
  let detail = 'ok';
  try {
    await Promise.race([
      Promise.resolve().then(() => definition.run(ctx)),
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new Error(`case deadline exceeded (${CASE_DEADLINE_MS} ms)`));
        }, CASE_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    status = 'fail';
    detail = error && error.message ? error.message : String(error);
  } finally {
    if (deadline) clearTimeout(deadline);
    controller.abort();
  }

  const primary = seeded[0] || null;
  return {
    id: definition.id,
    status,
    detail,
    requests,
    before: primary ? primary.sha256 : null,
    after: primary ? fileHash(env.manifest, primary.root, primary.path) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixtures) refuse('--fixtures is required');
  const manifest = readManifest(path.resolve(args.fixtures));
  const { profile, selected, profileCases } = selectCases(args, manifest);

  const startedAt = new Date().toISOString();
  const results = [];
  for (const definition of selected) {
    results.push(await runCase(definition, { manifest, overrideUrl: args.url }));
  }
  const finishedAt = new Date().toISOString();

  const passed = results.filter((entry) => entry.status === 'pass').length;
  const failed = results.filter((entry) => entry.status !== 'pass').length;
  const ranIds = new Set(results.map((entry) => entry.id));
  const complete = PENDING.length === 0 && profileCases.every((definition) => ranIds.has(definition.id));

  const report = {
    schema: 1,
    hostBuild: manifest.hostBuild,
    profile,
    startedAt,
    finishedAt,
    cases: results,
    pending: PENDING.map((entry) => ({ id: entry.id, why: entry.why })),
    summary: { pass: passed, fail: failed, pending: PENDING.length },
    complete,
  };

  if (args.report) {
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  for (const entry of results) {
    if (entry.status !== 'pass') process.stderr.write(`http run: fail ${entry.id}: ${entry.detail}\n`);
  }
  process.stdout.write(
    `http run: ${passed} passed, ${failed} failed, ${PENDING.length} pending ` +
    `(${results.length}/${profileCases.length} cases, profile ${profile}, complete=${complete})\n`,
  );

  if (failed > 0) process.exit(1);
  if (args.requireComplete && !complete) process.exit(3);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`http run: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
