const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapLimit } = require('../src/pool');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('mapLimit', () => {
  it('returns results in input order even when later items finish first', async () => {
    const results = await mapLimit([30, 10, 20], 3, async ms => {
      await delay(ms);
      return ms * 2;
    });
    assert.deepEqual(results, [60, 20, 40]);
  });

  it('runs no more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5], 2, async () => {
      peak = Math.max(peak, ++active);
      await delay(5);
      active--;
    });
    assert.equal(peak, 2);
  });

  it('resolves to an empty list for no items', async () => {
    assert.deepEqual(await mapLimit([], 4, () => assert.fail('should not be called')), []);
  });
});
