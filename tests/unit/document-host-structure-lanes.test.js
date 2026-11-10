// M3/S6: the structure lane's room half as three named functions. Every fixture
// below drives the host's own lanes against a stand-in authority that records
// each call in one shared array, so both the arguments and their order are
// visible.

const fs = require('fs');
const os = require('os');
const upath = require('upath');
const { createRootDocumentHost } = require('../../src/main/document-host');

const dirs = [];

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(upath.join(os.tmpdir(), 'document-host-structure-lanes-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  jest.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function hostFor(dir, { localAuthority = null } = {}) {
  return createRootDocumentHost({
    ctx: { root: { id: `structure-lanes-${upath.basename(dir)}`, path: dir }, localAuthority },
    live: { markBrowserSave: () => {}, broadcast: jest.fn(), notify: jest.fn() },
  });
}

function fakeAuthority(calls, { commitThrows = null } = {}) {
  return {
    prepareStructure: jest.fn((token, plan) => {
      calls.push(['prepareStructure', token, plan]);
      return { id: 'plan-1' };
    }),
    commitStructure: jest.fn((plan, completed, token, options) => {
      calls.push(['commitStructure', plan, completed, token, options]);
      if (commitThrows) throw commitThrows;
    }),
    releaseStructure: jest.fn((plan, token) => {
      calls.push(['releaseStructure', plan, token]);
    }),
    setAdmission: jest.fn((token, admission) => {
      calls.push(['setAdmission', token, admission]);
    }),
  };
}

const from = { location: '/root/a.html', canonical: '/root/a.html', isDir: false };
const to = { location: '/root/b.html', canonical: '/root/b.html', isDir: false };

test('prepareRestructure answers null without an authority and for the copy kinds', async () => {
  const dir = tempDir();
  const steps = [{ from: 'a.html', to: 'b.html' }];
  const entries = [{ from, to }];

  const bare = hostFor(dir);
  expect(bare.lanes.prepareRestructure({ kind: 'move', rootId: 'root-1', steps, entries, token: 'tok' })).toBeNull();

  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });

  expect(host.lanes.prepareRestructure({ kind: 'duplicate', rootId: 'root-1', steps, entries, token: 'tok' })).toBeNull();
  expect(authority.prepareStructure).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

test('prepareRestructure asks for the plan with the entries whole and the steps names', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });

  const plan = host.lanes.prepareRestructure({
    kind: 'move', rootId: 'root-1',
    steps: [{ from: 'a.html', to: 'b.html' }], entries: [{ from, to }], token: 'tok',
  });

  expect(plan).toEqual({ id: 'plan-1' });
  expect(authority.prepareStructure).toHaveBeenCalledTimes(1);
  expect(authority.prepareStructure).toHaveBeenCalledWith('tok', {
    rootId: 'root-1',
    steps: [{ from, fromRel: 'a.html', to, toRel: 'b.html' }],
  });
  expect(calls).toEqual([['prepareStructure', 'tok', {
    rootId: 'root-1',
    steps: [{ from, fromRel: 'a.html', to, toRel: 'b.html' }],
  }]]);
});

test('prepareRestructure asks for no destination when the kind retires', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });

  host.lanes.prepareRestructure({
    kind: 'trash', rootId: 'root-1',
    steps: [{ from: 'a.html', to: 'trash/a.html' }], entries: [{ from, to }], token: 'tok',
  });

  expect(authority.prepareStructure).toHaveBeenCalledWith('tok', {
    rootId: 'root-1',
    steps: [{ from, fromRel: 'a.html', to: null, toRel: null }],
  });
});

test('settleRestructure releases a plan that completed nothing', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });
  const plan = { id: 'plan-1' };

  host.lanes.settleRestructure({ plan, completed: 0, token: 'tok' });

  expect(authority.commitStructure).not.toHaveBeenCalled();
  expect(calls).toEqual([['releaseStructure', plan, 'tok']]);
});

test('settleRestructure commits the completed steps then releases the plan', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });
  const plan = { id: 'plan-1' };

  host.lanes.settleRestructure({ plan, completed: 2, copiedSteps: [1], token: 'tok' });

  expect(authority.commitStructure).toHaveBeenCalledTimes(1);
  expect(authority.commitStructure).toHaveBeenCalledWith(plan, 2, 'tok', { copiedSteps: [1] });
  expect(authority.releaseStructure).toHaveBeenCalledTimes(1);
  expect(authority.releaseStructure).toHaveBeenCalledWith(plan, 'tok');
  expect(calls).toEqual([
    ['commitStructure', plan, 2, 'tok', { copiedSteps: [1] }],
    ['releaseStructure', plan, 'tok'],
  ]);
});

test('settleRestructure releases the plan when the commit throws, then propagates', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls, { commitThrows: new Error('commit refused') });
  const host = hostFor(dir, { localAuthority: authority });
  const plan = { id: 'plan-1' };

  expect(() => host.lanes.settleRestructure({ plan, completed: 1, token: 'tok' })).toThrow('commit refused');

  expect(authority.releaseStructure).toHaveBeenCalledTimes(1);
  expect(authority.releaseStructure).toHaveBeenCalledWith(plan, 'tok');
  expect(calls).toEqual([
    ['commitStructure', plan, 1, 'tok', { copiedSteps: [] }],
    ['releaseStructure', plan, 'tok'],
  ]);
});

test('settleRestructure does nothing without a plan', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });

  host.lanes.settleRestructure({ plan: null, completed: 2, copiedSteps: [1], token: 'tok' });

  expect(calls).toEqual([]);
  expect(authority.commitStructure).not.toHaveBeenCalled();
  expect(authority.releaseStructure).not.toHaveBeenCalled();
});

test('admitCopy admits the copied destination as a live document path', async () => {
  const dir = tempDir();
  const calls = [];
  const authority = fakeAuthority(calls);
  const host = hostFor(dir, { localAuthority: authority });

  host.lanes.admitCopy({ rootId: 'root-1', step: { to: 'b.html' }, entry: { from, to }, token: 'tok' });

  expect(authority.setAdmission).toHaveBeenCalledTimes(1);
  expect(authority.setAdmission).toHaveBeenCalledWith('tok', {
    rootId: 'root-1', logicalPath: 'b.html',
    canonicalPath: '/root/b.html', active: true, prefix: false,
  });
});

test('admitCopy does nothing without an authority', async () => {
  const dir = tempDir();
  const host = hostFor(dir);

  expect(() => host.lanes.admitCopy({ rootId: 'root-1', step: { to: 'b.html' }, entry: { from, to }, token: 'tok' }))
    .not.toThrow();
});
