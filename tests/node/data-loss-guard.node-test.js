// Real-engine orchestration test for the Hyperclay Local data-clobber guard.
// Run via `node --test` (npm run test:node), NOT jest: it exercises the dynamic
// import() of the pure-ESM hyper-html-api engine (apply/extract). The filename
// ends in `.node-test.js` so jest's testMatch skips it.
//
// Covers: cold seed, fire on destruction, the restore round-trip, revert via the
// recover file, pin-once across a write chain, baseline advance on a clean
// gesture, provenance, page-load seed-on-read, and cross-environment auto-clear.
// No network; a temp baseDir per test; liveSync notify is a no-op (no clients).
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const guard = require('../../src/main/data-loss-guard');
const core = require('../../src/main/data-loss-core.cjs');

const NAME = 'app.html';

function page({ title = 'Title', items = ['a', 'b', 'c'] } = {}) {
  const lis = items.map((t) => `<li class="item">${t}</li>`).join('');
  return `<!DOCTYPE html><html><head>
<script type="application/json" data-rules-name="api" data-rules-version="1">
{ "title": "h1", "items": ".item[]" }
</script></head><body>
<h1>${title}</h1>
<ul id="list">${lis}</ul>
</body></html>`;
}

async function freshBaseDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dlg-'));
}

// Cold-seed the baseline from a known-good prev, then run the clobber write.
async function seedThenWrite(baseDir, orig, clobber, prov = 'external') {
  await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: orig, prevContent: orig, prov: 'external' });
  return guard.runDataLossGuard({ baseDir, name: NAME, newHtml: clobber, prevContent: orig, prov });
}

test('provenanceForLocalSave maps the userDriven bit (missing reads ui-unknown)', () => {
  assert.strictEqual(guard.provenanceForLocalSave(true), 'ui-gestured');
  assert.strictEqual(guard.provenanceForLocalSave(false), 'ui-background');
  assert.strictEqual(guard.provenanceForLocalSave(undefined), 'ui-unknown');
});

// A text save carries its provenance in a header, so the bit has to be read from
// one. It used to be read only out of the JSON envelope's `userDriven` field,
// which meant a spec-shaped save reported ui-unknown and the guard lost the
// human-gesture signal entirely.
function fakeReq(headers) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[String(name).toLowerCase()] };
}

test('userDrivenFromHeader reads Save-Trigger, falling back to the pre-spec header', () => {
  assert.strictEqual(guard.userDrivenFromHeader(fakeReq({ 'Save-Trigger': 'user' })), true);
  assert.strictEqual(guard.userDrivenFromHeader(fakeReq({ 'Save-Trigger': 'auto' })), false);
  // §9: a host treats any unknown trigger as `auto`, so document code cannot
  // invent a value that buys it a stronger claim than autosave.
  assert.strictEqual(guard.userDrivenFromHeader(fakeReq({ 'Save-Trigger': 'whatever' })), false);
  // Save-Trigger wins over the older spelling when both are present.
  assert.strictEqual(
    guard.userDrivenFromHeader(fakeReq({ 'Save-Trigger': 'auto', 'X-Hyperclay-User-Driven': '1' })),
    false,
  );
  assert.strictEqual(guard.userDrivenFromHeader(fakeReq({ 'X-Hyperclay-User-Driven': '1' })), true);
  assert.strictEqual(guard.userDrivenFromHeader(fakeReq({ 'X-Hyperclay-User-Driven': '0' })), false);
  // Neither header is an old client, which is not the same answer as `auto`.
  assert.strictEqual(guard.userDrivenFromHeader(fakeReq({})), undefined);
});

test('a header-driven save resolves to the same provenance the envelope used to give', () => {
  const fromHeader = guard.userDrivenFromHeader(fakeReq({ 'Save-Trigger': 'user' }));
  assert.strictEqual(guard.provenanceForLocalSave(fromHeader), 'ui-gestured');
  assert.strictEqual(
    guard.provenanceForLocalSave(guard.userDrivenFromHeader(fakeReq({ 'Save-Trigger': 'auto' }))),
    'ui-background',
  );
});

test('first sight blind-seeds and does not fire (no prev to compare)', async () => {
  const baseDir = await freshBaseDir();
  const ev = await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: page(), prevContent: null, prov: 'external' });
  assert.strictEqual(ev, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.ok(g.baseline);
  assert.strictEqual(g.event, null);
});

