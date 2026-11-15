'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { passiveObserver, followHost } = require('../sync-observer.cjs');

// A host whose event stream the test drives by hand.
function handHost() {
  const host = { listener: null, closed: false };
  host.events = (since, listener) => {
    host.since = since;
    host.listener = listener;
    return () => { host.closed = true; };
  };
  return host;
}

test('the observer follows the host\'s event stream', async (t) => {
  await t.test('a change reaches every subscriber', () => {
    const host = handHost();
    const observer = passiveObserver();
    const seen = [];
    observer.subscribe((frame) => seen.push(frame));
    followHost(host, observer);
    host.listener({ type: 'change', event: 'add', rel: 'apps/index.html' });
    assert.equal(host.since, null);
    assert.deepEqual(seen, [{ event: 'add', rel: 'apps/index.html' }]);
  });

  await t.test('a gap asks for a full comparison', () => {
    const host = handHost();
    const observer = passiveObserver();
    const seen = [];
    observer.subscribe((frame) => seen.push(frame));
    const gaps = [];
    followHost(host, observer, { onGap: (frame) => gaps.push(frame) });
    host.listener({ type: 'gap', since: '4:17' });
    assert.deepEqual(gaps, [{ type: 'gap', since: '4:17' }]);
    assert.deepEqual(seen, [], 'a gap is not a file change');
  });

  await t.test('stopping ends the feed', () => {
    const host = handHost();
    const stop = followHost(host, passiveObserver());
    stop();
    assert.equal(host.closed, true);
  });
});
