import crypto from 'node:crypto';

import { assert, assertEqual } from './support.mjs';
import { pageDocument } from '../fixtures/page-document.mjs';
import { joinLiveClient } from './live-client.mjs';

const PROFILES = ['local-full'];
const RUN = crypto.randomBytes(4).toString('hex');

const sidecarPath = (docPath) => `.hyperclay/blockeditor-state/${docPath}.json`;

async function editLiveRoom(ctx, docPath, doc) {
  const page = await joinLiveClient(ctx, { rootId: 'root-a', docPath, clientId: 'blockeditor-a' });
  const store = await joinLiveClient(ctx, { rootId: 'root-a', docPath, clientId: 'game-b' });
  const pageEdit = await page.edit('blockeditor', [{ op: 'set', path: ['y', 'http-a-1'], value: doc.update }]);
  assertEqual(pageEdit.status, 200, `the live page edit is accepted: ${JSON.stringify(pageEdit.body)}`);
  const storeEdit = await store.edit('game', [{ op: 'add', path: ['score'], n: 1 }]);
  assertEqual(storeEdit.status, 200, `the live store edit is accepted: ${JSON.stringify(storeEdit.body)}`);
  return { page, store };
}

async function waitForCheckpoint(ctx, docPath, timeoutMs, label) {
  return ctx.controlRequest('/checkpoint-wait', {
    method: 'POST',
    body: { root: 'root-a', path: docPath, timeoutMs },
  });
}

export const CHECKPOINT_CASES = [
  {
    id: 'checkpoint.last-participant-leaves',
    profiles: PROFILES,
    // src/main/local-authority.js:831-837 — a leaving editor runs checkpointService
    // .departed only when no OTHER participating editor remains; local-checkpoint.js
    // :200-218 then schedules the attempt, which renders the room over the file
    // (local-checkpoint.js:113-130) and writes both the document and its page
    // sidecar. No client asks for the checkpoint: both streams just close.
    async run(ctx) {
      const docPath = `checkpoint/last-${RUN}.html`;
      const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
      await ctx.seed('root-a', docPath, doc.html);
      const seeded = await ctx.read('root-a', docPath);

      const { page, store } = await editLiveRoom(ctx, docPath, doc);
      const edited = await ctx.read('root-a', docPath);
      assertEqual(edited.sha256, seeded.sha256, 'the live edits stay out of the file');

      await page.close();
      const early = await waitForCheckpoint(ctx, docPath, 400, 'checkpoint while one participant remains');
      assertEqual(early.status, 504, 'no checkpoint runs while a participant is still on the room');
      assertEqual(early.body.error, 'checkpoint-timeout', 'the wait reports its own expiry');
      const stillEdited = await ctx.read('root-a', docPath);
      assertEqual(stillEdited.sha256, seeded.sha256, 'the room stays unwritten while one participant remains');

      await store.close();
      const waited = await waitForCheckpoint(ctx, docPath, 10000, 'checkpoint after the last participant leaves');
      assertEqual(waited.status, 200, `the last participant's leave completed the checkpoint: ${JSON.stringify(waited.body)}`);
      assertEqual(waited.body.observed, true, 'a dirty room was actually checkpointed');

      const stored = await ctx.read('root-a', docPath);
      assert(stored.text.includes('>ac<'), 'the rendered file holds the page edit');
      assert(stored.text.includes('"score":1'), 'the rendered file holds the non-page store change');
      assert(!stored.text.includes('merge="blockeditor"'), 'the page state stays out of the file');

      const sidecar = await ctx.read('root-a', sidecarPath(docPath));
      assertEqual(sidecar.exists, true, 'the checkpoint left a page sidecar');
      const record = JSON.parse(sidecar.text);
      assertEqual(record.v, 1, 'the sidecar is a page state record');
      assert(typeof record.tag === 'string' && record.tag.includes('merge="blockeditor"'), 'the sidecar holds the page tag');
      assert(record.tag.includes('http-a-1'), 'the sidecar holds the participant\'s page edit');
    },
  },
  {
    id: 'checkpoint.survives-restart',
    profiles: PROFILES,
    // The checkpoint wrote the document and its page sidecar, so a host that starts
    // again on the same folders reads both back: src/main/page-state-store.js
    // :202-205 composes the stored file with its sidecar for every read, and
    // local-authority.js:1020-1032 opens the cold room from those same bytes.
    async run(ctx) {
      const docPath = `checkpoint/restart-${RUN}.html`;
      const doc = await pageDocument({ store: { name: 'game', value: { score: 0 } } });
      await ctx.seed('root-a', docPath, doc.html);

      const { page, store } = await editLiveRoom(ctx, docPath, doc);
      await page.close();
      await store.close();
      const waited = await waitForCheckpoint(ctx, docPath, 10000, 'checkpoint before the restart');
      assertEqual(waited.status, 200, `the checkpoint completes before the restart: ${JSON.stringify(waited.body)}`);

      const restarted = await ctx.controlRequest('/restart', { method: 'POST', body: {} });
      assertEqual(restarted.status, 200, `the host restarts: ${JSON.stringify(restarted.body)}`);
      assertEqual(restarted.body.ok, true, 'every root is running again');
      const rootA = restarted.body.roots.find((root) => root.id === 'root-a');
      assertEqual(rootA.url, ctx.rootUrl('root-a'), 'the restarted host kept the address the manifest promised');

      const served = await ctx.http('root-a', 'GET', `/${docPath}`);
      assertEqual(served.status, 200, 'a plain GET of the document after the restart');
      assert(served.text.includes('>ac<'), 'the served document holds the page edit');
      assert(served.text.includes('"score":1'), 'the served document holds the non-page store change');

      const client = await joinLiveClient(ctx, { rootId: 'root-a', docPath, clientId: 'after-restart' });
      try {
        const state = await client.ready();
        assert(state.stores && state.stores.game, 'the new participant reads the non-page store');
        assertEqual(state.stores.game.value.score, 1, 'the new participant reads the store change');
        assert(state.stores.blockeditor, 'the new participant reads the page store');
        assertEqual(state.stores.blockeditor.value.y['http-a-1'], doc.update, 'the new participant reads the page edit');
      } finally {
        await client.close();
      }
    },
  },
];
