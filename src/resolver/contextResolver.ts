import * as vscode from 'vscode';
import { SymbolDefinition } from '../types';

export interface EnclosingClassInfo {
  name: string;
  startLine: number;
  parentClasses: string[];
}

export interface ReceiverInfo {
  rawPrefix: string;
  varName?: string;
  containerName?: string; // Resolved target class (e.g. "Dog")
  isSelf: boolean;
  isCls: boolean;
  isSuper: boolean;
  enclosingClass?: EnclosingClassInfo;
}

export const GENERIC_VARIABLE_NAMES = new Set([
  'result',
  'results',
  'retry_result',
  'ret',
  'res',
  'data',
  'item',
  'items',
  'msg',
  'val',
  'value',
  'values',
  'params',
  'param',
  'args',
  'kwargs',
  'info',
  'resp',
  'response',
  'state',
  'status',
  'err',
  'error',
  'errors',
  'config',
  'cfg',
  'obj',
  'target',
  'node',
  'element',
  'entry',
  'record',
  'records',
  'row',
  'col',
  'line',
  'lines',
  'buf',
  'buffer',
  'stream',
  'temp',
  'tmp',
  'key',
  'keys',
  'd',
]);

export class ContextResolver {
  /**
   * Determine the enclosing class of a given position in a document.
   */
  public static getEnclosingClass(
    document: vscode.TextDocument,
    position: vscode.Position
  ): EnclosingClassInfo | undefined {
    const isPython = document.languageId === 'python';
    const currentLine = position.line;
    const currentLineText = document.lineAt(currentLine).text;
    const indentMatch = currentLineText.match(/^(\s*)/);
    const currentIndent = indentMatch ? indentMatch[1].length : 0;

    for (let i = currentLine - 1; i >= 0; i--) {
      const lineText = document.lineAt(i).text;
      const trimmed = lineText.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      if (isPython) {
        const classMatch = lineText.match(/^(\s*)class\s+([A-Za-z0-9_]+)(?:\s*\((.*?)\))?\s*:/);
        if (classMatch) {
          const classIndent = classMatch[1].length;
          // Must be indented under the class (or inside class body)
          if (currentIndent > classIndent || (currentIndent === 0 && currentLineText.trim().length === 0)) {
            const className = classMatch[2];
            const basesStr = classMatch[3];
            const parentClasses = basesStr
              ? basesStr
                  .split(',')
                  .map((b) => b.trim().split('.').pop() || b.trim())
                  .filter((b) => Boolean(b) && b !== 'object')
              : [];
            return {
              name: className,
              startLine: i,
              parentClasses,
            };
          }
        }
      } else {
        // TypeScript, JavaScript, Java, C++, etc.
        const classMatch = lineText.match(
          /(?:class|interface)\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$,\s]+))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/
        );
        if (classMatch) {
          const className = classMatch[1];
          const extendsStr = classMatch[2];
          const implementsStr = classMatch[3];
          const parentClasses: string[] = [];
          if (extendsStr) {
            parentClasses.push(
              ...extendsStr
                .split(',')
                .map((b) => b.trim().split('.').pop() || b.trim())
                .filter(Boolean)
            );
          }
          if (implementsStr) {
            parentClasses.push(
              ...implementsStr
                .split(',')
                .map((b) => b.trim().split('.').pop() || b.trim())
                .filter(Boolean)
            );
          }
          return {
            name: className,
            startLine: i,
            parentClasses,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Infer receiver details and container hint right before the symbol word.
   */
  public static inferReceiverFromPrefix(
    document: vscode.TextDocument,
    position: vscode.Position,
    wordRange: vscode.Range
  ): ReceiverInfo {
    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, wordRange.start.character);

    // 1. Check super() call: e.g. super().method or super(Dog, self).method or super.method
    const isSuper = /super\s*(?:\(.*?\))?\s*\.\s*$/.test(prefix) || /base\s*\.\s*$/.test(prefix);
    if (isSuper) {
      const enclosing = this.getEnclosingClass(document, position);
      return {
        rawPrefix: prefix,
        isSelf: false,
        isCls: false,
        isSuper: true,
        enclosingClass: enclosing,
        containerName: enclosing?.parentClasses[0],
      };
    }

    // 2. Check self / cls / this / $this
    const selfMatch = prefix.match(/(?:self|cls|this|\$this)\s*(?:->|\.)\s*$/);
    if (selfMatch) {
      const isCls = prefix.endsWith('cls.');
      const enclosing = this.getEnclosingClass(document, position);
      return {
        rawPrefix: prefix,
        isSelf: true,
        isCls,
        isSuper: false,
        enclosingClass: enclosing,
        containerName: enclosing?.name,
      };
    }

    // 2.5 Check multi-level dot chains: e.g. self.box_action.boxcfg.method() or client.service.method()
    const chainMatch = prefix.match(/([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*(?:->|\.)\s*$/);
    if (chainMatch) {
      const parts = chainMatch[1].split('.');
      const first = parts[0];
      const last = parts[parts.length - 1];

      let currentType: string | undefined;
      if (first === 'self' || first === 'this') {
        currentType = this.inferSelfPropertyType(document, parts[1], position.line);
        if (!currentType) {
          currentType = this.snakeToPascal(parts[1]);
        }
        for (let pIdx = 2; pIdx < parts.length; pIdx++) {
          currentType = this.snakeToPascal(parts[pIdx]);
        }
      } else {
        currentType = this.inferVariableType(document, first, position.line) || this.snakeToPascal(first);
        for (let pIdx = 1; pIdx < parts.length; pIdx++) {
          currentType = this.snakeToPascal(parts[pIdx]);
        }
      }

      return {
        rawPrefix: prefix,
        varName: last,
        containerName: currentType,
        isSelf: false,
        isCls: false,
        isSuper: false,
      };
    }

    // 2.6 Check self.<property> or this.<property>: e.g. self.box_action.method()
    const selfPropMatch = prefix.match(/(?:self|this)\.([A-Za-z0-9_]+)\s*(?:->|\.)\s*$/);
    if (selfPropMatch) {
      const propName = selfPropMatch[1];
      const propType = this.inferSelfPropertyType(document, propName, position.line);
      const containerName = propType || this.snakeToPascal(propName);
      return {
        rawPrefix: prefix,
        varName: propName,
        containerName,
        isSelf: false,
        isCls: false,
        isSuper: false,
      };
    }

    // 3. Check dot expression: obj.method or Class.method
    const dotMatch = prefix.match(/([A-Za-z0-9_]+)\s*(?:->|\.)\s*$/);
    if (dotMatch) {
      const varName = dotMatch[1];
      // Check if varName starts with uppercase (likely a class name already)
      if (/^[A-Z]/.test(varName)) {
        return {
          rawPrefix: prefix,
          varName,
          containerName: varName,
          isSelf: false,
          isCls: false,
          isSuper: false,
        };
      }

      // Infer variable type by scanning backward in current function/scope
      const inferredType = this.inferVariableType(document, varName, position.line);
      const isGeneric = GENERIC_VARIABLE_NAMES.has(varName);
      return {
        rawPrefix: prefix,
        varName,
        containerName: inferredType || (isGeneric ? undefined : this.snakeToPascal(varName)),
        isSelf: false,
        isCls: false,
        isSuper: false,
      };
    }

    return {
      rawPrefix: prefix,
      isSelf: false,
      isCls: false,
      isSuper: false,
    };
  }

  private static variablePatternCache = new Map<string, RegExp[]>();
  private static literalPatternCache = new Map<
    string,
    {
      dict: RegExp;
      list: RegExp;
      set: RegExp;
      tuple: RegExp;
      str: RegExp;
      bool: RegExp;
      number: RegExp;
    }
  >();

  private static getLiteralPatterns(escaped: string) {
    let p = this.literalPatternCache.get(escaped);
    if (!p) {
      if (this.literalPatternCache.size > 500) {
        this.literalPatternCache.clear();
      }
      p = {
        dict: new RegExp(`^${escaped}\\s*=\\s*(\\{|dict\\s*\\()`),
        list: new RegExp(`^${escaped}\\s*=\\s*(\\[|list\\s*\\()`),
        set: new RegExp(`^${escaped}\\s*=\\s*set\\s*\\(`),
        tuple: new RegExp(`^${escaped}\\s*=\\s*tuple\\s*\\(`),
        str: new RegExp(`^${escaped}\\s*=\\s*[fFrRbBuU]?['"]`),
        bool: new RegExp(`^${escaped}\\s*=\\s*(?:True|False)\\b`),
        number: new RegExp(`^${escaped}\\s*=\\s*\\d+(?:\\.\\d+)?\\b`),
      };
      this.literalPatternCache.set(escaped, p);
    }
    return p;
  }

  private static getVariablePatterns(escaped: string): RegExp[] {
    let patterns = this.variablePatternCache.get(escaped);
    if (!patterns) {
      if (this.variablePatternCache.size > 500) {
        this.variablePatternCache.clear();
      }
      patterns = [
        // const x = new Dog(...) or x = Dog(...) or x = module.sub.Dog(...)
        new RegExp(`(?:const|let|var\\s+)?${escaped}\\s*=\\s*(?:new\\s+)?(?:[A-Za-z0-9_]+\\.)*([A-Z][A-Za-z0-9_]*)\\s*\\(`),
        // x: Dog = ... or x: Optional[Dog] = ... or x: Union[Dog, None] = ...
        new RegExp(`(?:const|let|var\\s+)?${escaped}\\s*:\\s*(?:Optional\\[|Union\\[)?([A-Z][A-Za-z0-9_]*)\\b`),
        // def func(x: Dog): or def func(self, x: Optional[Dog]):
        new RegExp(`(?:def|function)\\s+[A-Za-z0-9_]+\\s*\\(.*?[(\\s,]${escaped}\\s*:\\s*(?:Optional\\[|Union\\[)?([A-Z][A-Za-z0-9_]*)`),
        // Multiline parameter annotation: x: Dog,
        new RegExp(`^[\\s,]*${escaped}\\s*:\\s*(?:Optional\\[|Union\\[)?([A-Z][A-Za-z0-9_]*)\\b`),
        // (x as Dog)
        new RegExp(`\\(${escaped}\\s+as\\s+([A-Z][A-Za-z0-9_]*)\\)`),
        // Generic service locator / component factory: x = get_service('auth') or lookup_object('nozzle') or get_component('...')
        new RegExp(`${escaped}\\s*=\\s*.*?(?:lookup_object|load_object|get_service|get_component|resolve|get_instance|get_client|create_client)\\s*\\(\\s*['"]([A-Za-z0-9_]+)['"]`),
      ];
      this.variablePatternCache.set(escaped, patterns);
    }
    return patterns;
  }

  /**
   * Scan upwards in current local scope to infer variable type.
   * e.g. `d = Dog()` or `d: Dog = ...` or `def test(d: Dog):`
   * Also recognizes standard Python built-in literals like `result = { ... }` (dict),
   * `items = [ ... ]` (list), `s = "..."` (str), etc.
   * Supports return type inference from callee signature (`-> ReturnType`) when indexer is provided.
   */
  public static inferVariableType(
    document: vscode.TextDocument,
    varName: string,
    callLine: number,
    indexer?: any
  ): string | undefined {
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = this.getVariablePatterns(escaped);
    const literals = this.getLiteralPatterns(escaped);

    const minLine = Math.max(0, callLine - 60);
    for (let i = callLine - 1; i >= minLine; i--) {
      const line = document.lineAt(i).text.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      // Check standard Python literal assignments (e.g. result = { ... }, items = [ ... ])
      if (literals.dict.test(line)) {
        return 'dict';
      }
      if (literals.list.test(line)) {
        return 'list';
      }
      if (literals.set.test(line)) {
        return 'set';
      }
      if (literals.tuple.test(line)) {
        return 'tuple';
      }
      if (literals.str.test(line)) {
        return 'str';
      }
      if (literals.bool.test(line)) {
        return 'bool';
      }
      if (literals.number.test(line)) {
        return 'number';
      }

      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          if (match[1] === 'None' || match[1] === 'Any') {
            const altMatch = line.match(new RegExp(`${escaped}\\s*:\\s*(?:.*\\|\\s*)?([A-Z][A-Za-z0-9_]*)\\b`));
            if (altMatch && altMatch[1] && altMatch[1] !== 'None' && altMatch[1] !== 'Any') {
              return altMatch[1];
            }
            continue;
          }
          return match[1];
        }
      }

      // Component getter: x = config.get_printer() or x = self.printer.get_reactor()
      const getterMatch = line.match(new RegExp(`${escaped}\\s*=\\s*.*?(?:get_|load_)([a-z0-9_]+)\\s*\\(\\s*\\)`));
      if (getterMatch && getterMatch[1]) {
        return ContextResolver.snakeToPascal(getterMatch[1]);
      }

      // Return type inference: var = callee(...)
      if (indexer && typeof indexer.findExact === 'function') {
        const calleeMatch = line.match(
          new RegExp(`^(?:const|let|var\\s+)?${escaped}\\s*=\\s*(?:[A-Za-z0-9_]+\\.)?([a-z_][A-Za-z0-9_]*)\\s*\\(`)
        );
        if (calleeMatch && calleeMatch[1]) {
          const calleeName = calleeMatch[1];
          const defs = indexer.findExact(calleeName);
          for (const d of defs) {
            if (d.signature) {
              const retMatch = d.signature.match(/->\s*(?:Optional\[)?([A-Z][A-Za-z0-9_]*)/);
              if (retMatch && retMatch[1]) {
                return retMatch[1];
              }
            }
            if (d.docstring) {
              const docMatch = d.docstring.match(/(?::rtype:|@returns?\{)\s*([A-Z][A-Za-z0-9_]*)/);
              if (docMatch && docMatch[1]) {
                return docMatch[1];
              }
            }
          }
        }
      }

      // Stop searching if we reach the enclosing function or class definition
      if (/^(?:def|function|class)\b/.test(line)) {
        break;
      }
    }

    return undefined;
  }

  private static selfPropCache = new Map<string, { version: number; type: string | undefined }>();
  private static chainedPropCache = new Map<string, { version: number; type: string | undefined }>();

  /**
   * Infer the type of a chained property access like `self.A.B` by:
   * 1. Inferring `A`'s type from the current document (self property scan)
   * 2. If `A` resolves to a class, scanning a sibling document (via indexer) for `self.B = {…}` patterns
   *
   * Returns the inferred type for `B`, or `undefined` if unresolvable.
   */
  public static inferChainedPropertyType(
    document: vscode.TextDocument,
    propChain: string,
    callLine: number,
    indexer?: { findByContainer?: (container: string, name: string, preferredUri?: string) => SymbolDefinition[]; findExact?: (name: string) => SymbolDefinition[] }
  ): string | undefined {
    const parts = propChain.replace(/^(?:self|this)\./, '').split('.');
    if (parts.length < 2) return undefined;

    const docVer = (document as any).version ?? 0;
    const cacheKey = `${document.uri.toString()}#${propChain}`;
    const cached = this.chainedPropCache.get(cacheKey);
    if (cached && cached.version === docVer) {
      return cached.type;
    }

    // Traverse the chain step by step:
    // parts = ['box_state', 'Tn_data'] or ['box_action', 'box_state', 'Tn_data']
    let currentContainer: string | undefined = this.inferSelfPropertyType(document, parts[0], callLine);
    if (!currentContainer) {
      currentContainer = this.snakeToPascal(parts[0]);
    }

    const parseSignatureType = (sig: string, attr: string): string | undefined => {
      const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*(\\{|dict\\b)`).test(sig)) return 'dict';
      if (new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*(\\[|list\\b)`).test(sig)) return 'list';
      if (new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*set\\b`).test(sig)) return 'set';
      if (new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*[fFrRbBuU]?['"]`).test(sig)) return 'str';
      if (new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*\\d+(?:\\.\\d+)?\\b`).test(sig)) return 'number';
      if (new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*(?:True|False)\\b`).test(sig)) return 'bool';
      const cls = sig.match(new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*(?:[A-Za-z0-9_]+\\.)*([A-Z][A-Za-z0-9_]*)\\s*\\(`));
      if (cls && cls[1]) return cls[1];
      const lk = sig.match(new RegExp(`(?:self|this)\\.${esc}\\s*=\\s*.*?(?:lookup_object|load_object|get_service|get_component)\\s*\\(\\s*['"]([A-Za-z0-9_]+)['"]`));
      if (lk && lk[1]) return lk[1];
      return undefined;
    };

    for (let step = 1; step < parts.length; step++) {
      const targetProp = parts[step];
      const isLast = step === parts.length - 1;
      let nextType: string | undefined;

      // 1. Try indexer by container and property name
      if (indexer?.findByContainer && currentContainer) {
        const defs = indexer.findByContainer(currentContainer, targetProp);
        for (const def of defs) {
          if (def.signature) {
            nextType = parseSignatureType(def.signature, targetProp);
            if (nextType) break;
          }
        }
      }

      // 2. Try scanning the current document if currentContainer is defined locally
      if (!nextType && currentContainer) {
        const totalLines = typeof document.lineCount === 'number' ? document.lineCount : 5000;
        let classStart = -1;
        for (let i = 0; i < totalLines; i++) {
          const lineText = typeof document.lineAt === 'function' ? document.lineAt(i).text : '';
          if (new RegExp(`^class\\s+${currentContainer}\\b`).test(lineText.trim())) {
            classStart = i;
            break;
          }
        }
        if (classStart >= 0) {
          const scanTo = Math.min(totalLines, classStart + 400);
          for (let i = classStart; i < scanTo; i++) {
            const line = typeof document.lineAt === 'function' ? document.lineAt(i).text : '';
            if (!line.includes(targetProp)) continue;
            nextType = parseSignatureType(line, targetProp);
            if (nextType) break;
          }
        }
      }

      if (!nextType) {
        // Fallback: snake_case to PascalCase for intermediate classes
        nextType = isLast ? undefined : this.snakeToPascal(targetProp);
      }

      if (isLast) {
        if (this.chainedPropCache.size > 1000) this.chainedPropCache.clear();
        this.chainedPropCache.set(cacheKey, { version: docVer, type: nextType });
        return nextType;
      }
      currentContainer = nextType;
      if (!currentContainer) break;
    }

    if (this.chainedPropCache.size > 1000) this.chainedPropCache.clear();
    this.chainedPropCache.set(cacheKey, { version: docVer, type: undefined });
    return undefined;
  }

  /**
   * Infer property type from self.<propName> = ClassName(...) or lookup_object('...') or this.<propName> = ...
   */
  public static inferSelfPropertyType(
    document: vscode.TextDocument,
    propName: string,
    currentLine?: number
  ): string | undefined {
    const cleanProp = propName.replace(/^(?:self|this)\./, '');

    const docVer = (document as any).version ?? 0;
    const cacheKey = `${document.uri.toString()}#${cleanProp}`;
    const cached = this.selfPropCache.get(cacheKey);
    if (cached && cached.version === docVer) {
      return cached.type;
    }

    const escaped = cleanProp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Match factory / lookup / service locator pattern:
    // e.g. self.gcode = self.printer.lookup_object('gcode', None)
    const lookupRegex = new RegExp(
      `(?:self|this)\\.${escaped}\\s*=\\s*.*?(?:lookup_object|load_object|get_service|get_component|resolve|get_instance|get_client|create_client)\\s*\\(\\s*['"]([A-Za-z0-9_]+)['"]`
    );

    // 1.5 Match component getter pattern:
    // e.g. self.printer = config.get_printer() or self.reactor = self.printer.get_reactor()
    const getterRegex = new RegExp(
      `(?:self|this)\\.${escaped}\\s*=\\s*.*?(?:get_|load_)([a-z0-9_]+)\\s*\\(\\s*\\)`
    );

    // 2. Match direct class instantiation:
    // e.g. self.prop = ClassName(...) or self.prop = module.ClassName(...)
    const classRegex = new RegExp(
      `(?:self|this)\\.${escaped}\\s*=\\s*(?:[A-Za-z0-9_]+\\.)*([A-Z][A-Za-z0-9_]*)\\s*\\(`
    );

    // 2.5 Match parameter assignment pattern:
    // e.g. self.box_state = box_state -> BoxState
    const paramRegex = new RegExp(
      `(?:self|this)\\.${escaped}\\s*=\\s*${escaped}\\b`
    );

    const recordResult = (res: string | undefined) => {
      if (this.selfPropCache.size > 1000) this.selfPropCache.clear();
      this.selfPropCache.set(cacheKey, { version: docVer, type: res });
      return res;
    };

    const totalLines = typeof document.lineCount === 'number' ? document.lineCount : 5000;
    // Scan up to first 800 lines (where __init__ and setup methods reside)
    const scanLimit = Math.min(totalLines, 800);
    for (let i = 0; i < scanLimit; i++) {
      const line = typeof document.lineAt === 'function' ? document.lineAt(i).text : '';
      if (!line || (!line.includes(`.${cleanProp}`) && !line.includes(cleanProp))) continue;

      const mLookup = line.match(lookupRegex);
      if (mLookup && mLookup[1]) {
        return recordResult(mLookup[1]);
      }
      const mGetter = line.match(getterRegex);
      if (mGetter && mGetter[1]) {
        return recordResult(mGetter[1]);
      }
      const mClass = line.match(classRegex);
      if (mClass && mClass[1]) {
        return recordResult(mClass[1]);
      }
      const mParam = line.match(paramRegex);
      if (mParam) {
        return recordResult(this.snakeToPascal(cleanProp));
      }
    }

    return recordResult(undefined);
  }

  /**
   * Convert snake_case to PascalCase:
   * e.g. "box_action" -> "BoxAction", "waste_chute_sensor" -> "WasteChuteSensor"
   */
  public static snakeToPascal(str: string): string {
    return str
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  /**
   * Check if a symbol definition represents an abstract or empty stub method.
   */
  public static isAbstractOrEmpty(docText: string, def: SymbolDefinition): boolean {
    const lines = docText.split(/\r?\n/);
    const startLine = def.range.start.line;
    const endLine = Math.min(lines.length - 1, startLine + 8);

    for (let i = startLine; i <= endLine; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      if (
        line === 'pass' ||
        line === '...' ||
        line.startsWith('raise NotImplementedError') ||
        line.startsWith('raise NotImplemented') ||
        line.startsWith('@abstractmethod')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a local variable or parameter in the current enclosing function/block scope.
   */
  public static resolveLocalScope(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolName: string
  ): { uri: vscode.Uri; range: vscode.Range; selectionRange: vscode.Range } | null {
    const isPython = document.languageId === 'python';
    const currentLine = position.line;
    let funcStartLine = 0;

    // 1. Find enclosing function start line
    if (isPython) {
      const lineText = document.lineAt(currentLine).text;
      const curIndentMatch = lineText.match(/^(\s*)/);
      const curIndent = curIndentMatch ? curIndentMatch[1].length : 0;
      for (let i = currentLine - 1; i >= 0; i--) {
        const line = document.lineAt(i).text;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
        if (defMatch) {
          const defIndent = defMatch[1].length;
          if (curIndent > defIndent || curIndent === 0) {
            funcStartLine = i;
            break;
          }
        }
        // If we hit class declaration with lower indent, stop
        const classMatch = line.match(/^(\s*)class\s+/);
        if (classMatch && classMatch[1].length < curIndent) {
          funcStartLine = i + 1;
          break;
        }
      }
    } else {
      for (let i = currentLine - 1; i >= 0; i--) {
        const line = document.lineAt(i).text;
        if (/\bfunction\b|\bdef\b|\bfunc\b|=>|\b(?:public|private|protected|async)\s+[A-Za-z0-9_$]+\s*\(/.test(line)) {
          funcStartLine = i;
          break;
        }
      }
    }

    // 2. Scan from funcStartLine up to currentLine
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`\\b${escaped}\\b`);
    const assignRegex = new RegExp(`^(\\s*)(?:const|let|var)?\\s*\\b(${escaped})\\b(?:\\[[^\\]]*\\])?(?:\\s*:\\s*[^=]+)?\\s*=(?!=)`);
    const forRegex = new RegExp(`^(\\s*)for\\s+.*?\\b(${escaped})\\b.*?\\bin\\b`);
    const withRegex = new RegExp(`^(\\s*)with\\s+.*?\\bas\\s+.*?\\b(${escaped})\\b`);

    let firstDecl: { line: number; col: number; len: number } | null = null;

    for (let i = funcStartLine; i < currentLine; i++) {
      const lineText = document.lineAt(i).text;
      if (!wordRegex.test(lineText)) continue;

      // Parameter in function header
      if (i === funcStartLine && (lineText.includes('def ') || lineText.includes('function ') || lineText.includes('func '))) {
        const paramRegex = new RegExp(`[\\(, ]\\s*(${escaped})\\s*[\\), =:]`);
        const paramMatch = paramRegex.exec(lineText);
        if (paramMatch) {
          const col = lineText.indexOf(symbolName, paramMatch.index);
          firstDecl = { line: i, col, len: symbolName.length };
          break;
        }
      }

      // Assignment: var = ...
      const mAssign = assignRegex.exec(lineText);
      if (mAssign) {
        const col = lineText.indexOf(symbolName, mAssign[1].length);
        firstDecl = { line: i, col, len: symbolName.length };
        break;
      }

      // for loop: for var in ...
      const mFor = forRegex.exec(lineText);
      if (mFor) {
        const col = lineText.indexOf(symbolName, mFor[1].length);
        firstDecl = { line: i, col, len: symbolName.length };
        break;
      }

      // with statement: with ... as var:
      const mWith = withRegex.exec(lineText);
      if (mWith) {
        const col = lineText.indexOf(symbolName, mWith[1].length);
        firstDecl = { line: i, col, len: symbolName.length };
        break;
      }
    }

    if (firstDecl) {
      const lineLen = document.lineAt(firstDecl.line).text.length;
      return {
        uri: document.uri,
        range: new vscode.Range(firstDecl.line, 0, firstDecl.line, lineLen),
        selectionRange: new vscode.Range(firstDecl.line, firstDecl.col, firstDecl.line, firstDecl.col + firstDecl.len),
      };
    }

    return null;
  }
}