test('external destruction fires with a client event', async () => {
  const baseDir = await freshBaseDir();
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a'] }), 'external');
  assert.ok(ev);
  assert.ok(ev.id);
  assert.strictEqual(ev.canRevert, true);
  assert.strictEqual(ev.lossSummary.provenance, 'external');
  assert.ok(ev.preview.length > 0);
});

test('a deliberate single-item removal under a gesture stays silent and advances the baseline', async () => {
  const baseDir = await freshBaseDir();
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a', 'b'] }), 'ui-gestured');
  assert.strictEqual(ev, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.strictEqual(g.uiWorkPending, true);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b']); // advanced to the blessed save
});

test('a big clobber fires even under a gesture', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ title: 'Keep', items: ['alpha', 'bravo', 'charlie', 'delta', 'echo'] });
  const clobber = page({ title: 'Keep', items: ['alpha'] });
  const ev = await seedThenWrite(baseDir, orig, clobber, 'ui-gestured');
  assert.ok(ev);
});

test('restore re-applies the recoverable data and clears the event', async () => {
  const baseDir = await freshBaseDir();
  const clobber = page({ items: ['a'] });
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), clobber, 'external');
  assert.strictEqual(ev.restorable, true);

  let written = null;
  const res = await guard.resolveGuard({
    baseDir, name: NAME, id: ev.id, choice: 'restore',
    currentHtml: clobber, writeBack: async (html) => { written = html; },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'restored');
  assert.ok(written.includes('<li class="item">a</li>'));
  assert.ok(written.includes('<li class="item">b</li>'));
  assert.ok(written.includes('<li class="item">c</li>'));
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
});

test('when the list was fully emptied, restore reports failed and revert is offered', async () => {
  const baseDir = await freshBaseDir();
  const emptied = page({ items: [] });
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), emptied, 'external');
  assert.strictEqual(ev.restorable, false); // no sibling to clone -> can't round-trip
  assert.strictEqual(ev.canRevert, true);

  const restoreRes = await guard.resolveGuard({
    baseDir, name: NAME, id: ev.id, choice: 'restore', currentHtml: emptied, writeBack: async () => {},
  });
  assert.strictEqual(restoreRes.ok, false);
  assert.strictEqual(restoreRes.statusCode, 422);

  let written = null;
  const revertRes = await guard.resolveGuard({
    baseDir, name: NAME, id: ev.id, choice: 'revert', currentHtml: emptied, writeBack: async (html) => { written = html; },
  });
  assert.strictEqual(revertRes.ok, true);
  assert.ok(written.includes('<li class="item">a</li>')); // whole-file last-good restored
});

test('dismiss accepts the current data as the new baseline and clears', async () => {
  const baseDir = await freshBaseDir();
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a'] }), 'external');
  const res = await guard.resolveGuard({
    baseDir, name: NAME, id: ev.id, choice: 'dismiss', currentHtml: page({ items: ['a'] }), writeBack: async () => {},
  });
  assert.strictEqual(res.ok, true);
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a']);
});

test('pin-once: subsequent external destruction never overwrites the first recoverable data', async () => {
  const baseDir = await freshBaseDir();
  await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a', 'b'] }), 'external'); // fires, pins orig
  const before = await guard._readGuard(baseDir, NAME);
  const pinned = JSON.stringify(before.event.recoverableData);
  await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: page({ items: [] }), prevContent: page({ items: ['a', 'b'] }), prov: 'external' });
  const after = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(JSON.stringify(after.event.recoverableData), pinned);
  assert.deepStrictEqual(after.event.recoverableData.api.items, ['a', 'b', 'c']);
});

// The notice's droppedAdditions tells the editor how many of its CURRENT items
// Restore will remove or overwrite. It used to be a net count (current length -
// recoverable length), which read 0 when a list was wiped and the editor then
// added new items - so Restore silently deleted them.

test('droppedAdditions counts the 2 items added after a 5-item wipe (the old net count said 0)', async () => {
  const baseDir = await freshBaseDir();
  const event = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c', 'd', 'e'] }), page({ items: [] }), 'external');
  assert.ok(event, 'the wipe must raise an event');
  assert.strictEqual(event.droppedAdditions, 0); // nothing left to drop at the wipe

  // The editor, still looking at the wiped page, adds two brand-new items.
  const current = page({ items: ['x', 'y'] });
  const after = await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: current, prevContent: page({ items: [] }), prov: 'ui-gestured' });
  assert.strictEqual(after, null); // the pinned event only bumps lastWriteAt

  const clientEvent = await guard.getGuardEvent(baseDir, NAME, current);
  assert.ok(clientEvent, 'the warning must survive the additions');
  assert.strictEqual(clientEvent.droppedAdditions, 2);
});

