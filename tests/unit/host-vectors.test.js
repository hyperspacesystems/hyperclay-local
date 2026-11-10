const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const dataLossCore = require('../../src/main/data-loss-core.cjs');
const { documentEtag, ifMatchSatisfied } = require('../../src/main/spec-wire');
const { stripSaveToken, injectDocumentEtag } = require('../../src/main/utils/root-attrs');

// The shared conformance vectors are the answer to "does this host's copy still agree with
// hyperclay.com's and with Go?". Nothing here is a hand-written expectation: every case comes
// out of the generated files, so a drift in data-loss-core.cjs, spec-wire or root-attrs fails
// as a named case instead of living on until someone notices in production.
//
// HOST_VECTORS_DIR names the directory, exactly as DATAGUARD_VECTORS does in Go. Unset, the
// installed package provides it. Either way a missing directory is a failure, never a suite
// that passes because it ran nothing.

function vectorsDir () {
  const override = process.env.HOST_VECTORS_DIR;
  if (override) {
    if (!existsSync(override)) throw new Error(`HOST_VECTORS_DIR=${override} does not exist`);
    return override;
  }
  let manifest = null;
  try {
    manifest = require.resolve('@panphora/host-conformance/package.json');
  } catch {
    manifest = null;
  }
  if (!manifest) {
    throw new Error(
      'conformance vectors not found: set HOST_VECTORS_DIR, or install @panphora/host-conformance'
    );
  }
  return join(dirname(manifest), 'vectors');
}

const VECTORS_DIR = vectorsDir();

const load = (name) => JSON.parse(readFileSync(join(VECTORS_DIR, name), 'utf8'));

// The vectors spell ordered objects {"$o": [["k", v], ...]} because the functions under test
// depend on key order, and invalid UTF-8 as {"$b64": "..."} because it cannot survive JSON.
// Assignment in pair order is the generator's own `decode`.
function decodeArg (value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeArg);
  if (Object.prototype.hasOwnProperty.call(value, '$b64')) return Buffer.from(value.$b64, 'base64');
  const out = {};
  for (const [key, inner] of value.$o) out[key] = decodeArg(inner);
  return out;
}

const core = {
  ...dataLossCore,
  shouldFire: (prov, uiWorkPending, base, inc) =>
    dataLossCore.shouldFire(prov, uiWorkPending, base, inc, dataLossCore.classifyDestruction(base, inc)),
  lossSummary: (prov, base, inc) =>
    dataLossCore.lossSummary(prov, dataLossCore.classifyDestruction(base, inc)),
};

// This host's injectDocumentEtag is bytes in, bytes out: decode a string case to UTF-8, and a
// bytesOnly case is already a Buffer from decodeArg.
const stampDocumentEtag = (html, stamp) =>
  injectDocumentEtag(Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf8'), stamp);

const RUNNERS = {
  'spec-wire.json': { documentEtag, ifMatchSatisfied },
  'root-attrs.json': { stripToken: stripSaveToken, injectDocumentEtag: stampDocumentEtag },
  'data-loss.json': core,
};

const isBytes = (value) =>
  value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '$b64');

// A Buffer answer is compared as the bytes it is when the case expected bytes, and as the text
// it holds otherwise; toString('utf8') alone would replace the invalid UTF-8 a bytesOnly case
// exists to pin.
function answerOf (answer, expected) {
  if (!Buffer.isBuffer(answer)) return JSON.parse(JSON.stringify(answer));
  return isBytes(expected) ? { $b64: answer.toString('base64') } : answer.toString('utf8');
}

describe.each(Object.keys(RUNNERS))('%s', (file) => {
  const cases = load(file).cases;
  console.log(`${file}: ${cases.length} cases`);

  it('has cases', () => expect(cases.length).toBeGreaterThan(0));
  it.each(cases.map((c) => [`${c.fn}/${c.name}`, c]))('%s', (_, c) => {
    const fn = RUNNERS[file][c.fn];
    expect(fn).toBeDefined();
    const answer = fn(...c.args.map(decodeArg));
    const expected = c.hostVariant === 'hyperclay-local' ? c.hostVariantExpect : c.expect;
    expect(answerOf(answer, expected)).toEqual(expected);
  });
});
