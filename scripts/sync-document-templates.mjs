import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repo, '../hyperclay/public-assets/core-apps');
const thumbnailSource = resolve(repo, '../hyperclay/public-assets/workspace/templates');
const destination = join(repo, 'src/main/document-templates');
const readJson = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
};

// The gallery hyperclay.com shows: Blank first, then its listed templates in order.
const catalog = (await readJson(join(source, 'templates.json')) || [])
  .map(item => ({ id: item.key, name: item.name, description: item.description, thumbnail: item.thumbnail, listed: true }));
const unlisted = await readJson(join(source, 'templates-unlisted.json')) || [];
const cards = [
  { id: 'blank', name: 'Blank', description: 'An empty HTML file with ClayJS included. Bring your own everything.', thumbnail: null, listed: true },
  ...catalog,
  ...['devlog', 'landing'].map(id => {
    const item = unlisted.find(entry => entry.key === id);
    return { id, name: item?.name || id, description: item?.description || '', thumbnail: item?.thumbnail || null, listed: false };
  }),
];

await mkdir(join(destination, 'thumbnails'), { recursive: true });
const manifest = [];
for (const card of cards) {
  const file = `${card.id}.html`;
  const bytes = await readFile(join(source, file));
  await writeFile(join(destination, file), bytes);
  // hyperclay.com draws `<id>.svg` whenever the catalog names no thumbnail (Blank among them), so take it whenever it exists.
  const hasThumbnail = await stat(join(thumbnailSource, `${card.id}.svg`)).then(() => true, () => false);
  if (hasThumbnail) await writeFile(join(destination, 'thumbnails', `${card.id}.svg`), await readFile(join(thumbnailSource, `${card.id}.svg`)));
  manifest.push({
    id: card.id, file, name: card.name, description: card.description,
    thumbnail: hasThumbnail ? `thumbnails/${card.id}.svg` : null, listed: card.listed,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
