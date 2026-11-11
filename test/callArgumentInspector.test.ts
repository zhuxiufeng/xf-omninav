import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CallArgumentInspector } from '../src/visual/callArgumentInspector';
import { SymbolIndexer } from '../src/indexer/symbolIndexer';
import { PythonParamInlayHintsProvider } from '../src/visual/pythonParamInlayHints';
import { CallArgumentCodeActionProvider } from '../src/visual/callArgumentCodeActions';
import {
  DynamicTypeHoverProvider,
  KlipperHoverProvider,
} from '../src/navigation/dynamicTypeHoverProvider';
import { SymbolParser } from '../src/indexer/symbolParser';
import { ContextResolver } from '../src/resolver/contextResolver';
import { OmniStatusBar } from '../src/statusBar/omniStatusBar';
import { StringInterner } from '../src/indexer/stringInterner';
import { HierarchyTreeViewer } from '../src/visual/hierarchyTree';

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
    assert.ok(
      mdValue.includes('Inferred Type') || mdValue.includes('Component Reference')
    );
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

  await t.test('inspectDocument: should correctly identify result as dict and never match adxl345.update(mcu_clock, chip_clock)', async () => {
    // Index adxl345 def update(self, mcu_clock, chip_clock)
    const adxlDoc = new (vscode as any).MockTextDocument(
      `class ADXL345:
    def update(self, mcu_clock, chip_clock):
        pass
`,
      '/workspace/adxl345.py',
      'python'
    );
    await indexer.indexDocument(adxlDoc);

    // Call result.update({...}) in nozzle_manager_wrapper.py
    const resultDoc = new (vscode as any).MockTextDocument(
      `def move_1207_retry(self, num):
    result = {
        "ok": False,
        "error": "right_move_retry_failed",
    }
    result.update({
        "error": "extruder_open_failed",
        "msg": "failed",
    })
    return result
`,
      '/workspace/nozzle_wrapper_dict.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(resultDoc);
    assert.equal(diagnostics.length, 0, 'result.update should be recognized as dict update, producing 0 diagnostics');
  });

  await t.test('inspectDocument: should never falsely flag gcode_move.get_status() when toolhead.get_status requires eventtime', async () => {
    // Index toolhead.py with def get_status(self, eventtime)
    const toolheadDoc = new (vscode as any).MockTextDocument(
      `class Toolhead:
    def get_status(self, eventtime):
        pass
`,
      '/workspace/toolhead.py',
      'python'
    );
    await indexer.indexDocument(toolheadDoc);

    // Caller document in nozzle_manager_wrapper.py
    const callerDoc = new (vscode as any).MockTextDocument(
      `def some_func(self):
    gcode_move = self.printer.lookup_object('gcode_move')
    saved_z_offset = gcode_move.get_status()['homing_origin'].z
`,
      '/workspace/caller_gcode_move.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerDoc);
    assert.equal(diagnostics.length, 0, 'gcode_move.get_status should skip mismatching toolhead.get_status and produce 0 diagnostics');
  });

  await t.test('parsePython: should correctly identify @staticmethod, @classmethod, and @property decorators', async () => {
    const decDoc = new (vscode as any).MockTextDocument(
      `class ServiceManager:
    @staticmethod
    def calc_hash(data):
        return len(data)

    @classmethod
    def create_default(cls, name):
        return cls()

    @property
    def is_ready(self):
        return True
`,
      '/workspace/decorators.py',
      'python'
    );
    const defs = SymbolParser.parsePython(decDoc.getText(), 'decorators.py', decDoc.uri);
    const calcHash = defs.find((d) => d.name === 'calc_hash');
    const createDef = defs.find((d) => d.name === 'create_default');
    const isReady = defs.find((d) => d.name === 'is_ready');

    assert.ok(calcHash, 'calc_hash should be parsed');
    assert.equal(calcHash?.isStatic, true, 'calc_hash should be identified as isStatic');

    assert.ok(createDef, 'create_default should be parsed');
    assert.equal(createDef?.isClassMethod, true, 'create_default should be identified as isClassMethod');

    assert.ok(isReady, 'is_ready should be parsed');
    assert.equal(isReady?.kind, 'property', 'is_ready should have kind property');

    // Static method signature should keep 'data' as first parameter
    const staticSig = inspector.parsePythonSignature(calcHash!.signature, true, true);
    assert.ok(staticSig);
    assert.equal(staticSig?.minPositional, 1, 'calc_hash static method should require 1 argument (data)');
    assert.equal(staticSig?.params[0].name, 'data', 'First parameter should be data, not stripped');
  });

  await t.test('ContextResolver: should infer generic factory locator (get_service, create_client)', async () => {
    const factoryDoc = new (vscode as any).MockTextDocument(
      `def run_workflow():
    auth_srv = get_service('auth_manager')
    api_client = create_client('rest_api')
`,
      '/workspace/factory.py',
      'python'
    );
    const authType = ContextResolver.inferVariableType(factoryDoc, 'auth_srv', 2);
    const apiType = ContextResolver.inferVariableType(factoryDoc, 'api_client', 3);

    assert.equal(authType, 'auth_manager', 'auth_srv should be inferred as auth_manager');
    assert.equal(apiType, 'rest_api', 'api_client should be inferred as rest_api');
  });

  await t.test('StringInterner: should deduplicate identical strings and conserve memory', () => {
    const s1 = StringInterner.intern('src/models/user.py');
    const s2 = StringInterner.intern('src/models/user.py');
    assert.equal(s1, s2);
    assert.ok(StringInterner.size > 0);
  });

  await t.test('ContextResolver: should infer variable type from callee return type annotation (-> ReturnType)', async () => {
    const providerDoc = new (vscode as any).MockTextDocument(
      `def get_printer_manager() -> PrinterManager:
    return None
`,
      '/workspace/manager_provider.py',
      'python'
    );
    await indexer.indexDocument(providerDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def run_job():
    mgr = get_printer_manager()
    mgr.start_job()
`,
      '/workspace/caller_job.py',
      'python'
    );
    const inferred = ContextResolver.inferVariableType(callerDoc, 'mgr', 2, indexer);
    assert.equal(inferred, 'PrinterManager', 'mgr should be inferred as PrinterManager from return type');
  });

  await t.test('PEP 3102: should flag keyword-only parameter passed as positional argument and offer QuickFix', async () => {
    const kwOnlyDoc = new (vscode as any).MockTextDocument(
      `class DeviceSetup:
    def configure(self, dev_id, *, timeout=10, retry=3):
        pass
`,
      '/workspace/device_setup.py',
      'python'
    );
    await indexer.indexDocument(kwOnlyDoc);

    const invalidCallerDoc = new (vscode as any).MockTextDocument(
      `def test_setup():
    d = DeviceSetup()
    d.configure(101, 5)
`,
      '/workspace/test_setup_caller.py',
      'python'
    );

    const diags = inspector.inspectDocument(invalidCallerDoc);
    assert.equal(diags.length, 1, 'Should produce 1 diagnostic for keyword-only violation');
    assert.equal(diags[0].code, 'keyword-only-as-positional');
    assert.ok(diags[0].message.includes('timeout'));

    // Verify QuickFix
    const codeActionProvider = new CallArgumentCodeActionProvider(inspector, indexer);
    const actions = codeActionProvider.provideCodeActions(
      invalidCallerDoc,
      diags[0].range,
      { diagnostics: diags } as any,
      {} as any
    );
    const convertAction = actions.find((a) => a.title.includes('转换为关键字形式'));
    assert.ok(convertAction, 'Should offer QuickFix to convert positional arg to keyword arg');
  });

  await t.test('HierarchyTreeViewer: should detect unimplemented abstract methods from base classes', async () => {
    const abstractBaseDoc = new (vscode as any).MockTextDocument(
      `class BasePlugin:
    @abstractmethod
    def execute_task(self, task_id):
        pass

    @abstractmethod
    def cleanup(self):
        pass
`,
      '/workspace/base_plugin.py',
      'python'
    );
    await indexer.indexDocument(abstractBaseDoc);

    const subPluginDoc = new (vscode as any).MockTextDocument(
      `class MySubPlugin(BasePlugin):
    def execute_task(self, task_id):
        return True
`,
      '/workspace/my_sub_plugin.py',
      'python'
    );
    await indexer.indexDocument(subPluginDoc);

    const missing = HierarchyTreeViewer.findMissingAbstractMethods(indexer, 'MySubPlugin');
    assert.equal(missing.length, 1, 'Should detect 1 missing abstract method (cleanup)');
    assert.equal(missing[0].name, 'cleanup');
  });

  await t.test('parseTypeScriptSignature: should parse TypeScript parameters and bounds accurately', () => {
    const tsSig = inspector.parseTypeScriptSignature('function calculate(total: number, tax: number = 0, ...rest: any[]): number');
    assert.ok(tsSig);
    assert.equal(tsSig?.minPositional, 1, 'total is required, tax has default');
    assert.equal(tsSig?.maxPositional, Infinity, 'has rest params');
    assert.equal(tsSig?.hasVarargs, true);
    assert.equal(tsSig?.params[0].name, 'total');
    assert.equal(tsSig?.params[0].type, 'number');
    assert.equal(tsSig?.params[1].name, 'tax');
    assert.equal(tsSig?.params[1].type, 'number');
    assert.equal(tsSig?.params[1].defaultValue, '0');
  });

  await t.test('extractDocstringParams: should extract parameter types and descriptions from Sphinx, Google, and JSDoc docstrings', () => {
    const sphinxDoc = `
    Connect to host.
    :param str host: Target hostname or IP
    :param int port: Target port number
    :type timeout: float
    :param timeout: Connection timeout in seconds
    `;
    const sphinxMap = inspector.extractDocstringParams(sphinxDoc);
    assert.equal(sphinxMap.get('host')?.type, 'str');
    assert.equal(sphinxMap.get('host')?.description, 'Target hostname or IP');
    assert.equal(sphinxMap.get('port')?.type, 'int');
    assert.equal(sphinxMap.get('timeout')?.type, 'float');
    assert.equal(sphinxMap.get('timeout')?.description, 'Connection timeout in seconds');

    const googleDoc = `
    Run task.
    Args:
        task_id (str): Unique task identifier
        max_retries (int): Maximum retry attempts
    `;
    const googleMap = inspector.extractDocstringParams(googleDoc);
    assert.equal(googleMap.get('task_id')?.type, 'str');
    assert.equal(googleMap.get('task_id')?.description, 'Unique task identifier');
    assert.equal(googleMap.get('max_retries')?.type, 'int');

    const jsDoc = `
    /**
     * @param {string} user - User name
     * @param {number} [retries=3] - Number of retries
     */
    `;
    const jsMap = inspector.extractDocstringParams(jsDoc);
    assert.equal(jsMap.get('user')?.type, 'string');
    assert.equal(jsMap.get('user')?.description, 'User name');
    assert.equal(jsMap.get('retries')?.type, 'number');
  });

  await t.test('SymbolIndexer: should preserve isAbstract across saveToDiskCache and loadFromDiskCache', async () => {
    const testIndexer = new SymbolIndexer();
    const testDoc = new (vscode as any).MockTextDocument(
      `from abc import ABC, abstractmethod
class AbstractWorker(ABC):
    @abstractmethod
    def run_work(self):
        pass
`,
      '/workspace/abstract_test.py',
      'python'
    );
    await testIndexer.indexDocument(testDoc);
    const methodsBefore = testIndexer.getMethodsInClass('AbstractWorker');
    assert.equal(methodsBefore.length, 1);
    assert.equal(methodsBefore[0].isAbstract, true);

    const cacheFile = '/tmp/test_omninav_cache.json';
    const saved = await testIndexer.saveToDiskCache(cacheFile);
    assert.ok(saved);

    const reloadedIndexer = new SymbolIndexer();
    const loaded = await reloadedIndexer.loadFromDiskCache(cacheFile);
    assert.ok(loaded);

    const methodsAfter = reloadedIndexer.getMethodsInClass('AbstractWorker');
    assert.equal(methodsAfter.length, 1);
    assert.equal(methodsAfter[0].isAbstract, true, 'isAbstract must be restored after loading cache');

    try {
      require('fs').unlinkSync(cacheFile);
    } catch {}
    testIndexer.dispose();
    reloadedIndexer.dispose();
  });

  await t.test('Reverse Adjacency Index: should query direct and transitive subclasses in O(1)/O(Descendants)', async () => {
    const testIndexer = new SymbolIndexer();
    const doc = new (vscode as any).MockTextDocument(
      `class Animal:
    pass
class Mammal(Animal):
    pass
class Dog(Mammal):
    pass
class Cat(Mammal):
    pass
`,
      '/workspace/animals.py',
      'python'
    );
    await testIndexer.indexDocument(doc);

    // Direct subclasses (O(1))
    const directToAnimal = testIndexer.getDirectSubClasses('Animal');
    assert.deepEqual(directToAnimal, ['Mammal']);

    const directToMammal = testIndexer.getDirectSubClasses('Mammal');
    assert.ok(directToMammal.includes('Dog'));
    assert.ok(directToMammal.includes('Cat'));

    // Transitive subclasses
    const allAnimalSubs = testIndexer.getSubClasses('Animal');
    assert.equal(allAnimalSubs.length, 3);
    assert.ok(allAnimalSubs.includes('Mammal'));
    assert.ok(allAnimalSubs.includes('Dog'));
    assert.ok(allAnimalSubs.includes('Cat'));

    testIndexer.dispose();
  });

  await t.test('OmniStatusBar: should format symbol count and indexing status cleanly', async () => {
    const statusBar = new OmniStatusBar(indexer);
    statusBar.update();
    assert.ok(statusBar, 'OmniStatusBar should be instantiated successfully');
    statusBar.dispose();
  });

  inspector.dispose();
  indexer.dispose();
});
