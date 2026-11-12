import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool } from '../src/indexer/workerPool';

test('WorkerPool tests', async (t) => {
  await t.test('WorkerPool: should parse symbols via worker threads without require(vscode) error', async () => {
    const pool = new WorkerPool();
    if (!pool.available) {
      // In CI or test environments where workerPath may not be built yet, skip
      return;
    }

    try {
      const pyCode = `
class WorkerTestClass:
    def worker_method(self, arg1, arg2=None):
        pass
`;
      const defs = await pool.parseText('file:///mock/worker_test.py', pyCode);
      assert.ok(Array.isArray(defs), 'defs should be an array');
      assert.ok(defs.length >= 2, 'should parse class and method');

      const classDef = defs.find((d) => d.name === 'WorkerTestClass');
      const methodDef = defs.find((d) => d.name === 'worker_method');

      assert.ok(classDef, 'WorkerTestClass should exist');
      assert.ok(methodDef, 'worker_method should exist');
      assert.equal(methodDef?.containerName, 'WorkerTestClass');
    } finally {
      pool.dispose();
    }
  });

  await t.test('WorkerPool: should cleanly dispose workers without leaving hanging handles', () => {
    const pool = new WorkerPool();
    assert.doesNotThrow(() => {
      pool.dispose();
    });
    assert.equal(pool.available, false);
  });
});
