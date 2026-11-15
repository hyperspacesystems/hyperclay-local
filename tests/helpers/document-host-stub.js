function stubDocumentHost(overrides = {}) {
  return {
    commit: jest.fn(async (request) => ({
      outcome: 'committed',
      reason: null,
      etag: null,
      checksum: 'stub',
      stored: request.bytes,
      content: request.bytes,
    })),
    read: jest.fn(async () => null),
    restructure: jest.fn(async ({ steps }) => ({
      outcome: 'committed',
      completed: steps.length,
      reason: null,
    })),
    blockeditorState: jest.fn(async () => undefined),
    syncFile: jest.fn(async () => ({ outcome: 'committed', reason: null })),
    ensureFolder: jest.fn(async () => ({ outcome: 'committed', reason: null, created: true })),
    ...overrides,
  };
}

// The in-process host's folder step through a suite's mocked file-operations, so a
// suite that asserts ensureDirectory calls still sees the folder a download makes.
function folderThroughFileOps(fileOps, rootOf) {
  return jest.fn(async (rel) => {
    const made = await fileOps.ensureDirectory(rel ? require('upath').join(rootOf(), rel) : rootOf());
    return { outcome: 'committed', reason: null, created: made !== undefined };
  });
}

module.exports = { stubDocumentHost, folderThroughFileOps };
