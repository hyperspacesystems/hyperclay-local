const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const core = require('../../src/main/data-loss-core.cjs');
const guard = require('../../src/main/data-loss-guard');
const { createApp } = require('../../src/main/server');
const { documentEtag } = require('../../src/main/spec-wire');
const { listenLoopback, closeLoopback } = require('../helpers/loopback');
const vectors = require('@panphora/host-conformance/vectors/sheet-guard.json');

test('shared guard vectors use the codec rowChange', async () => {
  const { grid } = await import('hyper-html-api/codecs/sheet');
  assert.equal(vectors.cases.length, 42);
  for (const entry of vectors.cases) {
    const D = core.classifyDestruction(entry.base, entry.inc, { codecs: { sheet: { rowChange: grid.rowChange } } });
    assert.deepEqual(D, entry.D, entry.name);
    const matched = entry.lane === 'agent' && guard.namesExactVersion(entry.ifMatch);
    assert.equal(core.shouldFire(entry.provenance, entry.pending && !matched, entry.base, entry.inc, D), entry.fire, entry.name);
  }
  for (const entry of vectors.metadata) assert.deepEqual(core[entry.fn](...entry.args), entry.expect, entry.name);
});

const NAME = 'guard.html';
const rules = { sheets: '[items=sheets]@codec(sheet)', note: 'p@textContent' };
const doc = (body, value = rules, version = 2) => `<!doctype html><html><head><script type="application/json" data-rules-name="api" data-rules-version="${version}">${JSON.stringify(value)}</script></head><body>${body}</body></html>`;
const table = cells => `<div items="sheets"><section item data-id="s1"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="a" data-pos="G"><col data-id="b" data-pos="V"><col data-id="c" data-pos="k"></colgroup><tbody><tr data-id="r1" data-pos="V">${cells.map(text => `<td>${text}</td>`).join('')}</tr></tbody></table></section></div><p>Saved note</p>`;
const original = doc(table(['one', 'two', 'three']));

async function fixture(fn) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-guard-')));
  try { await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function seed(baseDir, html = original) {
  await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: html, prevContent: null, prov: 'external' });
  await guard.runDataLossGuard({ baseDir, name: NAME, newHtml: html, prevContent: html, prov: 'ui-gestured' });
  assert.equal((await guard._readGuard(baseDir, NAME)).uiWorkPending, true);
}

for (const [name, after, ifMatched, fire] of [
  ['agent overwrite with matched version', doc(table(['one', 'updated', 'three'])), true, false],
  ['outside overwrite', doc(table(['one', 'updated', 'three'])), false, true],
  ['agent clears a cell', doc(table(['one', '', 'three'])), true, true],
  ['unreadable codec keeps ordinary keys', doc(table(['one', 'two', 'three']), { ...rules, sheets: '[items=sheets]@codec(unknown)' }), true, true],
  ['unreadable tag', doc(table(['one', 'two', 'three']), rules, 99), true, true],
]) {
  test(name, () => fixture(async baseDir => {
    await seed(baseDir);
    const event = await guard.runDataLossGuard({ baseDir, name: NAME, prevContent: original, newHtml: after, prov: 'external', ifMatched });
    assert.equal(Boolean(event), fire);
    const state = await guard._readGuard(baseDir, NAME);
    assert.equal(state.baseline.data['@form'], 'stored');
    assert.deepEqual(state.baseline.data['@codecs'], { api: { sheets: 'sheet' } });
    if (fire) {
      assert.ok(event.preview.length > 0);
      assert.equal(event.restorable, false);
      assert.equal(event.canRevert, true);
      assert.ok(!JSON.stringify(event.preview).includes('@form'));
      assert.ok(!JSON.stringify(event.preview).includes('@codecs'));
    }
  }));
}

for (const [name, value, header, fire] of [
  ['matched overwrite', 'updated', 'exact', false],
  ['unmatched overwrite', 'updated', null, true],
  ['wildcard overwrite', 'updated', '*', true],
  ['matched clear', '', 'exact', true],
]) {
  test(`HTTP agent patch ${name}`, () => fixture(async baseDir => {
    await fs.writeFile(path.join(baseDir, NAME), original);
    await seed(baseDir);
    const server = await listenLoopback(createApp(baseDir));
    try {
      let posting = request(server).post('/_/api/' + NAME).send({ patch: [{ sheet: 'Budget', range: 'B1', values: [[value]] }] });
      if (header) posting = posting.set('If-Match', header === 'exact' ? documentEtag(Buffer.from(original)) : header);
      const result = await posting;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const until = Date.now() + 2000;
      let state;
      do {
        state = await guard._readGuard(baseDir, NAME);
        if (state?.uiWorkPending === false) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < until);
      assert.equal(state?.uiWorkPending, false, 'the guard must finish');
      assert.equal(Boolean(state.event), fire);
    } finally { await closeLoopback(); }
  }));
}

test('legacy Block editor baselines normalize once while marked baselines and code examples stay intact', () => fixture(async baseDir => {
  const { seedValue } = await import('@panphora/clayjs/src/page/ybind/seed.js');
  const tag = `<script type="application/json" merge="blockeditor" clay="live">${JSON.stringify(seedValue([{ id: 'p', t: 'paragraph', text: 'Saved text '.repeat(300) }]))}</script>`;
  const article = '<article data-blockeditor data-rev="rev-000000000001"><p>Saved text</p></article>';
  const html = doc(article, { content: 'body@innerHTML' }, 1);
  const legacy = { api: { content: tag + article } };
  for (const marked of [false, true]) {
    const data = { ...legacy, ...(marked ? { '@form': 'stored' } : {}) };
    await guard._writeGuard(baseDir, NAME, { baseline: { data, hash: core.islandHash(data), at: marked ? 0 : Date.now() }, uiWorkPending: false, event: null });
    const event = await guard.runDataLossGuard({ baseDir, name: NAME, prevContent: html, newHtml: html, prov: 'ui-background' });
    assert.equal(Boolean(event), marked);
    const state = await guard._readGuard(baseDir, NAME);
    assert.equal(state.baseline.data['@form'], 'stored');
    assert.equal(state.baseline.data.api.content.includes('merge='), marked);
  }
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const example = doc(`<pre>${escape(tag + article)}</pre>`, { note: 'pre@textContent' }, 1);
  const data = { api: { note: tag + article } };
  await guard._writeGuard(baseDir, NAME, { baseline: { data }, uiWorkPending: true, event: null });
  assert.equal(await guard.runDataLossGuard({ baseDir, name: NAME, prevContent: example, newHtml: example, prov: 'external' }), null);
  assert.deepEqual((await guard._readGuard(baseDir, NAME)).baseline.data, data);
}));
