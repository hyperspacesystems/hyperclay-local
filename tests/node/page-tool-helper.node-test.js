// The built-in blockeditor-tool helper, driven through the real wire routes and the
// real dispatcher. The engine children are fakes: no test ever starts a real
// `claude` or `codex`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { runPageTool, loadPrompts, MOCK_TOOL } = require('../../src/main/helpers/page-tool');
const { claudeArgs } = require('../../src/main/helpers/ai-edit');
const {
  documentHTML,
  awaitRequest,
  awaitFrame,
  withHelperApp,
} = require('../helpers/helper-harness');

const PROMPTS = { system: 'You make tools.', contextText: 'The guide.' };
const REQUEST_ID = '123e4567-e89b-12d3-a456-426614174000';

const ARTIFACT = {
  title: 'Counter',
  html: '<div class="counter"><button type="button" data-count>0</button></div>',
  css: '.counter button { font: inherit; }',
  javascript: "const button = root.querySelector('[data-count]');\nbutton.textContent = '1';",
  fallbackHtml: '<p>Counter</p>',
  summary: 'A counter that counts up.',
};

const replyText = ({ artifact = {}, state = { count: 0 } } = {}) =>
  JSON.stringify({ artifact: { ...ARTIFACT, ...artifact }, state });

const claudeResult = (text = replyText()) =>
  `${JSON.stringify({ type: 'result', subtype: 'success', result: text, stop_reason: 'end_turn', model: 'claude-opus-5-5' })}\n`;

const payload = (extra = {}) => ({
  protocol: 'blockeditor-tool/1',
  requestId: REQUEST_ID,
  prompt: 'make me a counter',
  context: { page: 'A page about nothing.' },
  ...extra,
});

const request = (id, extra = {}) => ({
  type: 'wire/request',
  id,
  helper: 'blockeditor-tool',
  document: 'none',
  payload: payload(extra),
});

const settings = (extra = {}) => ({ aiEdit: { enabled: true, default: 'claude', ...extra } });

// A child process the way spawnAgent sees one: pipes, an exit, and a kill that
// closes it, so cancel and timeout take the same path a real child would.
function fakeSpawn(respond = () => {}) {
  const calls = [];
  const spawn = (command, args, options, signal) => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (input) => { child.input = input; };
    let closed = false;
    const close = (code) => {
      if (closed) return;
      closed = true;
      setImmediate(() => child.emit('close', code));
    };
    child.kill = () => close(null);
    const call = { command, args, options, signal, input: () => child.input };
    calls.push(call);
    setImmediate(() => respond({ child, close, ...call }));
    return child;
  };
  return { spawn, calls };
}

function pageToolFor(spawn, prompts = PROMPTS) {
  return {
    prompts: async () => prompts,
    run: (requestPayload, ctx) => runPageTool(requestPayload, { ...ctx, prompts, spawn }),
  };
}

async function runDirect(spawn, extra = {}) {
  return runPageTool(payload(extra.payload), {
    file: path.join(os.tmpdir(), 'doc.html'),
    baseDir: os.tmpdir(),
    settings: settings(extra.settings),
    prompts: PROMPTS,
    spawn,
    signal: extra.signal,
  });
}

test('a valid request runs through the real dispatcher and returns the tool', async () => {
  const { spawn } = fakeSpawn(({ child, close }) => {
    child.stdout.emit('data', Buffer.from(claudeResult()));
    close(0);
  });
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();

    const reply = await h.page.send(request('pt1'));

    assert.equal(reply.status, 200);
    const frames = await awaitRequest(stream, 'pt1');
    assert.deepEqual(frames.map((frame) => frame.type), ['wire/ack', 'wire/status', 'wire/done']);
    assert.equal(frames[0].payload.mode, 'jsonl');
    assert.match(frames[1].text, /^Making your tool/);
    const done = frames.at(-1);
    assert.deepEqual(Object.keys(done.payload).sort(), ['artifact', 'model', 'requestId', 'state']);
    assert.equal(done.payload.requestId, REQUEST_ID);
    assert.equal(done.payload.model, 'claude-opus-5-5');
    assert.deepEqual(done.payload.artifact, ARTIFACT);
    assert.deepEqual(done.payload.state, { count: 0 });
  });
});

