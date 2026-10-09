// The page's requests to its server. They run in the browser, but newestOnly needs nothing from it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newestOnly } from '../public/api.js';

// A task whose calls the test settles by hand, in any order.
function deferredTask() {
  const calls = [];
  const task = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  return { calls, task };
}

describe('newestOnly', () => {
  it('resolves to the value of a call that does not overlap another', async () => {
    const { calls, task } = deferredTask();
    const run = newestOnly(task);
    const result = run();
    calls[0].resolve('routes');
    assert.deepEqual(await result, { value: 'routes' });
  });

  it('resolves to the error of a call that fails', async () => {
    const { calls, task } = deferredTask();
    const run = newestOnly(task);
    const result = run();
    const error = new Error('offline');
    calls[0].reject(error);
    assert.deepEqual(await result, { error });
  });

  it('keeps both calls when they finish in the order they started', async () => {
    const { calls, task } = deferredTask();
    const run = newestOnly(task);
    const older = run();
    const newer = run();
    calls[0].resolve('old');
    calls[1].resolve('new');
    assert.deepEqual([await older, await newer], [{ value: 'old' }, { value: 'new' }]);
  });

  it('drops an older call that finishes after a newer one', async () => {
    const { calls, task } = deferredTask();
    const run = newestOnly(task);
    const older = run();
    const newer = run();
    calls[1].resolve('new');
    await newer;
    calls[0].resolve('old');
    assert.equal(await older, null);
  });

  it('drops an older call that fails after a newer one worked', async () => {
    const { calls, task } = deferredTask();
    const run = newestOnly(task);
    const older = run();
    const newer = run();
    calls[1].resolve('new');
    await newer;
    calls[0].reject(new Error('offline'));
    assert.equal(await older, null);
  });

  it('drops an older call that works after a newer one failed', async () => {
    const { calls, task } = deferredTask();
    const run = newestOnly(task);
    const older = run();
    const newer = run();
    calls[1].reject(new Error('offline'));
    await newer;
    calls[0].resolve('old');
    assert.equal(await older, null);
  });
});
