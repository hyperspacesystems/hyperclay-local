import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SAVE_CASES } from './save.mjs';
import { STORAGE_CASES } from './storage.mjs';
import { PAGE_CASES } from './page.mjs';
import { CHECKPOINT_CASES } from './checkpoint.mjs';

// The package's exports map names only its root and vectors, so the frozen rows are
// reached through the package root it does export.
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('@panphora/host-conformance/package.json'));
const { PROTOCOL_CASES } = await import(
  pathToFileURL(path.join(packageRoot, 'src', 'frozen', 'protocol-cases.js')).href
);

export const CASES = [
  ...PROTOCOL_CASES,
  ...SAVE_CASES,
  ...STORAGE_CASES,
  ...PAGE_CASES,
  ...CHECKPOINT_CASES,
];

export const PENDING = [];