test('a process that exits non-zero is engine_failed', async () => {
  const { spawn } = fakeSpawn(({ child, close }) => {
    child.stderr.emit('data', Buffer.from('bad things'));
    close(1);
  });
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt2'));
    const error = (await awaitRequest(stream, 'pt2')).at(-1);
    assert.equal(error.type, 'wire/error');
    assert.equal(error.payload.code, 'engine_failed');
    assert.match(error.text, /claude exited \(1\)/);
  });
});

test('a reply that is not a tool is invalid_reply', async () => {
  const { spawn } = fakeSpawn(({ child, close }) => {
    child.stdout.emit('data', Buffer.from(claudeResult('not json at all')));
    close(0);
  });
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt3'));
    const error = (await awaitRequest(stream, 'pt3')).at(-1);
    assert.equal(error.payload.code, 'invalid_reply');
  });
});

test('an oversized artifact is refused as invalid_reply', async () => {
  const { spawn } = fakeSpawn(({ child, close }) => {
    child.stdout.emit('data', Buffer.from(claudeResult(replyText({ artifact: { html: 'x'.repeat(30_000) } }))));
    close(0);
  });
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt4'));
    const error = (await awaitRequest(stream, 'pt4')).at(-1);
    assert.equal(error.payload.code, 'invalid_reply');
    assert.match(error.text, /not a tool/);
  });
});

test('a request that is not blockeditor-tool/1 is refused before any child starts', async () => {
  const { spawn, calls } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt5', { protocol: 'blockeditor-tool/2' }));
    const error = (await awaitRequest(stream, 'pt5')).at(-1);
    assert.equal(error.payload.code, 'invalid_request');
    assert.equal(calls.length, 0);
  });
});

test('cancelling stops the child and reports helper_cancelled', async () => {
  const { spawn } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt6'));
    await awaitFrame(stream, (frame) => frame.id === 'pt6' && frame.type === 'wire/ack');
    await h.page.send({ type: 'wire/cancel', id: 'pt6' });
    const frames = await awaitRequest(stream, 'pt6');
    assert.equal(frames.at(-1).payload.code, 'helper_cancelled');
  });
});

test('an expired budget reports helper_timeout, not helper_cancelled', async (t) => {
  const { spawn } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stream = await h.page.subscribe();
    await h.page.send(request('pt7'));
    await awaitFrame(stream, (frame) => frame.id === 'pt7' && frame.type === 'wire/ack');
    t.mock.timers.tick(300000);
    const frames = await awaitRequest(stream, 'pt7');
    assert.equal(frames.at(-1).payload.code, 'helper_timeout');
  });
});

test('a missing engine shows setup guidance', async () => {
  const { spawn } = fakeSpawn(({ child }) => {
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  });
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt8'));
    const error = (await awaitRequest(stream, 'pt8')).at(-1);
    assert.equal(error.payload.code, 'engine_unavailable');
    assert.match(error.text, /Install it and sign in/);
  });
});

test('an edit and a tool cannot run on one document together', async () => {
  let releaseEdit;
  const editGate = new Promise((resolve) => { releaseEdit = resolve; });
  const aiEdit = {
    enabled: true,
    run: async () => {
      await editGate;
      return { html: '<p>edited</p>', model: 'mock', stopReason: 'end_turn' };
    },
  };
  const { spawn } = fakeSpawn();
  await withHelperApp({
    html: documentHTML({ helpers: [] }),
    settings: settings(),
    aiEdit,
    pageTool: pageToolFor(spawn),
  }, async (h) => {
    const stream = await h.page.subscribe();

    await h.page.send({ type: 'wire/request', id: 'x1', helper: 'ai-edit', document: 'none', payload: { elementHTML: '<p>x</p>', tag: 'p', editId: 'p', comment: 'tighten', contextRefs: [] } });
    await awaitFrame(stream, (frame) => frame.id === 'x1' && frame.type === 'wire/ack');

    await h.page.send(request('x2'));
    const busy = (await awaitRequest(stream, 'x2')).at(-1);
    assert.equal(busy.payload.code, 'helper_busy');

    releaseEdit();
    await awaitRequest(stream, 'x1');
  });
});

