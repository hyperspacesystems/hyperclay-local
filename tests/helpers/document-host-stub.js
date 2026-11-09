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
    ...overrides,
  };
}

module.exports = { stubDocumentHost };
