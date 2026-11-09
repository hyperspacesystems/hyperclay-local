import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual } from './support.mjs';

const PROFILES = ['local-full'];

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'frozen-client');
const fixturePath = path.join(fixtureDir, 'minimal.htmlclay');
const readmePath = path.join(fixtureDir, 'README.md');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fixtureBytes() {
  return fs.readFileSync(fixturePath);
}

function readmeHash() {
  const recorded = fs.readFileSync(readmePath, 'utf8').match(/sha256:\s*\*?`?([0-9a-f]{64})/);
  assert(recorded, 'the fixture README records a sha256');
  return recorded[1];
}

// The fixture's script reads the token off the root element and builds its request
// from it: `fetch('/_/save/' + token, { method: 'POST', headers: { 'Content-Type':
// 'text/html' }, body: html })`. Read the call out of the script rather than
// restating it here, so the case sends what the client sends.
function scriptRequest() {
  const text = fixtureBytes().toString('utf8');
  const call = text.match(/fetch\(\s*'([^']*)'\s*\+\s*token\s*,\s*\{([\s\S]*?)\}\s*\)\s*;/);
  assert(call, 'the fixture script builds a fetch call over a token');
  const method = call[2].match(/method:\s*'([^']+)'/);
  assertEqual(method && method[1], 'POST', 'the fixture script posts');
  const contentType = call[2].match(/'Content-Type':\s*'([^']+)'/);
  assert(contentType, 'the fixture script sets a Content-Type');
  return { target: call[1], headers: { 'Content-Type': contentType[1] } };
}

function servedToken(html) {
  const root = html.match(/<html\b([^>]*)>/i);
  assert(root, 'the served page has an html element');
  for (const name of ['savetoken', 'htmlclaytoken']) {
    const found = root[1].match(new RegExp(`\\b${name}="([^"]*)"`));
    if (found) return found[1];
  }
  return null;
}

async function listVersions(ctx, dirPath) {
  const answer = await ctx.controlRequest(
    `/list?root=${encodeURIComponent('root-a')}&path=${encodeURIComponent(dirPath)}`,
  );
  assertEqual(answer.status, 200, `control list of ${dirPath}`);
  return answer.body.exists ? answer.body.entries : [];
}

export const ALIAS_CASES = [
  {
    id: 'alias.frozen-client',
    profiles: PROFILES,
    // A real inline save client from HTML Clay's history (fixtures/frozen-client)
    // reads `savetoken` or `htmlclaytoken` off the root element and posts the whole
    // document to `/_/save/<token>`. This host serves no token lane, so that address
    // answers 404 and nothing is written. A host that grows a token lane will answer
    // differently: the comparison (`http compare`) reports that row as a difference
    // rather than this suite hiding it.
    async run(ctx) {
      assertEqual(sha256(fixtureBytes()), readmeHash(), 'the frozen client fixture matches its README');

      const docPath = 'alias/frozen-client.html';
      await ctx.seed('root-a', docPath, fixtureBytes());
      const before = await ctx.read('root-a', docPath);
      const versionsPath = `.hyperclay/versions/${docPath.replace(/\.html$/, '')}`;
      const versionsBefore = await listVersions(ctx, versionsPath);

      const served = await ctx.http('root-a', 'GET', `/${docPath}`);
      assertEqual(served.status, 200, 'the served page');
      const injected = servedToken(served.text);
      // This host injects no token attribute, so the script would concatenate its
      // null token into the path. A literal placeholder names the same address.
      const token = injected ?? 'no-token';
      const request = scriptRequest();

      const response = await ctx.http('root-a', 'POST', `${request.target}${token}`, {
        headers: request.headers,
        body: `<!DOCTYPE html>\n${served.text}`,
      });
      assertEqual(response.status, 404, `the token lane ${request.target}${token}`);

      const after = await ctx.read('root-a', docPath);
      assertEqual(after.sha256, before.sha256, 'the frozen client left the document bytes unchanged');
      const versionsAfter = await listVersions(ctx, versionsPath);
      assertEqual(versionsAfter.length, versionsBefore.length, 'the frozen client minted no version');
      assertEqual(JSON.stringify(versionsAfter), JSON.stringify(versionsBefore), 'the versions folder is unchanged');
    },
  },
];