test('a tool already running keeps an edit out of the same document', async () => {
  const { spawn } = fakeSpawn();
  let releaseTool;
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  const pageTool = {
    prompts: async () => PROMPTS,
    run: () => toolGate.then(() => ({ requestId: REQUEST_ID, artifact: ARTIFACT, state: { count: 0 }, model: 'm' })),
  };
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool }, async (h) => {
    const stream = await h.page.subscribe();

    await h.page.send(request('y1'));
    await awaitFrame(stream, (frame) => frame.id === 'y1' && frame.type === 'wire/ack');

    await h.page.send({ type: 'wire/request', id: 'y2', helper: 'ai-edit', document: 'none', payload: { elementHTML: '<p>x</p>', tag: 'p', editId: 'p', comment: 'tighten', contextRefs: [] } });
    const busy = (await awaitRequest(stream, 'y2')).at(-1);
    assert.equal(busy.payload.code, 'helper_busy');

    releaseTool();
    await awaitRequest(stream, 'y1');
  });
});

test('/_/meta lists blockeditor-tool beside ai-edit when the prompt files are present', async () => {
  const { spawn } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const res = await fetch(`${h.page.origin}/_/meta`, { headers: { 'Document-URL': h.docUrl } });
    assert.deepEqual((await res.json()).document.helpers, [
      { name: 'ai-edit', state: 'ready' },
      { name: 'blockeditor-tool', state: 'ready' },
    ]);
  });
});

test('/_/meta reads blockeditor-tool as unavailable when AI Editing is off', async () => {
  const { spawn } = fakeSpawn();
  await withHelperApp({
    html: documentHTML({ helpers: [] }),
    settings: settings({ enabled: false }),
    aiEdit: { enabled: false },
    pageTool: pageToolFor(spawn),
  }, async (h) => {
    const res = await fetch(`${h.page.origin}/_/meta`, { headers: { 'Document-URL': h.docUrl } });
    assert.deepEqual((await res.json()).document.helpers, [
      { name: 'ai-edit', state: 'unavailable' },
      { name: 'blockeditor-tool', state: 'unavailable' },
    ]);
  });
});

test('/_/meta omits blockeditor-tool when the prompt files are missing', async () => {
  const { spawn } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn, null) }, async (h) => {
    const res = await fetch(`${h.page.origin}/_/meta`, { headers: { 'Document-URL': h.docUrl } });
    assert.deepEqual((await res.json()).document.helpers, [{ name: 'ai-edit', state: 'ready' }]);
  });
});

test('loadPrompts reads the selected runtime and answers null when either file is missing', async () => {
  const read = async (version, publicPath) => Buffer.from(publicPath.endsWith('system.md') ? 'S' : 'C');
  assert.deepEqual(await loadPrompts({ version: '9.9.9', readAsset: read }), { system: 'S', contextText: 'C' });
  assert.equal(await loadPrompts({ readAsset: async () => { throw new Error('missing'); } }), null);
  assert.equal(await loadPrompts({ readAsset: async (version, publicPath) => Buffer.from(publicPath.endsWith('system.md') ? 'S' : '') }), null);
});

