// A minimal EventSource backed by Node's http client, for tests that run a
// SharedWorker outside a browser against a real loopback origin.
//
// It parses the real wire -- `event:`, `id:`, `data:` and comment lines -- and
// dispatches with `data` and `lastEventId`, exactly the fields a worker's
// callbacks read. It never reconnects on its own: the worker owns reconnection
// (a rebuild from a new URL with new positions), so a test that wants a dropped
// connection drops the socket and lets the worker decide. Every socket it opens
// is recorded, so a test can count connections and inspect their URLs, and every
// socket it opened is destroyed by close() or by cleanup() at the end of a test.

const http = require('http');

class HttpEventSource {
  static opened = [];

  static reset() {
    HttpEventSource.opened = [];
  }

  static live() {
    return HttpEventSource.opened.filter((connection) => !connection.closed);
  }

  // Close every source a previous test left behind, so one test's worker cannot
  // reconnect into the next one, and destroy the sockets so neither holds the
  // server open. A close is deliberate, so it raises no error event.
  static cleanup() {
    for (const connection of HttpEventSource.opened) connection.source.close();
    HttpEventSource.opened = [];
  }

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    this.listeners = new Map();
    this._closedByCaller = false;
    this._connection = null;
    this._connect();
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }

  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }

  _emit(name, event) {
    for (const fn of [...(this.listeners.get(name) || [])]) fn(event);
    if (name === 'message' && typeof this.onmessage === 'function') this.onmessage(event);
  }

  _connect() {
    const url = new URL(this.url);
    const connection = {
      source: this,
      url: this.url,
      closed: false,
      response: null,
      destroy: () => {
        try {
          this._request?.destroy();
        } catch {}
      },
    };
    HttpEventSource.opened.push(connection);
    this._connection = connection;
    const headers = { 'Sec-Fetch-Site': 'same-origin', Accept: 'text/event-stream' };
    const request = http.get({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
    }, (response) => {
      connection.response = response;
      this.readyState = 1;
      response.setEncoding('utf8');
      let buffer = '';
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        connection.closed = true;
        this._fail();
      };
      response.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) this._dispatch(part);
      });
      response.on('end', end);
      response.on('error', end);
      response.on('close', () => {
        connection.closed = true;
        if (!this._closedByCaller) end();
      });
      if (typeof this.onopen === 'function') this.onopen({ type: 'open', target: this });
    });
    request.on('error', () => {
      connection.closed = true;
      this._fail();
    });
    this._request = request;
    connection.request = request;
  }

  _dispatch(part) {
    let name = 'message';
    let id = '';
    const data = [];
    for (const line of part.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const at = line.indexOf(':');
      const field = at < 0 ? line : line.slice(0, at);
      let value = at < 0 ? '' : line.slice(at + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;
    this._emit(name, { type: name, data: data.join('\n'), lastEventId: id, target: this });
  }

  _fail() {
    if (this._closedByCaller || this.readyState === 2) return;
    this.readyState = 2;
    if (typeof this.onerror === 'function') this.onerror({ type: 'error', target: this });
  }

  // Test-only: kill the socket without closing the source, the way a dropped
  // network connection would.
  drop() {
    this._connection?.destroy();
  }

  close() {
    if (this._closedByCaller) return;
    this._closedByCaller = true;
    this.readyState = 2;
    if (this._connection) this._connection.closed = true;
    this._connection?.destroy();
  }
}

module.exports = { HttpEventSource };
