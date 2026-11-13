import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READY_TIMEOUT_MS, STOP_GRACE_MS } from '../scripts/conformance.mjs';
import { assertReady } from './p1.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// A child's stdout split into lines, with a waiter that resolves on the first
// line matching its pattern. Lines that match nothing stay for a later waiter.
function lineReader(stream) {
  const waiters = [];
  const lines = [];
  let buffer = '';
  let failure = null;

  function drain() {
    while (waiters.length && !failure) {
      const waiter = waiters[0];
      const index = lines.findIndex((line) => waiter.pattern.test(line));
      if (index === -1) return;
      const [line] = lines.splice(index, 1);
      waiters.shift();
      waiter.resolve(line);
    }
    if (failure) {
      while (waiters.length) waiters.shift().reject(failure);
    }
  }

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      drain();
    }
  });
  stream.on('error', () => {
    failure = failure || new Error('the child’s stdout could not be read');
    drain();
  });
  stream.on('end', () => {
    failure = failure || new Error('the child’s stdout ended before that line arrived');
    drain();
  });

  return {
    next(pattern) {
      return new Promise((resolve, reject) => {
        waiters.push({ pattern, resolve, reject });
        drain();
      });
    },
  };
}

function tailOf(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8');
    return text.slice(-2000);
  } catch {
    return '';
  }
}

