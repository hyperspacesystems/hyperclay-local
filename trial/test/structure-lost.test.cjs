'use strict';

// The recorded gap (protocol v1, "Gaps recorded"): a person renames a page while
// the service cannot confirm the structure settle. Go moves the file, marks the
// page unconfirmed at both paths, and aborts with the steps that moved; the
// service settles late, so its room follows the file, and reconciles both paths.
// Without that, the room stays keyed to the old path, its next checkpoint is
// refused, and the edits are lost when the room expires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { realpathSync } = require('node:fs');

const { SKIP, until, save, buildTrialBinary, makeRoots, bootPair } = require('./service-harness.cjs');
const { pageStatePath } = require('../../src/main/page-state-store.js');
const { documentEtag } = require('../../src/main/spec-wire.js');
const { pageFixture } = require('../../tests/helpers/page-fixture');

const FIXTURE = pageFixture('abc');

test('a structure settle the service never received is settled late and reconciled', { skip: SKIP }, async (t) => {
  const tmp = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcl-structure-lost-')));
  const bin = buildTrialBinary(tmp);
  const roots = makeRoots(tmp);
  const pair = await bootPair(bin, roots);
  const { service, ready } = pair;
  t.after(async () => {
    await pair.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const rootA = roots[0];
  const rootAId = ready.roots[0].id;
  const pagePath = path.join(rootA, 'page.html');
  const movedPath = path.join(rootA, 'moved.html');

  const opened = await save(ready.roots[0].url, 'page.html', FIXTURE.html, { 'If-Match': documentEtag(Buffer.alloc(0)) });
  assert.equal(opened.status, 200, opened.body);
  const target = service.authority.bindTarget({ rootId: rootAId, logicalPath: 'page.html', canonicalPath: pagePath });
  const room = await service.authority.roomFor(target, () => ({
    rootId: rootAId, logicalPath: 'page.html', canonicalPath: pagePath, identity: target.identity,
  }));
  let n = 0;
  const edit = () => {
    n += 1;
    return service.authority.rooms.apply(room, 'editor', {
      name: 'blockeditor', n, epoch: room.epoch, blockeditorGeneration: room.blockeditorTransition?.id ?? null,
      compaction: 1,
      ops: [{ op: 'set', path: ['y', `uedit-${n}-x`], value: FIXTURE.update }],
    });
  };
  assert.equal(edit().error, undefined);
  assert.equal((await service.checkpoint.attempt(pagePath)).kind, 'ok');
  assert.equal(service.authority.roomIsDirty(room), false);

  const armed = await service.goCall('POST', '/v1/fault', { point: 'settle-lost', rel: 'page.html' });
  assert.equal(armed.armed, 1, JSON.stringify(armed));
  const moved = await service.goCall('POST', '/v1/restructure', {
    opId: randomBytes(16).toString('hex'), root: rootAId, kind: 'move', steps: [{ from: 'page.html', to: 'moved.html', blockeditorState: 'move' }],
  });
  assert.equal(moved.outcome, 'committed', JSON.stringify(moved));
  assert.equal(fs.existsSync(movedPath), true);
  assert.equal(fs.existsSync(pagePath), false);

  const followed = await until(() => service.authority.rooms.get(movedPath) === room, { timeout: 10000 });
  assert.equal(followed, true, 'the room stayed keyed to page.html after the lost settle');
  assert.equal(service.authority.rooms.get(pagePath) ?? undefined, undefined);

  let unconfirmed = null;
  const released = await until(() => {
    service.goCall('GET', '/v1/unconfirmed').then((answer) => { unconfirmed = answer; }, () => {});
    return unconfirmed !== null && unconfirmed.documents.length === 0;
  }, { timeout: 15000, interval: 200 });
  assert.equal(released, true, `Go still holds documents unconfirmed: ${JSON.stringify(unconfirmed)}`);

  assert.equal(edit().error, undefined);
  const written = await service.checkpoint.attempt(movedPath);
  assert.equal(written.kind, 'ok', JSON.stringify(written));
  assert.equal(fs.readFileSync(pageStatePath(rootA, 'moved.html'), 'utf8').includes(`edit-${n}`), true,
    'the edit made after the rename did not reach moved.html');
});
