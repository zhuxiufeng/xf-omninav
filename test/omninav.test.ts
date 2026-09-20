import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { SymbolParser } from '../src/indexer/symbolParser';
import { SymbolIndexer } from '../src/indexer/symbolIndexer';
import { ContextResolver } from '../src/resolver/contextResolver';
import { SmoothDefinitionProvider } from '../src/navigation/definitionProvider';
import { MockTextDocument, Uri, Position, workspace } from './vscode-mock';

describe('SymbolParser tests', () => {
  it('should parse Python classes, methods, and functions accurately', () => {
    const code = `
class UserService(BaseService):
    """Handles user operations."""
    DEFAULT_TIMEOUT = 30

    def __init__(self, db_client):
        self.db = db_client

    def get_user_by_id(self, user_id: int) -> dict:
        """Fetch user record."""
        return self.db.find(user_id)

    @property
    def is_healthy(self):
        return True

def create_user_service():
    return UserService()
`;

    const doc = new MockTextDocument(code, 'file:///app/user.py', 'python');
    const defs = SymbolParser.parsePython(code, doc.uri as any, 'app/user.py');

    // 1. Class
    const classDef = defs.find((d) => d.name === 'UserService');
    assert.ok(classDef, 'Should find UserService class');
    assert.strictEqual(classDef.kind, 'class');
    assert.strictEqual(classDef.docstring, 'Handles user operations.');

    // 2. Methods
    const getMethod = defs.find((d) => d.name === 'get_user_by_id');
    assert.ok(getMethod, 'Should find get_user_by_id method');
    assert.strictEqual(getMethod.kind, 'method');
    assert.strictEqual(getMethod.containerName, 'UserService');
    assert.strictEqual(getMethod.docstring, 'Fetch user record.');

    // 3. Property
    const propDef = defs.find((d) => d.name === 'is_healthy');
    assert.ok(propDef, 'Should find is_healthy property');
    assert.strictEqual(propDef.kind, 'property');
    assert.strictEqual(propDef.containerName, 'UserService');

    // 4. Instance attribute (self.db = db_client)
    const dbAttr = defs.find((d) => d.name === 'db');
    assert.ok(dbAttr, 'Should find instance attribute db');
    assert.strictEqual(dbAttr.containerName, 'UserService');

    // 5. Constant
    const constDef = defs.find((d) => d.name === 'DEFAULT_TIMEOUT');
    assert.ok(constDef, 'Should find DEFAULT_TIMEOUT constant');
    assert.strictEqual(constDef.kind, 'constant');
    assert.strictEqual(constDef.containerName, 'UserService');

    // 6. Standalone function
    const funcDef = defs.find((d) => d.name === 'create_user_service');
    assert.ok(funcDef, 'Should find create_user_service function');
    assert.strictEqual(funcDef.kind, 'function');
    assert.strictEqual(funcDef.containerName, undefined);
  });

  it('should parse real-world Klipper BoxSave self.box_filament_err attribute', () => {
    const klipperCode = `
class BoxSave():
    def __init__(self, config):
        self.last_cmd = None
        self.box_filament_err = False
        self.resume_tnn = None

class BoxWrapper():
    def __init__(self, config):
        self.box_save = BoxSave(config)

    def check(self):
        if self.box_save.box_filament_err:
            pass
`;

    const doc = new MockTextDocument(klipperCode, 'file:///klippy/extras/box_wrapper.py', 'python');
    const defs = SymbolParser.parsePython(klipperCode, doc.uri as any, 'klippy/extras/box_wrapper.py');

    const filamentErr = defs.find((d) => d.name === 'box_filament_err');
    assert.ok(filamentErr, 'Must find box_filament_err attribute');
    assert.strictEqual(filamentErr.containerName, 'BoxSave');
    assert.strictEqual(filamentErr.range.start.line, 4);

    const boxSaveAttr = defs.find((d) => d.name === 'box_save');
    assert.ok(boxSaveAttr, 'Must find box_save attribute in BoxWrapper');
    assert.strictEqual(boxSaveAttr.containerName, 'BoxWrapper');
  });

  it('should parse TypeScript/JavaScript classes, functions, and arrow functions', () => {
    const tsCode = `
export class OrderManager {
  executeOrder(id: string) {
    return true;
  }
}

export const processPayment = async (amount: number) => {
  return amount;
};

function calculateTax(subtotal: number) {
  return subtotal * 0.1;
}
`;

    const doc = new MockTextDocument(tsCode, 'file:///src/order.ts', 'typescript');
    const defs = SymbolParser.parseJavaScriptOrTypeScript(tsCode, doc.uri as any, 'src/order.ts');

    assert.ok(defs.some((d) => d.name === 'OrderManager' && d.kind === 'class'));
    assert.ok(defs.some((d) => d.name === 'executeOrder' && d.kind === 'method' && d.containerName === 'OrderManager'));
    assert.ok(defs.some((d) => d.name === 'processPayment' && d.kind === 'function'));
    assert.ok(defs.some((d) => d.name === 'calculateTax' && d.kind === 'function'));
  });
});

