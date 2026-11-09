import crypto from 'node:crypto';

import {
  assert,
  assertEqual,
  bodyJson,
  documentUrl,
  htmlDocument,
  saveDocument,
} from './support.mjs';

const PROFILES = ['local-full'];

// The name src/main/utils/backup.js mints for a version: LOCAL wall time plus the
// signed UTC offset in force at that moment, e.g. `2026-11-01-01-30-00-431-0400.html`
// (backup.js:41-52, published by publishVersion at backup.js:136-191).
function versionName(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absMinutes / 60))}${pad(absMinutes % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}${offset}.html`;
}

// The same shape the host itself accepts and prints back as `time`.
const VERSION_NAME_SHAPE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}(?:Z|[+-]\d{4})(?:-\d{3})?\.html$/;

function versionInstant(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})([+-])(\d{2})(\d{2})\.html$/.exec(name);
  assert(match, `seeded version name ${name} is not the format the host mints`);
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}` +
    `${match[8]}${match[9]}:${match[10]}`;
  return new Date(iso).toISOString();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function uploadPart(ctx, rootId, headers, filename, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  return ctx.http(rootId, 'POST', '/_/upload', { headers, body: form });
}

// `requestPath` must be the root-relative URL the host answered with, unmodified.
async function fetchBytes(ctx, rootId, requestPath) {
  const response = await fetch(`${ctx.rootUrl(rootId)}${requestPath}`, {
    signal: ctx.signal,
    redirect: 'manual',
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes };
}

function uploadedFile(response, label) {
  assertEqual(response.status, 200, label);
  const body = bodyJson(response, label);
  assertEqual(body.msg, 'Uploaded', `${label} message`);
  assert(Array.isArray(body.uploads) && body.uploads.length === 1,
    `${label}: expected one upload, got ${JSON.stringify(body.uploads)}`);
  return body.uploads[0];
}

async function listVersions(ctx, rootId, docPath) {
  const response = await ctx.http(rootId, 'GET', `/_/versions/${docPath}`);
  assertEqual(response.status, 200, `versions list of ${docPath}`);
  const body = bodyJson(response, 'versions');
  assertEqual(body.ok, true, 'versions list ok');
  assert(Array.isArray(body.versions), 'versions list carries an array');
  return body.versions;
}

async function readVersion(ctx, rootId, docPath, name) {
  return ctx.http(rootId, 'GET', `/_/version/${docPath}/${encodeURIComponent(name)}`);
}

export const STORAGE_CASES = [
  {
    id: 'workspace.iframe-credential',
    profiles: PROFILES,
    // src/main/server.js:279-305 — a framed document is the same document: serveHtml
    // stamps WHAT IT SENDS with this host's `documentetag` (server.js:290, written by
    // utils/root-attrs.js:90-107) whatever Sec-Fetch-Dest asked for, and the host cookies
    // ride every response (server.js:1557-1562). That stamp is the credential /_/save
    // compares as If-Match (server.js:2607-2622), so a document carrying it can save.
    async run(ctx) {
      const docPath = 'iframe/credential.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('iframe-seed'));
      const served = await ctx.http('root-a', 'GET', `/${docPath}`, {
        headers: { 'sec-fetch-dest': 'iframe' },
      });
      assertEqual(served.status, 200, 'framed document status');
      assertEqual(served.header('content-type'), 'text/html; charset=utf-8', 'framed document type');
      assert(served.setCookie.some((value) => value.startsWith('isLoggedIn=')),
        `framed document did not carry the host cookies: ${JSON.stringify(served.setCookie)}`);
      const stamp = /documentetag="([0-9a-f]{16})"/.exec(served.text);
      assert(stamp, 'the framed document carried no saving credential (documentetag) on its root element');

      const saved = await saveDocument(ctx, 'root-a', docPath, htmlDocument('iframe-saved'), {
        'if-match': stamp[1],
        'save-id': 'iframe-credential-0001',
      });
      assertEqual(saved.status, 200, 'save with the credential the framed document carried');
      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes('iframe-saved'), 'the framed document saved with its own credential');
      assert(state.sha256 !== seeded.sha256, 'the save moved the bytes on');
    },
  },
  {
    id: 'upload.root-relative-url',
    profiles: PROFILES,
    // src/main/server.js:3160-3171 — an upload answers a root-relative host path, and
    // server.js:3228-3254 serves those bytes back from it.
    async run(ctx) {
      const docPath = 'uploads/root-relative.html';
      await ctx.seed('root-a', docPath, htmlDocument('upload-root-seed'));
      const bytes = Buffer.from(`root-relative upload ${Date.now()}`, 'utf8');
      const file = uploadedFile(
        await uploadPart(ctx, 'root-a', { 'document-url': documentUrl(ctx, 'root-a', docPath) }, 'note.txt', bytes),
        'upload',
      );
      assert(/^\/(?!\/)/.test(file.url), `upload url ${JSON.stringify(file.url)} is not root-relative`);
      assert(!file.url.includes('://'), `upload url ${JSON.stringify(file.url)} names an origin`);
      assert(/^\/_\/uploads\/assets-root-relative\//.test(file.url),
        `upload url ${JSON.stringify(file.url)} is not the uploads path this host serves`);
      assertEqual(file.bytes, bytes.length, 'upload byte count');

      const served = await fetchBytes(ctx, 'root-a', file.url);
      assertEqual(served.status, 200, `GET ${file.url}`);
      assert(served.bytes.equals(bytes), `GET ${file.url} did not return the uploaded bytes`);
    },
  },
  {
    id: 'upload.binary-bytes',
    profiles: PROFILES,
    // src/main/server.js:3109-3152 stores the part's bytes verbatim and server.js:3228-3254
    // hands the file back with sendFile: every byte value survives the round trip.
    async run(ctx) {
      const docPath = 'uploads/binary.html';
      await ctx.seed('root-a', docPath, htmlDocument('upload-binary-seed'));
      const bytes = Buffer.alloc(512);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
      const file = uploadedFile(
        await uploadPart(ctx, 'root-a', { 'document-url': documentUrl(ctx, 'root-a', docPath) }, 'bytes.bin', bytes),
        'binary upload',
      );
      assertEqual(file.bytes, bytes.length, 'binary upload byte count');
      const served = await fetchBytes(ctx, 'root-a', file.url);
      assertEqual(served.status, 200, `GET ${file.url}`);
      assertEqual(sha256(served.bytes), sha256(bytes), 'sha256 of the served bytes');
    },
  },
  {
    id: 'upload.nested-directories',
    profiles: PROFILES,
    // src/main/server.js:94-106 reads `Upload-Folder` when the request names no document,
    // 3054-3060 requires that folder to exist, and 3165-3167 answers the file where it sits.
    async run(ctx) {
      await ctx.seed('root-a', 'nested/deep/keep.txt', 'keep\n');
      const bytes = Buffer.from(`nested upload ${Date.now()}`, 'utf8');
      const file = uploadedFile(
        await uploadPart(ctx, 'root-a', { 'upload-folder': 'nested/deep' }, 'shot.png', bytes),
        'nested upload',
      );
      assertEqual(file.url.slice(0, '/nested/deep/'.length), '/nested/deep/', `nested upload url ${file.url}`);
      assert(file.url.endsWith(file.name), `nested upload url ${file.url} does not end in ${file.name}`);
      const onDisk = await ctx.read('root-a', `nested/deep/${file.name}`);
      assertIdenticalBytes(onDisk.bytes, bytes, 'the nested upload landed in the named folder');
      const served = await fetchBytes(ctx, 'root-a', file.url);
      assertEqual(served.status, 200, `GET ${file.url}`);
      assert(served.bytes.equals(bytes), `GET ${file.url} did not return the uploaded bytes`);
    },
  },
  {
    id: 'upload.missing-404',
    profiles: PROFILES,
    // src/main/server.js:3231-3244 (no file under uploads/) and 3048-3053 (no document to
    // upload to) both answer 404 rather than an empty body or a listing.
    async run(ctx) {
      const missing = await ctx.http('root-a', 'GET', '/_/uploads/assets-missing/no-such-file.png');
      assertEqual(missing.status, 404, 'GET of a missing upload path');

      const response = await uploadPart(
        ctx, 'root-a', { 'document-url': documentUrl(ctx, 'root-a', 'uploads/no-such-document.html') }, 'x.png', Buffer.from('x'),
      );
      assertEqual(response.status, 404, 'upload naming a document that does not exist');
      assertEqual(bodyJson(response, 'upload').code, 'not-found', 'upload refusal code');
    },
  },
  {
    id: 'upload.html-not-privileged',
    profiles: PROFILES,
    // src/main/server.js:3072-3074 refuses a document type at the upload route, and
    // 4049-4071 serves any page type that reaches an uploads folder as a download:
    // no embedded credential, and no document-shaped answer to save back into.
    async run(ctx) {
      const docPath = 'uploads/html.html';
      await ctx.seed('root-a', docPath, htmlDocument('upload-html-seed'));
      const refusal = await uploadPart(
        ctx, 'root-a', { 'document-url': documentUrl(ctx, 'root-a', docPath) }, 'evil.html', htmlDocument('uploaded-html'),
      );
      assertEqual(refusal.status, 415, 'uploading an HTML file');
      assertEqual(bodyJson(refusal, 'html upload').code, 'unsupported-type', 'HTML upload refusal code');

      const seeded = htmlDocument('dropped-in-html');
      await ctx.seed('root-a', 'uploads/assets-html/dropped-in.html', seeded);
      const served = await fetchBytes(ctx, 'root-a', '/_/uploads/assets-html/dropped-in.html');
      assertEqual(served.status, 200, 'GET of a page type inside an uploads folder');
      assertEqual(served.headers.get('content-disposition'), 'attachment', 'the page type is handed over as a download');
      assertEqual(served.headers.get('x-content-type-options'), 'nosniff', 'the page type is never sniffed');
      assert(!served.bytes.toString('latin1').includes('documentetag'),
        'the upload was served with a saving credential, so it is a privileged document');
      assert(served.bytes.equals(Buffer.from(seeded, 'utf8')), 'the served bytes are the stored bytes, unstamped');
    },
  },
  {
    id: 'root.isolation-document-url',
    profiles: PROFILES,
    // src/main/server.js:367-395 resolves Document-URL to a PATH only, and server.js:2514
    // resolves that path inside the root this request arrived on. The other root's origin
    // is never consulted, so its file can never be the target.
    async run(ctx) {
      const docPath = 'isolation/doc.html';
      await ctx.seed('root-a', docPath, htmlDocument('isolation-a'));
      const otherSeed = await ctx.seed('root-b', docPath, htmlDocument('isolation-b'));
      const otherBefore = await ctx.read('root-b', docPath);
      assertEqual(otherBefore.sha256, otherSeed.sha256, 'root B seed');

      const crossPath = await saveDocument(ctx, 'root-a', docPath, htmlDocument('isolation-saved'), {
        'document-url': documentUrl(ctx, 'root-b', docPath),
      });
      assertEqual(crossPath.status, 200, 'save to root A naming root B\'s document path');
      const otherAfter = await ctx.read('root-b', docPath);
      assertEqual(otherAfter.sha256, otherBefore.sha256, 'root B\'s file is untouched by a save to root A');
      assert(otherAfter.text.includes('isolation-b'), 'root B still holds its own bytes');

      const own = await ctx.read('root-a', docPath);
      assert(own.text.includes('isolation-saved'),
        'root A did not treat the borrowed path as its own; observed behaviour changed');

      const foreignOnly = 'isolation/only-in-a.html';
      const crossOrigin = await saveDocument(ctx, 'root-a', foreignOnly, htmlDocument('isolation-foreign'), {
        'document-url': documentUrl(ctx, 'root-b', foreignOnly),
      });
      assertEqual(crossOrigin.status, 200, 'save naming a path that exists only under root B\'s origin');
      const landed = await ctx.read('root-a', foreignOnly);
      assert(landed.exists && landed.text.includes('isolation-foreign'), 'root A wrote its own copy of the path');
      const notThere = await ctx.read('root-b', foreignOnly);
      assertEqual(notThere.exists, false, 'root B never received the file');
    },
  },
  {
    id: 'history.list-read-restore',
    profiles: PROFILES,
    // src/main/server.js:3335-3336 addresses `.hyperclay/versions/<document path without
    // extension>/`, 3390-3406 lists it, 3409-3430 serves one version's bytes and
    // 3433-3581 puts one back. The name has to be one backup.js mints (backup.js:41-52) or
    // the store ignores it (server.js:3344-3345, 3372-3377).
    async run(ctx) {
      const docPath = 'history/sample.html';
      await ctx.seed('root-a', docPath, htmlDocument('history-seed'));
      const name = versionName(new Date(Date.now() - 60000));
      const versionBytes = Buffer.from(htmlDocument('history-version'), 'utf8');
      await ctx.seed('root-a', `.hyperclay/versions/history/sample/${name}`, versionBytes);

      const listed = await listVersions(ctx, 'root-a', docPath);
      const entry = listed.find((item) => item.name === name);
      assert(entry, `the seeded version ${name} was not listed: ${JSON.stringify(listed.map((i) => i.name))}`);
      assertEqual(entry.time, versionInstant(name), `the host read ${name} as the instant its local time and offset encode`);
      assertEqual(entry.size, versionBytes.length, 'listed version size');
      assertEqual(entry.seq, 0, 'listed version collision suffix');
      assert(VERSION_NAME_SHAPE.test(name), `seeded version name ${name} is not the format the host mints`);

      const read = await readVersion(ctx, 'root-a', docPath, name);
      assertEqual(read.status, 200, `GET the version ${name}`);
      assertEqual(read.header('content-type'), 'text/html; charset=utf-8', 'version content type');
      assertEqual(read.header('cache-control'), 'no-store', 'version cache control');
      assert(read.text === versionBytes.toString('utf8'), 'the version route returned other bytes');

      const before = await ctx.read('root-a', docPath);
      const restore = await ctx.http('root-a', 'POST', `/_/restore/${docPath}/${encodeURIComponent(name)}`);
      assertEqual(restore.status, 200, `restore ${name}`);
      const restored = bodyJson(restore, 'restore');
      assertEqual(restored.ok, true, 'restore ok');
      assertEqual(restored.msg, `Restored ${name}`, 'restore message');

      const after = await ctx.read('root-a', docPath);
      assert(after.bytes.equals(versionBytes), 'the document did not become the restored version');
      assert(after.sha256 !== before.sha256, 'the restore did not change the document');

      const listedAfter = await listVersions(ctx, 'root-a', docPath);
      const minted = listedAfter.find((item) => !listed.some((old) => old.name === item.name));
      assert(minted, 'the restore left no safety version behind');
      assert(VERSION_NAME_SHAPE.test(minted.name),
        `the host's own version name ${minted.name} does not match the seeded one's format ${name}`);
    },
  },
  {
    id: 'history.restore-no-stale-save-id',
    profiles: PROFILES,
    // src/main/server.js:3527 writes the bytes it replaces as a safety version, and the
    // restore itself records no save receipt (server.js:194-200, 2645): the id a client
    // sent before the restore is not claimed for the restored bytes, so a retry under its
    // old stamp is a plain 412 with no saveId naming the old save.
    async run(ctx) {
      const docPath = 'history/receipt.html';
      const saveId = 'restore-receipt-0001';
      await ctx.seed('root-a', docPath, htmlDocument('receipt-seed'));

      const first = await saveDocument(ctx, 'root-a', docPath, htmlDocument('receipt-one'));
      assertEqual(first.status, 200, 'first save');
      const second = await saveDocument(ctx, 'root-a', docPath, htmlDocument('receipt-two'), {
        'if-match': bodyJson(first, 'first save').etag,
        'save-id': saveId,
      });
      assertEqual(second.status, 200, 'second save');
      const secondBody = bodyJson(second, 'second save');
      assertEqual(secondBody.saveId, saveId, 'the save echoed its own id');

      const meta = await ctx.http('root-a', 'GET', '/_/meta', {
        headers: { 'document-url': documentUrl(ctx, 'root-a', docPath) },
      });
      const receipt = bodyJson(meta, 'meta').document;
      assertEqual(receipt.etag, secondBody.etag, 'meta stamps the saved bytes');
      assertEqual(receipt.saveId, saveId, 'meta names the save that produced them');

      const versionBytes = Buffer.from(htmlDocument('receipt-version'), 'utf8');
      const name = versionName(new Date(Date.now() - 60000));
      await ctx.seed('root-a', `.hyperclay/versions/history/receipt/${name}`, versionBytes);

      const before = await ctx.read('root-a', docPath);
      const restore = await ctx.http('root-a', 'POST', `/_/restore/${docPath}/${encodeURIComponent(name)}`);
      assertEqual(restore.status, 200, `restore ${name}`);
      const restored = await ctx.read('root-a', docPath);
      assert(restored.bytes.equals(versionBytes), 'the document did not become the restored version');

      const listed = await listVersions(ctx, 'root-a', docPath);
      let safety = null;
      for (const entry of listed) {
        const read = await readVersion(ctx, 'root-a', docPath, entry.name);
        if (read.status !== 200) continue;
        if (sha256(Buffer.from(read.text, 'utf8')) === before.sha256) safety = entry;
      }
      assert(safety, 'no safety version holds the bytes the restore replaced');

      const afterMeta = await ctx.http('root-a', 'GET', '/_/meta', {
        headers: { 'document-url': documentUrl(ctx, 'root-a', docPath) },
      });
      const after = bodyJson(afterMeta, 'meta after restore').document;
      assert(after.etag !== receipt.etag, 'the restore moved the stamp');
      assertEqual(after.saveId, undefined, 'the restored document still carries an old Save-ID receipt');

      const retry = await saveDocument(ctx, 'root-a', docPath, htmlDocument('receipt-two'), {
        'if-match': secondBody.etag,
        'save-id': saveId,
      });
      assertEqual(retry.status, 412, 'retry under the pre-restore stamp');
      const retryBody = bodyJson(retry, 'retry');
      assertEqual(retryBody.code, 'conflict', 'retry code');
      assertEqual(retryBody.saveId, undefined, 'the refusal claimed the old save as landed');
      assertEqual(retryBody.etag, after.etag, 'the refusal names the restored stamp');
      const still = await ctx.read('root-a', docPath);
      assert(still.bytes.equals(versionBytes), 'the refused retry overwrote the restored document');
    },
  },
];

function assertIdenticalBytes(actual, expected, label) {
  assert(actual !== null && actual !== undefined, `${label}: nothing was written`);
  assert(actual.equals(expected), `${label}: stored bytes differ from the uploaded bytes`);
}
