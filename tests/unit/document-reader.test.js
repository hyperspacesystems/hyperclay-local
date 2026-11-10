const { reader, withReader, disk } = require('../../src/main/document-reader');

test('the reader outside a scope is the disk, and a scope answers with its own', async () => {
  expect(reader()).toBe(disk);
  const custom = { readFile: async () => 'custom' };
  const seen = await withReader(custom, async () => {
    expect(reader()).toBe(custom);
    await new Promise((r) => setTimeout(r, 5));
    expect(reader()).toBe(custom);
    return reader();
  });
  expect(seen).toBe(custom);
  expect(reader()).toBe(disk);
});

test('two concurrent scopes do not leak into each other', async () => {
  const a = { readFile: async () => 'a' };
  const b = { readFile: async () => 'b' };
  const records = [];
  const work = (custom, delays) => {
    const seen = [];
    records.push(seen);
    return withReader(custom, async () => {
      seen.push(reader());
      for (const delay of delays) {
        await new Promise((r) => setTimeout(r, delay));
        seen.push(reader());
      }
    });
  };

  await Promise.all([work(a, [5, 1]), work(b, [1, 5])]);

  expect(records).toHaveLength(2);
  expect(records[0]).toEqual([a, a, a]);
  expect(records[1]).toEqual([b, b, b]);
});
