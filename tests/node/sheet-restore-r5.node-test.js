const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = require('../../src/main/data-loss-core.cjs');
const guard = require('../../src/main/data-loss-guard');
const NAME = 'restore.html';
const doc = body => `<!doctype html><html><head><script type="application/json" data-rules-name="api" data-rules-version="1">{"content":"body@innerHTML"}</script></head><body>${body}</body></html>`;

test('Restore of a legacy Block editor event keeps a stored baseline and the next save quiet', async () => {
  const baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-restore-r5-')));
  try {
    const { seedValue } = await import('@panphora/clayjs/src/page/ybind/seed.js');
    const { splitPage } = require('@panphora/clayjs/server/rooms');
    const article = '<article data-blockeditor data-rev="rev-000000000001"><p>Saved text</p></article>';
    const tag = `<script type="application/json" merge="blockeditor" clay="live">${JSON.stringify(seedValue([{ id: 'p', t: 'paragraph', text: 'Saved text '.repeat(300) }]))}</script>`;
    const { extractViaTag } = require('../../src/main/utils/data-extractor');
    const recoverableData = { api: await extractViaTag(doc(tag + article), 'api') };
    let disk = doc(article.replace('Saved text', 'Changed text'));
    await guard._writeGuard(baseDir, NAME, {
      baseline: { data: recoverableData, hash: core.islandHash(recoverableData) },
      uiWorkPending: true,
      event: { id: 'legacy', recoverableData },
    });
    const result = await guard.resolveGuard({ baseDir, name: NAME, id: 'legacy', choice: 'restore', currentHtml: disk,
      writeBack: async html => {
        const split = splitPage(html);
        assert.ok(split.state);
        disk = split.file;
      },
    });
    assert.equal(result.status, 'restored', JSON.stringify(result));
    const state = await guard._readGuard(baseDir, NAME);
    assert.equal(state.event, null);
    assert.equal(state.baseline.data['@form'], 'stored');
    assert.ok(!state.baseline.data.api.content.includes('merge="blockeditor"'));
    assert.deepEqual(state.baseline.data, await guard.extractIsland(disk));
    assert.equal(await guard.runDataLossGuard({ baseDir, name: NAME, prevContent: disk, newHtml: disk, prov: 'ui-gestured' }), null);
    assert.equal((await guard._readGuard(baseDir, NAME)).event, null);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