test('droppedAdditions counts the 3 items added beside the 2 survivors of a 5-item list', async () => {
  const baseDir = await freshBaseDir();
  const event = await seedThenWrite(
    baseDir, page({ items: ['a', 'b', 'c', 'd', 'e'] }), page({ items: ['a', 'b'] }), 'external',
  );
  assert.ok(event, 'losing 3 of 5 items must raise an event');

  const current = page({ items: ['a', 'b', 'x', 'y', 'z'] });
  const after = await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: current, prevContent: page({ items: ['a', 'b'] }), prov: 'ui-gestured',
  });
  assert.strictEqual(after, null);

  const clientEvent = await guard.getGuardEvent(baseDir, NAME, current);
  assert.ok(clientEvent, 'the warning must survive the additions');
  assert.strictEqual(clientEvent.droppedAdditions, 3);
});

const item = (t) => ({ title: t });

test('droppedItems counts current items with no identical recoverable item left', () => {
  const a = item('a');
  const b = item('b');
  const c = item('c');
  const d = item('d');
  const e = item('e');

  // A 5-item list wiped, then 2 new items added. Net length: 2 - 5 -> old 0.
  assert.strictEqual(core.droppedItems({ items: [a, b, c, d, e] }, { items: [item('x'), item('y')] }), 2);
  // 3 of 5 lost, 3 new added to the 2 survivors. Net length: 5 - 5 -> old 0.
  assert.strictEqual(
    core.droppedItems({ items: [a, b, c, d, e] }, { items: [a, b, item('x'), item('y'), item('z')] }),
    3,
  );
  // A multiset: the extra duplicate has no identical item left to pair with.
  assert.strictEqual(core.droppedItems([a, a], [a, a, a]), 1);
  // An unchanged list drops nothing.
  assert.strictEqual(core.droppedItems({ items: [a, b, c] }, { items: [a, b, c] }), 0);
  // An edited item is overwritten by RESTORE, so it counts as dropped.
  const bEdited = { title: 'b', n: 2 };
  assert.strictEqual(core.droppedItems({ items: [a, { title: 'b', n: 1 }, c] }, { items: [a, bEdited] }), 1);
  // Key order inside an item does not matter (stableDigest sorts keys).
  assert.strictEqual(core.droppedItems({ items: [{ t: 'a', n: 1 }] }, { items: [{ n: 1, t: 'a' }] }), 0);
  // Only list values can drop items; a scalar key contributes 0.
  assert.strictEqual(core.droppedItems({ title: 'a', items: [a] }, { title: 'changed', items: [a] }), 0);
});


test('cross-environment auto-clear: an incoming write that restores the pinned data clears the event', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  const ev = await seedThenWrite(baseDir, orig, page({ items: ['a'] }), 'external');
  assert.ok(ev);
  const cleared = await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: orig, prevContent: page({ items: ['a'] }), prov: 'external' });
  assert.strictEqual(cleared, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.strictEqual(g.status, 'restored');
});

test('a pinned event is NOT auto-cleared when a later write MODIFIES (not restores) the recoverable atoms', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ title: 'Title', items: ['a', 'b', 'c'] });
  // Wipe the title -> fires, pins {title:'Title', items:[a,b,c]}.
  const ev = await seedThenWrite(baseDir, orig, page({ title: '', items: ['a', 'b', 'c'] }), 'external');
  assert.ok(ev);
  const pinned = JSON.parse(JSON.stringify((await guard._readGuard(baseDir, NAME)).event.recoverableData));

  // A later write refills the title with a DIFFERENT value (modification, not
  // restoration). The loss is NOT undone, so the event must stay pending and the
  // pinned recoverable data must be untouched (regression for the auto-clear that
  // used !anyDestruction, which treated modification as "undone").
  await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: page({ title: 'Different', items: ['a', 'b', 'c'] }),
    prevContent: page({ title: '', items: ['a', 'b', 'c'] }), prov: 'external',
  });
  const g = await guard._readGuard(baseDir, NAME);
  assert.ok(g.event, 'event must stay pending after a modifying write');
  assert.deepStrictEqual(g.event.recoverableData, pinned); // pin-once intact
});

