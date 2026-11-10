// M2/S4: the authority's recovered-copy writer is already injected, so recovery
// of a room an outside write replaced suspends on that writer's promise. Nothing
// else changes while it is pending -- the room stays kept and recovering -- and a
// writer that settles on Go's receipt can split recovery into two phases.

const fs = require('fs');
const os = require('os');
const path = require('upath');
const { createRooms } = require('@panphora/clayjs/server/rooms');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');

const baseline = '<!doctype html><html><body><article>confirmed</article><script type="application/json" merge="count" clay="live">{"n":0}</script></body></html>';
const foreign = baseline.replace('{"n":0}', '{"n":99}');
const PUBLISHED = '2026-11-10-000000-000.html';

function deferredWriter() {
  const calls = [];
  const publishRecovered = (rootPath, rel, html) => new Promise((resolve, reject) => calls.push({ rootPath, rel, html, resolve, reject }));
  return { calls, publishRecovered };
}

const dirs = [];

function tempDir() {
  const dir = path.resolve(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-recovery-suspends-'))));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

async function dirtyReplacement() {
  const dir = tempDir();
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, baseline);
  const rooms = createRooms({});
  const writer = deferredWriter();
  const authority = createLocalAuthority({ rooms, withDocument: withDocumentWrite, publishRecovered: writer.publishRecovered });
  authority.registerRoot({ id: 'root-a', path: dir, canonicalPath: dir }, { owner: 'server' });
  const target = authority.bindTarget({ rootId: 'root-a', logicalPath: 'page.html', canonicalPath: file });
  const room = await authority.roomFor(target, async () => ({
    rootId: 'root-a', logicalPath: 'page.html', canonicalPath: file, identity: target.identity,
  }));
  const accepted = rooms.apply(room, 'client', {
    name: 'count', n: 1, epoch: room.epoch, ops: [{ op: 'set', path: ['n'], value: 7 }],
  }, { connected: ['client'] });
  expect(accepted.error).toBeUndefined();
  fs.writeFileSync(file, foreign);

  const observe = () => withDocumentWrite(async () => ({ canonicalPath: file }), (_target, token) =>
    authority.observeExternal(target, foreign, token));

  return { file, rooms, writer, authority, target, room, observe };
}

async function waitForCalls(writer, count) {
  for (let turn = 0; turn < 200; turn += 1) {
    if (writer.calls.length >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`the recovered-copy writer was not called ${count} time(s)`);
}

test('recovery is suspended until the recovered-copy writer settles', async () => {
  const { file, rooms, writer, authority, target, room, observe } = await dirtyReplacement();

  const started = observe();
  started.catch(() => {});
  await waitForCalls(writer, 1);

  expect(rooms.get(file)).toBe(room);
  expect(authority.isCurrentTarget(target)).toBe(false);

  writer.calls[0].resolve({ filename: PUBLISHED });
  const result = await started;

  expect(result).toEqual({ kind: 'replacement', recovered: `recovered-${PUBLISHED}` });
  expect(writer.calls).toHaveLength(1);
  expect(rooms.get(file)).toBeNull();
});

test('a failed writer leaves the room recovering and the next observation writes again', async () => {
  const { file, rooms, writer, authority, target, room, observe } = await dirtyReplacement();

  const first = observe();
  first.catch(() => {});
  await waitForCalls(writer, 1);
  writer.calls[0].reject(new Error('disk full'));

  await expect(first).rejects.toThrow('disk full');
  expect(rooms.get(file)).toBe(room);
  expect(authority.isCurrentTarget(target)).toBe(false);

  const second = observe();
  second.catch(() => {});
  await waitForCalls(writer, 2);
  expect(writer.calls).toHaveLength(2);
  expect(rooms.get(file)).toBe(room);

  writer.calls[1].resolve({ filename: PUBLISHED });
  const result = await second;

  expect(result).toEqual({ kind: 'replacement', recovered: `recovered-${PUBLISHED}` });
  expect(rooms.get(file)).toBeNull();
});
