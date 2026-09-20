import * as assert from 'assert';
import { test, describe } from 'node:test';
import { InheritanceAnalyzer } from '../src/indexer/inheritanceAnalyzer';
import { MockTextDocument } from './vscode-mock';

describe('Inheritance Analyzer Python Tests', () => {
  const pythonCode = `
class Animal:
    def speak(self):
        return "..."

    def sleep(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof!"

    def fetch(self):
        return "Ball"

class Puppy(Dog):
    def speak(self):
        return "Yip!"

class Cat(Animal):
    def speak(self):
        return "Meow!"
`;

  test('detects all class hierarchy and method overriding correctly', async () => {
    const analyzer = new InheritanceAnalyzer();
    const doc = new MockTextDocument(pythonCode, 'file:///sample.py', 'python');

    const markers = await analyzer.analyzeDocument(doc as any);

    // Map markers by symbolName
    const markerMap = new Map<string, any>();
    for (const m of markers) {
      markerMap.set(m.symbolName, m);
    }

    // 1. Animal class: should have sub marker (children: Dog, Puppy, Cat)
    const animalClass = markerMap.get('Animal');
    assert.ok(animalClass, 'Animal class marker should exist');
    assert.strictEqual(animalClass.markerKind, 'sub', 'Animal class marker should be sub');
    const animalChildNames = animalClass.children.map((c: any) => c.name);
    assert.ok(animalChildNames.includes('Dog'), 'Animal should have Dog child');
    assert.ok(animalChildNames.includes('Cat'), 'Animal should have Cat child');
    assert.ok(animalChildNames.includes('Puppy'), 'Animal should have Puppy child');

    // 2. Animal.speak: should have sub marker (children: Dog.speak, Puppy.speak, Cat.speak)
    const animalSpeak = markerMap.get('Animal.speak');
    assert.ok(animalSpeak, 'Animal.speak marker should exist');
    assert.strictEqual(animalSpeak.markerKind, 'sub', 'Animal.speak marker should be sub');
    const speakChildren = animalSpeak.children.map((c: any) => c.name);
    assert.ok(speakChildren.includes('Dog.speak'), 'Animal.speak should be overridden in Dog');
    assert.ok(speakChildren.includes('Puppy.speak'), 'Animal.speak should be overridden in Puppy');
    assert.ok(speakChildren.includes('Cat.speak'), 'Animal.speak should be overridden in Cat');

    // 3. Dog class: should have both marker (parent: Animal, child: Puppy)
    const dogClass = markerMap.get('Dog');
    assert.ok(dogClass, 'Dog class marker should exist');
    assert.strictEqual(dogClass.markerKind, 'both', 'Dog class marker should be both');
    assert.ok(dogClass.parents.some((p: any) => p.name === 'Animal'));
    assert.ok(dogClass.children.some((c: any) => c.name === 'Puppy'));

    // 4. Dog.speak: should have both marker (parent: Animal.speak, child: Puppy.speak)
    const dogSpeak = markerMap.get('Dog.speak');
    assert.ok(dogSpeak, 'Dog.speak marker should exist');
    assert.strictEqual(dogSpeak.markerKind, 'both', 'Dog.speak marker should be both');
    assert.ok(dogSpeak.parents.some((p: any) => p.name === 'Animal.speak'));
    assert.ok(dogSpeak.children.some((c: any) => c.name === 'Puppy.speak'));

    // 5. Puppy class: should have super marker (parent: Dog)
    const puppyClass = markerMap.get('Puppy');
    assert.ok(puppyClass, 'Puppy class marker should exist');
    assert.strictEqual(puppyClass.markerKind, 'super', 'Puppy class marker should be super');
    assert.ok(puppyClass.parents.some((p: any) => p.name === 'Dog'));

    // 6. Puppy.speak: should have super marker (parent: Dog.speak)
    const puppySpeak = markerMap.get('Puppy.speak');
    assert.ok(puppySpeak, 'Puppy.speak marker should exist');
    assert.strictEqual(puppySpeak.markerKind, 'super', 'Puppy.speak marker should be super');
    assert.ok(puppySpeak.parents.some((p: any) => p.name === 'Dog.speak'));

    // 7. Cat class: should have super marker (parent: Animal)
    const catClass = markerMap.get('Cat');
    assert.ok(catClass, 'Cat class marker should exist');
    assert.strictEqual(catClass.markerKind, 'super', 'Cat class marker should be super');

    // 8. Cat.speak: should have super marker (parent: Animal.speak)
    const catSpeak = markerMap.get('Cat.speak');
    assert.ok(catSpeak, 'Cat.speak marker should exist');
    assert.strictEqual(catSpeak.markerKind, 'super', 'Cat.speak marker should be super');
    assert.ok(catSpeak.parents.some((p: any) => p.name === 'Animal.speak'));
  });

  test('extracts Python imports and aliases correctly', () => {
    const analyzer = new InheritanceAnalyzer();
    const code = `
from extras.box_wrapper import BoxError as BoxErrorBase, BoxState as BoxStateBase
from util import partial, key_exists
import extras.box_wrapper as box_wrapper
import logging
`;
    const doc = new MockTextDocument(code, 'file:///test.py', 'python');
    const imports = analyzer.extractPythonImports(doc as any);

    assert.strictEqual(imports.size, 6);
    assert.ok(imports.has('BoxErrorBase'));
    assert.strictEqual(imports.get('BoxErrorBase')?.moduleName, 'extras.box_wrapper');
    assert.strictEqual(imports.get('BoxErrorBase')?.originalName, 'BoxError');

    assert.ok(imports.has('BoxStateBase'));
    assert.strictEqual(imports.get('BoxStateBase')?.moduleName, 'extras.box_wrapper');
    assert.strictEqual(imports.get('BoxStateBase')?.originalName, 'BoxState');

    assert.ok(imports.has('partial'));
    assert.strictEqual(imports.get('partial')?.moduleName, 'util');

    assert.ok(imports.has('box_wrapper'));
    assert.strictEqual(imports.get('box_wrapper')?.moduleName, 'extras.box_wrapper');
  });

  test('resolves cross-file Python inheritance and method overrides correctly', async () => {
    const analyzer = new InheritanceAnalyzer();
    const baseCode = `
class BoxState:
    def __init__(self):
        pass

    def generate_Tnn_content(self):
        return "base_tnn"

    def base_only_method(self):
        pass
`;
    const nanoCode = `
from extras.box_wrapper import BoxState as BoxStateBase

class BoxState(BoxStateBase):
    def __init__(self):
        pass

    def generate_Tnn_content(self):
        return "nano_tnn"
`;

    const baseDoc = new MockTextDocument(baseCode, 'file:///extras/box_wrapper.py', 'python');
    const nanoDoc = new MockTextDocument(nanoCode, 'file:///extras/box_nano_wrapper.py', 'python');

    // Add to workspace mock textDocuments
    const { workspace } = await import('./vscode-mock');
    workspace.textDocuments.push(baseDoc as any, nanoDoc as any);

    const markers = await analyzer.analyzeDocument(nanoDoc as any);

    const markerMap = new Map<string, any>();
    for (const m of markers) {
      markerMap.set(m.symbolName, m);
    }

    // 1. BoxState in nanoDoc: should have super marker pointing to BoxState in box_wrapper.py
    const boxState = markerMap.get('BoxState');
    assert.ok(boxState, 'BoxState class marker should exist in nanoDoc');
    assert.strictEqual(boxState.markerKind, 'super', 'BoxState should have super marker');
    assert.strictEqual(boxState.parents.length, 1);
    assert.strictEqual(boxState.parents[0].name, 'BoxState');

    // 2. generate_Tnn_content in nanoDoc: should have super marker pointing to BoxState.generate_Tnn_content
    const tnnMethod = markerMap.get('BoxState.generate_Tnn_content');
    assert.ok(tnnMethod, 'BoxState.generate_Tnn_content marker should exist');
    assert.strictEqual(tnnMethod.markerKind, 'super', 'generate_Tnn_content should have super marker');
    assert.strictEqual(tnnMethod.parents.length, 1);
    assert.strictEqual(tnnMethod.parents[0].name, 'BoxState.generate_Tnn_content');

    // 3. __init__ in nanoDoc: should also have super marker
    const initMethod = markerMap.get('BoxState.__init__');
    assert.ok(initMethod, 'BoxState.__init__ marker should exist');
    assert.strictEqual(initMethod.markerKind, 'super', 'init should have super marker');

    // 4. Now analyze baseDoc (box_wrapper.py)
    const baseMarkers = await analyzer.analyzeDocument(baseDoc as any);
    const baseMarkerMap = new Map<string, any>();
    for (const m of baseMarkers) {
      baseMarkerMap.set(m.symbolName, m);
    }

    // BoxState in baseDoc: should have sub marker pointing to BoxState in box_nano_wrapper.py
    const baseBoxState = baseMarkerMap.get('BoxState');
    assert.ok(baseBoxState, 'BoxState in baseDoc should have marker');
    assert.strictEqual(baseBoxState.markerKind, 'sub', 'BoxState in baseDoc should have sub marker');
    assert.ok(baseBoxState.children.some((c: any) => c.name === 'BoxState'));

    // generate_Tnn_content in baseDoc: should have sub marker
    const baseTnnMethod = baseMarkerMap.get('BoxState.generate_Tnn_content');
    assert.ok(baseTnnMethod, 'generate_Tnn_content in baseDoc should have marker');
    assert.strictEqual(baseTnnMethod.markerKind, 'sub', 'generate_Tnn_content in baseDoc should have sub marker');
    assert.ok(baseTnnMethod.children.some((c: any) => c.name === 'BoxState.generate_Tnn_content'));
  });

  test('BoxAction and BoxActionBase with get_flush_velocity: base analyzed FIRST discovers all overrides in subclasses', async () => {
    const analyzer = new InheritanceAnalyzer();

    const boxWrapperCode = `
class BoxAction:
    def __init__(self, config, box_state):
        pass

    def get_flush_velocity(self, last_tnn, current_tnn):
        return 100
`;

    const boxLite2Code = `
from extras.box_wrapper import BoxAction as BoxActionBase

class BoxAction(BoxActionBase):
    def __init__(self, config, box_state):
        super().__init__(config, box_state)

    def get_flush_velocity(self, last_tnn, current_tnn):
        return 200
`;

    const boxNanoCode = `
from extras.box_wrapper import BoxAction as BoxActionBase

class BoxAction(BoxActionBase):
    def __init__(self, config, box_state):
        super().__init__(config, box_state)

    def get_flush_velocity(self, last_tnn, current_tnn):
        return 300
`;

    const baseDoc = new MockTextDocument(boxWrapperCode, 'file:///klippy/extras/box_wrapper.py', 'python');
    const lite2Doc = new MockTextDocument(boxLite2Code, 'file:///klippy/extras/box_lite2_wrapper.py', 'python');
    const nanoDoc = new MockTextDocument(boxNanoCode, 'file:///klippy/extras/box_nano_wrapper.py', 'python');

    const { workspace } = await import('./vscode-mock');
    workspace.textDocuments = [baseDoc as any, lite2Doc as any, nanoDoc as any];

    // 1. Analyze baseDoc (box_wrapper.py) FIRST!
    const baseMarkers = await analyzer.analyzeDocument(baseDoc as any);
    const baseMarkerMap = new Map<string, any>();
    for (const m of baseMarkers) {
      baseMarkerMap.set(m.symbolName, m);
    }

    // BoxAction class in baseDoc must have sub marker with 2 children
    const boxActionCls = baseMarkerMap.get('BoxAction');
    assert.ok(boxActionCls, 'BoxAction marker must exist in baseDoc');
    assert.strictEqual(boxActionCls.markerKind, 'sub', 'BoxAction should have sub marker');
    assert.strictEqual(boxActionCls.children.length, 2, 'BoxAction should have 2 subclasses');

    // BoxAction.get_flush_velocity must have sub marker with 2 child overrides
    const flushMethod = baseMarkerMap.get('BoxAction.get_flush_velocity');
    assert.ok(flushMethod, 'get_flush_velocity marker must exist in baseDoc');
    assert.strictEqual(flushMethod.markerKind, 'sub', 'get_flush_velocity should have sub marker (down arrow)');
    assert.strictEqual(flushMethod.children.length, 2, 'get_flush_velocity should have 2 overriding methods');
    assert.ok(flushMethod.children.some((c: any) => c.uri.includes('box_lite2_wrapper.py')));
    assert.ok(flushMethod.children.some((c: any) => c.uri.includes('box_nano_wrapper.py')));

    // 2. Now analyze lite2Doc (box_lite2_wrapper.py)
    const lite2Markers = await analyzer.analyzeDocument(lite2Doc as any);
    const lite2MarkerMap = new Map<string, any>();
    for (const m of lite2Markers) {
      lite2MarkerMap.set(m.symbolName, m);
    }

    // BoxAction.get_flush_velocity in lite2Doc must have super marker pointing to baseDoc
    const lite2Flush = lite2MarkerMap.get('BoxAction.get_flush_velocity');
    assert.ok(lite2Flush, 'get_flush_velocity in lite2Doc must have marker');
    assert.strictEqual(lite2Flush.markerKind, 'super', 'lite2 get_flush_velocity should have super marker (up arrow)');
    assert.strictEqual(lite2Flush.parents.length, 1);
    assert.ok(lite2Flush.parents[0].uri.includes('box_wrapper.py'));

    // 3. Now analyze nanoDoc (box_nano_wrapper.py)
    const nanoMarkers = await analyzer.analyzeDocument(nanoDoc as any);
    const nanoMarkerMap = new Map<string, any>();
    for (const m of nanoMarkers) {
      nanoMarkerMap.set(m.symbolName, m);
    }

    // BoxAction.get_flush_velocity in nanoDoc must have super marker pointing to baseDoc
    const nanoFlush = nanoMarkerMap.get('BoxAction.get_flush_velocity');
    assert.ok(nanoFlush, 'get_flush_velocity in nanoDoc must have marker');
    assert.strictEqual(nanoFlush.markerKind, 'super', 'nano get_flush_velocity should have super marker (up arrow)');
    assert.strictEqual(nanoFlush.parents.length, 1);
    assert.ok(nanoFlush.parents[0].uri.includes('box_wrapper.py'));
  });

  test('real Klipper extras files: BoxAction.get_flush_velocity resolves overrides and super methods correctly', async () => {
    const fs = await import('fs');
    const boxWrapperPath = '/home/zxf/cxsw/code/gerrit/8.4/kl_klipper_440x/klippy/extras/box_wrapper.py';
    const boxLite2Path = '/home/zxf/cxsw/code/gerrit/8.4/kl_klipper_440x/klippy/extras/box_lite2_wrapper.py';
    const boxNanoPath = '/home/zxf/cxsw/code/gerrit/8.4/kl_klipper_440x/klippy/extras/box_nano_wrapper.py';

    if (!fs.existsSync(boxWrapperPath)) {
      return;
    }

    const analyzer = new InheritanceAnalyzer();
    const baseDoc = new MockTextDocument(fs.readFileSync(boxWrapperPath, 'utf8'), `file://${boxWrapperPath}`, 'python');
    const lite2Doc = new MockTextDocument(fs.readFileSync(boxLite2Path, 'utf8'), `file://${boxLite2Path}`, 'python');
    const nanoDoc = new MockTextDocument(fs.readFileSync(boxNanoPath, 'utf8'), `file://${boxNanoPath}`, 'python');

    const { workspace } = await import('./vscode-mock');
    workspace.textDocuments = [baseDoc as any, lite2Doc as any, nanoDoc as any];

    const baseMarkers = await analyzer.analyzeDocument(baseDoc as any);

    // BoxAction class marker in real box_wrapper.py
    const boxActionMarker = baseMarkers.find((m) => m.symbolName === 'BoxAction');
    assert.ok(boxActionMarker, 'BoxAction class marker must exist in real box_wrapper.py');
    assert.strictEqual(boxActionMarker.markerKind, 'sub');
    assert.strictEqual(boxActionMarker.children.length, 2, 'BoxAction has 2 subclasses (lite2 and nano)');
    assert.ok(boxActionMarker.children.some((c) => c.uri.includes('box_lite2_wrapper.py')));
    assert.ok(boxActionMarker.children.some((c) => c.uri.includes('box_nano_wrapper.py')));

    // BoxAction.get_flush_velocity marker in real box_wrapper.py
    const flushMarker = baseMarkers.find((m) => m.symbolName === 'BoxAction.get_flush_velocity');
    assert.ok(flushMarker, 'get_flush_velocity marker must exist in real box_wrapper.py');
    assert.strictEqual(flushMarker.markerKind, 'sub', 'markerKind must be sub (down arrow)');
    assert.strictEqual(flushMarker.children.length, 1, 'Only box_lite2_wrapper.py overrides get_flush_velocity');
    assert.ok(flushMarker.children[0].uri.includes('box_lite2_wrapper.py'));

    const lite2Markers = await analyzer.analyzeDocument(lite2Doc as any);
    const lite2Flush = lite2Markers.find((m) => m.symbolName === 'BoxAction.get_flush_velocity');
    assert.ok(lite2Flush, 'get_flush_velocity marker must exist in real box_lite2_wrapper.py');
    assert.strictEqual(lite2Flush.markerKind, 'super', 'markerKind must be super (up arrow)');
    assert.ok(lite2Flush.parents.some((p) => p.uri.includes('box_wrapper.py')));

    // Now analyze nanoDoc
    const nanoMarkers1 = await analyzer.analyzeDocument(nanoDoc as any);
    assert.ok(nanoMarkers1.length > 0, 'nanoMarkers1 should have markers');

    // Switch back to baseDoc
    const baseMarkers2 = await analyzer.analyzeDocument(baseDoc as any);
    assert.ok(baseMarkers2.length > 0, 'baseMarkers2 should have markers');
    const boxActionMarkers = baseMarkers2.filter((m) => m.symbolName === 'BoxAction');
    assert.strictEqual(boxActionMarkers.length, 1, 'BoxAction marker must appear exactly once, not duplicated');

    // Switch back to nanoDoc
    const nanoMarkers2 = await analyzer.analyzeDocument(nanoDoc as any);
    assert.ok(nanoMarkers2.length > 0, 'nanoMarkers2 should have markers');
  });

  test('silent document loader reads from disk without calling workspace.openTextDocument', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { workspace } = await import('./vscode-mock');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitree-test-'));
    const parentFile = path.join(tmpDir, 'parent_mod.py');
    const childFile = path.join(tmpDir, 'child_mod.py');

    fs.writeFileSync(
      parentFile,
      `class SilentParent:\n    def execute(self):\n        pass\n`
    );
    fs.writeFileSync(
      childFile,
      `from parent_mod import SilentParent\n\nclass SilentChild(SilentParent):\n    def execute(self):\n        print("child")\n`
    );

    let openTextDocumentCallCount = 0;
    const originalOpen = workspace.openTextDocument;
    workspace.openTextDocument = async (uri: any) => {
      openTextDocumentCallCount++;
      return originalOpen(uri);
    };

    try {
      const analyzer = new InheritanceAnalyzer();
      const parentDoc = new MockTextDocument(fs.readFileSync(parentFile, 'utf8'), `file://${parentFile}`, 'python');

      // Only parentDoc is in workspace.textDocuments; childFile is only on disk!
      workspace.textDocuments = [parentDoc as any];

      const markers = await analyzer.analyzeDocument(parentDoc as any);

      // Verify that workspace.openTextDocument was NOT called for childFile!
      assert.strictEqual(
        openTextDocumentCallCount,
        0,
        'openTextDocument must NOT be called for background candidate files on disk!'
      );

      // Verify marker was found correctly via silent file loading
      const parentMarker = markers.find((m) => m.symbolName === 'SilentParent');
      assert.ok(parentMarker, 'SilentParent marker should be found');
      assert.strictEqual(parentMarker.markerKind, 'sub', 'SilentParent should have sub marker');
      assert.ok(parentMarker.children.some((c) => c.name === 'SilentChild'));

      const execMarker = markers.find((m) => m.symbolName === 'SilentParent.execute');
      assert.ok(execMarker, 'SilentParent.execute marker should be found');
      assert.strictEqual(execMarker.markerKind, 'sub', 'execute should have sub marker');
    } finally {
      workspace.openTextDocument = originalOpen;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('progressive onProgress emits Phase 1 superclasses and in-doc hierarchy immediately', async () => {
    const analyzer = new InheritanceAnalyzer();
    const code = `
class BaseService:
    def start(self):
        pass

class MyService(BaseService):
    def start(self):
        print("running")
`;
    const doc = new MockTextDocument(code, 'file:///service.py', 'python');

    let progressCalled = false;
    let progressMarkerCount = 0;
    const finalMarkers = await analyzer.analyzeDocument(doc as any, undefined, (intermediate) => {
      progressCalled = true;
      progressMarkerCount = intermediate.length;
    });

    assert.ok(progressCalled, 'onProgress callback must be called during Phase 1');
    assert.ok(progressMarkerCount > 0, 'onProgress must emit Phase 1 markers');
    assert.strictEqual(finalMarkers.length, progressMarkerCount);
  });
});

