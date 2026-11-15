const { conflictedCopyName } = require('../../src/sync-engine/conflicted-copy-name');
const { validateFullPath, validateFileName } = require('../../src/sync-engine/validation');

// Every copy the engine makes has to be a name the server accepts, or it stays on this computer
// and never syncs. validation.js is Local's copy of the server's rule.
describe('conflictedCopyName', () => {
  const cases = [
    ['board.html', false],
    ['board.htmlclay', false],
    ['apps/board.html', false],
    ['notes.txt', false],
    ['proj2', true],
  ];
  for (const [rel, isDirectory] of cases) {
    for (const n of [1, 2, 100]) {
      it(`copy ${n} of ${rel} is a name the server accepts`, () => {
        const copy = conflictedCopyName(rel, n);
        const result = copy.includes('/') ? validateFullPath(copy) : validateFileName(copy, isDirectory);
        expect(result).toMatchObject({ valid: true });
        expect(copy).not.toBe(rel);
      });
    }
  }

  it('keeps the folder and the extension', () => {
    expect(conflictedCopyName('apps/board.html')).toBe('apps/board-conflicted-copy.html');
    expect(conflictedCopyName('apps/board.html', 2)).toBe('apps/board-conflicted-copy-2.html');
  });
});
