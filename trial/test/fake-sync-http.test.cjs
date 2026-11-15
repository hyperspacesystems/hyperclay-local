'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../../src/sync-engine/api-client.js');
const { startFakeSyncHttp } = require('../fake-sync-http.cjs');

const key = 'hcsk_' + 'a'.repeat(64);
const actor = { id: 7, username: 'sam', person: { id: 7, name: 'Sam' } };
const accounts = [{ id: 7, kind: 'personal', username: 'sam' }];

const seed = () => [
  { id: 1, type: 'folder', name: 'apps', parentId: 0 },
  { id: 2, type: 'site', name: 'index.html', parentId: 1, content: '<p>one</p>' }
];

async function withServer(fn) {
  const fake = await startFakeSyncHttp({ nodes: seed(), key, actor, accounts });
  const conn = { serverUrl: fake.url, apiKey: key, protocol: 2 };
  try {
    return await fn(fake, conn);
  } finally {
    await fake.close();
  }
}

test('lists the nodes', async () => {
  await withServer(async (_fake, conn) => {
    const nodes = await api.listNodes(conn);
    assert.equal(nodes.length, 2);
    assert.deepEqual(nodes.map((node) => node.id).sort(), [1, 2]);
  });
});

test('reads and writes content', async () => {
  await withServer(async (_fake, conn) => {
    const before = await api.getNodeContent(conn, 2);
    assert.equal(before.content, '<p>one</p>');
    assert.ok(before.etag);

    await api.putNodeContent(conn, 2, '<p>two</p>', { ifMatch: before.etag });

    const after = await api.getNodeContent(conn, 2);
    assert.equal(after.content, '<p>two</p>');
  });
});

test('a stale If-Match is refused', async () => {
  await withServer(async (_fake, conn) => {
    const current = await api.getNodeContent(conn, 2);

    await assert.rejects(
      api.putNodeContent(conn, 2, 'x', { ifMatch: 'stale' }),
      (error) => {
        assert.equal(error.statusCode, 412);
        assert.equal(error.etag, current.etag);
        return true;
      }
    );

    const after = await api.getNodeContent(conn, 2);
    assert.equal(after.content, '<p>one</p>');
  });
});

test('a wrong key is refused', async () => {
  await withServer(async (fake, conn) => {
    await assert.rejects(
      api.listNodes({ ...conn, apiKey: 'hcsk_' + 'b'.repeat(64) }),
      (error) => error.statusCode === 401
    );
    assert.equal(fake.requests[fake.requests.length - 1].authorized, false);
  });
});

test('creates, renames, moves and deletes', async () => {
  await withServer(async (fake, conn) => {
    const created = await api.createNode(conn, {
      type: 'site',
      name: 'new.html',
      parentId: 1,
      content: '<p>new</p>'
    });
    assert.ok(created.id);
    assert.ok(fake.server.paths().includes('apps/new.html'));

    await api.renameNode(conn, created.id, 'renamed.html');
    assert.ok(fake.server.paths().includes('apps/renamed.html'));

    await api.moveNode(conn, created.id, 0);
    assert.ok(fake.server.paths().includes('renamed.html'));

    await api.deleteNode(conn, created.id);
    assert.deepEqual(fake.server.paths(), ['apps', 'apps/index.html']);
  });
});

test('accounts answer protocol 2', async () => {
  await withServer(async (fake) => {
    const data = await api.getAccounts({ serverUrl: fake.url, apiKey: key });
    assert.equal(data.protocol, 2);
    assert.equal(data.actor.username, 'sam');
  });
});

test('the stream sends sync-ready, then what is pushed', async () => {
  await withServer(async (fake) => {
    const controller = new AbortController();
    const response = await fetch(fake.url + '/_/sync/stream', {
      headers: { 'X-API-Key': key },
      signal: controller.signal
    });
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('"sync-ready"');
    fake.push({ type: 'node-saved', nodeId: 2 });
    await readUntil('"node-saved"');
    controller.abort();

    assert.ok(text.includes('data: {"type":"sync-ready","sync":{"enabled":true}}\n\n'));
    assert.ok(text.includes('data: {"type":"node-saved","nodeId":2}\n\n'));
  });
});
