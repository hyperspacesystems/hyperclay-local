import { SAVE_CASES } from './save.mjs';
import { STORAGE_CASES } from './storage.mjs';
import { PAGE_CASES } from './page.mjs';
import { CHECKPOINT_CASES } from './checkpoint.mjs';
import { ALIAS_CASES } from './alias.mjs';

export const CASES = [...SAVE_CASES, ...STORAGE_CASES, ...PAGE_CASES, ...CHECKPOINT_CASES, ...ALIAS_CASES];

export const PENDING = [];
