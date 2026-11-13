const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cheerio = { ...require('cheerio') };
require.cache[require.resolve('cheerio')].exports = cheerio;
const guard = require('../../src/main/data-loss-guard');
const vectors = require('../fixtures/sheet-guard-extraction.json');
const { extractViaTag } = require('../../src/main/utils/data-extractor');

for (const entry of vectors.cases) {
  test(`shared guard extraction: ${entry.name}`, async () => {
    const first = await guard.extractIsland(entry.html);
    assert.deepEqual(first, entry.island);
    assert.deepEqual(await guard.extractIsland(entry.html), first);
    assert.deepEqual(await extractViaTag(entry.html, 'api'), entry.data);
    assert.deepEqual(await extractViaTag(entry.html, 'api'), entry.data);
  });
}

const sheetHtml = () => {
  const cols = Array.from({ length: 40 }, (_, i) => `<col data-id="c${i}" data-pos="V">`).join('');
  const cells = '<td>Saved cell</td>'.repeat(40);
  const rows = Array.from({ length: 500 }, (_, i) => `<tr data-id="r${i}" data-pos="V">${cells}</tr>`).join('');
  return `<!doctype html><html><head><script data-rules-name="api" data-rules-version="2">{"sheets":"[items=sheets]@codec(sheet)"}</script></head><body><div items="sheets"><section item data-id="s1"><h2 bind="name">Budget</h2><table grid><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table></section></div></body></html>`;
};

test('a 20,000-cell guard read never builds the full cell tree', async t => {
  const html = sheetHtml();
  await guard.extractIsland(html);
  const load = cheerio.load;
  const parsed = [];
  cheerio.load = (...args) => { parsed.push(args[0]); return load(...args); };
  try {
    const durations = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await guard.extractIsland(html);
      durations.push(performance.now() - start);
      assert.equal(result.api.sheets[0].rows.length, 500);
    }
    assert.ok(parsed.length > 0);
    assert.ok(parsed.every(source => !source.includes('<td>Saved cell</td>')), 'only the sheet shell reaches the tree parser');
    t.diagnostic(`20,000 cells median ${durations.sort((a, b) => a - b)[2].toFixed(2)} ms`);
  } finally { cheerio.load = load; }
});

test('opening a guarded document skips extraction after the baseline exists', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-open-'));
  const load = cheerio.load;
  let parses = 0;
  cheerio.load = (...args) => { parses++; return load(...args); };
  try {
    const html = vectors.cases[0].html;
    await guard.getGuardEvent(baseDir, 'sheet.html', html);
    assert.ok((await guard._readGuard(baseDir, 'sheet.html')).baseline);
    assert.ok(parses > 0);
    parses = 0;
    assert.equal(await guard.getGuardEvent(baseDir, 'sheet.html', html), null);
    assert.equal(parses, 0);
  } finally {
    cheerio.load = load;
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
