'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BUILD = require(path.join(__dirname, '..', '..', 'package.json')).build;

function entryGlob(entry) {
  if (typeof entry === 'string') return entry;
  return entry && typeof entry.from === 'string' ? entry.from : '';
}

function reachesTrial(glob) {
  const text = entryGlob(glob).replace(/^\.\//, '').replace(/^!/, '');
  const first = text.split('/')[0];
  if (first === 'trial') return true;
  return /[*?{[]/.test(first);
}

function globsReachingTrial(build) {
  return [...(build.files || []), ...(build.extraFiles || []), ...(build.extraResources || [])]
    .filter((glob) => !entryGlob(glob).startsWith('!'))
    .filter(reachesTrial)
    .map(entryGlob);
}

test('no packaged glob can include the trial folder', () => {
  assert.deepEqual(globsReachingTrial(BUILD), []);
});

test('the check catches a glob that would pack the trial folder', () => {
  assert.deepEqual(globsReachingTrial({ files: ['src/main/**/*', 'trial/**/*'] }), ['trial/**/*']);
  assert.deepEqual(globsReachingTrial({ files: ['**/*'] }), ['**/*']);
  assert.deepEqual(globsReachingTrial({ files: ['src/**'], extraResources: [{ from: 'trial', to: 'x' }] }), ['trial']);
  assert.deepEqual(globsReachingTrial({ files: ['src/**', '!trial/**'] }), []);
});
