// A live participant built only from what a browser tab does against this host:
// open the document's live SSE stream (/_/sync?lane=live&client-id=...), read the
// room's state and its `conn` from the data lane (GET /_/sync/data), then send
// frames to the same lane (POST /_/sync/data). The same request shapes
// @panphora/clayjs/src/live/server-lane.js sends, with no server-side imports.

import { assert, delay } from './support.mjs';

const JOIN_DEADLINE_MS = 8000;

export async function joinLiveClient(ctx, { rootId, docPath, clientId }) {
  const origin = ctx.rootUrl(rootId);
  const documentUrl = `${origin}/${docPath}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onAbort);

  const events = [];
  const stream = await fetch(
    `${origin}/_/sync?${new URLSearchParams({ 'document-url': documentUrl, lane: 'live', 'client-id': clientId })}`,
    { headers: { 'document-url': documentUrl }, signal: controller.signal },
  );
  assert(stream.status === 200, `live stream for ${clientId} answered ${stream.status}`);
  const type = stream.headers.get('content-type') || '';
  assert(type.includes('text/event-stream'), `live stream for ${clientId} is typed ${type}`);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = { event: 'message', data: '' };
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('data: ')) event.data += line.slice(6);
          }
          events.push(event);
        }
      }
    } catch {}
  })();

  let session = null;
  let n = 0;

  async function state() {
    const response = await fetch(`${origin}/_/sync/data?${new URLSearchParams({ 'client-id': clientId })}`, {
      headers: { 'document-url': documentUrl },
      signal: controller.signal,
    });
    const text = await response.text();
    assert(response.status === 200, `live client ${clientId} state read answered ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  async function ready() {
    const deadline = Date.now() + JOIN_DEADLINE_MS;
    for (;;) {
      const current = await state();
      if (typeof current.conn === 'string' && current.conn) {
        session = current;
        return session;
      }
      assert(Date.now() < deadline, `live client ${clientId} never joined the document's room`);
      await delay(25);
    }
  }

  async function edit(name, ops) {
    if (!session) await ready();
    n += 1;
    const response = await fetch(`${origin}/_/sync/data?${new URLSearchParams({ 'client-id': clientId })}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'document-url': documentUrl },
      body: JSON.stringify({
        conn: session.conn,
        name,
        n,
        epoch: session.epoch,
        blockeditorGeneration: session.blockeditorTransition ? session.blockeditorTransition.id : null,
        ops,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    ctx.signal.removeEventListener('abort', onAbort);
    await pump;
  }

  return {
    clientId,
    documentUrl,
    events,
    state,
    ready,
    edit,
    close,
    get session() { return session; },
  };
}
