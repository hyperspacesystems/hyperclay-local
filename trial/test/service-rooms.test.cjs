'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { realpathSync } = require('node:fs');

const {
  SKIP, until, document, save, buildTrialBinary, makeRoots, bootPair, trackCalls,
} = require('./service-harness.cjs');
const { pageStatePath } = require('../../src/main/page-state-store.js');
const { documentEtag } = require('../../src/main/spec-wire.js');
const { pageFixture } = require('../../tests/helpers/page-fixture');

const FIXTURE = pageFixture('abc');

test('the JS service checkpoint, observe and structure handlers, proven against the Go host', { skip: SKIP }, async (t) => {
  const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-service-rooms-')));
  const bin = buildTrialBinary(tmp);
  const roots = makeRoots(tmp);

  const pair = await bootPair(bin, roots);
  const { service, ready } = pair;
  const rootA = roots[0];
  const rootAUrl = ready.roots[0].url;
  const rootAId = ready.roots[0].id;

  const calls = trackCalls(service, [
    '/v1/render-checkpoint', '/v1/observe', '/v1/structure/prepare', '/v1/structure/settle',
    '/v1/admit', '/v1/settle',
  ]);
  const forName = (pathname, name) => calls.filter((call) => call.path === pathname && call.name === name);

  const observer = service.rootFor(rootAId).observer;
  const applied = [];
  const applyExternal = observer._applyExternal;
  observer._applyExternal = function (rel, target, token, observed) {
    const text = observed == null ? null : (Buffer.isBuffer(observed) ? observed : Buffer.from(observed)).toString('utf8');
    applied.push({ rel, text });
    return applyExternal.call(this, rel, target, token, observed);
  };
  const removals = [];
  const notifyRemoved = observer._notifyRemoved;
  observer._notifyRemoved = function (rel, removal) {
    removals.push(rel);
    return notifyRemoved.call(this, rel, removal);
  };

  t.after(async () => {
    await pair.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const pagePath = path.join(rootA, 'page.html');
  const movedPath = path.join(rootA, 'moved.html');
  const notesPath = path.join(rootA, 'notes.html');
  let room = null;
  let n = 0;
  const edit = () => {
    n += 1;
    return service.authority.rooms.apply(room, 'editor', {
      name: 'blockeditor', n, epoch: room.epoch, blockeditorGeneration: room.blockeditorTransition?.id ?? null,
      compaction: 1,
      ops: [{ op: 'set', path: ['y', `uedit-${n}-x`], value: FIXTURE.update }],
    });
  };
  const moveBody = () => ({
    opId: randomBytes(16).toString('hex'), root: rootAId, kind: 'move',
    steps: [{ from: 'page.html', to: 'moved.html' }],
  });

  await t.test('a dirty room is written by Local\'s checkpoint, through Go', async () => {
    const opened = await save(rootAUrl, 'page.html', FIXTURE.html, { 'If-Match': documentEtag(Buffer.alloc(0)) });
    assert.equal(opened.status, 200, opened.body);

    const target = service.authority.bindTarget({ rootId: rootAId, logicalPath: 'page.html', canonicalPath: pagePath });
    room = await service.authority.roomFor(target, () => ({
      rootId: rootAId, logicalPath: 'page.html', canonicalPath: pagePath, identity: target.identity,
    }));
    const edited = edit();
    assert.equal(edited.error, undefined, JSON.stringify(edited));
    assert.equal(service.authority.roomIsDirty(room), true);

    const before = calls.length;
    const result = await service.checkpoint.attempt(pagePath);
    assert.equal(result.kind, 'ok', JSON.stringify(result));

    assert.equal(fs.readFileSync(pageStatePath(rootA, 'page.html'), 'utf8').includes('edit-1'), true);
    assert.equal(service.authority.roomIsDirty(room), false);

    const since = calls.slice(before);
    const checkpoints = since.filter((call) => call.path === '/v1/render-checkpoint');
    assert.equal(checkpoints.length, 1, JSON.stringify(since));
    assert.equal(checkpoints[0].name, 'page.html');

    const admits = since.filter((call) => call.path === '/v1/admit');
    assert.equal(admits.length, 1, JSON.stringify(since));
    assert.equal(admits[0].lane, 'save');
    assert.equal(admits[0].origin, 'checkpoint');

    const order = since
      .map((call) => call.path)
      .filter((pathname) => pathname === '/v1/render-checkpoint' || pathname === '/v1/admit' || pathname === '/v1/settle');
    assert.deepEqual(order.slice(0, 3), ['/v1/render-checkpoint', '/v1/admit', '/v1/settle'], JSON.stringify(since));
  });

  await t.test('a second checkpoint of the clean room writes nothing', async () => {
    const pageBefore = fs.readFileSync(pagePath);
    const sidecarPath = pageStatePath(rootA, 'page.html');
    const sidecarBefore = fs.readFileSync(sidecarPath);
    const admitsBefore = calls.filter((call) => call.path === '/v1/admit').length;

    const result = await service.checkpoint.attempt(pagePath);
    console.log(`the clean room's checkpoint answered ${JSON.stringify(result)}`);
    assert.notEqual(result.kind, 'ok', JSON.stringify(result));
    assert.equal(result.kind, 'clean', JSON.stringify(result));

    assert.deepEqual(fs.readFileSync(pagePath), pageBefore);
    assert.deepEqual(fs.readFileSync(sidecarPath), sidecarBefore);
    assert.equal(calls.filter((call) => call.path === '/v1/admit').length, admitsBefore, JSON.stringify(calls));
  });

  await t.test('Go\'s own write is judged self; an outside edit is observed', async () => {
    const answer = await save(rootAUrl, 'notes.html', document('<p>one</p>'));
    assert.equal(answer.status, 200, answer.body);

    const seen = await until(() => forName('/v1/observe', 'notes.html').length > 0, { timeout: 5000 });
    console.log(`a /v1/observe for notes.html within 5 s: ${seen} ${JSON.stringify(forName('/v1/observe', 'notes.html'))}`);

    assert.equal(applied.filter((call) => call.rel === 'notes.html').length, 0, JSON.stringify(applied));

    fs.writeFileSync(notesPath, document('<p>outside</p>'));
    assert.equal(await until(() => applied.some((call) => call.rel === 'notes.html' && call.text && call.text.includes('<p>outside</p>')), { timeout: 10000 }),
      true, JSON.stringify(applied));
  });

  await t.test('a removal on disk tells the tabs', async () => {
    fs.unlinkSync(notesPath);
    assert.equal(await until(() => removals.includes('notes.html'), { timeout: 10000 }), true, JSON.stringify(removals));
    assert.equal(forName('/v1/observe', 'notes.html').some((call) => call.event === 'unlink'), true, JSON.stringify(calls));
  });

  await t.test('a move through Go moves the room; a dirty room refuses it', async () => {
    const edited = edit();
    assert.equal(edited.error, undefined, JSON.stringify(edited));
    assert.equal(service.authority.roomIsDirty(room), true);

    const refused = await service.goCall('POST', '/v1/restructure', moveBody());
    console.log(`the dirty room's move answered ${JSON.stringify(refused)}`);
    assert.equal(refused.outcome, 'refused', JSON.stringify(refused));
    assert.equal(refused.refusal ? refused.refusal.code : null, 'peers-editing', JSON.stringify(refused));
    assert.equal(fs.existsSync(pagePath), true);
    assert.equal(fs.existsSync(movedPath), false);

    const cleaned = await service.checkpoint.attempt(pagePath);
    assert.equal(cleaned.kind, 'ok', JSON.stringify(cleaned));

    const preparesBefore = calls.filter((call) => call.path === '/v1/structure/prepare').length;
    const settlesBefore = calls.filter((call) => call.path === '/v1/structure/settle').length;
    const moved = await service.goCall('POST', '/v1/restructure', moveBody());
    console.log(`the clean room's move answered ${JSON.stringify(moved)}`);
    assert.equal(moved.outcome, 'committed', JSON.stringify(moved));
    assert.equal(moved.completed, 1, JSON.stringify(moved));

    assert.equal(fs.existsSync(movedPath), true);
    assert.equal(fs.existsSync(pagePath), false);
    assert.equal(service.authority.rooms.get(movedPath), room);
    assert.equal(service.authority.rooms.get(pagePath) ?? undefined, undefined);

    assert.equal(calls.filter((call) => call.path === '/v1/structure/prepare').length, preparesBefore + 1, JSON.stringify(calls));
    assert.equal(calls.filter((call) => call.path === '/v1/structure/settle').length, settlesBefore + 1, JSON.stringify(calls));
  });
});
