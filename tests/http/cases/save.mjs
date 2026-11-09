import http from 'node:http';

import {
  assert,
  assertCookieSet,
  assertEntityTagHeader,
  assertEqual,
  bodyJson,
  delay,
  documentEtag,
  documentUrl,
  htmlDocument,
  saveDocument,
  saveHeaders,
} from './support.mjs';

const PROFILES = ['local-full'];

function startSaveProxy(ctx, { rootId, docPath, beforeSha, expectMarker }) {
  const target = ctx.rootUrl(rootId);
  const state = { sawCommitted: false, upstreamStatus: null };
  const server = http.createServer(async (req, res) => {
    try {
      const headers = { ...req.headers };
      for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) delete headers[name];
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      });
      await upstream.text();
      state.upstreamStatus = upstream.status;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = await ctx.read(rootId, docPath);
        if (current.exists && current.sha256 !== beforeSha && current.text.includes(expectMarker)) {
          state.sawCommitted = true;
          break;
        }
        await delay(50);
      }
      req.socket.destroy();
    } catch {
      try { req.socket.destroy(); } catch {}
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

async function lostSave(ctx, { rootId, docPath, saveId, stamp, body, marker }) {
  const before = await ctx.read(rootId, docPath);
  const proxy = await startSaveProxy(ctx, { rootId, docPath, beforeSha: before.sha256, expectMarker: marker });
  let dropped = false;
  try {
    const response = await fetch(`${proxy.url}/_/save`, {
      method: 'POST',
      headers: saveHeaders(ctx, rootId, docPath, { 'save-id': saveId, 'if-match': stamp }),
      body,
    });
    await response.text();
  } catch {
    dropped = true;
  }
  await proxy.close();
  return { dropped, sawCommitted: proxy.state.sawCommitted, upstreamStatus: proxy.state.upstreamStatus };
}

export const SAVE_CASES = [
  {
    id: 'origin.absent',
    profiles: PROFILES,
    // src/main/server.js:1511 — a request with no Origin header passes the gate.
    async run(ctx) {
      const docPath = 'origin/absent.html';
      await ctx.seed('root-a', docPath, htmlDocument('origin-absent-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('origin-absent-saved'));
      assertEqual(res.status, 200, 'save with no Origin');
      assertEqual(bodyJson(res, 'save').msg, 'Saved', 'save message');
      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes('origin-absent-saved'), 'the save landed');
    },
  },
  {
    id: 'origin.own-port',
    profiles: PROFILES,
    // src/main/server.js:1513 — an Origin on this app's own port passes the gate.
    async run(ctx) {
      const docPath = 'origin/own-port.html';
      const origin = ctx.rootUrl('root-a');
      await ctx.seed('root-a', docPath, htmlDocument('origin-own-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('origin-own-saved'), { origin });
      assertEqual(res.status, 200, `save with Origin ${origin}`);
      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes('origin-own-saved'), 'the save landed');
    },
  },
  {
    id: 'origin.foreign',
    profiles: PROFILES,
    // src/main/server.js:1512-1513 — a loopback Origin on another port is refused.
    async run(ctx) {
      const docPath = 'origin/foreign.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('origin-foreign-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('origin-foreign-saved'), {
        origin: 'http://127.0.0.1:1',
      });
      assertEqual(res.status, 403, 'save with a foreign Origin');
      assertEqual(bodyJson(res, 'save').msg, 'Cross-origin requests are not allowed.', 'refusal message');
      const state = await ctx.read('root-a', docPath);
      assertEqual(state.sha256, seeded.sha256, 'the refused save left the file unchanged');
    },
  },
  {
    id: 'origin.null',
    profiles: PROFILES,
    // src/main/server.js:1512 — `Origin: null` is refused.
    async run(ctx) {
      const docPath = 'origin/null.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('origin-null-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('origin-null-saved'), { origin: 'null' });
      assertEqual(res.status, 403, 'save with Origin: null');
      assertEqual(bodyJson(res, 'save').msgType, 'error', 'refusal envelope');
      const state = await ctx.read('root-a', docPath);
      assertEqual(state.sha256, seeded.sha256, 'the refused save left the file unchanged');
    },
  },
  {
    id: 'cookie.on-document',
    profiles: PROFILES,
    // src/main/server.js:1558-1562 — the host cookies ride every response, including a document.
    async run(ctx) {
      const docPath = 'cookie/document.html';
      await ctx.seed('root-a', docPath, htmlDocument('cookie-document'));
      const res = await ctx.http('root-a', 'GET', `/${docPath}`);
      assertEqual(res.status, 200, 'document status');
      assertEqual(res.header('content-type'), 'text/html; charset=utf-8', 'document content type');
      assertCookieSet(res, 'isAdminOfCurrentResource', 'document response');
      assertCookieSet(res, 'isLoggedIn', 'document response');
    },
  },
  {
    id: 'cookie.on-non-document',
    profiles: PROFILES,
    // src/main/server.js:1558-1562 — and on a response that is not a document.
    async run(ctx) {
      const docPath = 'cookie/non-document.html';
      await ctx.seed('root-a', docPath, htmlDocument('cookie-non-document'));
      const res = await ctx.http('root-a', 'GET', '/_/meta', {
        headers: { 'document-url': documentUrl(ctx, 'root-a', docPath) },
      });
      assertEqual(res.status, 200, 'meta status');
      assert(res.header('content-type').startsWith('application/json'), 'meta is not a document');
      assertCookieSet(res, 'isAdminOfCurrentResource', 'meta response');
      assertCookieSet(res, 'isLoggedIn', 'meta response');
    },
  },
  {
    id: 'save.tokenless-document-url',
    profiles: PROFILES,
    // src/main/server.js:2454-2462 — the save route asks for Document-URL and no save token.
    async run(ctx) {
      const docPath = 'save/tokenless.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('tokenless-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('tokenless-saved'));
      assertEqual(res.status, 200, 'tokenless save');
      const state = await ctx.read('root-a', docPath);
      assert(state.sha256 !== seeded.sha256, 'the tokenless save landed');
      assert(state.text.includes('tokenless-saved'), 'the saved bytes are on disk');
      assert(!state.text.includes('savetoken'), 'no save token reached the file');
    },
  },
  {
    id: 'save.legacy-bare-route',
    profiles: PROFILES,
    // src/main/server.js:1535-1548 and 2454 — the pre-marker bare `/save` alias still saves.
    async run(ctx) {
      const docPath = 'save/bare-route.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('bare-seed'));
      const res = await ctx.http('root-a', 'POST', '/save', {
        headers: saveHeaders(ctx, 'root-a', docPath),
        body: htmlDocument('bare-saved'),
      });
      assertEqual(res.status, 200, 'bare route save');
      const state = await ctx.read('root-a', docPath);
      assert(state.sha256 !== seeded.sha256, 'the bare route save landed');
      assert(state.text.includes('bare-saved'), 'the saved bytes are on disk');
    },
  },
  {
    id: 'precondition.missing-if-match',
    profiles: PROFILES,
    // src/main/server.js:2607 — an absent If-Match is a plain last-write-wins save.
    async run(ctx) {
      const docPath = 'precondition/missing.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('missing-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('missing-saved'));
      assertEqual(res.status, 200, 'save with no If-Match');
      const state = await ctx.read('root-a', docPath);
      assert(state.sha256 !== seeded.sha256, 'the unconditional save landed');
      assert(state.text.includes('missing-saved'), 'the saved bytes are on disk');
    },
  },
  {
    id: 'precondition.empty-if-match',
    profiles: PROFILES,
    // src/main/server.js:2607-2648 — an empty If-Match is refused with the current stamp.
    async run(ctx) {
      const docPath = 'precondition/empty.html';
      const seeded = await ctx.seed('root-a', docPath, htmlDocument('empty-seed'));
      const res = await saveDocument(ctx, 'root-a', docPath, htmlDocument('empty-saved'), { 'if-match': '' });
      assertEqual(res.status, 412, 'save with an empty If-Match');
      const body = bodyJson(res, 'save');
      assertEqual(body.code, 'conflict', 'refusal code');
      const state = await ctx.read('root-a', docPath);
      assertEqual(body.etag, documentEtag(state.bytes), 'the refusal names the stored bytes');
      assertEqual(state.sha256, seeded.sha256, 'the refused save left the file unchanged');
    },
  },
  {
    id: 'precondition.unchanged-save',
    profiles: PROFILES,
    // src/main/server.js:2622-2655 and 2694 — identical bytes under their own stamp save again.
    async run(ctx) {
      const docPath = 'precondition/unchanged.html';
      await ctx.seed('root-a', docPath, htmlDocument('unchanged-seed'));
      const body = htmlDocument('unchanged-body');
      const first = await saveDocument(ctx, 'root-a', docPath, body);
      assertEqual(first.status, 200, 'first save');
      const stamp = bodyJson(first, 'first save').etag;
      assertEntityTagHeader(first, 'first save');
      const afterFirst = await ctx.read('root-a', docPath);
      assertEqual(stamp, documentEtag(afterFirst.text), 'the success stamp describes the stored bytes');

      const second = await saveDocument(ctx, 'root-a', docPath, body, { 'if-match': stamp });
      assertEqual(second.status, 200, 'save of identical bytes');
      assertEqual(bodyJson(second, 'second save').etag, stamp, 'identical bytes keep their stamp');
      assertEntityTagHeader(second, 'second save');
      const afterSecond = await ctx.read('root-a', docPath);
      assertEqual(afterSecond.sha256, afterFirst.sha256, 'identical bytes leave the file unchanged');
    },
  },
  {
    id: 'precondition.competing-saves',
    profiles: PROFILES,
    // src/main/server.js:2548-2655 — the write queue serializes two saves on one stamp:
    // exactly one lands and the other is refused with the winner's stamp.
    async run(ctx) {
      const docPath = 'precondition/competing.html';
      await ctx.seed('root-a', docPath, htmlDocument('competing-seed'));
      const base = await saveDocument(ctx, 'root-a', docPath, htmlDocument('competing-base'));
      assertEqual(base.status, 200, 'base save');
      const stamp = bodyJson(base, 'base save').etag;

      const bodyA = htmlDocument('competing-A');
      const bodyB = htmlDocument('competing-B');
      const [resA, resB] = await Promise.all([
        saveDocument(ctx, 'root-a', docPath, bodyA, { 'if-match': stamp }),
        saveDocument(ctx, 'root-a', docPath, bodyB, { 'if-match': stamp }),
      ]);
      const pairs = [
        { res: resA, marker: 'competing-A' },
        { res: resB, marker: 'competing-B' },
      ];
      const winners = pairs.filter((pair) => pair.res.status === 200);
      const losers = pairs.filter((pair) => pair.res.status !== 200);
      assertEqual(winners.length, 1, `exactly one save landed (${resA.status}, ${resB.status})`);
      assertEqual(losers.length, 1, 'exactly one save was refused');
      const loser = losers[0];
      assertEqual(loser.res.status, 412, 'the losing save got the conflict status');
      const loserBody = bodyJson(loser.res, 'losing save');
      assertEqual(loserBody.code, 'conflict', 'losing save code');
      const winnerBody = bodyJson(winners[0].res, 'winning save');
      assertEqual(loserBody.etag, winnerBody.etag, 'the refusal names the stamp the winner stored');
      assertEntityTagHeader(winners[0].res, 'winning save');
      assertEntityTagHeader(loser.res, 'losing save');

      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes(winners[0].marker), 'the file holds the winner');
      assert(!state.text.includes(loser.marker), 'the file does not hold the loser');
    },
  },
  {
    id: 'alias.token-attributes',
    profiles: PROFILES,
    // Protocol: src/main/server.js:2497 — a document carrying only the pre-rename
    // `htmlclaytoken` (and `htmlclayid`) saves through `/_/save`, which strips the
    // credential from the root tag and keeps the document identity.
    async run(ctx) {
      const docPath = 'alias/token-attributes.html';
      await ctx.seed(
        'root-a',
        docPath,
        htmlDocument('alias-seed', 'htmlclaytoken="stale-credential" htmlclayid="doc-identity-1"'),
      );
      const res = await saveDocument(
        ctx,
        'root-a',
        docPath,
        htmlDocument('alias-saved', 'htmlclaytoken="stale-credential" htmlclayid="doc-identity-1"'),
      );
      assertEqual(res.status, 200, 'save of a token-attribute document');
      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes('alias-saved'), 'the save landed');
      assert(!state.text.includes('htmlclaytoken'), 'the legacy token was stripped');
      assert(!state.text.includes('stale-credential'), 'no credential reached the file');
      assert(state.text.includes('htmlclayid="doc-identity-1"'), 'the document identity was kept');
    },
  },
  {
    id: 'receipt.lost-response',
    profiles: PROFILES,
    // src/main/server.js:2645 and 2698 plus 2939-2940 — the Save-ID of the request whose
    // bytes reached disk is reported on the refusal and on /_/meta.
    async run(ctx) {
      const docPath = 'receipt/lost-response.html';
      await ctx.seed('root-a', docPath, htmlDocument('receipt-seed'));
      const base = await saveDocument(ctx, 'root-a', docPath, htmlDocument('receipt-start'));
      assertEqual(base.status, 200, 'baseline save');
      const stamp = bodyJson(base, 'baseline save').etag;

      const saveId = 'lost-response-save-0001';
      const body = htmlDocument('receipt-lost-response-body');
      const lost = await lostSave(ctx, {
        rootId: 'root-a',
        docPath,
        saveId,
        stamp,
        body,
        marker: 'receipt-lost-response-body',
      });
      assertEqual(lost.dropped, true, 'the proxy dropped the save response');
      assertEqual(lost.sawCommitted, true, 'the proxy observed the committed bytes on disk before dropping');

      const meta = await ctx.http('root-a', 'GET', '/_/meta', {
        headers: { 'document-url': documentUrl(ctx, 'root-a', docPath) },
      });
      assertEqual(meta.status, 200, 'meta status');
      const document = bodyJson(meta, 'meta').document;
      assertEqual(document.saveId, saveId, 'meta reports the lost save as the one that landed');
      assert(document.etag !== stamp, 'the lost save moved the stamp');

      const retry = await saveDocument(ctx, 'root-a', docPath, body, { 'save-id': saveId, 'if-match': stamp });
      assertEqual(retry.status, 412, 'the retry under the original stamp is refused');
      const retryBody = bodyJson(retry, 'retry');
      assertEqual(retryBody.code, 'conflict', 'retry code');
      assertEqual(retryBody.saveId, saveId, 'the refusal names the retry\'s own save id');
      assertEqual(retryBody.etag, document.etag, 'the refusal names the current stamp');
      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes('receipt-lost-response-body'), 'the file still holds the lost save');
    },
  },
  {
    id: 'receipt.foreign-save-not-overwritten',
    profiles: PROFILES,
    // src/main/server.js:2622-2646 — after a lost response, a later save moves the bytes on,
    // so a retry under the original stamp is refused and cannot overwrite them.
    async run(ctx) {
      const docPath = 'receipt/foreign-save.html';
      await ctx.seed('root-a', docPath, htmlDocument('foreign-seed'));
      const base = await saveDocument(ctx, 'root-a', docPath, htmlDocument('foreign-start'));
      assertEqual(base.status, 200, 'baseline save');
      const stamp = bodyJson(base, 'baseline save').etag;

      const saveId = 'foreign-save-lost-0001';
      const lostBody = htmlDocument('foreign-lost-body');
      const lost = await lostSave(ctx, {
        rootId: 'root-a',
        docPath,
        saveId,
        stamp,
        body: lostBody,
        marker: 'foreign-lost-body',
      });
      assertEqual(lost.dropped, true, 'the proxy dropped the save response');
      assertEqual(lost.sawCommitted, true, 'the proxy observed the committed bytes on disk before dropping');

      const meta = await ctx.http('root-a', 'GET', '/_/meta', {
        headers: { 'document-url': documentUrl(ctx, 'root-a', docPath) },
      });
      const afterLost = bodyJson(meta, 'meta').document;
      assertEqual(afterLost.saveId, saveId, 'meta reports the lost save');

      const foreign = await saveDocument(ctx, 'root-a', docPath, htmlDocument('foreign-other-save'), {
        'if-match': afterLost.etag,
      });
      assertEqual(foreign.status, 200, 'a different save lands');
      const foreignStamp = bodyJson(foreign, 'foreign save').etag;
      assert(foreignStamp !== afterLost.etag, 'the foreign save moved the stamp');

      const retry = await saveDocument(ctx, 'root-a', docPath, lostBody, { 'save-id': saveId, 'if-match': stamp });
      assertEqual(retry.status, 412, 'the retry under the original stamp is refused');
      const retryBody = bodyJson(retry, 'retry');
      assertEqual(retryBody.code, 'conflict', 'retry code');
      assert(retryBody.saveId === undefined, 'the receipt no longer names the lost save');
      assertEqual(retryBody.etag, foreignStamp, 'the refusal names the foreign save\'s stamp');

      const state = await ctx.read('root-a', docPath);
      assert(state.text.includes('foreign-other-save'), 'the file holds the foreign save');
      assert(!state.text.includes('foreign-lost-body'), 'the retry did not overwrite it');
    },
  },
];
