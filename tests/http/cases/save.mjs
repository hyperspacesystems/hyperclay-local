import {
  assert,
  assertEntityTagHeader,
  assertEqual,
  bodyJson,
  htmlDocument,
  saveDocument,
} from './support.mjs';

const PROFILES = ['local-full'];

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
    id: 'local.save-response-etag',
    profiles: PROFILES,
    // Express stamps its own weak entity tag over the save response body, a detail no
    // client reads, so the shared precondition.unchanged-save row does not demand it.
    async run(ctx) {
      const docPath = 'precondition/save-response-etag.html';
      await ctx.seed('root-a', docPath, htmlDocument('unchanged-seed'));
      const body = htmlDocument('unchanged-body');
      const first = await saveDocument(ctx, 'root-a', docPath, body);
      assertEqual(first.status, 200, 'first save');
      const stamp = bodyJson(first, 'first save').etag;
      assertEntityTagHeader(first, 'first save');

      const second = await saveDocument(ctx, 'root-a', docPath, body, { 'if-match': stamp });
      assertEqual(second.status, 200, 'save of identical bytes');
      assertEntityTagHeader(second, 'second save');
    },
  },
];