test('getGuardEvent seeds the baseline on first read without firing, then an external clobber fires', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  const onRead = await guard.getGuardEvent(baseDir, NAME, orig);
  assert.strictEqual(onRead, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b', 'c']);

  const ev = await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: page({ items: ['a'] }), prevContent: orig, prov: 'external' });
  assert.ok(ev);
  const again = await guard.getGuardEvent(baseDir, NAME, page({ items: ['a'] }));
  assert.strictEqual(again.id, ev.id);
});

test('getGuardEvent does not seed for an island-less page', async () => {
  const baseDir = await freshBaseDir();
  const noIsland = '<!DOCTYPE html><html><head></head><body><h1>plain</h1></body></html>';
  const onRead = await guard.getGuardEvent(baseDir, NAME, noIsland);
  assert.strictEqual(onRead, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g, null); // no guard file created
});

test('a data-rules-version skew fails open: the write proceeds, no guard action', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: orig, prevContent: orig, prov: 'external' });
  const before = await guard._readGuard(baseDir, NAME);

  // newHtml whose api tag carries an unsupported version -> extractViaTag throws
  // -> safeExtractIsland is not-ok -> runDataLossGuard returns early (fail open).
  const skew = `<!DOCTYPE html><html><head>
<script type="application/json" data-rules-name="api" data-rules-version="2">
{ "title": "h1", "items": ".item[]" }
</script></head><body><h1>x</h1></body></html>`;
  const ev = await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: skew, prevContent: orig, prov: 'external' });
  assert.strictEqual(ev, null);                                  // no throw, no event
  const after = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(after.event, null);
  assert.deepStrictEqual(after.baseline.data, before.baseline.data); // baseline untouched
});

test('external & ui-background non-firing writes never advance the baseline (external clears uiWorkPending, ui-background leaves it)', async () => {
  const baseDir = await freshBaseDir();
  // A clean ui-gestured save blesses items=['a','b'] and sets uiWorkPending.
  await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a', 'b'] }), 'ui-gestured');
  let g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.uiWorkPending, true);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b']);

  // external additions-only (non-firing): baseline NOT advanced, uiWorkPending cleared.
  const extEv = await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: page({ items: ['a', 'b', 'c'] }), prevContent: page({ items: ['a', 'b'] }), prov: 'external',
  });
  assert.strictEqual(extEv, null);
  g = await guard._readGuard(baseDir, NAME);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b']); // never auto-blessed
  assert.strictEqual(g.uiWorkPending, false);                    // external clears it

  // Re-bless so uiWorkPending is true again.
  await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: page({ items: ['a', 'b'] }), prevContent: page({ items: ['a', 'b'] }), prov: 'ui-gestured',
  });
  g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.uiWorkPending, true);

  // ui-background pure-modification (non-firing): baseline NOT advanced, and (per
  // the core spec) ui-background does not clear uiWorkPending — only external does.
  const bgEv = await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: page({ title: 'Renamed', items: ['a', 'b'] }), prevContent: page({ items: ['a', 'b'] }), prov: 'ui-background',
  });
  assert.strictEqual(bgEv, null);
  g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.baseline.data.api.title, 'Title'); // not advanced to 'Renamed'
  assert.strictEqual(g.uiWorkPending, true);              // ui-background leaves it
});

test('auto-clear also fires when the recoverable data returns WITH legitimate additions (no destruction of the recoverable set)', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  const ev = await seedThenWrite(baseDir, orig, page({ items: ['a'] }), 'external'); // fires, pins a,b,c
  assert.ok(ev);
  // Incoming write restores a,b,c AND keeps a new item d (e.g. a concurrent add on
  // the other env). Not byte-equal to the pinned data, but nothing recoverable is
  // destroyed -> the loss is undone -> clear.
  const cleared = await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: page({ items: ['a', 'b', 'c', 'd'] }), prevContent: page({ items: ['a'] }), prov: 'external',
  });
  assert.strictEqual(cleared, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.strictEqual(g.status, 'restored');
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b', 'c', 'd']); // adopts current
});

