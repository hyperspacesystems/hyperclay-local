// Which Origin and Host headers a root's app treats as its own. A root with only a
// port (Hyperclay Local's own folders) keeps the loopback-and-port rule; a root
// with a whole public origin (HTML Clay serves every folder on one port, at
// http://<name>.htmlclay.localhost:<port>) accepts exactly that origin.
const { isOwnOrigin, isOwnHostHeader } = require('../../src/main/server.js');

const req = (localPort) => ({ socket: { localPort } });

describe('a root with only a port', () => {
  const ctx = { root: { port: 4321 } };
  test.each([
    ['localhost on its port', 'http://localhost:4321', true],
    ['127.0.0.1 on its port', 'http://127.0.0.1:4321', true],
    ['[::1] on its port', 'http://[::1]:4321', true],
    ['the port the connection arrived on', 'http://localhost:5555', true],
    ['another port', 'http://localhost:4322', false],
    ['no port', 'http://localhost', false],
    ['a non-loopback host on its port', 'http://evil.example:4321', false],
    ['a named localhost on its port', 'http://notes.htmlclay.localhost:4321', false],
    ['null', 'null', false],
  ])('%s', (_, origin, ok) => {
    expect(isOwnOrigin(origin, req(5555), ctx)).toBe(ok);
  });

  test.each([
    ['localhost:4321', true],
    ['127.0.0.1:4321', true],
    ['localhost', true],
    ['evil.example:4321', false],
    ['notes.htmlclay.localhost:4321', false],
    ['', false],
  ])('Host %s', (host, ok) => {
    expect(isOwnHostHeader(host, ctx)).toBe(ok);
  });
});

describe('a root with a whole public origin', () => {
  const own = 'notes.htmlclay.localhost:1212';
  const ctx = { root: { port: 1212, origin: `http://${own}` } };
  test.each([
    ['its own origin', `http://${own}`, true],
    ['its own origin in upper case', 'http://NOTES.htmlclay.localhost:1212', true],
    ["another folder's origin", 'http://journal.htmlclay.localhost:1212', false],
    ["a loose file's origin", 'http://htmlclay3.localhost:1212', false],
    ["the dashboard's origin", 'http://htmlclay.localhost:1212', false],
    ['its own name on another port', 'http://notes.htmlclay.localhost:4321', false],
    ['a bare loopback origin on the same port', 'http://127.0.0.1:1212', false],
    ['localhost on the same port', 'http://localhost:1212', false],
    ['https with its own name', `https://${own}`, false],
    ['null', 'null', false],
    ['garbage', 'not a url', false],
  ])('%s', (_, origin, ok) => {
    expect(isOwnOrigin(origin, req(1212), ctx)).toBe(ok);
  });

  test.each([
    [own, true],
    ['Notes.HTMLClay.localhost:1212', true],
    ['journal.htmlclay.localhost:1212', false],
    ['127.0.0.1:1212', false],
    ['localhost:1212', false],
    ['notes.htmlclay.localhost:4321', false],
    ['evil.example', false],
    ['', false],
  ])('Host %s', (host, ok) => {
    expect(isOwnHostHeader(host, ctx)).toBe(ok);
  });
});
