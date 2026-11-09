/**
 * page-tool helper — the built-in handler that makes a tool for a Block-based
 * document with the person's own `claude` or `codex`.
 *
 * Served as the named helper `page-tool` by the helper dispatcher (see
 * ./dispatcher.js): no declaration, no approval, and no server state. The page
 * sends a `page-tool/1` payload, the model answers with one artifact and its
 * state, and the page previews it until its owner keeps or discards it.
 *
 * The request and the reply are checked by ./page-tool-contract.js, a port of
 * the hosted runner's contract, so both hosts accept and refuse the same
 * shapes. The prompt comes from the vendored runtime's
 * `tool-generation/system.md` and `tool-generation/context.md`; when either is
 * missing the helper is not listed and its requests are refused.
 *
 * Engines are the ai-edit ones. Only this helper's `claude` child turns off
 * Claude Code's global CLAUDE.md files, because headless generation otherwise
 * loads the person's own instructions into every tool.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const runtimeAssets = require('../runtime-assets');
const { loginPath, withPath } = require('./runner');
const { resolveEngines, codexArgs, spawnAgent, stripFences } = require('./ai-edit');
const { validateToolRequest, parseToolReply } = require('./page-tool-contract');

const SYSTEM_FILE = 'tool-generation/system.md';
const CONTEXT_FILE = 'tool-generation/context.md';

const START_STATUS = 'Making your tool…';

const MOCK_TOOL = {
  artifact: {
    title: 'Counter',
    html: '<div class="page-tool-counter"><button type="button" data-count>0</button></div>',
    css: '.page-tool-counter button { font: inherit; padding: 6px 10px; }',
    javascript: "const button = root.querySelector('[data-count]');\nlet count = 0;\nbutton.addEventListener('click', () => { count += 1; button.textContent = String(count); });",
    fallbackHtml: '<p>Counter: 0</p>',
    summary: 'A counter that counts up when clicked.',
  },
  state: { count: 0 },
};

const isMock = () => process.env.MOCK_MODEL === '1';
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A package build without the two prompt files answers null rather than
// throwing: the helper is then not listed, and a request for it is refused.
async function loadPrompts({ readAsset = runtimeAssets.readAsset, version = runtimeAssets.selectedVersion } = {}) {
  try {
    const [system, contextText] = await Promise.all([
      readAsset(version, SYSTEM_FILE),
      readAsset(version, CONTEXT_FILE),
    ]);
    const systemText = Buffer.isBuffer(system) ? system.toString('utf8') : String(system ?? '');
    const contextMD = Buffer.isBuffer(contextText) ? contextText.toString('utf8') : String(contextText ?? '');
    if (!systemText.trim() || !contextMD.trim()) return null;
    return { system: systemText, contextText: contextMD };
  } catch {
    return null;
  }
}

function claudeToolArgs(model, systemFile) {
  return [
    '-p',
    '--model', model,
    '--system-prompt-file', systemFile,
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns', '1',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose'
  ];
}

function toolEnv(env) {
  return { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
}

async function claudeToolAdapter(engine, system, userTurn, ctx, spawner) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'page-tool-claude-'));
  try {
    const systemFile = path.join(scratch, 'system.md');
    await fs.writeFile(systemFile, system);
    return await new Promise((resolve, reject) => {
      const child = spawnAgent('claude', claudeToolArgs(engine.model, systemFile),
        { cwd: scratch, env: toolEnv(ctx.env), stdio: ['pipe', 'pipe', 'pipe'] }, ctx.signal, spawner);
      child.stdin.on('error', () => {});
      child.stdin.end(userTurn);

      let result = null;
      let modelSeen = engine.model;
      let stderrTail = '';
      let buf = '';
      child.stdout.on('data', chunk => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
            ctx.progress(event.event.delta.text);
          } else if (event.type === 'system' && event.subtype === 'init') {
            modelSeen = event.model;
          } else if (event.type === 'result') {
            result = event;
          }
        }
      });
      child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-400); });
      child.on('error', reject);
      child.on('close', code => {
        if (ctx.signal.aborted) {
          reject(abortError());
        } else if (!result) {
          reject(new Error(`claude exited (${code}) without a result${stderrTail ? ': ' + stderrTail.trim() : ''}`));
        } else if (result.is_error) {
          reject(new Error(String(result.result || result.subtype)));
        } else {
          resolve({
            text: result.result || '',
            stopReason: result.stop_reason || (result.subtype === 'success' ? 'end_turn' : result.subtype),
            model: modelSeen
          });
        }
      });
    });
  } finally {
    fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function codexToolAdapter(engine, system, userTurn, ctx, spawner) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'page-tool-codex-'));
  const outFile = path.join(scratch, 'last-message.txt');
  try {
    await new Promise((resolve, reject) => {
      const child = spawnAgent('codex', codexArgs(scratch, outFile),
        { cwd: scratch, env: ctx.env, stdio: ['pipe', 'ignore', 'pipe'] }, ctx.signal, spawner);
      child.stdin.on('error', () => {});
      child.stdin.end(`${system}\n\n${userTurn}`);
      let stderrTail = '';
      child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-400); });
      child.on('error', reject);
      child.on('close', code => {
        if (ctx.signal.aborted) reject(abortError());
        else if (code !== 0) reject(new Error(`codex exited (${code})${stderrTail ? ': ' + stderrTail.trim() : ''}`));
        else resolve();
      });
    });
    const text = await fs.readFile(outFile, 'utf8').catch(() => '');
    if (!text.trim()) throw new Error('codex produced no reply');
    return { text: stripFences(text), stopReason: 'end_turn', model: 'codex' };
  } finally {
    fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const replyMessage = (code) => {
  switch (code) {
    case 'declined':
      return 'The AI declined this request. Try wording it differently.';
    case 'incomplete':
      return 'The AI stopped part-way through the tool. Please try again.';
    default:
      return 'The AI answered with something that is not a tool. Please try again.';
  }
};

function setupGuidance(adapter) {
  if (adapter === 'codex') {
    return 'Codex isn\u2019t available: `codex` was not found on this machine. Install it and sign in, then try again.';
  }
  return 'Claude Code isn\u2019t available: `claude` was not found on this machine. Install it and sign in, then try again.';
}

// The dispatcher's built-in branch calls this: the answer is
// `{ requestId, artifact, state, model }`, and every refusal is a thrown Error
// whose `code` the dispatcher reports as the wire error's application code.
async function runPageTool(payload, {
  file, baseDir, settings, signal, progress, prompts,
  spawn,
} = {}) {
  const checked = validateToolRequest(payload);
  if (!checked.ok) throw coded(checked.code, checked.message);
  const request = checked.request;

  const aiEdit = (settings && settings.aiEdit) || {};
  const engines = resolveEngines(aiEdit);
  const defaultEngine = String(aiEdit.default || 'claude').toLowerCase();
  const engine = engines[defaultEngine];
  if (!engine) throw coded('unknown_engine', `default engine "${defaultEngine}" is not configured`);
  if (engine.adapter !== 'claude' && engine.adapter !== 'codex') {
    throw coded('engine_unsupported', `${engine.name} can\u2019t make tools; use Claude Code or Codex`);
  }

  const context = prompts ?? await loadPrompts();
  if (!context) throw coded('helper_unavailable', 'AI tools are not available here right now.');

  const label = engine.model || engine.name;
  if (isMock()) {
    return {
      requestId: request.requestId,
      artifact: { ...MOCK_TOOL.artifact },
      state: { ...MOCK_TOOL.state },
      model: `mock(${label})`,
    };
  }

  const report = typeof progress === 'function' ? progress : () => {};
  const ctx = { baseDir, env: withPath(process.env, await loginPath()), progress: report, signal: signal || new AbortController().signal };
  const userTurn = JSON.stringify({ prompt: request.prompt, context: request.context, current: request.current });
  const system = context.contextText ? `${context.system}\n\n${context.contextText}` : context.system;

  let result;
  try {
    result = engine.adapter === 'codex'
      ? await codexToolAdapter(engine, system, userTurn, ctx, spawn)
      : await claudeToolAdapter(engine, system, userTurn, ctx, spawn);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.code === 'ENOENT') throw coded('engine_unavailable', setupGuidance(engine.adapter));
    throw coded('engine_failed', err.message);
  }

  if (result.stopReason === 'refusal') throw coded('declined', replyMessage('declined'));
  if (result.stopReason !== 'end_turn') throw coded('incomplete', replyMessage('incomplete'));
  const reply = parseToolReply(result.text);
  if (!reply.ok) throw coded(reply.code, replyMessage(reply.code));

  return {
    requestId: request.requestId,
    artifact: reply.artifact,
    state: reply.state,
    model: result.model,
  };
}

module.exports = {
  runPageTool,
  loadPrompts,
  claudeToolArgs,
  codexToolArgs: codexArgs,
  toolEnv,
  MOCK_TOOL,
  START_STATUS,
};