// Races a wait for a line against the child's exit and the deadline, so a wait
// that can no longer succeed fails with the step that was running.
function waitFor(check, {
  child, name, timeoutMs, step,
}) {
  const deadline = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${step}: the ${name} answered nothing within ${timeoutMs}ms`)),
      Math.max(timeoutMs, 1),
    );
    timer.unref?.();
  });
  const gone = new Promise((resolve) => {
    if (exited(child)) {
      resolve();
      return;
    }
    child.once('exit', resolve);
  }).then(() => {
    if (exited(child)) throw new Error(`${step}: the ${name} exited first (${child.signalCode ?? `exit ${child.exitCode}`})`);
  });
  const named = check.catch((error) => {
    throw new Error(`${step}: ${error?.message || String(error)}`);
  });
  return Promise.race([named, gone, deadline]);
}

function terminate({ child, exitPromise, graceMs }) {
  if (exited(child)) return exitPromise.then(() => {});
  try {
    child.stdin.end();
  } catch {
    // A stdin that is already gone is a child already shutting down.
  }
  return Promise.race([exitPromise, wait(graceMs).then(() => null)]).then(async (gone) => {
    if (gone) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // A signal to a gone child is the same as a child that has gone.
    }
    const afterTerm = await Promise.race([exitPromise, wait(graceMs).then(() => null)]);
    if (afterTerm) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing left to kill.
    }
    await exitPromise;
  });
}

// A port the pair can have: Go gives root i the port `port + i`, so both P and
// P+1 must be free on loopback before the hosts start.
function probePort(port) {
  return new Promise((resolve) => {
    const first = net.createServer();
    first.once('error', () => resolve(false));
    first.listen(port, '127.0.0.1', () => {
      first.close(() => {
        const second = net.createServer();
        second.once('error', () => resolve(false));
        second.listen(port + 1, '127.0.0.1', () => second.close(() => resolve(true)));
      });
    });
  });
}

export async function freePortPair() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 39999);
    if (await probePort(port)) return port;
  }
  throw new Error('no free base port in 20000..60000');
}

/**
 * The managed trial's host pair: the JS service as its own process, then Go
 * attached to it, then the service attached to Go (protocol v1, "Transport and
 * bootstrap"). Answers what `startGo` in trial/p1.mjs answers, plus `service`,
 * so every P script can take either.
 *
 * Either child can then be killed (`kill`) or restarted (`restartGo`,
 * `restartService`) without losing the pair's public root URLs, because a tab's
 * URL has to survive a restart. A restarted child is told about its peer through
 * `/v1/peer`, as at boot.
 */
export async function startManaged({
  bin, cwd = REPO, env = process.env, scratch, roots, localSource = cwd,
  serviceNodeArgs = [], port = 0, timeoutMs = READY_TIMEOUT_MS, graceMs = STOP_GRACE_MS,
}) {
  const serviceLog = path.join(scratch, 'service.log');
  const goLog = path.join(scratch, 'go-host.log');
  writeFileSync(serviceLog, '');
  writeFileSync(goLog, '');

  const basePort = port === 0 ? await freePortPair() : port;

  const kids = [];
  const shutdown = () => Promise.all(kids.map((kid) => terminate({ ...kid, graceMs }).catch(() => {})));

  function pipeLog(streams, child, logPath) {
    for (const stream of streams) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        try {
          appendFileSync(logPath, chunk);
        } catch {
          // A log that cannot be written is only a lost witness.
        }
      });
    }
    child.stdin.on('error', () => {});
  }

  // The service process, from spawn to its READY line: its URL, epoch and secret.
  async function startServiceChild() {
    const secret = randomBytes(32).toString('hex');
    const serviceBin = env.TRIAL_SERVICE_BIN;
    const child = spawn(
      serviceBin || process.execPath,
      serviceBin ? [] : [...serviceNodeArgs, path.join(REPO, 'trial', 'service-main.cjs')],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    kids.push({ child, exitPromise });
    pipeLog([child.stdout, child.stderr], child, serviceLog);

    const lines = lineReader(child.stdout);
    child.stdin.write(`${JSON.stringify({ v: 1, secret })}\n`);
    const readyLine = await waitFor(lines.next(/^READY (\{.*\})$/), {
      child, name: 'service', timeoutMs, step: 'the service\u2019s READY line',
    });
    const ready = JSON.parse(/^READY (\{.*\})$/.exec(readyLine)[1]);
    return {
      child, exitPromise, lines, secret, url: ready.url, epoch: ready.epoch,
    };
  }

  // The Go process, from spawn to its READY line, bootstrapped with the service
  // it should consult: its control URL, epoch, secret and the roots it serves.
  async function startGoChild(service) {
    const secret = randomBytes(32).toString('hex');
    const child = spawn(bin, [
      '--root', roots[0],
      '--root', roots[1],
      '--port', String(basePort),
      '--local-source', localSource,
      '--bootstrap-stdin',
    ], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    kids.push({ child, exitPromise });
    pipeLog([child.stdout], child, goLog);

    const lines = lineReader(child.stdout);
    child.stdin.write(`${JSON.stringify({
      v: 1,
      secret,
      service: { url: service.url, secret: service.secret, epoch: service.epoch },
    })}\n`);
    const readyLine = await waitFor(lines.next(/^READY (\{.*\})$/), {
      child, name: 'go host', timeoutMs, step: 'the go host\u2019s READY line',
    });
    const ready = JSON.parse(/^READY (\{.*\})$/.exec(readyLine)[1]);
    return {
      child, exitPromise, lines, secret, control: ready.control, epoch: ready.epoch, roots: ready.roots, ready,
    };
  }

  // The service's half of the bootstrap: Go's control URL, secret, epoch and
  // READY roots, answered with ATTACHED once it has registered every root.
  async function attachService(service, host) {
    service.child.stdin.write(`${JSON.stringify({
      host: {
        url: host.control,
        secret: host.secret,
        epoch: host.epoch,
        roots: host.roots,
      },
    })}\n`);
    await waitFor(service.lines.next(/^ATTACHED$/), {
      child: service.child, name: 'service', timeoutMs, step: 'the service\u2019s answer to the attach',
    });
  }

  async function postPeer(url, secret, body) {
    const answer = await fetch(`${url}/v1/peer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (answer.status !== 200) {
      throw new Error(`${url}/v1/peer answered ${answer.status}: ${await answer.text()}`);
    }
    return answer.json().catch(() => null);
  }

  const publicUrls = (readyRoots) => (readyRoots ?? []).map((root) => root.url);

  let session = null;
  let goStarted = false;

  try {
    const service = await startServiceChild();
    const go = await startGoChild(service);
    goStarted = true;
    await attachService(service, go);

    const target = assertReady(go.ready, roots[0]);
    if (typeof go.control !== 'string' || !go.control) {
      throw new Error('the go host names no control URL');
    }

    async function stop() {
      session.flushed = null;
      try {
        const answer = await fetch(`${session.service.url}/v1/flush`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${session.service.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ deadlineMs: 10000 }),
        });
        session.flushed = await answer.json();
      } catch {
        session.flushed = null;
      }
      await terminate({ child: session.service.child, exitPromise: session.service.exitPromise, graceMs });
      await terminate({ child: session.child, exitPromise: session.goExit, graceMs });
    }

    // SIGKILL one child and answer how it went, without restarting anything.
    async function kill(which) {
      if (which !== 'go' && which !== 'service') throw new Error(`the supervisor runs no ${which}`);
      const record = which === 'go' ? session : session.service;
      if (!exited(record.child)) record.child.kill('SIGKILL');
      return which === 'go' ? session.goExit : session.service.exitPromise;
    }

    // A new Go process over the same roots and port, told to the service through
    // its /v1/peer so every open consultation is aborted and every room
    // reconciled; the public root URLs stay what a tab already has.
    async function restartGo() {
      const before = publicUrls(session.readyRoots);
      await terminate({ child: session.child, exitPromise: session.goExit, graceMs });
      const go = await startGoChild(session.service);
      const target_ = assertReady(go.ready, roots[0]);
      session.child = go.child;
      session.goExit = go.exitPromise;
      session.secret = go.secret;
      session.control = go.control;
      session.goEpoch = go.epoch;
      session.readyRoots = go.roots;
      session.url = target_.url;
      session.root = target_.root;
      await postPeer(session.service.url, session.service.secret, {
        url: go.control, secret: go.secret, epoch: go.epoch,
      });
      const after = publicUrls(session.readyRoots);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`a restarted go host serves ${JSON.stringify(after)}, not ${JSON.stringify(before)}`);
      }
      return session;
    }

    // A new service process, told to Go through its /v1/peer before it attaches,
    // so its first calls to Go carry an epoch Go accepts; then the host line and
    // its ATTACHED answer, exactly as at boot.
    async function restartService() {
      await terminate({ child: session.service.child, exitPromise: session.service.exitPromise, graceMs });
      const service_ = await startServiceChild();
      await postPeer(session.control, session.secret, {
        url: service_.url, secret: service_.secret, epoch: service_.epoch,
      });
      session.service = {
        url: service_.url,
        secret: service_.secret,
        epoch: service_.epoch,
        child: service_.child,
        exitPromise: service_.exitPromise,
        logPath: serviceLog,
      };
      await attachService(service_, {
        control: session.control, secret: session.secret, epoch: session.goEpoch, roots: session.readyRoots,
      });
      return session;
    }

    session = {
      ...target,
      secret: go.secret,
      control: go.control,
      goEpoch: go.epoch,
      readyRoots: go.roots,
      child: go.child,
      goExit: go.exitPromise,
      logPath: goLog,
      service: {
        url: service.url,
        secret: service.secret,
        epoch: service.epoch,
        child: service.child,
        exitPromise: service.exitPromise,
        logPath: serviceLog,
      },
      flushed: null,
      kill,
      restartGo,
      restartService,
      stop,
    };
    return session;
  } catch (error) {
    await shutdown();
    const name = goStarted ? 'go-host.log' : 'service.log';
    const logPath = path.join(scratch, name);
    throw new Error(`${error?.message || String(error)}; last of ${name}:\n${tailOf(logPath)}`);
  }
}
