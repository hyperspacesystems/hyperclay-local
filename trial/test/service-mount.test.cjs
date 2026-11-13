'use strict';

// A host mounts its own routes on the service's listener (HTML Clay's dashboard
// API), behind the same host, bearer and epoch checks as the protocol's routes,
// and hears roots come and go.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.HYPERCLAY_PAGE_COMPACTION = '0';
const { createTrialService } = require('../service.cjs');

const SECRET = 'a'.repeat(64);

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function call(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('mounted routes pass the listener checks first, and roots are announced', async (t) => {
  // A stand-in for Go: the service follows its event stream once it has a peer.
  const go = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/events')) { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); return; }
    res.writeHead(404); res.end();
  });
  const goUrl = await listen(go);
  const service = createTrialService({ secret: SECRET });
  const url = await service.listen();
  t.after(async () => { go.closeAllConnections(); go.close(); await service.close(); });

  const seen = [];
  service.mount('/v1/shell/', (req, res) => { seen.push(req.url); res.writeHead(200); res.end('shell'); });
  assert.throws(() => service.mount('/v1/route/x/', () => {}));
  assert.throws(() => service.mount('/v1/shell', () => {}));

  const bearer = { authorization: `Bearer ${SECRET}` };
  assert.equal((await call(`${url}/v1/shell/api/roots`)).status, 401);
  assert.equal((await call(`${url}/v1/shell/api/roots`, { headers: bearer })).status, 409, 'no peer yet, so no epoch is current');
  const peer = await call(`${url}/v1/peer`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ url: goUrl, secret: 'b'.repeat(64), epoch: 'go-epoch' }) });
  assert.equal(peer.status, 200);
  const epochs = { ...bearer, 'x-trial-epoch': 'go-epoch', 'x-trial-peer-epoch': service.epoch };
  assert.equal((await call(`${url}/v1/shell/api/roots`, { headers: { ...epochs, 'x-trial-epoch': 'old' } })).status, 409);
  const answered = await call(`${url}/v1/shell/api/roots`, { headers: epochs });
  assert.deepEqual([answered.status, answered.text], [200, 'shell']);
  assert.deepEqual(seen, ['/v1/shell/api/roots']);
  assert.equal((await call(`${url}/v1/shellx`, { headers: epochs })).status, 404);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-mount-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let announced = 0;
  const stop = service.onRoots(() => { announced += 1; });
  const roots = (body) => call(`${url}/v1/roots`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await roots({ add: [{ id: 'r1', path: dir, url: 'http://notes.htmlclay.localhost:1212' }] })).status, 200);
  assert.equal(announced, 1);
  assert.equal((await roots({ remove: ['r1'], deadlineMs: 1000 })).status, 200);
  assert.equal(announced, 2);
  stop();
  await roots({ add: [{ id: 'r1', path: dir, url: 'http://notes.htmlclay.localhost:1212' }] });
  assert.equal(announced, 2, 'an unsubscribed listener hears nothing');
});