test('auto-clear does NOT fire on a partial restore (a recoverable atom is still missing -> warning preserved)', async () => {
  const baseDir = await freshBaseDir();
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a'] }), 'external'); // pins a,b,c
  assert.ok(ev);
  // Only a,b come back; c is still gone -> destruction of the recoverable set -> keep the event.
  const still = await guard.runDataLossGuard({
    baseDir, name: NAME, newHtml: page({ items: ['a', 'b'] }), prevContent: page({ items: ['a'] }), prov: 'external',
  });
  assert.strictEqual(still, null); // pinned event only bumps lastWriteAt; no NEW event returned
  const g = await guard._readGuard(baseDir, NAME);
  assert.ok(g.event); // warning preserved
  assert.deepStrictEqual(g.event.recoverableData.api.items, ['a', 'b', 'c']);
});

test('getGuardEvent re-validates on read: clears a stale event once the current content no longer destroys the recoverable set', async () => {
  const baseDir = await freshBaseDir();
  const ev = await seedThenWrite(baseDir, page({ items: ['a', 'b', 'c'] }), page({ items: ['a'] }), 'external'); // event pinned
  assert.ok(ev);
  // Still clobbered on read -> event surfaces.
  const stillThere = await guard.getGuardEvent(baseDir, NAME, page({ items: ['a'] }));
  assert.ok(stillThere && stillThere.id === ev.id);
  // Read with restored content -> stale event cleared, returns null.
  const onRestored = await guard.getGuardEvent(baseDir, NAME, page({ items: ['a', 'b', 'c'] }));
  assert.strictEqual(onRestored, null);
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b', 'c']);
});
// --- The outside-edit catch-up (M10's deferred item) -------------------------
// An edit made while Local was closed has no watcher pass behind it. The page
// load judges the bytes on disk against the last bytes the guard or the host
// saw, so the first read after such an edit raises the same notice a live
// external write would. The saves below go through the real document host, so
// the stamp they leave is the one the commit wrapper takes, not a test's copy.

const crypto = require('crypto');
const { createDocumentHost } = require('../../src/main/document-host');
const { atomicWriteFile } = require('../../src/main/utils/write-queue');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The save lane's dependencies, as small as a committed save allows. Everything
// incidental is a no-op; the guard, the clock and the disk are real.
function saveHost(dir, overrides = {}) {
  return createDocumentHost({
    ctx: {},
    baseDir: dir,
    live: { markBrowserSave: () => {}, broadcast: () => {}, notify: () => {}, wasBrowserSave: () => false },
    store: { etags: new Map(), snapshots: new Map() },
    resolveTailwindWrite: async (tailwindName) => path.join(dir, 'tailwind', `${tailwindName}.css`),
    canonicalForWrite: (html) => html,
    formatHtml: (html) => html,
    scopeTailwindLink: (name, html) => html,
    stripSaveToken: (bytes) => bytes,
    splitWrite: async (baseDir, name, formatted) => ({ file: formatted, logical: formatted }),
    storePageState: async (baseDir, name, logical) => logical,
    writePageState: async () => {},
    logicalDocument: async (baseDir, name, file) => file,
    createBackup: async () => true,
    createBackupIfExists: async () => true,
    createBinaryBackupIfExists: async () => true,
    atomicWriteFile,
    assertWriteContext: () => {},
    assertStructureContext: () => {},
    stripCopyBytes: (bytes) => bytes,
    writeApiSidecar: async () => {},
    refreshDerivedArtifacts: async () => {},
    getTailwindCssName: () => null,
    compileTailwind: async () => '',
    dataGuard: guard,
    documentEtag: (html) => `etag:${html}`,
    rebaseStaleSave: async () => null,
    newestVersionFiles: async () => [],
    needsAdoption: () => false,
    roomsPackage: () => ({ splitPage: (html) => ({ file: html }) }),
    MAX_EXTERNAL_HTML: 1024 * 1024,
    VERSIONS_DIR: '.hyperclay/versions',
    TAILWIND_DIR: '.hyperclay/tailwindcss',
    emit: () => {},
    logger: null,
    ...overrides,
  });
}

async function waitFor(predicate, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(what);
}

function save(baseDir, html, { userDriven, prev, deps } = {}) {
  return saveHost(baseDir, deps).commit({
    kind: 'browser-save', name: NAME, filePath: path.join(baseDir, NAME), bytes: html, userDriven, dataLossPrev: prev,
  });
}

