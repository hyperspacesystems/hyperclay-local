const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Builds a jest module mock from the real module's export list: every exported function becomes a
// bare jest.fn() unless the test overrides it. A test that mocks a module therefore keeps working
// when the module gains an export, instead of failing with "x is not a function".
function mockExports(fromRoot, overrides = {}) {
  const actual = jest.requireActual(path.join(ROOT, fromRoot));
  for (const key of Object.keys(overrides)) {
    if (!(key in actual)) throw new Error(`${fromRoot} has no export ${key}; remove it from the mock`);
  }
  const mock = {};
  for (const [key, value] of Object.entries(actual)) {
    mock[key] = typeof value === 'function' ? jest.fn() : value;
  }
  return Object.assign(mock, overrides);
}

module.exports = { mockExports };
