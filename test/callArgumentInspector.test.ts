import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CallArgumentInspector } from '../src/visual/callArgumentInspector';
import { SymbolIndexer } from '../src/indexer/symbolIndexer';

test('CallArgumentInspector tests', async (t) => {
  const indexer = new SymbolIndexer({ subscriptions: [] } as any);
  const inspector = new CallArgumentInspector(indexer);

  await t.test('parsePythonSignature: should correctly parse method parameters and positional bounds', () => {
    // 1. Zero-param method
    const sig1 = inspector.parsePythonSignature('def _is_nano_pro(self):', true);
    assert.ok(sig1);
    assert.equal(sig1.minPositional, 0);
    assert.equal(sig1.maxPositional, 0);
    assert.equal(sig1.hasVarargs, false);

    // 2. Default param method
    const sig2 = inspector.parsePythonSignature('def _is_nano_pro_tpu(self, tnn=None):', true);
    assert.ok(sig2);
    assert.equal(sig2.minPositional, 0);
    assert.equal(sig2.maxPositional, 1);
    assert.equal(sig2.hasVarargs, false);

    // 3. Required positional param method
    const sig3 = inspector.parsePythonSignature('def replace_nozzle(self, nozzle_num):', true);
    assert.ok(sig3);
    assert.equal(sig3.minPositional, 1);
    assert.equal(sig3.maxPositional, 1);
    assert.equal(sig3.hasVarargs, false);

    // 4. Varargs method
    const sig4 = inspector.parsePythonSignature('def log(self, msg, *args, **kwargs):', true);
    assert.ok(sig4);
    assert.equal(sig4.minPositional, 1);
    assert.equal(sig4.maxPositional, Infinity);
    assert.equal(sig4.hasVarargs, true);
    assert.equal(sig4.hasVarkwargs, true);
  });

  await t.test('inspectDocument: should detect excess arguments on dynamic variable call (boxobj._is_nano_pro(1))', async () => {
    // Index the definition file containing BoxAction._is_nano_pro(self)
    const defDoc = new (vscode as any).MockTextDocument(
      `class BoxAction(BoxActionBase):
    def _is_nano_pro(self):
        return True
`,
      '/workspace/box_def.py',
      'python'
    );
    await indexer.indexDocument(defDoc);

    // Caller document containing: if boxobj and boxobj._is_nano_pro(1):
    const callerDoc = new (vscode as any).MockTextDocument(
      `def some_function():
    boxobj = self.printer.lookup_object('box')
    if boxobj and boxobj._is_nano_pro(1):
        pass
    if boxobj and boxobj._is_nano_pro():
        pass
`,
      '/workspace/box_caller.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerDoc);
    assert.equal(diagnostics.length, 1, 'Should produce exactly 1 diagnostic for the invalid call');
    assert.ok(diagnostics[0].message.includes("'_is_nano_pro' 最多接收 0 个位置参数"));
    assert.ok(diagnostics[0].message.includes('实际传入了 1 个'));
    assert.equal(diagnostics[0].source, 'XF OmniNav');
  });

  await t.test('inspectDocument: should accept valid calls with zero diagnostics', async () => {
    const validCallerDoc = new (vscode as any).MockTextDocument(
      `def some_function():
    boxobj = self.printer.lookup_object('box')
    if boxobj and boxobj._is_nano_pro():
        pass
`,
      '/workspace/box_valid.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(validCallerDoc);
    assert.equal(diagnostics.length, 0, 'Valid call with 0 arguments should produce 0 diagnostics');
  });

  inspector.dispose();
  indexer.dispose();
});
