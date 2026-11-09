import crypto from 'node:crypto';

import { assert, assertEqual, bodyJson } from './support.mjs';
import { pageDocument } from '../fixtures/page-document.mjs';
import { joinLiveClient } from './live-client.mjs';

const PROFILES = ['local-full'];
// Each run of this suite is its own process against one long-lived fixture, and the
// self test runs the whole profile twice. A page document carries room state between
// requests, so the cases name their own files per process rather than sharing one.
const RUN = crypto.randomBytes(4).toString('hex');

const apiPath = (docPath) => `/_/api/${docPath}`;

async function readData(ctx, rootId, docPath, label) {
  const response = await ctx.http(rootId, 'GET', apiPath(docPath));
  assertEqual(response.status, 200, `${label}: data read`);
  const etag = response.header('etag');
  const revision = response.header('page-revision');
  assert(typeof etag === 'string' && etag.length > 0, `${label}: data read carries an ETag`);
  assert(typeof revision === 'string' && revision.length > 0, `${label}: data read carries a Page-Revision`);
  return { etag, revision, data: bodyJson(response, label) };
}

async function writeData(ctx, rootId, docPath, data, headers, label) {
  return ctx.http(rootId, 'POST', apiPath(docPath), {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
}

async function listDir(ctx, rootId, dirPath) {
  const answer = await ctx.controlRequest(
    `/list?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(dirPath)}`,
  );
  assertEqual(answer.status, 200, `control list of ${dirPath}`);
  assertEqual(answer.body.exists, true, `${dirPath} exists`);
  return answer.body.entries;
}

export const PAGE_CASES = [
  {
    id: 'page.api-requires-both-preconditions',
    profiles: PROFILES,
    // src/main/server.js:3814-3826 — a write to a document that holds a page store
    // needs both Page-If-Match (the page revision) and If-Match (the document
    // stamp): a missing page revision is 428 revision-required, a missing stamp is
    // 428 etag-required, and neither refusal writes. With both it writes and answers
    // the new revision in Page-Revision (server.js:3849-3851).
    async run(ctx) {
      const docPath = `page/preconditions-${RUN}.html`;
      const doc = await pageDocument();
      await ctx.seed('root-a', docPath, doc.html);
      const current = await readData(ctx, 'root-a', docPath, 'page precondition read');
      const before = await ctx.read('root-a', docPath);

      const refused = [
        { label: 'write with neither precondition', headers: {}, code: 'revision-required' },
        { label: 'write with only If-Match', headers: { 'if-match': current.etag }, code: 'revision-required' },
        { label: 'write with only Page-If-Match', headers: { 'page-if-match': current.revision }, code: 'etag-required' },
      ];
      for (const attempt of refused) {
        const response = await writeData(ctx, 'root-a', docPath, { second: 'refused' }, attempt.headers, attempt.label);
        assertEqual(response.status, 428, `${attempt.label} is refused`);
        assertEqual(bodyJson(response, attempt.label).code, attempt.code, `${attempt.label} refusal code`);
        const after = await ctx.read('root-a', docPath);
        assertEqual(after.sha256, before.sha256, `${attempt.label} left the file unchanged`);
      }

      const accepted = await writeData(ctx, 'root-a', docPath, { second: 'written' }, {
        'if-match': current.etag,
        'page-if-match': current.revision,
      }, 'write with both preconditions');
      assertEqual(accepted.status, 200, 'write with both preconditions is accepted');
      const written = bodyJson(accepted, 'write with both preconditions');
      assertEqual(written.second, 'written', 'the accepted write landed');
      const revision = accepted.header('page-revision');
      assert(typeof revision === 'string' && revision.length > 0, 'the accepted write answers a Page-Revision');
      assert(revision !== current.revision, 'the accepted write answers the new page revision');
      const stored = await ctx.read('root-a', docPath);
      assert(stored.text.includes('>written<'), 'the accepted write changed the file');
    },
  },
  {
    id: 'page.api-stale-refused',
    profiles: PROFILES,
    // src/main/server.js:3837-3840 — the page revision the caller names is compared
    // under the held room, and an older one is 409 revision-stale with the current
    // Page-Revision, before any commit: the file, the versions folder
    // (server.js:3335-3336 addresses `.hyperclay/versions/<path without extension>/`)
    // and the page sidecar (utils/artifact-paths.js PAGE_STATE_DIR, written by
    // page-state-store.js) all stay exactly as they were.
    async run(ctx) {
      const docPath = `page/stale-${RUN}.html`;
      const doc = await pageDocument();
      await ctx.seed('root-a', docPath, doc.html);
      const first = await readData(ctx, 'root-a', docPath, 'stale precondition read');

      const accepted = await writeData(ctx, 'root-a', docPath, { second: 'first-write' }, {
        'if-match': first.etag,
        'page-if-match': first.revision,
      }, 'first page write');
      assertEqual(accepted.status, 200, 'the first page write is accepted');

      const versionsPath = `.hyperclay/versions/${docPath.replace(/\.html$/, '')}`;
      const sidecarPath = `.hyperclay/page-state/${docPath}.json`;
      const before = {
        file: (await ctx.read('root-a', docPath)).sha256,
        versions: await listDir(ctx, 'root-a', versionsPath),
        sidecar: (await ctx.read('root-a', sidecarPath)).sha256,
      };
      assert(before.versions.length > 0, 'the accepted write left a version of the bytes it replaced');
      assert(typeof before.sidecar === 'string', 'the accepted write left a page sidecar');

      const current = await readData(ctx, 'root-a', docPath, 'current page read');
      const stale = await writeData(ctx, 'root-a', docPath, { second: 'stale-write' }, {
        'if-match': current.etag,
        'page-if-match': first.revision,
      }, 'write under the old page revision');
      assertEqual(stale.status, 409, 'a stale Page-If-Match is refused');
      assertEqual(bodyJson(stale, 'stale write').code, 'revision-stale', 'stale refusal code');
      assertEqual(stale.header('page-revision'), current.revision, 'the refusal names the current page revision');

      const after = {
        file: (await ctx.read('root-a', docPath)).sha256,
        versions: await listDir(ctx, 'root-a', versionsPath),
        sidecar: (await ctx.read('root-a', sidecarPath)).sha256,
      };
      assertEqual(after.file, before.file, 'the refused write left the file bytes unchanged');
      assertEqual(after.versions.length, before.versions.length, 'the refused write minted no version');
      assertEqual(JSON.stringify(after.versions), JSON.stringify(before.versions), 'the versions folder is unchanged');
      assertEqual(after.sidecar, before.sidecar, 'the refused write left the page sidecar unchanged');
    },
  },
  {
    id: 'page.api-preserves-dirty-room',
    profiles: PROFILES,
    // src/main/server.js:3827-3848 — the write holds the document's room, renders the
    // page over the room's authoritative HTML (utils/page-api.js authoritativePageHtml
    // merges the unsaved edits) and commits that, releasing the hold after. The
    // participant keeps its own edit, and the file it renders next holds both.
    async run(ctx) {
      const docPath = `page/dirty-${RUN}.html`;
      const doc = await pageDocument();
      await ctx.seed('root-a', docPath, doc.html);
      const seeded = await ctx.read('root-a', docPath);

      const client = await joinLiveClient(ctx, { rootId: 'root-a', docPath, clientId: 'page-a' });
      try {
        const edit = await client.edit('page', [
          { op: 'set', path: ['y', 'http-a-1'], value: doc.update },
        ]);
        assertEqual(edit.status, 200, `the live page edit is accepted: ${JSON.stringify(edit.body)}`);
        const afterEdit = await ctx.read('root-a', docPath);
        assertEqual(afterEdit.sha256, seeded.sha256, 'the unsaved live edit stays out of the file');

        const current = await readData(ctx, 'root-a', docPath, 'dirty room read');
        assertEqual(current.data.body, 'ac', 'the data read renders the unsaved room edit');

        const accepted = await writeData(ctx, 'root-a', docPath, { second: 'api-change' }, {
          'if-match': current.etag,
          'page-if-match': current.revision,
        }, 'data write over a dirty room');
        assertEqual(accepted.status, 200, `the data write lands over the dirty room: ${accepted.text.slice(0, 200)}`);
        const written = bodyJson(accepted, 'data write over a dirty room');
        assertEqual(written.body, 'ac', 'the API write rendered the unsaved room edit');
        assertEqual(written.second, 'api-change', 'the API write landed its own change');

        const state = await client.state();
        assert(state.stores && state.stores.page, 'the participant still holds the page store');
        assertEqual(state.stores.page.value.y['http-a-1'], doc.update, 'the participant still holds its edit');

        const stored = await ctx.read('root-a', docPath);
        assert(stored.text.includes('>ac<'), 'the next rendered file holds the room edit');
        assert(stored.text.includes('>api-change<'), 'the next rendered file holds the API change');
      } finally {
        await client.close();
      }
    },
  },
];