describe('SymbolIndexer tests', () => {
  it('should index and query symbols by exact, fuzzy, and container name', () => {
    const indexer = new SymbolIndexer();

    const pyCode = `
class Order:
    def save(self):
        pass

class User:
    def save(self):
        pass

def save():
    pass
`;
    const doc = new MockTextDocument(pyCode, 'file:///app/models.py', 'python');
    indexer.indexDocument(doc as any);

    // Exact search
    const allSaves = indexer.findExact('save');
    assert.strictEqual(allSaves.length, 3, 'Should find 3 save definitions');

    // Container search
    const orderSaves = indexer.findByContainer('Order', 'save');
    assert.strictEqual(orderSaves.length, 1, 'Should find exactly 1 Order.save');
    assert.strictEqual(orderSaves[0].containerName, 'Order');

    const userSaves = indexer.findByContainer('User', 'save');
    assert.strictEqual(userSaves.length, 1, 'Should find exactly 1 User.save');
    assert.strictEqual(userSaves[0].containerName, 'User');

    // Case-insensitive search
    const fuzzy = indexer.findFuzzy('SAVE');
    assert.strictEqual(fuzzy.length, 3, 'Fuzzy search should find all 3');

    // Removal
    indexer.removeFileSymbols(doc.uri.toString());
    assert.strictEqual(indexer.findExact('save').length, 0, 'Symbols should be removed');
  });
});

describe('UsageResolver tests', () => {
  it('should detect definition line and find callers/usages correctly', async () => {
    const { UsageResolver } = await import('../src/resolver/usageResolver');

    const code = `
class BoxAction:
    def get_flush_velocity(self, last_tnn, current_tnn):
        return 100, 1

    def run(self):
        v, p = self.get_flush_velocity(1, 2)
        v2, p2 = self.get_flush_velocity(3, 4)
`;

    const doc = new MockTextDocument(code, 'file:///app/box.py', 'python');

    // 1. Definition check at line 2: def get_flush_velocity
    const atDef = UsageResolver.isAtDefinition(doc as any, new (await import('./vscode-mock')).Position(2, 8), 'get_flush_velocity');
    assert.strictEqual(atDef, true, 'Must detect cursor is at definition line');

    // 2. Call site check at line 6: self.get_flush_velocity(1, 2)
    const atCall = UsageResolver.isAtDefinition(doc as any, new (await import('./vscode-mock')).Position(6, 20), 'get_flush_velocity');
    assert.strictEqual(atCall, false, 'Must detect cursor is NOT at definition line');

    // 3. Find usages when at definition
    const usages = await UsageResolver.findUsages(doc as any, new (await import('./vscode-mock')).Position(2, 8), 'get_flush_velocity');
    assert.strictEqual(usages.length, 2, 'Must find both callers on lines 6 and 7');
    assert.strictEqual(usages[0].range.start.line, 6);
    assert.strictEqual(usages[1].range.start.line, 7);
  });

  it('should scan text directly with scanTextForCalls without openTextDocument', async () => {
    const { UsageResolver } = await import('../src/resolver/usageResolver');
    const { Uri } = await import('./vscode-mock');

    const content = `
    const x = calculateTotal(10, 20);
    console.log("total:", calculateTotal(5, 5));
    `;

    const uri = Uri.file('/src/main.ts');
    const calls = UsageResolver.scanTextForCalls(uri as any, content, 'calculateTotal');
    assert.strictEqual(calls.length, 2, 'Should find 2 call sites in text');
    assert.strictEqual(calls[0].range.start.line, 1);
    assert.strictEqual(calls[1].range.start.line, 2);
  });
});

