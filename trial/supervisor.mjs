import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/**
 * The managed trial's host pair: the JS service as its own process, then Go
 * attached to it, then the service attached to Go (protocol v1, "Transport and
 * bootstrap"). Answers what `startGo` in trial/p1.mjs answers, plus `service`,
 * so every P script can take either.
 */
export async function startManaged({
  bin, cwd = REPO, env = process.env, scratch, roots, localSource = cwd,
  serviceNodeArgs = [], timeoutMs = READY_TIMEOUT_MS, graceMs = STOP_GRACE_MS,
}) {
  const serviceLog = path.join(scratch, 'service.log');
  const goLog = path.join(scratch, 'go-host.log');
  writeFileSync(serviceLog, '');
  writeFileSync(goLog, '');

  const serviceSecret = randomBytes(32).toString('hex');
  const goSecret = randomBytes(32).toString('hex');

  const kids = [];
  const shutdown = () => Promise.all(kids.map((kid) => terminate({ ...kid, graceMs }).catch(() => {})));

  const serviceChild = spawn(
    process.execPath,
    [...serviceNodeArgs, path.join(REPO, 'trial', 'service-main.cjs')],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const serviceExit = new Promise((resolve) => serviceChild.once('exit', (code, signal) => resolve({ code, signal })));
  kids.push({ child: serviceChild, exitPromise: serviceExit });
  for (const stream of [serviceChild.stdout, serviceChild.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      try {
        appendFileSync(serviceLog, chunk);
      } catch {
        // A log that cannot be written is only a lost witness.
      }
    });
  }
  serviceChild.stdin.on('error', () => {});

  let goChild = null;
  let goExit = null;
  let serviceUrl = null;
  let serviceEpoch = null;
  let flushed = null;

  try {
    const serviceLines = lineReader(serviceChild.stdout);
    serviceChild.stdin.write(`${JSON.stringify({ v: 1, secret: serviceSecret })}\n`);
    const readyLine = await waitFor(serviceLines.next(/^READY (\{.*\})$/), {
      child: serviceChild, name: 'service', timeoutMs, step: 'the service’s READY line',
    });
    const serviceReady = JSON.parse(/^READY (\{.*\})$/.exec(readyLine)[1]);
    serviceUrl = serviceReady.url;
    serviceEpoch = serviceReady.epoch;

    goChild = spawn(bin, [
      '--root', roots[0],
      '--root', roots[1],
      '--port', '0',
      '--local-source', localSource,
      '--bootstrap-stdin',
    ], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    goExit = new Promise((resolve) => goChild.once('exit', (code, signal) => resolve({ code, signal })));
    kids.push({ child: goChild, exitPromise: goExit });
    goChild.stdout.setEncoding('utf8');
    goChild.stdout.on('data', (chunk) => {
      try {
        appendFileSync(goLog, chunk);
      } catch {
        // A log that cannot be written is only a lost witness.
      }
    });
    goChild.stdin.on('error', () => {});

    const goLines = lineReader(goChild.stdout);
    goChild.stdin.write(`${JSON.stringify({
      v: 1,
      secret: goSecret,
      service: { url: serviceUrl, secret: serviceSecret, epoch: serviceEpoch },
    })}\n`);
    const goReadyLine = await waitFor(goLines.next(/^READY (\{.*\})$/), {
      child: goChild, name: 'go host', timeoutMs, step: 'the go host’s READY line',
    });
    const goReady = JSON.parse(/^READY (\{.*\})$/.exec(goReadyLine)[1]);

    serviceChild.stdin.write(`${JSON.stringify({
      host: {
        url: goReady.control,
        secret: goSecret,
        epoch: goReady.epoch,
        roots: goReady.roots,
      },
    })}\n`);
    await waitFor(serviceLines.next(/^ATTACHED$/), {
      child: serviceChild, name: 'service', timeoutMs, step: 'the service’s answer to the attach',
    });

    async function stop() {
      flushed = null;
      try {
        const answer = await fetch(`${serviceUrl}/v1/flush`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceSecret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ deadlineMs: 10000 }),
        });
        flushed = await answer.json();
      } catch {
        flushed = null;
      }
      session.flushed = flushed;
      await terminate({ child: serviceChild, exitPromise: serviceExit, graceMs });
      await terminate({ child: goChild, exitPromise: goExit, graceMs });
    }

    const target = assertReady(goReady, roots[0]);
    if (typeof goReady.control !== 'string' || !goReady.control) {
      throw new Error('the go host names no control URL');
    }
    const session = {
      ...target,
      secret: goSecret,
      control: goReady.control,
      readyRoots: goReady.roots,
      child: goChild,
      logPath: goLog,
      service: {
        url: serviceUrl, secret: serviceSecret, epoch: serviceEpoch, child: serviceChild, logPath: serviceLog,
      },
      flushed: null,
      stop,
    };
    return session;
  } catch (error) {
    await shutdown();
    const name = goChild ? 'go-host.log' : 'service.log';
    const logPath = path.join(scratch, name);
    throw new Error(`${error?.message || String(error)}; last of ${name}:\n${tailOf(logPath)}`);
  }
}
