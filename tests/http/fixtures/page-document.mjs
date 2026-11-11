// A page document built from the page format's own client modules: the same
// construction tests/helpers/page-fixture.js uses (seed value, rendered blocks,
// an update that deletes one character of the paragraph's flow text), with the
// data API rules this suite writes through. Nothing here imports the host.

import * as Y from '@panphora/clayjs/src/vendor/yjs.vendor.js';
import { seedValue } from '@panphora/clayjs/src/page/ybind/seed.js';
import { docFromValue, enc } from '@panphora/clayjs/src/page/ybind/provider.js';
import { readYValue, projection } from '@panphora/clayjs/page/yjs';

const API_RULES = { body: 'article p', second: 'article p[data-id=q]', rev: 'article@data-rev' };

export async function pageDocument({ text = 'abc', second = 'second', store = null } = {}) {
  const value = seedValue([
    { id: 'p', t: 'paragraph', text },
    { id: 'q', t: 'paragraph', text: second },
  ]);
  const page = await readYValue(value);
  const rendered = projection.renderBlocks(page.blocks);
  const storeTag = store
    ? `<script type="application/json" merge="${store.name}" clay="live">${JSON.stringify(store.value)}</script>`
    : '';
  const html = '<!doctype html><html><head><script type="application/json" merge="blockeditor" clay="live">' +
    JSON.stringify(value) + '</script><script type="application/json" data-rules-name="api" data-rules-version="1">' +
    JSON.stringify(API_RULES) + '</script>' + storeTag + '</head><body><article data-blockeditor="1" data-rev="' +
    rendered.rev + '">' + rendered.html + '</article></body></html>';
  const doc = docFromValue(value, { strict: true });
  doc.clientID = 123;
  doc.getText('flow').delete(2, 1);
  const update = enc(Y.encodeStateAsUpdateV2(doc));
  doc.destroy();
  return { html, revision: page.revision, update };
}
