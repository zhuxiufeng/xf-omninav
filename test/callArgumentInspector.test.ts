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
  const codeActions = new CallArgumentCodeActionProvider(inspector, indexer);

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

  await t.test('Chained property call: self.gcode.run_script_from_command should detect excess positional argument', async () => {
    // 1. Index GCodeDispatch in gcode.py
    const gcodeDoc = new (vscode as any).MockTextDocument(
      `class GCodeDispatch:
    def run_script_from_command(self, script):
        pass
`,
      '/workspace/klippy/gcode.py',
      'python'
    );
    await indexer.indexDocument(gcodeDoc);

    // 2. Index a separate class that has run_script_from_command with 2 arguments
    const otherDoc = new (vscode as any).MockTextDocument(
      `class OtherComponent:
    def run_script_from_command(self, cmd, showlog=True):
        pass
`,
      '/workspace/klippy/extras/other.py',
      'python'
    );
    await indexer.indexDocument(otherDoc);

    // 3. User document has self.gcode = lookup_object('gcode') and calls self.gcode.run_script_from_command('G90', 1)
    const callerDoc = new (vscode as any).MockTextDocument(
      `class NozzleManager:
    def __init__(self, config):
        self.gcode = config.get_printer().lookup_object('gcode', None)

    def execute_move(self):
        self.gcode.run_script_from_command('G90', 1)
`,
      '/workspace/klippy/extras/nozzle_manager.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    assert.ok(diags.length > 0, 'Should detect error for excess argument on self.gcode.run_script_from_command');
    assert.equal(diags[0].code, 'too-many-arguments');
    assert.ok(diags[0].message.includes('run_script_from_command'));
    assert.ok(diags[0].message.includes('最多接收 1 个位置参数'));
  });

  await t.test('Bug Fix: parseTypeScriptSignature should never treat callback arrow type (=> void) as default parameter', () => {
    const sig = inspector.parseTypeScriptSignature('function register(name: string, callback: () => void, timeout: number = 1000): void');
    assert.ok(sig);
    assert.equal(sig.params.length, 3);
    assert.equal(sig.params[0].name, 'name');
    assert.equal(sig.params[0].hasDefault, false);
    assert.equal(sig.params[1].name, 'callback');
    assert.equal(sig.params[1].type, '() => void');
    assert.equal(sig.params[1].hasDefault, false, 'Callback parameter must NOT be marked as hasDefault');
    assert.equal(sig.params[2].name, 'timeout');
    assert.equal(sig.params[2].hasDefault, true);
    assert.equal(sig.minPositional, 2, 'Must require both name and callback');
    assert.equal(sig.maxPositional, 3);
  });

  await t.test('Bug Fix: parseCallArguments should handle backticks and escaped backslashes', () => {
    const doc = new (vscode as any).MockTextDocument(
      'call(`result: (${value})`, "C:\\\\path\\\\to\\\\dir", 42)',
      '/workspace/test_quotes.js',
      'javascript'
    );
    const args = inspector.parseCallArguments(doc, 0, 4);
    assert.ok(args);
    assert.equal(args.positionalCount, 3);
    assert.equal(args.items.length, 3);
    assert.equal(args.items[0].text, '`result: (${value})`');
    assert.equal(args.items[1].text, '"C:\\\\path\\\\to\\\\dir"');
    assert.equal(args.items[2].text, '42');
  });

  await t.test('Bug Fix: SymbolParser should parse multiline Python function with typed parameters without truncating at colon', () => {
    const code = `
def process_stream(
    stream_id: str,
    buffer_size: int = 4096,
) -> bool:
    pass
`;
    const symbols = SymbolParser.parseText(code, vscode.Uri.file('/workspace/multiline_test.py'), 'python');
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, 'process_stream');
    assert.ok(symbols[0].signature.includes('stream_id: str'));
    assert.ok(symbols[0].signature.includes('buffer_size: int = 4096'));
    assert.ok(symbols[0].signature.endsWith(') -> bool'));

    const parsedSig = inspector.parsePythonSignature(symbols[0].signature);
    assert.ok(parsedSig);
    assert.equal(parsedSig.minPositional, 1);
    assert.equal(parsedSig.maxPositional, 2);
  });

  await t.test('Bug Fix: SymbolParser should parse TypeScript methods with override keyword and callback parameters', () => {
    const code = `
class Worker {
    public override execute(callback: () => void): void {
        callback();
    }
}
`;
    const symbols = SymbolParser.parseText(code, vscode.Uri.file('/workspace/ts_override.ts'), 'typescript');
    const method = symbols.find((s) => s.name === 'execute');
    assert.ok(method, 'Should successfully parse override method');
    assert.equal(method.kind, 'method');
    assert.equal(method.containerName, 'Worker');
  });

  await t.test('Bug Fix: inspectDocument should detect missing required keyword-only parameter without default', async () => {
    const serverDoc = new (vscode as any).MockTextDocument(
      `class ApiClient:
    def create_session(self, user_id, *, api_token, timeout=30):
        pass
`,
      '/workspace/api_client.py',
      'python'
    );
    await indexer.indexDocument(serverDoc);

    const callDoc = new (vscode as any).MockTextDocument(
      `class Service:
    def __init__(self):
        self.api = ApiClient()
    def run(self):
        self.api.create_session('user123')
`,
      '/workspace/service.py',
      'python'
    );
    await indexer.indexDocument(callDoc);

    const diags = inspector.inspectDocument(callDoc);
    const missingDiag = diags.find((d) => d.code === 'missing-arguments');
    assert.ok(missingDiag, 'Should flag missing required keyword-only argument api_token');
    assert.ok(missingDiag.message.includes('api_token'));
  });

  await t.test('Bug Fix: ContextResolver should infer Dog from x: None | Dog', () => {
    const doc = new (vscode as any).MockTextDocument(
      `class Handler:
    def handle(self):
        d: None | Dog = None
        d.bark()
`,
      '/workspace/union_test.py',
      'python'
    );
    const inferred = ContextResolver.inferVariableType(doc, 'd', 3);
    assert.equal(inferred, 'Dog', 'Should skip None and infer Dog');
  });

  await t.test('Screenshot Reproduction: gcode.printer.lookup_object should detect excess positional arguments (3, 1)', async () => {
    // 1. Index Printer.lookup_object in klippy.py
    const klippyDoc = new (vscode as any).MockTextDocument(
      `class Printer:
    def lookup_object(self, name, default=None):
        pass
`,
      '/workspace/klippy/klippy.py',
      'python'
    );
    await indexer.indexDocument(klippyDoc);

    // 2. Caller uses chained receiver: gcode.printer.lookup_object("virtual_sdcard", None, 3, 1)
    const callerDoc = new (vscode as any).MockTextDocument(
      `class VirtualSdCardWrapper:
    def check_sd(self, gcode):
        cur = greenlet.getcurrent()
        v_sd = gcode.printer.lookup_object("virtual_sdcard", None, 3, 1)
`,
      '/workspace/klippy/extras/virtual_sdcard_wrapper.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    assert.ok(diags.length > 0, 'Should detect error for excess arguments on gcode.printer.lookup_object');
    const tooManyDiag = diags.find((d) => d.code === 'too-many-arguments');
    assert.ok(tooManyDiag, 'Should flag too-many-arguments diagnostic');
    assert.ok(tooManyDiag.message.includes('lookup_object'));
    assert.ok(tooManyDiag.message.includes('最多接收 2 个位置参数'));
    assert.ok(tooManyDiag.message.includes('实际传入了 4 个'));
  });

  await t.test('Inheritance: should detect excess arguments on inherited method from base class', async () => {
    const parentDoc = new (vscode as any).MockTextDocument(
      `class BaseDevice:
    def execute_command(self, cmd, timeout=10):
        pass
`,
      '/workspace/devices/base_device.py',
      'python'
    );
    await indexer.indexDocument(parentDoc);

    const childDoc = new (vscode as any).MockTextDocument(
      `class CustomDevice(BaseDevice):
    pass
`,
      '/workspace/devices/custom_device.py',
      'python'
    );
    await indexer.indexDocument(childDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def run_test():
    dev = CustomDevice()
    dev.execute_command("START", 5, "EXTRA1", "EXTRA2")
`,
      '/workspace/test_runner.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    const excessDiag = diags.find((d) => d.code === 'too-many-arguments');
    assert.ok(excessDiag, 'Should flag too-many-arguments on inherited BaseDevice method call');
    assert.ok(excessDiag.message.includes('execute_command'));
    assert.ok(excessDiag.message.includes('最多接收 2 个位置参数'));
  });

  await t.test('Chained expression call: should extract receiver from lookup_object expression', async () => {
    const pinsDoc = new (vscode as any).MockTextDocument(
      `class PrinterPins:
    def register_chip(self, chip_name, chip_obj):
        pass
`,
      '/workspace/pins.py',
      'python'
    );
    await indexer.indexDocument(pinsDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def setup_pins(printer):
    printer.lookup_object('pins').register_chip("mcu", self, 123, 456)
`,
      '/workspace/mcu_init.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    const excessDiag = diags.find((d) => d.code === 'too-many-arguments');
    assert.ok(excessDiag, 'Should flag too-many-arguments on chained lookup_object expression call');
    assert.ok(excessDiag.message.includes('register_chip'));
  });

  await t.test('ContextResolver: should infer leading parameter annotation and getter pattern', () => {
    const doc = new (vscode as any).MockTextDocument(
      `def handle(event: Event):
    p = config.get_printer()
    pass
`,
      '/workspace/test.py',
      'python'
    );
    const eventType = ContextResolver.inferVariableType(doc, 'event', 2);
    assert.equal(eventType, 'Event', 'Should infer leading parameter event: Event');

    const printerType = ContextResolver.inferVariableType(doc, 'p', 3);
    assert.equal(printerType, 'Printer', 'Should infer p from config.get_printer()');
  });

  await t.test('PEP 570: should flag positional-only parameter passed as keyword and offer QuickFix', async () => {
    const apiDoc = new (vscode as any).MockTextDocument(
      `def format_data(data, format_type='json', /):
    pass
`,
      '/workspace/formatter.py',
      'python'
    );
    await indexer.indexDocument(apiDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def run():
    format_data("hello", format_type='xml')
`,
      '/workspace/caller.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    const posOnlyDiag = diags.find((d) => d.code === 'positional-only-as-keyword');
    assert.ok(posOnlyDiag, 'Should flag positional-only-as-keyword diagnostic');
    assert.ok(posOnlyDiag.message.includes('format_type'));
    assert.ok(posOnlyDiag.message.includes('PEP 570'));

    const actions = codeActions.provideCodeActions(callerDoc, callerDoc.lineAt(1).range, { diagnostics: [posOnlyDiag] } as any, {} as any);
    const convertAction = actions.find((a) => a.title.includes('转换为位置参数形式'));
    assert.ok(convertAction, 'Should offer QuickFix to convert positional-only keyword to positional value');
  });

  await t.test('Multiple values for argument: should detect parameter passed positionally and by keyword', async () => {
    const netDoc = new (vscode as any).MockTextDocument(
      `def connect(ip, port=8080):
    pass
`,
      '/workspace/network.py',
      'python'
    );
    await indexer.indexDocument(netDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def test_connect():
    connect('127.0.0.1', 8080, port=9000)
`,
      '/workspace/net_test.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    const dupValDiag = diags.find((d) => d.code === 'duplicate-argument-value');
    assert.ok(dupValDiag, 'Should detect duplicate value for port');
    assert.ok(dupValDiag.message.includes('port'));
    assert.ok(dupValDiag.message.includes('TypeError: got multiple values for argument'));
  });

  await t.test('Duplicate keyword argument: should detect repeated keyword in function call', async () => {
    const netDoc = new (vscode as any).MockTextDocument(
      `def connect(ip, port=8080):
    pass
`,
      '/workspace/network.py',
      'python'
    );
    await indexer.indexDocument(netDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def test_connect():
    connect('127.0.0.1', port=8080, port=9000)
`,
      '/workspace/net_test.py',
      'python'
    );
    await indexer.indexDocument(callerDoc);

    const diags = inspector.inspectDocument(callerDoc);
    const dupKwDiag = diags.find((d) => d.code === 'duplicate-keyword-argument');
    assert.ok(dupKwDiag, 'Should detect repeated keyword argument port');
    assert.ok(dupKwDiag.message.includes('SyntaxError: keyword argument repeated'));
  });

  await t.test('Mutable default argument: should warn on list or dict default value in function definitions', () => {
    const doc = new (vscode as any).MockTextDocument(
      `def append_item(val, target=[]):
    pass
def configure(options={}):
    pass
`,
      '/workspace/utils.py',
      'python'
    );

    const diags = inspector.inspectDocument(doc);
    const mutableDiags = diags.filter((d) => d.code === 'mutable-default-argument');
    assert.equal(mutableDiags.length, 2, 'Should flag mutable-default-argument on both list and dict defaults');
    assert.ok(mutableDiags[0].message.includes('target=[]'));
    assert.ok(mutableDiags[1].message.includes('options={}'));
  });

  await t.test('PythonSignatureHelpProvider: should provide active parameter highlighting and docstrings', async () => {
    const { PythonSignatureHelpProvider } = await import('../src/navigation/pythonSignatureHelpProvider');
    const sigProvider = new PythonSignatureHelpProvider(inspector, indexer);

    const defDoc = new (vscode as any).MockTextDocument(
      `class DeviceHub:
    def send_command(self, cmd: str, timeout: int = 10, retry: bool = True):
        """Send command to device.
        :param cmd: The command string
        :param timeout: Seconds before timeout
        """
        pass
`,
      '/workspace/hub.py',
      'python'
    );
    await indexer.indexDocument(defDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def run(hub):
    hub.send_command("RESET", 5, 
`,
      '/workspace/caller.py',
      'python'
    );

    const help = await sigProvider.provideSignatureHelp(
      callerDoc,
      new (vscode as any).Position(1, 33),
      {} as any,
      {} as any
    );

    assert.ok(help, 'Should return SignatureHelp');
    assert.equal(help.activeParameter, 2, 'Should highlight activeParameter 2 (retry)');
    assert.ok(help.signatures[0].label.includes('send_command'));
    assert.equal(help.signatures[0].parameters.length, 3);
  });

  await t.test('PythonKeywordCompletionProvider: should suggest unpassed keyword parameters with snippet', async () => {
    const { PythonKeywordCompletionProvider } = await import('../src/navigation/pythonKeywordCompletionProvider');
    const compProvider = new PythonKeywordCompletionProvider(inspector, indexer);

    const defDoc = new (vscode as any).MockTextDocument(
      `class DeviceHub:
    def send_command(self, cmd: str, timeout: int = 10, retry: bool = True):
        pass
`,
      '/workspace/hub.py',
      'python'
    );
    await indexer.indexDocument(defDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def run(hub):
    hub.send_command("RESET", 
`,
      '/workspace/caller.py',
      'python'
    );

    const items = await compProvider.provideCompletionItems(
      callerDoc,
      new (vscode as any).Position(1, 30),
      {} as any,
      {} as any
    );

    assert.ok(items && items.length > 0, 'Should return completion items');
    const timeoutItem = items.find((it) => it.label === 'timeout=');
    const retryItem = items.find((it) => it.label === 'retry=');
    assert.ok(timeoutItem, 'Should suggest timeout= keyword argument');
    assert.ok(retryItem, 'Should suggest retry= keyword argument');
    assert.ok(timeoutItem.insertText?.value.includes('timeout='), 'Should use snippet insertText');
  });

  await t.test('parsePythonSignature: should parse default lambda and dict without misidentifying type', () => {
    const sig = inspector.parsePythonSignature(
      "def process(val, cb=lambda x: x + 1, opts={'mode': 1}):",
      false
    );
    assert.ok(sig);
    assert.equal(sig.params.length, 3);
    assert.equal(sig.params[1].name, 'cb');
    assert.equal(sig.params[1].type, undefined);
    assert.equal(sig.params[1].defaultValue, 'lambda x: x + 1');
    assert.equal(sig.params[2].name, 'opts');
    assert.equal(sig.params[2].type, undefined);
    assert.equal(sig.params[2].defaultValue, "{'mode': 1}");
  });

  await t.test('parsePythonSignature: should parse string parameter containing comma (sep=", ") without splitting', () => {
    const sig = inspector.parsePythonSignature(
      'def join_words(words, sep=", ", end="\\n"):',
      false
    );
    assert.ok(sig);
    assert.equal(sig.params.length, 3);
    assert.equal(sig.params[0].name, 'words');
    assert.equal(sig.params[1].name, 'sep');
    assert.equal(sig.params[1].defaultValue, '", "');
    assert.equal(sig.params[2].name, 'end');
    assert.equal(sig.params[2].defaultValue, '"\\n"');
  });

  await t.test('inspectDocument: MathUtil.add(1, 2) on static method should NOT have excess or missing arguments', async () => {
    const defDoc = new (vscode as any).MockTextDocument(
      `class MathUtil:
    @staticmethod
    def add(a: int, b: int) -> int:
        return a + b
`,
      '/workspace/math_util.py',
      'python'
    );
    await indexer.indexDocument(defDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `def calculate():
    val = MathUtil.add(1, 2)
    bad = MathUtil.add(1, 2, 3)
`,
      '/workspace/math_caller.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerDoc);
    assert.equal(diagnostics.length, 1, 'Should only flag bad call with 3 arguments, valid call with 2 args should be accepted');
    assert.ok(diagnostics[0].message.includes('最多接收 2 个位置参数'));
    assert.ok(diagnostics[0].message.includes('实际传入了 3 个'));
  });

  await t.test('parseCallArguments: should handle triple quotes with inner quotes, commas, comments, and parens', () => {
    const lines = [
      'val = process("""first line, with comma',
      '# not a comment, and ) paren',
      'third line \'quoted\'""", timeout=30)',
    ];
    const doc = new (vscode as any).MockTextDocument(lines.join('\n'), '/workspace/call.py', 'python');
    const openParenChar = lines[0].indexOf('(');
    const parsed = inspector.parseCallArguments(doc, 0, openParenChar, (l) => lines[l]);
    assert.ok(parsed, 'Should parse multiline call with triple-quoted string');
    assert.equal(parsed.positionalCount, 1, 'Should have exactly 1 positional argument (the triple-quoted string)');
    assert.equal(parsed.keywords.length, 1, 'Should have exactly 1 keyword argument');
    assert.equal(parsed.keywords[0], 'timeout');
  });

  await t.test('SymbolParser: should strip inline comments with parentheses when parsing signatures', () => {
    const pyCode = `def calculate(a, # comment (note)
              b):
    return a + b
`;
    const doc = new (vscode as any).MockTextDocument(pyCode, '/workspace/calc.py', 'python');
    const symbols = SymbolParser.parseText(pyCode, doc.uri, 'python');
    const fn = symbols.find((s) => s.name === 'calculate');
    assert.ok(fn, 'Should find calculate function');
    assert.ok(fn.signature);
    assert.ok(!fn.signature.includes('#'), 'Signature should not contain inline comment');
    assert.ok(!fn.signature.includes('note'), 'Signature should not contain comment text');
    const parsedSig = inspector.parsePythonSignature(fn.signature, false);
    assert.ok(parsedSig);
    assert.equal(parsedSig.params.length, 2);
    assert.equal(parsedSig.params[0].name, 'a');
    assert.equal(parsedSig.params[1].name, 'b');
  });

  await t.test('inspectDocument: self.box_state.get_box_mode(BoxProtol.START_ADDR, 1, 2) should detect excess arguments', async () => {
    const boxStateDoc = new (vscode as any).MockTextDocument(
      `class BoxState:
    def get_box_mode(self, addr):
        return 0
`,
      '/workspace/box_state_def.py',
      'python'
    );
    await indexer.indexDocument(boxStateDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `class BoxAction:
    def __init__(self, config, box_state):
        self.box_state = box_state

    def process(self):
        self.get_material_info_before_replace_nozzle()
        box_mode = self.box_state.get_box_mode(BoxProtol.START_ADDR, 1, 2)
        valid_mode = self.box_state.get_box_mode(BoxProtol.START_ADDR)
`,
      '/workspace/box_action_caller.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerDoc);
    assert.equal(diagnostics.length, 1, 'Should detect excess arguments on get_box_mode call');
    assert.ok(diagnostics[0].message.includes("'get_box_mode' 最多接收 1 个位置参数"));
    assert.ok(diagnostics[0].message.includes('实际传入了 3 个'));
  });

  await t.test('inspectDocument: self.box_state.Tn_data.get("enable", 3,3,3,3,3,3,3) should detect excess dict.get() args', async () => {
    // This tests chained property inference: self.box_state.Tn_data is a dict (BoxState.__init__ has self.Tn_data = {})
    const boxStateDoc = new (vscode as any).MockTextDocument(
      `class BoxState:
    def __init__(self, config):
        self.Tn_data = {}  # Tn's data to app

    def get_box_mode(self, addr):
        return 0
`,
      '/workspace/box_wrapper.py',
      'python'
    );
    await indexer.indexDocument(boxStateDoc);

    const callerDoc = new (vscode as any).MockTextDocument(
      `class BoxActionWrapper:
    def __init__(self, config, box_state):
        self.box_state = box_state

    def is_box_ready(self):
        # dict.get(key, default) — only 2 args allowed; passing 8 should be flagged
        return (self.box_state.Tn_data.get("enable", 3, 3, 3, 3, 3, 3, 3) == 1
                and self.box_state.Tn_data.get("state") == "connect")
`,
      '/workspace/box_nano_wrapper.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerDoc);
    const dictGetDiag = diagnostics.find((d) => d.message.includes('dict.get'));
    assert.ok(dictGetDiag, 'Should detect excess arguments on dict.get() call');
    assert.ok(
      dictGetDiag.message.includes('8') || dictGetDiag.message.includes('7'),
      `Diagnostic should mention arg count, got: ${dictGetDiag.message}`
    );
  });

  await t.test('inspectDocument: self.box_state.Tn_data.get("state") with valid args should NOT flag', async () => {
    const boxStateDoc2 = new (vscode as any).MockTextDocument(
      `class BoxState:
    def __init__(self, config):
        self.Tn_data = {}
`,
      '/workspace/box_wrapper2.py',
      'python'
    );
    await indexer.indexDocument(boxStateDoc2);

    const callerDoc2 = new (vscode as any).MockTextDocument(
      `class BoxActionWrapper2:
    def __init__(self, config, box_state):
        self.box_state = box_state

    def check_state(self):
        return self.box_state.Tn_data.get("state") == "connect"
`,
      '/workspace/box_nano_wrapper2.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(callerDoc2);
    const dictGetDiag = diagnostics.find((d) => d.message.includes('dict.get'));
    assert.ok(!dictGetDiag, `Valid dict.get("state") should NOT be flagged, but got: ${dictGetDiag?.message}`);
  });

  await t.test('inspectDocument: list.append(x, y) with excess args should be detected', async () => {
    const doc = new (vscode as any).MockTextDocument(
      `def process():
    items = []
    items.append(1, 2)
    items.append(3)
`,
      '/workspace/list_test.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(doc);
    const listDiag = diagnostics.find((d) => d.message.includes('list.append'));
    assert.ok(listDiag, `Should detect excess args on list.append(1, 2), got diagnostics: ${JSON.stringify(diagnostics.map(d => d.message))}`);
  });

  await t.test('Screenshot Reproduction: tuple(sorted(remain.items())) should NEVER be flagged as missing argument', async () => {
    // 1. Simulate an accidental C symbol in lodepng.c or other C file if present
    const cDocText = `
/*search the index in the array, that has the largest value smaller than or equal to the given value,
given array must be sorted (if no value is smaller, it returns the size of the given array)*/
static size_t searchCodeIndex(const unsigned* array, size_t array_size, size_t value) {
  return 0;
}
`;
    const cDefs = SymbolParser.parseText(cDocText, (vscode as any).Uri.file('/workspace/lodepng.c'), 'c');
    assert.equal(cDefs.find(d => d.name === 'sorted'), undefined, 'lodepng.c comment should NOT parse as sorted function');

    // 2. Test python code calling sorted()
    const pyDoc = new (vscode as any).MockTextDocument(
      `def _handle_rfid_update(self, data):
    remain = data.get('remain', {})
    if remain is not None:
        sig = tuple(sorted(remain.items()))
        return sig
`,
      '/workspace/box_nano_rfid.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(pyDoc);
    const sortedDiag = diagnostics.find((d) => d.message.includes('sorted'));
    assert.ok(!sortedDiag, `sorted() should NOT be flagged with missing required arguments, but got: ${sortedDiag?.message}`);
  });

  await t.test('Language Isolation: Python call should never resolve to C function in .c file', async () => {
    // Index a C function directly in indexer
    const cCode = `int custom_c_worker(int x, int y, int z) { return x + y + z; }`;
    indexer.indexFile((vscode as any).Uri.file('/workspace/engine.c'), cCode);

    // Call same-name function in Python without receiver
    const pyDoc = new (vscode as any).MockTextDocument(
      `def run():
    custom_c_worker(1)
`,
      '/workspace/caller.py',
      'python'
    );

    const diagnostics = inspector.inspectDocument(pyDoc);
    const diag = diagnostics.find((d) => d.message.includes('custom_c_worker'));
    assert.ok(!diag, `Python caller should NOT match C function without ffi_lib bridge, got: ${diag?.message}`);
  });

  await t.test('Screenshot Reproduction 2: sensor = getattr(self, waste_chute_sensor); sensor.get_status() should NOT flag missing eventtime', async () => {
    // 1. Index WasteChuteSensor in box_wrapper.py
    const boxWrapperText = `
class WasteChuteSensor:
    def __init__(self, config):
        pass
    def get_status(self):
        return {'enabled': True}
`;
    indexer.indexFile((vscode as any).Uri.file('/workspace/box_wrapper.py'), boxWrapperText);

    // 2. MultiColorMaterialBoxWrapper in box_nano_wrapper.py calling sensor.get_status()
    const nanoWrapperText = `
class MultiColorMaterialBoxWrapper:
    def __init__(self, config):
        self.waste_chute_sensor = box_wrapper.WasteChuteSensor(config)

    def get_status(self, eventtime):
        sensor = getattr(self, 'waste_chute_sensor', None)
        if sensor is not None:
            res = {}
            res["waste_chute"] = sensor.get_status()
            return res
`;
    const doc = new (vscode as any).MockTextDocument(
      nanoWrapperText,
      '/workspace/box_nano_wrapper.py',
      'python'
    );
    indexer.indexFile((vscode as any).Uri.file('/workspace/box_nano_wrapper.py'), nanoWrapperText);

    const diagnostics = inspector.inspectDocument(doc);
    const getStatusDiag = diagnostics.find((d) => d.message.includes('get_status') || d.message.includes('eventtime'));
    assert.ok(
      !getStatusDiag,
      `sensor.get_status() should NOT flag missing eventtime, but got: ${getStatusDiag?.message}`
    );
  });

  await t.test('Screenshot Reproduction 3: subprocess.check_output(cmd, shell=True) should NEVER flag unknown keyword argument shell', async () => {
    // 1. Index def check_output(prog): in scripts/buildcommands.py
    const buildCommandsText = `
def check_output(prog):
    logging.debug("Running %s" % (repr(prog),))
    return ""
`;
    indexer.indexFile((vscode as any).Uri.file('/workspace/scripts/buildcommands.py'), buildCommandsText);

    // 2. Caller doc with subprocess.check_output('/usr/bin/beep.sh 0.2', shell=True)
    const callerText = `
import subprocess

def test_beep():
    ret = subprocess.check_output('/usr/bin/beep.sh 0.2', shell=True).decode("utf-8")
    return ret
`;
    const doc = new (vscode as any).MockTextDocument(callerText, '/workspace/extras/box_nano_wrapper.py', 'python');
    const diagnostics = inspector.inspectDocument(doc);
    const shellDiag = diagnostics.find((d) => d.message.includes('shell') || d.message.includes('check_output'));
    assert.ok(!shellDiag, `subprocess.check_output with shell=True should NOT produce error, got: ${shellDiag?.message}`);

    // 3. Caller doc with from subprocess import check_output
    const bareCallerText = `
from subprocess import check_output

def test_beep_bare():
    ret = check_output('/usr/bin/beep.sh 0.2', shell=True)
    return ret
`;
    const bareDoc = new (vscode as any).MockTextDocument(bareCallerText, '/workspace/extras/filament_rack_wrapper.py', 'python');
    const bareDiagnostics = inspector.inspectDocument(bareDoc);
    const bareDiag = bareDiagnostics.find((d) => d.message.includes('shell') || d.message.includes('check_output'));
    assert.ok(!bareDiag, `bare check_output imported from subprocess should NOT produce error, got: ${bareDiag?.message}`);

    // 4. Legitimate call on module buildcommands.check_output should match
    const validModuleCallerText = `
import buildcommands

def test_bc():
    ret = buildcommands.check_output('git status')
    bad = buildcommands.check_output('git status', unknown_kw=True)
`;
    const modDoc = new (vscode as any).MockTextDocument(validModuleCallerText, '/workspace/test_bc.py', 'python');
    const modDiagnostics = inspector.inspectDocument(modDoc);
    assert.equal(modDiagnostics.length, 1, 'Should only flag bad call with unknown_kw, valid call should have 0 diagnostics');
    assert.ok(modDiagnostics[0].message.includes("未知关键字参数 'unknown_kw'"));
  });

  await t.test('Unrelated Receiver Isolation: call on unknown receiver object should NEVER match unrelated class', async () => {
    const serviceDef = `
class UnrelatedWorker:
    def execute_task(self, task_name):
        pass
`;
    indexer.indexFile((vscode as any).Uri.file('/workspace/service.py'), serviceDef);

    const callerText = `
def handle(custom_client):
    # custom_client has no relation to UnrelatedWorker
    custom_client.execute_task('test', timeout=30, force=True)
`;
    const doc = new (vscode as any).MockTextDocument(callerText, '/workspace/handler.py', 'python');
    const diagnostics = inspector.inspectDocument(doc);
    const diag = diagnostics.find((d) => d.message.includes('execute_task'));
    assert.ok(!diag, `Unknown receiver custom_client should NOT be matched to UnrelatedWorker, got: ${diag?.message}`);
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
