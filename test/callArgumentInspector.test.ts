import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CallArgumentInspector } from '../src/visual/callArgumentInspector';
import { SymbolIndexer } from '../src/indexer/symbolIndexer';
import { PythonParamInlayHintsProvider } from '../src/visual/pythonParamInlayHints';
import { CallArgumentCodeActionProvider } from '../src/visual/callArgumentCodeActions';
import { KlipperHoverProvider } from '../src/navigation/klipperHoverProvider';

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
    assert.equal(diagnostics[0].severity, vscode.DiagnosticSeverity.Error, 'Default severity should be Error for prominent red highlight');
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

  await t.test('inspectDocument: should detect nozzle_manager.replace_nozzle excess arguments and apply prominent red decorations', async () => {
    const nozzleDefDoc = new (vscode as any).MockTextDocument(
      `class NozzleManager:
    def replace_nozzle(self, nozzle_num):
        pass
`,
      '/workspace/nozzle_manager.py',
      'python'
    );
    await indexer.indexDocument(nozzleDefDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def run_replace(self):
    ret = nozzle_manager.replace_nozzle(nozzle_num, 3)
    return ret
`,
      '/workspace/caller_nozzle.py',
      'python'
    );

    let decoratedRanges: any[] = [];
    const mockEditor = {
      document: callerDoc,
      setDecorations: (_type: any, ranges: any[]) => {
        decoratedRanges = ranges;
      },
    };
    (vscode.window as any).visibleTextEditors = [mockEditor];

    const diagnostics = inspector.inspectDocument(callerDoc);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    assert.ok(diagnostics[0].message.includes("'replace_nozzle' 最多接收 1 个位置参数"));
    assert.ok(diagnostics[0].message.includes('实际传入了 2 个'));

    assert.equal(decoratedRanges.length, 1, 'Should set prominent decoration on active editor');
    assert.ok(decoratedRanges[0].renderOptions.after.contentText.includes('❗参数错误: 期望 ≤1 个，实传 2 个'));

    (vscode.window as any).visibleTextEditors = [];
  });

  await t.test('inspectDocument: should detect missing required arguments', async () => {
    const callerMissingDoc = new (vscode as any).MockTextDocument(
      `def run_replace(self):
    ret = nozzle_manager.replace_nozzle()
    return ret
`,
      '/workspace/caller_missing.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerMissingDoc);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'missing-arguments');
    assert.ok(diagnostics[0].message.includes('缺少必填参数: nozzle_num'));
  });

  await t.test('inspectDocument: should detect unexpected keyword arguments', async () => {
    const callerUnexpectedKwDoc = new (vscode as any).MockTextDocument(
      `def run_replace(self):
    ret = nozzle_manager.replace_nozzle(nozzle_num=1, force_reload=True)
    return ret
`,
      '/workspace/caller_unexpected_kw.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerUnexpectedKwDoc);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'unexpected-keyword');
    assert.ok(diagnostics[0].message.includes("未知关键字参数 'force_reload'"));
  });

  await t.test('PythonParamInlayHintsProvider: should provide parameter name hints for positional calls', () => {
    const callerDoc = new (vscode as any).MockTextDocument(
      `def run_replace(self):
    ret = nozzle_manager.replace_nozzle(1)
    return ret
`,
      '/workspace/caller_hints.py',
      'python'
    );

    inspector.inspectDocument(callerDoc);
    const provider = new PythonParamInlayHintsProvider(inspector);
    const hints = provider.provideInlayHints(callerDoc, new vscode.Range(0, 0, 10, 0), {} as any);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].label, 'nozzle_num: ');
  });

  await t.test('CallArgumentCodeActionProvider: should offer QuickFix to remove excess arguments', () => {
    const callerDoc = new (vscode as any).MockTextDocument(
      `def run_replace(self):
    ret = nozzle_manager.replace_nozzle(nozzle_num, 3)
    return ret
`,
      '/workspace/caller_fix.py',
      'python'
    );

    const diags = inspector.inspectDocument(callerDoc);
    const actionProvider = new CallArgumentCodeActionProvider(inspector, indexer);
    const actions = actionProvider.provideCodeActions(
      callerDoc,
      diags[0].range,
      { diagnostics: diags } as any,
      {} as any
    );

    assert.ok(actions.length >= 1);
    const removeAction = actions.find((a) => a.title.includes('移除多余实参'));
    assert.ok(removeAction, 'Should offer QuickFix to remove excess arguments');
    assert.ok(removeAction.edit?.has(callerDoc.uri));
  });

  await t.test('KlipperHoverProvider: should provide hover card for lookup_object variables', () => {
    const klipperDoc = new (vscode as any).MockTextDocument(
      `def test_klipper(self):
    nozzle_manager = self.printer.lookup_object('nozzle_manager')
    nozzle_manager.replace_nozzle(1)
`,
      '/workspace/test_klipper_hover.py',
      'python'
    );

    const hoverProvider = new KlipperHoverProvider(indexer);
    const hover = hoverProvider.provideHover(
      klipperDoc,
      new vscode.Position(2, 5), // hovering over nozzle_manager
      {} as any
    ) as any;

    assert.ok(hover, 'Hover should be returned for Klipper object');
    const mdValue = hover.contents[0].value;
    assert.ok(mdValue.includes('Klipper Component Reference'));
    assert.ok(mdValue.includes('nozzle_manager'));
  });

  await t.test('inspectDocument: should skip common polymorphic methods (e.g. config.get, d.update) to prevent false positives', async () => {
    // Index a custom def get(self, gcmd) from pa_tester.py
    const paTesterDoc = new (vscode as any).MockTextDocument(
      `class PaTester:
    def get(self, gcmd):
        pass
`,
      '/workspace/pa_tester.py',
      'python'
    );
    await indexer.indexDocument(paTesterDoc);

    // Call config.get('xy_calib_buttons_pins', default=None) in nozzle_manager_wrapper.py
    const configCallerDoc = new (vscode as any).MockTextDocument(
      `def init(self, config):
    raw_pins = config.get('xy_calib_buttons_pins', default=None)
    val = d.get('key', 0)
    d.update({'a': 1})
`,
      '/workspace/nozzle_manager_wrapper.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(configCallerDoc);
    assert.equal(diagnostics.length, 0, 'Polymorphic methods like config.get should not trigger false positives');
  });

  await t.test('parsePythonSignature: should never count self or cls as missing argument', () => {
    // Method signature where isMethod wasn't provided or stripped
    const sig = inspector.parsePythonSignature('def stop_temp_stats_timer(self):', false);
    assert.ok(sig);
    assert.equal(sig.minPositional, 0, 'self should be stripped from positional bounds even if isMethod=false');
  });

  inspector.dispose();
  indexer.dispose();
});