// The first save on a document with no guard yet only seeds the baseline (cold
// start, first sight), so there is nothing to stamp: seed with one save and let
// hostSave prove the stamp on the next.
async function seedDocument(baseDir, html) {
  await fsp.writeFile(path.join(baseDir, NAME), html);
  assert.strictEqual((await save(baseDir, html, { userDriven: true, prev: html })).outcome, 'committed');
  await waitFor(async () => Boolean(((await guard._readGuard(baseDir, NAME)) || {}).baseline), 'the guard never seeded a baseline');
}

// A real save that must leave the bytes it committed as the guard's last seen.
// The commit wrapper takes the stamp without awaiting it, so this waits for it
// to land before reading.
async function hostSave(baseDir, html, { userDriven, prev } = {}) {
  const result = await save(baseDir, html, { userDriven, prev });
  assert.strictEqual(result.outcome, 'committed');
  await waitFor(
    async () => (((await guard._readGuard(baseDir, NAME)) || {}).lastSeen === sha256(result.stored)),
    'the host never stamped the bytes it committed as seen',
  );
  return result;
}

// What GET /data-loss does: read the file as bytes, judge any outside edit, then
// serve whatever event the guard holds.
async function pageLoad(baseDir) {
  const bytes = await fsp.readFile(path.join(baseDir, NAME));
  const html = bytes.toString('utf8');
  await guard.catchUpOutsideEdit(baseDir, NAME, bytes, html);
  return { bytes, event: await guard.getGuardEvent(baseDir, NAME, html) };
}

test('an outside edit made while Local was closed raises a notice on the next page load', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  await seedDocument(baseDir, orig);
  await hostSave(baseDir, orig, { userDriven: true, prev: orig });

  // Local is closed: a helper empties the list straight to disk.
  await fsp.writeFile(path.join(baseDir, NAME), page({ items: [] }));

  const { event } = await pageLoad(baseDir);
  assert.ok(event, 'the first read after the outside edit must raise');
  assert.strictEqual(event.lossSummary.provenance, 'external');
  const row = event.preview.find((entry) => entry.key === 'items');
  assert.ok(row, 'the preview must name the lost list');
  assert.strictEqual(row.now, '\u2014 empty \u2014');
  assert.strictEqual(row.yours, 'a, b, c');
});

test('a ui-unknown save that removes one item leaves no event on the next page load', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  await seedDocument(baseDir, orig);
  await hostSave(baseDir, orig, { userDriven: true, prev: orig });

  // Below the big-clobber bar and with no userDriven bit: nothing fires, and the
  // baseline does not advance. The bytes it wrote are simply the last ones seen.
  const smaller = page({ items: ['a', 'b'] });
  await hostSave(baseDir, smaller, { userDriven: undefined, prev: orig });
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.deepStrictEqual(g.baseline.data.api.items, ['a', 'b', 'c']);

  const { event } = await pageLoad(baseDir);
  assert.strictEqual(event, null);
});

test('a guard restore leaves no new event on the next page load', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  await seedDocument(baseDir, orig);
  await hostSave(baseDir, orig, { userDriven: true, prev: orig });
  const clobbered = page({ items: ['a'] });
  await fsp.writeFile(path.join(baseDir, NAME), clobbered);

  const { event } = await pageLoad(baseDir);
  assert.ok(event);

  // The restore goes through the host, so its bytes are the last ones seen too.
  const res = await guard.resolveGuard({
    baseDir, name: NAME, id: event.id, choice: 'restore', currentHtml: clobbered,
    writeBack: async (html) => { await hostSave(baseDir, html, { userDriven: true }); },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual((await guard._readGuard(baseDir, NAME)).event, null);

  const after = await pageLoad(baseDir);
  assert.strictEqual(after.event, null);
});

test('a guard written before lastSeen existed is seeded on the first read and raises nothing', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  // The pre-upgrade write path: a guard pass, no stamp.
  await fsp.writeFile(path.join(baseDir, NAME), orig);
  await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: orig, prevContent: orig, prov: 'ui-gestured' });
  assert.strictEqual((await guard._readGuard(baseDir, NAME)).lastSeen, undefined);

  const emptied = page({ items: [] });
  await fsp.writeFile(path.join(baseDir, NAME), emptied);

  const { event } = await pageLoad(baseDir);
  assert.strictEqual(event, null);
  assert.strictEqual((await guard._readGuard(baseDir, NAME)).lastSeen, sha256(Buffer.from(emptied, 'utf8')));
});

