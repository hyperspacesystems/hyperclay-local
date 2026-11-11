// M1c/S1: the checkpoint's room half as renderCheckpoint. The host is the real
// one the checkpoint service registers -- a real temp root, a real authority and a
// real dirty room -- and the lane runs under the document boundary checkpoint
// holds, so what is asserted is what the lane reads, renders and leaves on disk.

const fs = require('fs').promises;
const os = require('os');
const upath = require('upath');
const { createLocalAuthority } = require('../../src/main/local-authority');
const { withDocumentWrite } = require('../../src/main/utils/write-queue');
const { storePageState } = require('../../src/main/page-state-store');
const { pageFixture } = require('../helpers/page-fixture');
const { checkpointHost } = require('../helpers/checkpoint-host');

const NAME = 'doc.html';
const dirs = [];

afterEach(async () => {
  jest.restoreAllMocks();
  while (dirs.length) await fs.rm(dirs.pop(), { recursive: true, force: true });
});

async function dirtyPage() {
  const dir = upath.resolve(await fs.realpath(await fs.mkdtemp(upath.join(os.tmpdir(), 'document-host-checkpoint-lane-'))));
  dirs.push(dir);
  const file = upath.join(dir, NAME);
  const fixture = pageFixture('abc');
  await fs.writeFile(file, await storePageState(dir, NAME, fixture.html));
  const authority = createLocalAuthority({ withDocument: withDocumentWrite, pageCompaction: false });
  authority.registerRoot({ id: 'root-a', path: dir, canonicalPath: dir });
  const host = checkpointHost({ dir, authority });
  const target = authority.bindTarget({ rootId: 'root-a', logicalPath: NAME, canonicalPath: file });
  const room = await authority.roomFor(target, () => ({
    rootId: 'root-a', logicalPath: NAME, canonicalPath: file, identity: target.identity,
  }));
  const edited = authority.rooms.apply(room, 'a', {
    name: 'blockeditor', n: 1, epoch: room.epoch, blockeditorGeneration: room.blockeditorTransition?.id ?? null,
    ops: [{ op: 'set', path: ['y', 'edit-1'], value: fixture.update }],
  });
  expect(edited.error).toBeUndefined();
  expect(authority.roomIsDirty(room)).toBe(true);
  return { dir, file, authority, host, target, room };
}

// Exactly how checkpoint calls the lane: the claim is taken outside the boundary
// and the lane runs inside it, with the room and generation the caller passes.
function render(page, options = {}) {
  const core = require('@panphora/clayjs/server/checkpoint');
  const claim = page.authority.captureAdmission(page.target);
  return withDocumentWrite(() => ({ canonicalPath: page.file }), (_locked, token) =>
    page.host.lanes.renderCheckpoint({
      core, key: page.file, roomIdentity: page.target.identity,
      generation: page.room.blockeditorTransition?.id ?? null,
      target: page.target, room: page.room, claim, token, ...options,
    }));
}

test('renderCheckpoint renders a dirty room and writes nothing', async () => {
  const page = await dirtyPage();
  const bytesBefore = await fs.readFile(page.file);
  const mtimeBefore = (await fs.stat(page.file)).mtimeMs;

  const result = await render(page);

  expect(result.kind).toBe('render');
  expect(result.html).toContain('<p data-id="p">ac</p>');
  expect(result.readIdentity).toHaveProperty('ino');
  const bytesAfter = await fs.readFile(page.file);
  expect(bytesAfter.equals(bytesBefore)).toBe(true);
  expect((await fs.stat(page.file)).mtimeMs).toBe(mtimeBefore);
  expect(page.authority.roomIsDirty(page.room)).toBe(true);
});

test('renderCheckpoint refuses a document the injected read cannot find', async () => {
  const page = await dirtyPage();

  const result = await render(page, {
    readCurrent: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
  });

  expect(result).toEqual({ kind: 'refused', reason: 'invalid-identity' });
});

test('renderCheckpoint uses the injected read and returns its identity', async () => {
  const page = await dirtyPage();
  const html = await fs.readFile(page.file, 'utf8');
  const readIdentity = { ino: 4242n, mtimeMs: 1n, size: 2n };

  const result = await render(page, { readCurrent: async () => ({ html, readIdentity }) });

  expect(result.kind).toBe('render');
  expect(result.readIdentity).toBe(readIdentity);
});
