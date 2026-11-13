const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const guard = require('../../src/main/data-loss-guard');
const core = require('../../src/main/data-loss-core.cjs');
const rooms = require('@panphora/clayjs/server/rooms');

const doc = (body, rules = { content: 'body@innerHTML' }) => `<!doctype html><html><head><script data-rules-name="api" data-rules-version="1">${JSON.stringify(rules)}</script></head><body>${body}</body></html>`;
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

for (const operation of ['save', 'open']) {
  for (const scenario of ['recovered', 'marked', 'example', 'partial']) {
    test(`${operation} recovery comparison: ${scenario}`, async () => {
      const { seedValue } = await import('@panphora/clayjs/src/page/ybind/seed.js');
      const tag = `<script type="application/json" merge="blockeditor" clay="live">${JSON.stringify(seedValue([{ id: 'p', t: 'paragraph', text: 'Recovered paragraph. '.repeat(300) }]))}</script>`;
      const article = '<article data-blockeditor="" data-rev="saved"><p>Recovered paragraph</p></article>';
      const example = scenario === 'example';
      const current = example ? doc(`<pre>${escape(article)}</pre>`, { note: 'pre@textContent' }) : doc(scenario === 'partial' ? article.replace('Recovered paragraph', 'Still missing') : article);
      assert.equal(Boolean(rooms.pageRev(current)), !example);
      const recoverable = { api: { [example ? 'note' : 'content']: tag + article }, ...(scenario === 'marked' ? { '@form': 'stored' } : {}) };
      const pinned = structuredClone(recoverable);
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-recovery-'));
      try {
        await guard._writeGuard(baseDir, 'doc.html', {
          baseline: { data: recoverable, hash: core.islandHash(recoverable), at: 0 },
          event: { id: 'old-event', recoverableData: recoverable, status: 'pending', lossSummary: {} },
          status: 'pending', uiWorkPending: false,
        });
        if (operation === 'save') {
          await guard.runDataLossGuard({ baseDir, name: 'doc.html', newHtml: current, prevContent: doc('<p>clobbered</p>'), prov: 'ui-background' });
        } else {
          const event = await guard.getGuardEvent(baseDir, 'doc.html', current);
          assert.equal(Boolean(event), scenario !== 'recovered');
        }
        const state = await guard._readGuard(baseDir, 'doc.html');
        assert.equal(Boolean(state.event), scenario !== 'recovered');
        assert.deepEqual(recoverable, pinned);
        if (state.event) assert.deepEqual(state.event.recoverableData, pinned);
        else {
          assert.equal(state.status, 'restored');
          assert.deepEqual(state.baseline.data, await guard.extractIsland(current));
        }
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    });
  }
}
