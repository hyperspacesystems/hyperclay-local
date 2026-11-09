#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const KINDS = new Set([
  'missingFromCandidate',
  'missingFromBaseline',
  'statusDiffers',
  'requestsDiffer',
  'mutationDiffers',
  'incomplete',
]);

function refuse(message) {
  process.stderr.write(`http compare: ${message}\n`);
  process.exit(3);
}

function parseArgs(argv) {
  const args = { baseline: null, candidate: null, expected: null, out: null };
  const flags = {
    '--baseline': 'baseline',
    '--candidate': 'candidate',
    '--expected-differences': 'expected',
    '--out': 'out',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flags[flag]) {
      if (value === undefined) refuse(`${flag} needs a value`);
      args[flags[flag]] = value;
      i += 1;
    } else {
      refuse(`unknown argument: ${flag}`);
    }
  }
  if (!args.baseline) refuse('--baseline is required');
  if (!args.candidate) refuse('--candidate is required');
  return args;
}

function readJson(label, file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) refuse(`missing ${label}: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    refuse(`${label} is not valid JSON: ${file} (${error.message})`);
  }
  return null;
}

function readReport(label, file) {
  const report = readJson(`${label} report`, file);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    refuse(`${label} report is not an object: ${file}`);
  }
  if (report.schema !== 1) {
    refuse(`unsupported ${label} report schema: ${JSON.stringify(report.schema)} (${file})`);
  }
  if (!Array.isArray(report.cases)) refuse(`${label} report has no cases array: ${file}`);
  for (const entry of report.cases) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
      refuse(`${label} report has a case with no id: ${file}`);
    }
  }
  return report;
}

function readExpected(file) {
  if (!file) return [];
  let document;
  try {
    document = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    refuse(`expected differences is not valid JSON: ${file} (${error.message})`);
  }
  if (!document || typeof document !== 'object' || document.schema !== 1) {
    refuse(`unsupported expected differences schema: ${JSON.stringify(document && document.schema)} (${file})`);
  }
  if (!Array.isArray(document.items)) refuse(`expected differences has no items array: ${file}`);
  return document.items.map((item, index) => {
    if (!item || typeof item !== 'object') refuse(`expected differences item ${index} is not an object`);
    if (typeof item.id !== 'string' || item.id.length === 0) refuse(`expected differences item ${index} has no id`);
    if (typeof item.kind !== 'string' || !KINDS.has(item.kind)) {
      refuse(`expected differences item ${index} (${item.id}) has no known kind: ${JSON.stringify(item.kind)}`);
    }
    if (typeof item.reason !== 'string' || item.reason.length === 0) {
      refuse(`expected differences item ${index} (${item.id}) has no reason`);
    }
    return { id: item.id, kind: item.kind, reason: item.reason };
  });
}

function requestStatuses(entry) {
  return Array.isArray(entry.requests) ? entry.requests.map((request) => (request ? request.status : null)) : [];
}

function mutated(entry) {
  return entry.before !== entry.after;
}

function compare(baseline, candidate) {
  const differences = [];
  const baselineById = new Map(baseline.cases.map((entry) => [entry.id, entry]));
  const candidateById = new Map(candidate.cases.map((entry) => [entry.id, entry]));

  for (const [id, before] of baselineById) {
    const after = candidateById.get(id);
    if (!after) {
      differences.push({ kind: 'missingFromCandidate', id, baseline: before.status, candidate: null });
      continue;
    }
    if (before.status !== after.status) {
      differences.push({ kind: 'statusDiffers', id, baseline: before.status, candidate: after.status });
    }
    const beforeRequests = requestStatuses(before);
    const afterRequests = requestStatuses(after);
    if (JSON.stringify(beforeRequests) !== JSON.stringify(afterRequests)) {
      differences.push({ kind: 'requestsDiffer', id, baseline: beforeRequests, candidate: afterRequests });
    }
    const beforeMutated = mutated(before);
    const afterMutated = mutated(after);
    if (beforeMutated !== afterMutated) {
      differences.push({ kind: 'mutationDiffers', id, baseline: beforeMutated, candidate: afterMutated });
    }
  }

  for (const [id, after] of candidateById) {
    if (!baselineById.has(id)) {
      differences.push({ kind: 'missingFromBaseline', id, baseline: null, candidate: after.status });
    }
  }

  for (const [label, report] of [['baseline', baseline], ['candidate', candidate]]) {
    if (report.complete !== true) {
      differences.push({
        kind: 'incomplete',
        id: label,
        baseline: baseline.complete === true,
        candidate: candidate.complete === true,
      });
    }
  }

  return differences;
}

function match(differences, expected) {
  const used = new Set();
  for (const difference of differences) {
    const at = expected.findIndex((item, index) =>
      !used.has(index) && item.id === difference.id && item.kind === difference.kind);
    if (at >= 0) {
      used.add(at);
      difference.expected = expected[at].reason;
    }
  }
  return expected.filter((_, index) => !used.has(index));
}

function line(difference) {
  const values = `baseline=${JSON.stringify(difference.baseline)} candidate=${JSON.stringify(difference.candidate)}`;
  if (typeof difference.expected === 'string') {
    return `http compare: expected ${difference.kind} ${difference.id}: ${values} (${difference.expected})`;
  }
  return `http compare: ${difference.kind} ${difference.id}: ${values}`;
}

const args = parseArgs(process.argv.slice(2));
const baseline = readReport('baseline', args.baseline);
const candidate = readReport('candidate', args.candidate);
const expected = readExpected(args.expected);

const differences = compare(baseline, candidate);
const unusedExpected = match(differences, expected);
const unexplained = differences.filter((difference) => typeof difference.expected !== 'string');

for (const difference of differences) process.stdout.write(`${line(difference)}\n`);
for (const item of unusedExpected) {
  process.stdout.write(
    `http compare: unusedExpected ${item.kind} ${item.id}: ` +
    `baseline=null candidate=null (${item.reason})\n`,
  );
}

const ok = unexplained.length === 0 && unusedExpected.length === 0;
process.stdout.write(
  `http compare: ${differences.length} differences, ${differences.length - unexplained.length} expected, ` +
  `${unusedExpected.length} unused expected, ${baseline.cases.length} baseline cases, ` +
  `${candidate.cases.length} candidate cases -> ${ok ? 'pass' : 'fail'}\n`,
);

if (args.out) {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({
    schema: 1,
    baseline: path.resolve(args.baseline),
    candidate: path.resolve(args.candidate),
    ok,
    differences,
    unusedExpected,
  }, null, 2)}\n`);
}

process.exit(ok ? 0 : 1);
