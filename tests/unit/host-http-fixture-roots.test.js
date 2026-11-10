// H0: the HTTP fixture can serve folders it is given with --root <id>=<dir>, and
// it never deletes them. Without the flag it keeps creating its own temp roots.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withoutInjectedDocumentEtag } = require('../helpers/served-metadata');

const FIXTURE = path.join(__dirname, '..', 'helpers', 'host-http-fixture.cjs');
const LOCAL_APPS = path.join(os.homedir(), 'Documents', 'GitHub', 'hyper', 'LOCAL_APPS');

jest.setTimeout(120000);

const created = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function spawnFixture(manifestPath, extra) {
  const child = spawn(process.execPath, [FIXTURE, '--manifest', manifestPath, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForManifest(manifestPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(manifestPath)) {
      const text = fs.readFileSync(manifestPath, 'utf8');
      if (text.trim()) {
        try { return JSON.parse(text); } catch {}
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function runRefusal(extra) {
  const dir = tempDir('fixture-roots-refusal-');
  const manifestPath = path.join(dir, 'manifest.json');
  const { child, logs } = spawnFixture(manifestPath, extra);
  const exit = await waitForExit(child);
  return { exit, logs: logs.join(''), manifestPath };
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

test('--root serves a given folder and leaves it in place after exit', async () => {
  const box = tempDir('fixture-roots-');
  const rootDir = path.join(box, 'docs');
  fs.mkdirSync(rootDir);
  const bytes = Buffer.from('<!doctype html><html><body><p>given-folder</p></body></html>');
  fs.writeFileSync(path.join(rootDir, 'page.html'), bytes);
  const manifestPath = path.join(box, 'manifest.json');

  const { child, logs } = spawnFixture(manifestPath, ['--root', `docs=${rootDir}`]);
  const exit = waitForExit(child);
  try {
    const manifest = await waitForManifest(manifestPath, 90000);
    expect(manifest).not.toBeNull();
    expect(manifest.roots.map((root) => root.id)).toEqual(['docs']);
    expect(manifest.roots[0].fixtureRoot).toBe(rootDir);

    const served = await fetch(`${manifest.roots[0].url}/page.html`);
    expect(served.status).toBe(200);
    const body = Buffer.from(await served.arrayBuffer());
    expect(withoutInjectedDocumentEtag(body).equals(bytes)).toBe(true);

    const stopped = await fetch(`${manifest.control.url}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manifest.control.token}` },
    });
    expect(stopped.status).toBe(200);

    const finished = await exit;
    expect(`${finished.code}\n${logs.join('')}`).toMatch(/^0\n/);
    expect(fs.existsSync(rootDir)).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'page.html'))).toBe(true);
    expect(fs.readFileSync(path.join(rootDir, 'page.html')).equals(bytes)).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('--root refuses a repeated id', async () => {
  const rootDir = tempDir('fixture-roots-dup-');
  const { exit, logs, manifestPath } = await runRefusal([
    '--root', `docs=${rootDir}`,
    '--root', `docs=${rootDir}`,
  ]);
  expect(exit.code).not.toBe(0);
  expect(logs).toMatch(/--root id repeated: docs/);
  expect(fs.existsSync(manifestPath)).toBe(false);
  expect(fs.existsSync(rootDir)).toBe(true);
});

test('--root refuses a missing directory', async () => {
  const box = tempDir('fixture-roots-missing-');
  const missing = path.join(box, 'not-there');
  const { exit, logs, manifestPath } = await runRefusal(['--root', `docs=${missing}`]);
  expect(exit.code).not.toBe(0);
  expect(logs).toMatch(/--root docs is not an existing directory/);
  expect(fs.existsSync(manifestPath)).toBe(false);
});

test('--root refuses a path under LOCAL_APPS by name, even when it does not exist', async () => {
  const nearLocalApps = path.join(LOCAL_APPS, `does-not-exist-${process.pid}`);
  expect(fs.existsSync(nearLocalApps)).toBe(false);

  const { exit, logs, manifestPath } = await runRefusal(['--root', `live=${nearLocalApps}`]);
  expect(exit.code).not.toBe(0);
  expect(logs).toMatch(/LOCAL_APPS/);
  expect(logs).toContain(nearLocalApps);
  expect(fs.existsSync(manifestPath)).toBe(false);
  expect(fs.existsSync(nearLocalApps)).toBe(false);
});
