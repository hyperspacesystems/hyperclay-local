// One `page-tool/1` request and one reply, checked on either side of the model call.
//
// A request is a prompt, the document context and, on a revision, the tool as it stands. A reply
// is one JSON object: six artifact strings and a state object. Neither side is trusted: the sizes
// are capped here and the artifact's JavaScript is parsed, never run.

const vm = require('vm');

const PROTOCOL = 'page-tool/1';
const ARTIFACT_FIELDS = ['title', 'html', 'css', 'javascript', 'fallbackHtml', 'summary'];
const ARTIFACT_BYTES = 24_576;
const STATE_BYTES = 8_192;
const CONTEXT_BYTES = 16_384;
const PROMPT_BYTES = 8_192;
const PAYLOAD_BYTES = 65_536;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const encodedBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const fail = (code, message) => ({ ok: false, code, message });

function artifactProblem(artifact) {
  if (!plainObject(artifact)) return 'The tool artifact must be an object.';
  const keys = Object.keys(artifact);
  const complete = ARTIFACT_FIELDS.every((field) => keys.includes(field));
  const exact = keys.every((key) => ARTIFACT_FIELDS.includes(key));
  if (!complete || !exact) return 'The tool artifact must have exactly title, html, css, javascript, fallbackHtml and summary.';
  const notString = ARTIFACT_FIELDS.find((field) => typeof artifact[field] !== 'string');
  if (notString) return `The tool artifact field ${notString} must be a string.`;
  if (encodedBytes(artifact) > ARTIFACT_BYTES) return 'The tool artifact is too large.';
  return null;
}

function stateProblem(state) {
  if (!plainObject(state)) return 'The tool state must be a JSON object.';
  if (encodedBytes(state) > STATE_BYTES) return 'The tool state is too large.';
  return null;
}

// Syntax only, as a function body, the way the tool mounts itself. The script is never run.
function javascriptParses(source) {
  try {
    new vm.Script(`(function () {\n${source}\n})`);
    return true;
  } catch {
    return false;
  }
}

function validateToolRequest(payload) {
  if (!plainObject(payload)) return fail('invalid_request', 'A tool request must be an object.');
  if (encodedBytes(payload) > PAYLOAD_BYTES) return fail('invalid_request', 'This tool request is too large.');
  if (payload.protocol !== PROTOCOL) return fail('invalid_request', `A tool request must say protocol ${PROTOCOL}.`);
  if (typeof payload.requestId !== 'string' || !REQUEST_ID.test(payload.requestId)) {
    return fail('invalid_request', 'A tool request needs a UUID requestId.');
  }
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) return fail('invalid_request', 'A tool request needs a prompt.');
  if (Buffer.byteLength(payload.prompt) > PROMPT_BYTES) return fail('invalid_request', 'The prompt is too long.');

  const context = payload.context ?? {};
  if (!plainObject(context)) return fail('invalid_request', 'The document context must be an object.');
  if (encodedBytes(context) > CONTEXT_BYTES) return fail('invalid_context', 'This document context is too large to send.');

  const target = payload.target ?? null;
  const current = payload.current ?? null;
  if (target !== null) {
    if (!plainObject(target) || typeof target.toolId !== 'string' || !target.toolId) {
      return fail('invalid_request', 'A revision must name the tool it revises.');
    }
    if (typeof target.rev !== 'string' && typeof target.rev !== 'number') {
      return fail('invalid_request', 'A revision must name the revision it started from.');
    }
  }
  if (target !== null && current === null) {
    return fail('invalid_request', 'A revision must include the tool as it stands.');
  }
  if (current !== null) {
    if (!plainObject(current)) return fail('invalid_request', 'The current tool must be an object.');
    if (target === null) return fail('invalid_request', 'A current tool must belong to a revision.');
    const problem = artifactProblem(current.artifact) || stateProblem(current.state);
    if (problem) return fail('invalid_request', problem);
  }

  return { ok: true, request: { protocol: PROTOCOL, requestId: payload.requestId, prompt: payload.prompt, context, target, current } };
}

function parseToolReply(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
  const json = fenced ? fenced[1].trim() : trimmed;
  if (!json) return { ok: false, code: 'incomplete' };

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, code: 'invalid_reply' };
  }
  if (!plainObject(parsed)) return { ok: false, code: 'invalid_reply' };
  const extra = Object.keys(parsed).filter((key) => key !== 'artifact' && key !== 'state');
  if (extra.length || !('artifact' in parsed) || !('state' in parsed)) return { ok: false, code: 'invalid_reply' };
  if (artifactProblem(parsed.artifact) || stateProblem(parsed.state)) return { ok: false, code: 'invalid_reply' };
  if (!javascriptParses(parsed.artifact.javascript)) return { ok: false, code: 'invalid_reply' };
  return { ok: true, artifact: parsed.artifact, state: parsed.state };
}

module.exports = {
  PROTOCOL,
  ARTIFACT_FIELDS,
  ARTIFACT_BYTES,
  STATE_BYTES,
  CONTEXT_BYTES,
  PROMPT_BYTES,
  PAYLOAD_BYTES,
  validateToolRequest,
  parseToolReply,
};