test('blockeditor-tool\u2019s claude child gets the env variable and argv, and ai-edit\u2019s does not', async () => {
  let systemText = '';
  const { spawn, calls } = fakeSpawn(({ child, close, args }) => {
    systemText = fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
    child.stdout.emit('data', Buffer.from(claudeResult()));
    close(0);
  });
  await runDirect(spawn);

  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, 'claude');
  assert.equal(options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.notEqual(options.env, process.env, 'the env is a copy, never the shared object');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  assert.ok(args.includes('--system-prompt-file'));
  assert.equal(systemText, `${PROMPTS.system}\n\n${PROMPTS.contextText}`);

  const editArgs = claudeArgs('claude-opus-5-5');
  assert.ok(!editArgs.includes('--system-prompt-file'), 'ai-edit keeps its append-system-prompt argv');
});

test('codex gets the whole prompt as one input and its final message is parsed', async () => {
  let input = '';
  const { spawn, calls } = fakeSpawn(({ child, close, args }) => {
    fs.writeFileSync(args[args.indexOf('-o') + 1], replyText());
    close(0);
  });
  const result = await runDirect(spawn, { settings: { default: 'codex' } });
  input = calls[0].input();

  assert.equal(result.model, 'codex');
  assert.deepEqual(result.artifact, ARTIFACT);
  assert.equal(input, `${PROMPTS.system}\n\n${PROMPTS.contextText}\n\n${JSON.stringify({
    prompt: 'make me a counter',
    context: { page: 'A page about nothing.' },
    current: null,
  })}`);
});

test('MOCK_MODEL returns a fixed tool without spawning', async () => {
  const previous = process.env.MOCK_MODEL;
  process.env.MOCK_MODEL = '1';
  const { spawn, calls } = fakeSpawn();
  try {
    const result = await runPageTool(payload(), { prompts: PROMPTS, spawn, settings: settings() });
    assert.equal(calls.length, 0);
    assert.deepEqual(result.state, { count: 0 });
    assert.equal(result.artifact.title, 'Counter');
  } finally {
    if (previous === undefined) delete process.env.MOCK_MODEL;
    else process.env.MOCK_MODEL = previous;
  }
});

// The mock is what browser passes run with, so its script has to be one ClayJS
// can mount: `mount(tool)` reading the artifact's html out of tool.root.
test('the mock tool defines mount and counts through its state', () => {
  const dom = new JSDOM(`<div id="root">${MOCK_TOOL.artifact.html}</div>`);
  const root = dom.window.document.getElementById('root');
  const added = [];
  const listeners = new Set();
  const tool = {
    root,
    state: {
      data: { ...MOCK_TOOL.state },
      add(path, n = 1) {
        added.push([path, n]);
        if (path.length === 1) tool.state.data = { ...tool.state.data, [path[0]]: (tool.state.data[path[0]] ?? 0) + n };
        for (const fn of [...listeners]) fn();
      },
    },
    on(event, fn) {
      assert.equal(event, 'change');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const factory = new Function('tool', `${MOCK_TOOL.artifact.javascript};return typeof mount === 'function' ? mount : undefined;`)(tool);
  assert.equal(typeof factory, 'function', 'the mock script defines mount(tool)');

  const cleanup = factory(tool);
  assert.equal(root.querySelector('output').textContent, '0');

  root.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(added, [[['count'], 1]]);
  assert.equal(root.querySelector('output').textContent, '1');
  assert.equal(typeof cleanup, 'function');
});

test('a document that asks for the page itself with a tool is refused', async () => {
  const { spawn } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send({ ...request('pt9'), document: 'edit' });
    const error = (await awaitRequest(stream, 'pt9')).at(-1);
    assert.equal(error.payload.code, 'helper_protocol_unsupported');
  });
});

test('a host without the prompt files refuses a blockeditor-tool request', async () => {
  const { spawn } = fakeSpawn();
  await withHelperApp({ html: documentHTML({ helpers: [] }), settings: settings(), pageTool: pageToolFor(spawn, null) }, async (h) => {
    const stream = await h.page.subscribe();
    await h.page.send(request('pt10'));
    const error = (await awaitRequest(stream, 'pt10')).at(-1);
    assert.equal(error.payload.code, 'helper_unavailable');
  });
});
