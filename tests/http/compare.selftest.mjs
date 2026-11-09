#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const compare = path.join(here, 'compare.mjs');
const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'http-compare-selftest-'));

function caseEntry(id, { status = 'pass', requests = [200], before = 'aa', after = 'aa' } = {}) {
  return {
    id,
    status,
    detail: status === 'pass' ? 'ok' : 'failed',
    requests: requests.map((code, index) => ({
      root: 'root-a',
      method: 'GET',
      path: `/probe-${index}`,
      status: code,
      headers: { etag: `"stamp-${index}"` },
    })),
    before,
    after,
  };
}

function report(cases, { complete = true, schema = 1 } = {}) {
  const pass = cases.filter((entry) => entry.status === 'pass').length;
  return {
    schema,
    hostBuild: { version: '1.36.0', source: 'local' },
    profile: 'local-full',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    cases,
    pending: [],
    summary: { pass, fail: cases.length - pass, pending: 0 },
    complete,
  };
}

let writes = 0;
function writeJson(name, value) {
  writes += 1;
  const file = path.join(tempDir, `${writes}-${name}`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function run(args) {
  const result = spawnSync(process.execPath, [compare, ...args], { encoding: 'utf8' });
  assert.equal(result.signal, null, `compare was killed by ${result.signal}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function compareReports(baseline, candidate, expected) {
  const args = [
    '--baseline', writeJson('baseline.json', baseline),
    '--candidate', writeJson('candidate.json', candidate),
  ];
  if (expected) args.push('--expected-differences', writeJson('expected.json', expected));
  return run(args);
}

try {
  {
    const cases = [caseEntry('alpha.one'), caseEntry('beta.two')];
    const result = compareReports(report(cases), report(cases));
    assert.equal(result.code, 0, `identical reports exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /-> pass/, 'identical reports end pass');
  }

  {
    const baseline = report([caseEntry('alpha.one'), caseEntry('beta.two', { status: 'fail' })]);
    const candidate = report([caseEntry('alpha.one', { status: 'fail' }), caseEntry('beta.two')]);
    const result = compareReports(baseline, candidate);
    assert.equal(result.code, 1, `swapped statuses exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.equal(baseline.summary.pass, candidate.summary.pass, 'the swapped reports have equal pass counts');
    assert.match(result.stdout, /alpha\.one/, 'the swapped run names alpha.one');
    assert.match(result.stdout, /beta\.two/, 'the swapped run names beta.two');
    assert.match(result.stdout, /statusDiffers/, 'the swapped run reports a status difference');
  }

  {
    const baseline = report([caseEntry('alpha.one'), caseEntry('gamma.three')]);
    const candidate = report([caseEntry('alpha.one')]);
    const result = compareReports(baseline, candidate);
    assert.equal(result.code, 1, `missing case exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /missingFromCandidate gamma\.three/, 'the missing case is named');
  }

  {
    const baseline = report([caseEntry('alpha.one', { requests: [200, 200] })]);
    const candidate = report([caseEntry('alpha.one', { requests: [200, 404] })]);
    const result = compareReports(baseline, candidate);
    assert.equal(result.code, 1, `differing request exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /requestsDiffer alpha\.one/, 'the differing request is named');
    assert.match(result.stdout, /\[200,200\]/, 'the differing request prints the baseline statuses');
    assert.match(result.stdout, /\[200,404\]/, 'the differing request prints the candidate statuses');
  }

  {
    const baseline = report([caseEntry('alpha.one', { before: 'aa', after: 'aa' })]);
    const candidate = report([caseEntry('alpha.one', { before: 'aa', after: 'bb' })]);
    const result = compareReports(baseline, candidate);
    assert.equal(result.code, 1, `mutation difference exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /mutationDiffers alpha\.one/, 'the mutation difference is named');
  }

  {
    const baseline = report([caseEntry('alpha.one', { requests: [200, 200] })]);
    const candidate = report([caseEntry('alpha.one', { requests: [200, 404] })]);
    const result = compareReports(baseline, candidate, {
      schema: 1,
      items: [{ id: 'alpha.one', kind: 'requestsDiffer', reason: 'the candidate answers the token lane' }],
    });
    assert.equal(result.code, 0, `expected difference exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /expected requestsDiffer alpha\.one/, 'the expected difference is reported as expected');
  }

  {
    const cases = [caseEntry('alpha.one')];
    const result = compareReports(report(cases), report(cases), {
      schema: 1,
      items: [{ id: 'alpha.one', kind: 'statusDiffers', reason: 'not a difference this time' }],
    });
    assert.equal(result.code, 1, `unused expected exit ${result.code}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /unusedExpected statusDiffers alpha\.one/, 'the unused expected difference is named');
  }

  {
    const cases = [caseEntry('alpha.one')];
    const result = compareReports(report(cases), report(cases, { schema: 2 }));
    assert.equal(result.code, 3, `schema 2 exit ${result.code}\n${result.stdout}${result.stderr}`);
  }

  console.log(`http compare self test: ok (${writes} reports)`);
} finally {
  await fsp.rm(tempDir, { recursive: true, force: true });
}