test('a page load that races a just-finished commit before its persist raises no event', async () => {
  const baseDir = await freshBaseDir();
  const orig = page({ items: ['a', 'b', 'c'] });
  await seedDocument(baseDir, orig);
  await hostSave(baseDir, orig, { userDriven: true, prev: orig });

  // The commit has written the bytes and set pendingSeen, but its persist has not
  // landed yet. A page load must not re-judge its own bytes.
  const emptied = page({ items: [] });
  await fsp.writeFile(path.join(baseDir, NAME), emptied);
  const pending = guard.noteSeen(baseDir, NAME, Buffer.from(emptied, 'utf8'));

  const { event } = await pageLoad(baseDir);
  assert.strictEqual(event, null);

  await pending;
  const g = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(g.event, null);
  assert.strictEqual(g.lastSeen, sha256(Buffer.from(emptied, 'utf8')));
});

// The reviewer's first-save reproduction: one save through the real root host has
// to leave lastSeen behind, or the next read treats an outside edit as a
// pre-upgrade guard and stamps it silently.
test('one save through the root host stamps lastSeen, so an outside edit while closed raises a notice', async () => {
  const baseDir = await freshBaseDir();
  const initial = page({ items: ['a', 'b', 'c'] });
  await fsp.writeFile(path.join(baseDir, NAME), initial);

  const { createRootDocumentHost } = require('../../src/main/document-host');
  const host = createRootDocumentHost({
    ctx: { root: { id: baseDir, path: baseDir } },
    live: { markBrowserSave: () => {}, broadcast: () => {}, notify: () => {}, wasBrowserSave: () => false },
  });
  const saved = await host.commit({
    kind: 'browser-save', name: NAME, filePath: path.join(baseDir, NAME), bytes: initial,
    dataLossPrev: initial, userDriven: true,
  });
  assert.strictEqual(saved.outcome, 'committed');

  await waitFor(async () => Boolean(((await guard._readGuard(baseDir, NAME)) || {}).baseline), 'the guard never seeded a baseline');
  await waitFor(
    async () => ((await guard._readGuard(baseDir, NAME)) || {}).lastSeen !== undefined,
    'the first save never stamped the bytes it committed as the last ones seen',
  );
  const seeded = await guard._readGuard(baseDir, NAME);
  assert.strictEqual(seeded.lastSeen, sha256(Buffer.from(saved.stored, 'utf8')));

  // Local is closed: a helper empties the list straight to disk.
  await fsp.writeFile(path.join(baseDir, NAME), page({ items: [] }));

  const { event } = await pageLoad(baseDir);
  assert.ok(event, 'the first read after the outside edit must raise');
  assert.strictEqual(event.lossSummary.provenance, 'external');
});

// The reviewer's Tailwind reproduction: the file is renamed into place, then the
// lane still awaits the sidecar and the Tailwind compile. A read in that window
// must not re-judge the host's own bytes as an outside edit.
test('a page load while the save lane is still finishing raises no event', async () => {
  const baseDir = await freshBaseDir();
  const initial = page({ items: ['a', 'b', 'c'] });
  await fsp.writeFile(path.join(baseDir, NAME), initial);
  const first = await save(baseDir, initial, { userDriven: true, prev: initial });
  assert.strictEqual(first.outcome, 'committed');
  await waitFor(
    async () => ((await guard._readGuard(baseDir, NAME)) || {}).lastSeen === sha256(first.stored),
    'the first save never stamped the bytes it committed as the last ones seen',
  );

  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const deps = {
    getTailwindCssName: () => 'notes',
    compileTailwind: async () => { entered(); await barrier; return ''; },
  };

  const smaller = page({ items: ['a', 'b'] });
  const saving = save(baseDir, smaller, { userDriven: undefined, prev: initial, deps });
  try {
    await started;
    assert.strictEqual(await fsp.readFile(path.join(baseDir, NAME), 'utf8'), smaller);
    const bytes = await fsp.readFile(path.join(baseDir, NAME));
    await guard.catchUpOutsideEdit(baseDir, NAME, bytes, smaller);
    assert.strictEqual((await guard._readGuard(baseDir, NAME)).event, null);
    assert.strictEqual((await pageLoad(baseDir)).event, null);
  } finally {
    release();
  }

  assert.strictEqual((await saving).outcome, 'committed');
  const after = await pageLoad(baseDir);
  assert.strictEqual(after.event, null);
});
