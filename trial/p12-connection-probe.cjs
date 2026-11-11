'use strict';

// Preloaded into the sync driver (P12, part E). The driver starts its own Go
// process and keeps Go's control URL and secret to itself, so the harness that
// forked it cannot read the event stream `GET /v1/events?since=` is resumed from.
// This reads the connection the driver's own watcher reads
// (trial/go-process.cjs getConnection) and records each new one where the
// harness that set P12_CONNECTION_OUT can find it.
const fs = require('fs');
const path = require('path');

const target = path.join(process.env.LOCAL_DIR || path.resolve(__dirname, '..'), 'trial', 'go-process.cjs');
const out = process.env.P12_CONNECTION_OUT;

let recorded = null;

function record() {
  if (!out) return;
  let connection;
  try {
    connection = require(target).getConnection();
  } catch {
    return;
  }
  if (recorded && recorded.url === connection.url && recorded.secret === connection.secret) return;
  recorded = { url: connection.url, secret: connection.secret, epoch: connection.epoch ?? null };
  try {
    fs.writeFileSync(out, `${JSON.stringify(recorded)}\n`);
  } catch {
    // A harness that cannot read the record sees no connection, never a stale one.
  }
}

setInterval(record, 50).unref();