describe('Optimization & Raw I/O tests', () => {
  it('should parseText with auto-detected language from extension', () => {
    const pyCode = `
class Service:
    def execute(self):
        pass
`;
    const uri = Uri.file('/project/svc.py');
    const defs = SymbolParser.parseText(pyCode, uri as any);
    assert.strictEqual(defs.length, 2);
    assert.strictEqual(defs[0].name, 'Service');
    assert.strictEqual(defs[1].name, 'execute');

    const tsCode = `
export class Svc {
    run() {}
}
`;
    const tsUri = Uri.file('/project/svc.ts');
    const tsDefs = SymbolParser.parseText(tsCode, tsUri as any);
    assert.strictEqual(tsDefs.length, 2);
    assert.strictEqual(tsDefs[0].name, 'Svc');
  });

  it('should indexFile from raw string without creating vscode.TextDocument', () => {
    const indexer = new SymbolIndexer();
    const uri = Uri.file('/src/core.py');
    const pyCode = `
class Engine:
    def start(self):
        pass
`;
    indexer.indexFile(uri as any, pyCode);
    const results = indexer.findExact('start');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].containerName, 'Engine');
  });
});

describe('Subclass Overrides & Precision Jump tests', () => {
  it('should track class hierarchy and find subclass overrides', () => {
    const code = `
class Animal:
    def speak(self) -> str:
        return "..."
    def sleep(self) -> None:
        pass

class Dog(Animal):
    def speak(self) -> str:
        return "Woof!"
    def fetch(self) -> str:
        return "Ball"

class Puppy(Dog):
    def speak(self) -> str:
        return "Yip!"

class Cat(Animal):
    def speak(self) -> str:
        return "Meow!"
`;
    const doc = new MockTextDocument(code, 'file:///app/animals.py', 'python');
    const indexer = new SymbolIndexer();
    indexer.indexDocument(doc as any);

    // Hierarchy
    const dogAncestors = indexer.getSuperClasses('Dog');
    assert.deepStrictEqual(dogAncestors, ['Animal']);

    const puppyAncestors = indexer.getSuperClasses('Puppy');
    assert.deepStrictEqual(puppyAncestors, ['Dog', 'Animal']);

    const animalChildren = indexer.getSubClasses('Animal');
    assert.ok(animalChildren.includes('Dog'));
    assert.ok(animalChildren.includes('Puppy'));
    assert.ok(animalChildren.includes('Cat'));

    // Subclass overrides
    const speakOverrides = indexer.findSubclassOverrides('Animal', 'speak');
    assert.strictEqual(speakOverrides.length, 3);
    const containers = speakOverrides.map((d) => d.containerName);
    assert.ok(containers.includes('Dog'));
    assert.ok(containers.includes('Puppy'));
    assert.ok(containers.includes('Cat'));

    // Hierarchy resolution
    const dogSpeak = indexer.findInHierarchy('Dog', 'speak');
    assert.strictEqual(dogSpeak?.containerName, 'Dog'); // Subclass override

    const dogSleep = indexer.findInHierarchy('Dog', 'sleep');
    assert.strictEqual(dogSleep?.containerName, 'Animal'); // Inherited from parent

    const puppySleep = indexer.findInHierarchy('Puppy', 'sleep');
    assert.strictEqual(puppySleep?.containerName, 'Animal'); // Inherited from ancestor
  });

  it('should infer receiver and resolve enclosing class via ContextResolver', () => {
    const code = `
class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof!"
    def test(self):
        self.speak()
        super().speak()

def run():
    d = Dog()
    d.speak()
`;
    const doc = new MockTextDocument(code, 'file:///app/animals.py', 'python');

    // 1. Line 9: self.speak() -> col 13
    const posSelf = new Position(9, 13);
    const wordRangeSelf = doc.getWordRangeAtPosition(posSelf)!;
    const recSelf = ContextResolver.inferReceiverFromPrefix(doc as any, posSelf as any, wordRangeSelf as any);
    assert.strictEqual(recSelf.isSelf, true);
    assert.strictEqual(recSelf.containerName, 'Dog');
    assert.strictEqual(recSelf.enclosingClass?.name, 'Dog');

    // 2. Line 10: super().speak() -> col 16
    const posSuper = new Position(10, 16);
    const wordRangeSuper = doc.getWordRangeAtPosition(posSuper)!;
    const recSuper = ContextResolver.inferReceiverFromPrefix(doc as any, posSuper as any, wordRangeSuper as any);
    assert.strictEqual(recSuper.isSuper, true);
    assert.strictEqual(recSuper.containerName, 'Animal');

    // 3. Line 14: d.speak() -> col 6
    const posVar = new Position(14, 6);
    const wordRangeVar = doc.getWordRangeAtPosition(posVar)!;
    const recVar = ContextResolver.inferReceiverFromPrefix(doc as any, posVar as any, wordRangeVar as any);
    assert.strictEqual(recVar.isSelf, false);
    assert.strictEqual(recVar.containerName, 'Dog');
  });

  it('should jump directly to subclass overridden method in SmoothDefinitionProvider', async () => {
    const code = `
class Animal:
    def speak(self):
        pass
    def sleep(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof!"
    def greet(self):
        self.speak()
        self.sleep()
        super().speak()
`;
    const doc = new MockTextDocument(code, 'file:///app/animals.py', 'python');
    const indexer = new SymbolIndexer();
    indexer.indexDocument(doc as any);

    const { SmoothDefinitionProvider } = await import('../src/navigation/definitionProvider');
    const provider = new SmoothDefinitionProvider(indexer);

    // 1. self.speak() in Dog (line 11) -> must jump directly to Dog.speak (line 8)
    const posSelfSpeak = new Position(11, 13);
    const resultSelfSpeak = (await provider.provideDefinition(
      doc as any,
      posSelfSpeak as any,
      {} as any
    )) as any[];

    assert.ok(resultSelfSpeak, 'Must find definition for self.speak()');
    assert.strictEqual(resultSelfSpeak.length, 1, 'Must return exactly 1 definition to ensure direct jump');
    // Dog.speak is defined at line 8
    assert.strictEqual(resultSelfSpeak[0].targetRange.start.line, 8, 'Must point directly to Dog.speak at line 8');

    // 2. self.sleep() in Dog (line 12) -> must jump to Animal.sleep (line 4)
    const posSelfSleep = new Position(12, 13);
    const resultSelfSleep = (await provider.provideDefinition(
      doc as any,
      posSelfSleep as any,
      {} as any
    )) as any[];
    assert.ok(resultSelfSleep, 'Must find definition for self.sleep()');
    assert.strictEqual(resultSelfSleep.length, 1);
    assert.strictEqual(resultSelfSleep[0].targetRange.start.line, 4, 'Must point to Animal.sleep at line 4');

    // 3. super().speak() in Dog (line 13) -> must jump to Animal.speak (line 2)
    const posSuperSpeak = new Position(13, 16);
    const resultSuperSpeak = (await provider.provideDefinition(
      doc as any,
      posSuperSpeak as any,
      {} as any
    )) as any[];
    assert.ok(resultSuperSpeak, 'Must find definition for super().speak()');
    assert.strictEqual(resultSuperSpeak.length, 1);
    assert.strictEqual(resultSuperSpeak[0].targetRange.start.line, 2, 'Must point to Animal.speak at line 2');
  });

  it('should jump directly to subclass overridden method via NavigateCommand', async () => {
    const code = `
class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof!"
    def greet(self):
        self.speak()

def run():
    d = Dog()
    d.speak()
`;
    const doc = new MockTextDocument(code, 'file:///app/animals.py', 'python');
    const indexer = new SymbolIndexer();
    indexer.indexDocument(doc as any);

    const { window, Selection, workspace } = await import('./vscode-mock');
    const { NavigateCommand } = await import('../src/navigation/navigateCommand');

    workspace.textDocuments = [doc as any];

    let jumpedLine = -1;
    window.showTextDocument = async (targetDoc: any) => {
      const mockEditor = {
        document: targetDoc,
        selection: new Selection(new Position(0, 0), new Position(0, 0)),
        revealRange: (_range: any) => {},
      };
      Object.defineProperty(mockEditor, 'selection', {
        set(sel: any) {
          jumpedLine = sel.active.line;
        },
      });
      return mockEditor as any;
    };

    const cmd = new NavigateCommand(indexer);

    // 1. Cursor on self.speak() at line 9, col 13
    const posSelfSpeak = new Position(9, 13);
    window.activeTextEditor = {
      document: doc,
      selection: new Selection(posSelfSpeak, posSelfSpeak),
    } as any;

    await cmd.execute();
    assert.strictEqual(jumpedLine, 6, 'NavigateCommand must jump directly to Dog.speak at line 6');

    // 2. Cursor on d.speak() at line 13, col 6
    const posVarSpeak = new Position(13, 6);
    window.activeTextEditor = {
      document: doc,
      selection: new Selection(posVarSpeak, posVarSpeak),
    } as any;

    await cmd.execute();
    assert.strictEqual(jumpedLine, 6, 'NavigateCommand must jump directly to Dog.speak for d.speak()');
  });

  it('should jump directly to subclass override when base class and subclass share the same class name via import alias', async () => {
    const baseCode = `
class BoxAction:
    def get_flush_velocity(self):
        return 100
`;
    const subCode = `
from extras.box_wrapper import BoxAction as BoxActionBase

class BoxAction(BoxActionBase):
    def get_flush_velocity(self):
        return 200

    def run(self):
        v = self.get_flush_velocity()
`;
    const baseUri = Uri.file('/workspace/box_wrapper.py');
    const subUri = Uri.file('/workspace/box_nano_wrapper.py');

    const indexer = new SymbolIndexer();
    indexer.indexFile(baseUri, baseCode);
    indexer.indexFile(subUri, subCode);

    const subDoc = new MockTextDocument(subCode, subUri.fsPath, 'python');
    workspace.textDocuments.push(subDoc);

    const provider = new SmoothDefinitionProvider(indexer);
    // Cursor on self.get_flush_velocity() at line 8: "v = self.get_flush_velocity()"
    const pos = new Position(8, 18);
    const result = (await provider.provideDefinition(subDoc as any, pos as any, {} as any)) as any[];

    assert.ok(result, 'Must find definition');
    assert.strictEqual(result.length, 1, 'Must return 1 definition');
    assert.strictEqual(result[0].targetUri.fsPath, subUri.fsPath, 'Must jump to subclass file box_nano_wrapper.py');
    assert.strictEqual(result[0].targetRange.start.line, 4, 'Must jump to subclass get_flush_velocity at line 4');
  });

  it('should jump directly to local variable definition without popups', async () => {
    const code = `
class Worker:
    def process(self):
        same_tnn_list = []
        for item in items:
            if item.ok:
                same_tnn_list = item.data
        if len(same_tnn_list) < 1:
            pass
`;
    const doc = new MockTextDocument(code, '/workspace/worker.py', 'python');
    const indexer = new SymbolIndexer();
    indexer.indexDocument(doc as any);

    const provider = new SmoothDefinitionProvider(indexer);
    // Cursor on same_tnn_list at line 7: "        if len(same_tnn_list) < 1:"
    const pos = new Position(7, 18);
    const result = (await provider.provideDefinition(
      doc as any,
      pos as any,
      {} as any
    )) as any[];

    assert.ok(result, 'Must find definition for local same_tnn_list');
    assert.strictEqual(result.length, 1, 'Must return exactly 1 definition (no popups)');
    assert.strictEqual(result[0].targetRange.start.line, 3, 'Must point directly to local assignment at line 3');
  });

  it('should parse C functions, structs, and macros accurately', () => {
    const cCode = `
#define BUFFER_SIZE 1024

struct buffer {
    char *data;
    int len;
};

static inline int
calc_size(int n)
{
    return n * 2;
}

void __visible
buffer_alloc(uint32_t size)
{
    // ...
}
`;
    const defs = SymbolParser.parseText(cCode, Uri.file('/workspace/chelper/buffer.c'));
    const names = defs.map((d) => d.name);
    assert.ok(names.includes('BUFFER_SIZE'), 'Must include macro BUFFER_SIZE');
    assert.ok(names.includes('buffer'), 'Must include struct buffer');
    assert.ok(names.includes('calc_size'), 'Must include calc_size');
    assert.ok(names.includes('buffer_alloc'), 'Must include buffer_alloc');
  });

  it('should jump directly from Python CFFI ffi_lib call to C implementation source', async () => {
    const cCode = `
struct stepcompress * __visible
stepcompress_alloc(uint32_t oid)
{
    return 0;
}
`;
    const hCode = `
struct stepcompress *stepcompress_alloc(uint32_t oid);
`;
    const pyCode = `
import chelper

def init():
    ffi_main, ffi_lib = chelper.get_ffi()
    queue = ffi_lib.stepcompress_alloc(1)
`;
    const cUri = Uri.file('/workspace/klippy/chelper/stepcompress.c');
    const hUri = Uri.file('/workspace/klippy/chelper/stepcompress.h');
    const pyUri = Uri.file('/workspace/klippy/stepper.py');

    const indexer = new SymbolIndexer();
    indexer.indexFile(cUri, cCode);
    indexer.indexFile(hUri, hCode);
    indexer.indexFile(pyUri, pyCode);

    const doc = new MockTextDocument(pyCode, pyUri.fsPath, 'python');
    const provider = new SmoothDefinitionProvider(indexer);

    // Cursor on stepcompress_alloc at line 5: "    queue = ffi_lib.stepcompress_alloc(1)"
    const pos = new Position(5, 25);
    const result = (await provider.provideDefinition(
      doc as any,
      pos as any,
      {} as any
    )) as any[];

    assert.ok(result, 'Must find definition for CFFI call');
    assert.strictEqual(result.length, 1, 'Must prioritize .c implementation over .h without popups');
    assert.strictEqual(result[0].targetUri.fsPath, cUri.fsPath, 'Must point directly to stepcompress.c');
    assert.strictEqual(result[0].targetRange.start.line, 2, 'Must point to line 2 in stepcompress.c');
  });

  it('should resolve module __init__.py via findModuleDefinition', () => {
    const initCode = `# chelper module`;
    const initUri = Uri.file('/workspace/klippy/chelper/__init__.py');

    const indexer = new SymbolIndexer();
    indexer.indexFile(initUri, initCode);

    const modDef = indexer.findModuleDefinition('chelper');
    assert.ok(modDef, 'Must find definition for module chelper');
    assert.strictEqual(modDef.uri.fsPath, initUri.fsPath, 'Must jump to chelper/__init__.py');
  });
});
