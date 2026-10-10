import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { InheritanceMarker, TargetLocation, MarkerKind } from '../types';
import { rangeToSerializable, executeCommandWithTimeout, getTreeConfig } from '../utils';

export const PYTHON_BUILTIN_CLASSES = new Set([
  'object',
  'builtins.object',
  'Exception',
  'BaseException',
  'StandardError',
  'ArithmeticError',
  'BufferError',
  'LookupError',
  'EnvironmentError',
  'AssertionError',
  'AttributeError',
  'EOFError',
  'FloatingPointError',
  'GeneratorExit',
  'IOError',
  'ImportError',
  'IndexError',
  'KeyError',
  'KeyboardInterrupt',
  'MemoryError',
  'NameError',
  'NotImplementedError',
  'OSError',
  'OverflowError',
  'ReferenceError',
  'RuntimeError',
  'StopIteration',
  'StopAsyncIteration',
  'SyntaxError',
  'IndentationError',
  'TabError',
  'SystemError',
  'SystemExit',
  'TypeError',
  'UnboundLocalError',
  'UnicodeError',
  'UnicodeEncodeError',
  'UnicodeDecodeError',
  'UnicodeTranslateError',
  'ValueError',
  'ZeroDivisionError',
  'Warning',
  'UserWarning',
  'DeprecationWarning',
  'PendingDeprecationWarning',
  'SyntaxWarning',
  'RuntimeWarning',
  'FutureWarning',
  'ImportWarning',
  'UnicodeWarning',
  'BytesWarning',
  'ResourceWarning',
  'dict',
  'list',
  'set',
  'frozenset',
  'tuple',
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'bytearray',
  'memoryview',
  'range',
  'slice',
  'type',
  'super',
]);

export interface AnalysisDocument {
  uri: vscode.Uri;
  languageId: string;
  lineCount: number;
  fileName?: string;
  lineAt(line: number): { text: string; range: vscode.Range };
  getText(): string;
}

export class SimpleAnalysisDocument implements AnalysisDocument {
  public readonly uri: vscode.Uri;
  public readonly languageId: string;
  public readonly lineCount: number;
  public readonly fileName: string;
  private readonly lines: string[];
  private readonly fullText: string;

  constructor(uri: vscode.Uri, content: string, languageId?: string) {
    this.uri = uri;
    this.fileName = uri.fsPath;
    this.fullText = content;
    this.lines = content.split(/\r?\n/);
    this.lineCount = this.lines.length;

    if (languageId) {
      this.languageId = languageId;
    } else {
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (ext === '.py') {
        this.languageId = 'python';
      } else if (ext === '.ts' || ext === '.tsx') {
        this.languageId = 'typescript';
      } else if (ext === '.js' || ext === '.jsx') {
        this.languageId = 'javascript';
      } else if (ext === '.rs') {
        this.languageId = 'rust';
      } else if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.h' || ext === '.hpp') {
        this.languageId = 'cpp';
      } else if (ext === '.c') {
        this.languageId = 'c';
      } else if (ext === '.java') {
        this.languageId = 'java';
      } else if (ext === '.cs') {
        this.languageId = 'csharp';
      } else if (ext === '.go') {
        this.languageId = 'go';
      } else if (ext === '.php') {
        this.languageId = 'php';
      } else {
        this.languageId = 'unknown';
      }
    }
  }

  public lineAt(line: number): { text: string; range: vscode.Range } {
    const text = this.lines[line] ?? '';
    return {
      text,
      range: new vscode.Range(line, 0, line, text.length),
    };
  }

  public getText(): string {
    return this.fullText;
  }
}

interface PythonImport {
  moduleName: string;
  originalName: string;
  alias: string;
}

interface InternalClass {
  name: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  baseClassNames: string[];
  methods: Map<string, InternalMethod>;
  parentClasses: TargetLocation[];
  childClasses: TargetLocation[];
}

interface InternalMethod {
  name: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  className: string;
  parentMethods: TargetLocation[];
  childMethods: TargetLocation[];
}

export class InheritanceAnalyzer {
  private documentSymbolCache = new Map<string, vscode.DocumentSymbol[]>();

  // Global class cache across files: uri#className -> InternalClass
  private globalClassCache = new Map<string, InternalClass>();

  // Cache candidate subclass document URIs by class name
  private subclassCandidateCache = new Map<string, string[]>();

  public clearCache(): void {
    this.documentSymbolCache.clear();
    this.globalClassCache.clear();
    this.subclassCandidateCache.clear();
  }

  public clearCandidateCache(): void {
    this.subclassCandidateCache.clear();
  }

  public clearFileCache(uri: vscode.Uri | string): void {
    const uriStr = typeof uri === 'string' ? uri : uri.toString();
    this.documentSymbolCache.delete(uriStr);

    // Remove any classes belonging to this file from globalClassCache
    for (const key of Array.from(this.globalClassCache.keys())) {
      if (key.startsWith(`${uriStr}#`)) {
        this.globalClassCache.delete(key);
      }
    }
  }

  /**
   * Silently loads document content without firing VS Code's onDidOpenTextDocument event.
   * If the document is already open in editor tabs, reuses it to reflect unsaved typing.
   * If on disk, reads directly via fs.promises.readFile to prevent GitLens / Explorer tree re-renders and flicker.
   */
  public async loadDocumentSilently(uri: vscode.Uri): Promise<AnalysisDocument | undefined> {
    const uriStr = uri.toString();
    // 1. Check if already open in VS Code (preserves active in-memory modifications)
    for (const openDoc of (vscode.workspace.textDocuments || [])) {
      if (openDoc.uri.toString() === uriStr || openDoc.uri.fsPath === uri.fsPath) {
        return openDoc;
      }
    }

    // 2. Read directly from disk via Node fs (fast, silent, 0 VS Code event emission)
    try {
      const isFileScheme = !uri.scheme || uri.scheme === 'file';
      const fsPath = uri.fsPath || (uri.toString().startsWith('file://') ? uri.toString().replace('file://', '') : '');
      if (isFileScheme && fsPath && fs.existsSync(fsPath)) {
        const content = await fs.promises.readFile(fsPath, 'utf8');
        return new SimpleAnalysisDocument(uri, content);
      }
    } catch {}

    // 3. Fallback to workspace.fs.readFile (for remote schemes)
    try {
      if (vscode.workspace.fs && vscode.workspace.fs.readFile) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        return new SimpleAnalysisDocument(uri, content);
      }
    } catch {}

    // 4. Fallback to openTextDocument if all else fails
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {}

    return undefined;
  }

  /**
   * Main entry point: Analyze a document and return all inheritance markers.
   * Supports an optional onProgress callback to emit immediate Phase 1 markers (Superclasses & in-doc hierarchy)
   * within 1-2 milliseconds, before Phase 2 (external subclass discovery) completes.
   */
  public async analyzeDocument(
    document: vscode.TextDocument | AnalysisDocument,
    token?: vscode.CancellationToken,
    onProgress?: (markers: InheritanceMarker[]) => void
  ): Promise<InheritanceMarker[]> {
    if (token?.isCancellationRequested) {
      return [];
    }

    if (!getTreeConfig<boolean>('enable', true)) {
      return [];
    }

    const supportedLanguages = getTreeConfig<string[]>('supportedLanguages', [
      'python',
      'typescript',
      'javascript',
      'typescriptreact',
      'javascriptreact',
      'rust',
      'cpp',
      'c',
      'java',
      'csharp',
      'go',
      'php',
    ]);

    if (!supportedLanguages.includes(document.languageId)) {
      return [];
    }

    // 1. Fast Syntactic extraction (runs in < 1ms)
    const classMap = await this.extractDocumentClassesAndMethods(document, token);
    if (token?.isCancellationRequested || classMap.size === 0) {
      return [];
    }

    // 2. Merge previously discovered relationships from global cache for classes in this doc.
    // NOTE: Keep the current cls and method ranges (fresh from latest document AST)!
    // Only restore the external references (parentClasses, childClasses, parentMethods, childMethods),
    // and if a target refers to another symbol in the same document, do not keep stale line numbers.
    for (const cls of classMap.values()) {
      const globalKey = `${document.uri.toString()}#${cls.name}`;
      const cached = this.globalClassCache.get(globalKey);
      if (cached) {
        // Only keep targets from OTHER documents, or targets that will be re-resolved
        const extParents = cached.parentClasses.filter((p) => p.uri !== document.uri.toString());
        const extChildren = cached.childClasses.filter((c) => c.uri !== document.uri.toString());
        cls.parentClasses.push(...extParents);
        cls.childClasses.push(...extChildren);

        for (const [mName, m] of cls.methods.entries()) {
          const cachedM = cached.methods.get(mName);
          if (cachedM) {
            const extParentMethods = cachedM.parentMethods.filter((pm) => pm.uri !== document.uri.toString());
            const extChildMethods = cachedM.childMethods.filter((cm) => cm.uri !== document.uri.toString());
            m.parentMethods.push(...extParentMethods);
            m.childMethods.push(...extChildMethods);
          }
        }
      }
    }

    // 3. Phase 1: Resolve superclasses and in-document relationships (< 1ms)
    await this.resolveSuperClassesAndInDoc(document, classMap, token);
    if (token?.isCancellationRequested) {
      return [];
    }

    // 4. Resolve method overrides for known classes so far (< 1ms)
    await this.resolveMethodOverrides(document, classMap, token);
    if (token?.isCancellationRequested) {
      return [];
    }

    // Emit Phase 1 markers immediately (< 2ms) so superclasses and CodeLens appear with ZERO delay!
    if (onProgress) {
      const phase1Markers = this.buildMarkers(document, classMap);
      if (phase1Markers.length > 0) {
        onProgress(phase1Markers);
      }
    }

    // 5. Phase 2: Batch Subclass discovery across external files (single fast batch grep, ~14ms)
    await this.resolveExternalSubclassesBatch(document, classMap, token);
    if (token?.isCancellationRequested) {
      return [];
    }

    // 6. Re-resolve method overrides across the complete class hierarchy
    await this.resolveMethodOverrides(document, classMap, token);
    if (token?.isCancellationRequested) {
      return [];
    }

    // 7. Store current document classes into global cache
    for (const cls of classMap.values()) {
      const globalKey = `${cls.uri.toString()}#${cls.name}`;
      this.globalClassCache.set(globalKey, cls);
    }

    // 8. Convert to final InheritanceMarker array
    return this.buildMarkers(document, classMap);
  }

  /**
   * Helper to convert internal classMap to unique InheritanceMarker array.
   */
  public buildMarkers(
    document: vscode.TextDocument | AnalysisDocument,
    classMap: Map<string, InternalClass>
  ): InheritanceMarker[] {
    const markers: InheritanceMarker[] = [];
    const showClassInheritance = getTreeConfig<boolean>('showClassInheritance', true);
    const showMethodOverrides = getTreeConfig<boolean>('showMethodOverrides', true);
    const seenClasses = new Set<InternalClass>();

    for (const cls of classMap.values()) {
      if (seenClasses.has(cls)) {
        continue;
      }
      seenClasses.add(cls);

      // Only emit markers for classes located in the currently analyzed document
      if (cls.uri.toString() !== document.uri.toString()) {
        continue;
      }

      if (showClassInheritance) {
        const marker = this.createClassMarker(cls);
        if (marker) {
          markers.push(marker);
        }
      }

      if (showMethodOverrides) {
        for (const method of cls.methods.values()) {
          const marker = this.createMethodMarker(cls, method);
          if (marker) {
            markers.push(marker);
          }
        }
      }
    }

    // Deduplicate markers by symbol and line to guarantee no duplicates
    const seenMarkerKeys = new Set<string>();
    const uniqueMarkers: InheritanceMarker[] = [];
    for (const m of markers) {
      const key = `${m.symbolName}#${m.selectionRange.start.line}:${m.selectionRange.start.character}`;
      if (!seenMarkerKeys.has(key)) {
        seenMarkerKeys.add(key);
        uniqueMarkers.push(m);
      }
    }

    return uniqueMarkers;
  }

  /**
   * Extract classes and methods from document combining syntactic regex and fallback to LSP.
   */
  private async extractDocumentClassesAndMethods(
    document: vscode.TextDocument | AnalysisDocument,
    token?: vscode.CancellationToken
  ): Promise<Map<string, InternalClass>> {
    const classMap = new Map<string, InternalClass>();

    // Fast Syntactic extraction (< 1ms)
    if (document.languageId === 'python') {
      this.extractPythonSyntactic(document, classMap);
    } else if (
      document.languageId === 'typescript' ||
      document.languageId === 'javascript' ||
      document.languageId === 'typescriptreact' ||
      document.languageId === 'javascriptreact'
    ) {
      this.extractTypeScriptSyntactic(document, classMap);
    }

    // Only query LSP if syntactic extraction found nothing
    if (classMap.size === 0) {
      try {
        const lspSymbols = await this.getDocumentSymbols(document.uri);
        if (lspSymbols && lspSymbols.length > 0) {
          this.mergeLspSymbols(document, lspSymbols, classMap);
        }
      } catch {
        // ignore
      }
    }

    return classMap;
  }

  /**
   * Syntactic scanner for Python imports.
   */
  public extractPythonImports(document: vscode.TextDocument | AnalysisDocument): Map<string, PythonImport> {
    const importMap = new Map<string, PythonImport>();
    const lineCount = document.lineCount;
    let insideMultiLineFrom: { moduleName: string } | null = null;

    for (let i = 0; i < lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;
      const trimmed = text.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // If inside multi-line from ... import (...)
      if (insideMultiLineFrom) {
        if (trimmed.includes(')')) {
          const content = trimmed.substring(0, trimmed.indexOf(')'));
          this.parsePythonImportItems(content, insideMultiLineFrom.moduleName, importMap);
          insideMultiLineFrom = null;
        } else {
          this.parsePythonImportItems(trimmed, insideMultiLineFrom.moduleName, importMap);
        }
        continue;
      }

      // Optimization: imports are usually in first 300 lines
      if (i > 300 && (trimmed.startsWith('class ') || trimmed.startsWith('def '))) {
        break;
      }

      // from <module> import ( ...
      const multiFromMatch = /^from\s+([a-zA-Z0-9_.]+)\s+import\s*\((.*)/.exec(trimmed);
      if (multiFromMatch) {
        const mod = multiFromMatch[1];
        const rest = multiFromMatch[2];
        if (rest.includes(')')) {
          const content = rest.substring(0, rest.indexOf(')'));
          this.parsePythonImportItems(content, mod, importMap);
        } else {
          this.parsePythonImportItems(rest, mod, importMap);
          insideMultiLineFrom = { moduleName: mod };
        }
        continue;
      }

      // from <module> import <items>
      const fromMatch = /^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)/.exec(trimmed);
      if (fromMatch) {
        const mod = fromMatch[1];
        const namesStr = fromMatch[2];
        this.parsePythonImportItems(namesStr, mod, importMap);
        continue;
      }

      // import <module> as <alias>
      const importAsMatch = /^import\s+([a-zA-Z0-9_.]+)\s+as\s+([a-zA-Z0-9_]+)/.exec(trimmed);
      if (importAsMatch) {
        const mod = importAsMatch[1];
        const alias = importAsMatch[2];
        importMap.set(alias, { moduleName: mod, originalName: '', alias });
        continue;
      }

      // import <module1>, <module2>
      const importMatch = /^import\s+([a-zA-Z0-9_.,\s]+)/.exec(trimmed);
      if (importMatch && !trimmed.includes(' as ')) {
        const mods = importMatch[1].split(',');
        for (const m of mods) {
          const mod = m.trim();
          if (mod) {
            importMap.set(mod, { moduleName: mod, originalName: '', alias: mod });
          }
        }
      }
    }

    return importMap;
  }

  private parsePythonImportItems(
    itemsStr: string,
    mod: string,
    importMap: Map<string, PythonImport>
  ): void {
    const parts = itemsStr.split(',');
    for (const part of parts) {
      const item = part.replace(/[()]/g, '').trim();
      if (!item) continue;
      if (item.includes(' as ')) {
        const [orig, alias] = item.split(' as ').map((s) => s.trim());
        if (orig && alias) {
          importMap.set(alias, { moduleName: mod, originalName: orig, alias });
        }
      } else {
        importMap.set(item, { moduleName: mod, originalName: item, alias: item });
      }
    }
  }

  /**
   * Syntactic scanner for Python classes and methods.
   */
  private extractPythonSyntactic(
    document: vscode.TextDocument | AnalysisDocument,
    classMap: Map<string, InternalClass>
  ): void {
    const lineCount = document.lineCount;
    let currentClass: InternalClass | null = null;
    let currentClassIndent = -1;

    for (let i = 0; i < lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;
      const trimmed = text.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const indent = text.search(/\S/);

      // Class definition: class ClassName(Base1, Base2):
      const classMatch = /^class\s+([a-zA-Z0-9_]+)(?:\s*\(([^)]*)\))?\s*:/.exec(trimmed);
      if (classMatch) {
        const className = classMatch[1];
        const basesRaw = classMatch[2] || '';
        const baseClassNames = basesRaw
          .split(',')
          .map((b) => b.trim())
          .filter(
            (b) =>
              b &&
              !PYTHON_BUILTIN_CLASSES.has(b) &&
              !PYTHON_BUILTIN_CLASSES.has(b.split('.').pop() || '')
          );

        const col = text.indexOf(className);
        const nameRange = new vscode.Range(i, col, i, col + className.length);

        currentClass = {
          name: className,
          uri: document.uri,
          range: line.range,
          selectionRange: nameRange,
          baseClassNames,
          methods: new Map(),
          parentClasses: [],
          childClasses: [],
        };
        currentClassIndent = indent;
        classMap.set(className, currentClass);
        continue;
      }

      // Check if exited current class indentation
      if (currentClass && indent <= currentClassIndent) {
        currentClass = null;
        currentClassIndent = -1;
      }

      // Method definition inside class: def methodName(self, ...):
      if (currentClass && indent > currentClassIndent) {
        const methodMatch = /^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/.exec(trimmed);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const col = text.indexOf(methodName);
          const nameRange = new vscode.Range(i, col, i, col + methodName.length);

          if (!currentClass.methods.has(methodName)) {
            currentClass.methods.set(methodName, {
              name: methodName,
              uri: document.uri,
              range: line.range,
              selectionRange: nameRange,
              className: currentClass.name,
              parentMethods: [],
              childMethods: [],
            });
          }
        }
      }
    }
  }

  /**
   * Syntactic scanner for TypeScript/JavaScript classes.
   */
  private extractTypeScriptSyntactic(
    document: vscode.TextDocument | AnalysisDocument,
    classMap: Map<string, InternalClass>
  ): void {
    const lineCount = document.lineCount;
    let currentClass: InternalClass | null = null;
    let braceDepth = 0;
    let classBraceStart = -1;

    for (let i = 0; i < lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;
      const trimmed = text.trim();

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        continue;
      }

      // Match class / interface
      const classMatch =
        /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface)\s+([a-zA-Z0-9_]+)(?:\s+extends\s+([a-zA-Z0-9_,\s]+))?(?:\s+implements\s+([a-zA-Z0-9_,\s]+))?/.exec(
          trimmed
        );

      if (classMatch) {
        const className = classMatch[1];
        const extendsRaw = classMatch[2] || '';
        const implementsRaw = classMatch[3] || '';
        const baseClassNames = `${extendsRaw},${implementsRaw}`
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean);

        const col = text.indexOf(className);
        const nameRange = new vscode.Range(i, col, i, col + className.length);

        currentClass = {
          name: className,
          uri: document.uri,
          range: line.range,
          selectionRange: nameRange,
          baseClassNames,
          methods: new Map(),
          parentClasses: [],
          childClasses: [],
        };
        classBraceStart = braceDepth;
        classMap.set(className, currentClass);
      }

      // Method inside class
      if (currentClass) {
        const methodMatch =
          /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:override\s+)?([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?::\s*[^;{]+)?\s*\{?/.exec(
            trimmed
          );

        if (
          methodMatch &&
          !trimmed.startsWith('constructor') &&
          !trimmed.startsWith('if') &&
          !trimmed.startsWith('for') &&
          !trimmed.startsWith('while') &&
          !trimmed.startsWith('switch')
        ) {
          const methodName = methodMatch[1];
          if (
            methodName !== 'if' &&
            methodName !== 'for' &&
            methodName !== 'while' &&
            methodName !== 'switch' &&
            methodName !== 'constructor'
          ) {
            const col = text.indexOf(methodName);
            const nameRange = new vscode.Range(i, col, i, col + methodName.length);
            if (!currentClass.methods.has(methodName)) {
              currentClass.methods.set(methodName, {
                name: methodName,
                uri: document.uri,
                range: line.range,
                selectionRange: nameRange,
                className: currentClass.name,
                parentMethods: [],
                childMethods: [],
              });
            }
          }
        }
      }

      const openBraces = (text.match(/\{/g) || []).length;
      const closeBraces = (text.match(/\}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      if (currentClass && braceDepth <= classBraceStart) {
        currentClass = null;
        classBraceStart = -1;
      }
    }
  }

  /**
   * Merge LSP symbols into classMap.
   */
  private mergeLspSymbols(
    document: vscode.TextDocument | AnalysisDocument,
    symbols: vscode.DocumentSymbol[],
    classMap: Map<string, InternalClass>
  ): void {
    const traverse = (syms: vscode.DocumentSymbol[], containerName?: string) => {
      for (const sym of syms) {
        const isClass =
          sym.kind === vscode.SymbolKind.Class ||
          sym.kind === vscode.SymbolKind.Interface ||
          sym.kind === vscode.SymbolKind.Struct;

        const isMethod =
          sym.kind === vscode.SymbolKind.Method ||
          sym.kind === vscode.SymbolKind.Function;

        const cleanName = sym.name.replace(/\(.*$/, '').trim();

        if (isClass) {
          if (!classMap.has(cleanName)) {
            classMap.set(cleanName, {
              name: cleanName,
              uri: document.uri,
              range: sym.range,
              selectionRange: sym.selectionRange,
              baseClassNames: [],
              methods: new Map(),
              parentClasses: [],
              childClasses: [],
            });
          }
          if (sym.children && sym.children.length > 0) {
            traverse(sym.children, cleanName);
          }
        } else if (isMethod && containerName) {
          const cls = classMap.get(containerName);
          if (cls && !cls.methods.has(cleanName)) {
            cls.methods.set(cleanName, {
              name: cleanName,
              uri: document.uri,
              range: sym.range,
              selectionRange: sym.selectionRange,
              className: containerName,
              parentMethods: [],
              childMethods: [],
            });
          }
        } else if (sym.children && sym.children.length > 0) {
          traverse(sym.children, containerName);
        }
      }
    };

    traverse(symbols);
  }

  /**
   * Phase 1: Resolve superclasses and in-document relationships (< 1ms).
   */
  private async resolveSuperClassesAndInDoc(
    document: vscode.TextDocument | AnalysisDocument,
    classMap: Map<string, InternalClass>,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const isPython = document.languageId === 'python';
    const pythonImports = isPython ? this.extractPythonImports(document) : new Map<string, PythonImport>();

    // 1. In-document bidirectional linking
    for (const cls of classMap.values()) {
      for (const baseName of cls.baseClassNames) {
        const simpleBase = baseName.split('.').pop() || baseName;
        const parentCls = classMap.get(baseName) || classMap.get(simpleBase);
        if (parentCls && parentCls !== cls) {
          cls.parentClasses.push({
            uri: parentCls.uri.toString(),
            range: rangeToSerializable(parentCls.selectionRange),
            name: parentCls.name,
            kind: 'class',
            description: `Superclass of ${cls.name}`,
          });
          parentCls.childClasses.push({
            uri: cls.uri.toString(),
            range: rangeToSerializable(cls.selectionRange),
            name: cls.name,
            kind: 'class',
            description: `Subclass of ${parentCls.name}`,
          });
        }
      }
    }

    // 2. Transitive descendants within document
    for (const cls of classMap.values()) {
      const descendants = this.collectAllSubclasses(cls.name, classMap, new Set());
      for (const desc of descendants) {
        if (!cls.childClasses.some((c) => c.name === desc.name)) {
          cls.childClasses.push({
            uri: desc.uri.toString(),
            range: rangeToSerializable(desc.selectionRange),
            name: desc.name,
            kind: 'class',
            description: `Subclass of ${cls.name}`,
          });
        }
      }
    }

    // 3. Resolve base classes outside this document
    for (const cls of classMap.values()) {
      if (token?.isCancellationRequested) {
        return;
      }
      if (cls.uri.toString() !== document.uri.toString()) {
        continue;
      }

      for (const baseName of cls.baseClassNames) {
        const simpleBase = baseName.split('.').pop() || baseName;
        if (classMap.has(baseName) || classMap.has(simpleBase)) {
          continue;
        }

        // 3a. Check Python Imports table first (< 1ms, no LSP wait)
        if (isPython) {
          let resolved = false;

          // Check direct import alias or name: e.g. BoxStateBase or BoxState
          const pyImport = pythonImports.get(baseName) || pythonImports.get(simpleBase);
          if (pyImport) {
            const modUri = await this.resolvePythonModuleUri(document.uri, pyImport.moduleName);
            if (modUri) {
              const targetName = pyImport.originalName || simpleBase;
              await this.loadExternalParentClassByUri(modUri, targetName, cls, classMap, baseName);
              resolved = true;
            }
          }

          // Check module prefix: e.g. stepper.PrinterStepper
          if (!resolved && baseName.includes('.')) {
            const prefix = baseName.split('.')[0];
            const className = baseName.split('.').slice(1).join('.');
            const modImport = pythonImports.get(prefix);
            if (modImport) {
              const modUri = await this.resolvePythonModuleUri(document.uri, modImport.moduleName);
              if (modUri) {
                await this.loadExternalParentClassByUri(modUri, className, cls, classMap, baseName);
                resolved = true;
              }
            }
          }

          if (resolved) {
            continue;
          }
        }

        // 3b. Check global cache of previously indexed classes
        let foundInCache = false;
        for (const cachedCls of this.globalClassCache.values()) {
          if (cachedCls.name === baseName || cachedCls.name === simpleBase) {
            cls.parentClasses.push({
              uri: cachedCls.uri.toString(),
              range: rangeToSerializable(cachedCls.selectionRange),
              name: cachedCls.name,
              kind: 'class',
              description: `Superclass of ${cls.name}`,
            });
            cachedCls.childClasses.push({
              uri: cls.uri.toString(),
              range: rangeToSerializable(cls.selectionRange),
              name: cls.name,
              kind: 'class',
              description: `Subclass of ${cachedCls.name}`,
            });
            if (!classMap.has(cachedCls.name)) {
              classMap.set(cachedCls.name, cachedCls);
            }
            foundInCache = true;
            break;
          }
        }
        if (foundInCache) {
          continue;
        }

        // 3c. Fallback to LSP definition provider (150ms timeout)
        const externalParent = await this.resolveExternalClassDefinition(document, cls, baseName);
        if (externalParent) {
          cls.parentClasses.push(externalParent);
          await this.loadExternalParentClass(externalParent, classMap);
        }
      }
    }

    // Deduplicate
    for (const cls of classMap.values()) {
      cls.parentClasses = this.deduplicateTargets(cls.parentClasses);
      cls.childClasses = this.deduplicateTargets(cls.childClasses);
    }
  }

  /**
   * Phase 2: Batch Subclass discovery across external files (~14ms).
   * Instead of running sequential greps per class, batches all classes in the current document
   * into a single native grep call and parses only matched candidate documents silently.
   */
  private async resolveExternalSubclassesBatch(
    document: vscode.TextDocument | AnalysisDocument,
    classMap: Map<string, InternalClass>,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const currentDocClasses = Array.from(classMap.values()).filter(
      (c) => c.uri.toString() === document.uri.toString()
    );

    if (currentDocClasses.length === 0) {
      return;
    }

    // 1. Check global class cache first for previously discovered subclasses (0ms)
    for (const cls of currentDocClasses) {
      for (const cachedCls of this.globalClassCache.values()) {
        if (cachedCls.uri.toString() === cls.uri.toString()) continue;
        const matchesCached = cachedCls.baseClassNames.some(
          (b) => b === cls.name || b.split('.').pop() === cls.name
        );
        if (matchesCached) {
          const cachedFileName = path.basename(cachedCls.uri.fsPath);
          cls.childClasses.push({
            uri: cachedCls.uri.toString(),
            range: rangeToSerializable(cachedCls.selectionRange),
            name: cachedCls.name,
            containerName: cachedFileName,
            kind: 'class',
            description: `Subclass in ${cachedFileName}`,
          });
          const cachedKey = `${cachedCls.uri.toString()}#${cachedCls.name}`;
          if (!classMap.has(cachedKey)) {
            classMap.set(cachedKey, cachedCls);
          }
        }
      }
    }

    // 2. Discover candidate subclass documents in a single batch
    const candidateDocs = await this.findBatchCandidateSubclassDocuments(
      document,
      currentDocClasses,
      token
    );

    // 3. Parse candidate documents and link subclasses
    for (const candDoc of candidateDocs) {
      if (token?.isCancellationRequested) {
        return;
      }

      const tempMap = new Map<string, InternalClass>();
      if (candDoc.languageId === 'python') {
        this.extractPythonSyntactic(candDoc, tempMap);
      } else {
        this.extractTypeScriptSyntactic(candDoc, tempMap);
      }

      const candImports = candDoc.languageId === 'python'
        ? this.extractPythonImports(candDoc)
        : new Map<string, PythonImport>();

      for (const sub of tempMap.values()) {
        for (const cls of currentDocClasses) {
          if (this.isSubclassOf(sub, cls, candImports)) {
            const subKey = `${sub.uri.toString()}#${sub.name}`;
            const parentKey = `${cls.uri.toString()}#${cls.name}`;

            if (subKey === parentKey) {
              continue;
            }

            const subFileName = path.basename(sub.uri.fsPath);
            const parentFileName = path.basename(cls.uri.fsPath);

            cls.childClasses.push({
              uri: sub.uri.toString(),
              range: rangeToSerializable(sub.selectionRange),
              name: sub.name,
              containerName: subFileName,
              kind: 'class',
              description: `Subclass in ${subFileName}`,
            });

            sub.parentClasses.push({
              uri: cls.uri.toString(),
              range: rangeToSerializable(cls.selectionRange),
              name: cls.name,
              containerName: parentFileName,
              kind: 'class',
              description: `Superclass in ${parentFileName}`,
            });

            classMap.set(subKey, sub);
            this.globalClassCache.set(subKey, sub);

            for (const b of sub.baseClassNames) {
              classMap.set(`${sub.uri.toString()}#${b}`, cls);
              classMap.set(b, cls);
            }

            if (!classMap.has(sub.name)) {
              classMap.set(sub.name, sub);
            }
          }
        }
      }
    }

    // Deduplicate
    for (const cls of classMap.values()) {
      cls.parentClasses = this.deduplicateTargets(cls.parentClasses);
      cls.childClasses = this.deduplicateTargets(cls.childClasses);
    }
  }

  /**
   * Check if subClass inherits from parentClass directly, through module qualification, or via import alias.
   */
  private isSubclassOf(
    sub: InternalClass,
    parentCls: InternalClass,
    imports: Map<string, PythonImport>
  ): boolean {
    const parentBaseName = path.basename(parentCls.uri.fsPath, path.extname(parentCls.uri.fsPath));
    const isSameFile = sub.uri.toString() === parentCls.uri.toString();

    for (const base of sub.baseClassNames) {
      // 1. Direct name match: class Sub(BoxAction):
      if (base === parentCls.name) {
        if (isSameFile) {
          return true;
        }
        const pyImp = imports.get(base);
        if (pyImp && pyImp.moduleName) {
          const modParts = pyImp.moduleName.replace(/^\.+/, '').split('.');
          const lastModPart = modParts[modParts.length - 1];
          if (lastModPart && lastModPart !== parentBaseName) {
            continue;
          }
        }
        return true;
      }

      // 2. Dotted module match: class Sub(box_wrapper.BoxAction):
      const parts = base.split('.');
      if (parts[parts.length - 1] === parentCls.name) {
        const modPrefix = parts[0];
        const pyImp = imports.get(modPrefix);
        if (pyImp && pyImp.moduleName) {
          const modParts = pyImp.moduleName.replace(/^\.+/, '').split('.');
          const lastModPart = modParts[modParts.length - 1];
          if (lastModPart && lastModPart !== parentBaseName) {
            continue;
          }
        } else if (parts.length > 1 && modPrefix !== parentBaseName) {
          continue;
        }
        return true;
      }

      // 3. Import alias match: from extras.box_wrapper import BoxAction as BoxActionBase
      const pyImp = imports.get(base);
      if (pyImp && pyImp.originalName === parentCls.name) {
        if (pyImp.moduleName) {
          const modParts = pyImp.moduleName.replace(/^\.+/, '').split('.');
          const lastModPart = modParts[modParts.length - 1];
          if (lastModPart && lastModPart !== parentBaseName) {
            continue;
          }
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Find candidate documents for an entire batch of classes in a single fast operation.
   * Uses a single native batch grep (<15ms) across the current folder instead of separate greps per class.
   */
  private async findBatchCandidateSubclassDocuments(
    document: vscode.TextDocument | AnalysisDocument,
    classes: InternalClass[],
    token?: vscode.CancellationToken
  ): Promise<AnalysisDocument[]> {
    const candidateDocs: AnalysisDocument[] = [];
    const seenUris = new Set<string>();
    seenUris.add(document.uri.toString());

    const currentExt = path.extname(document.uri.fsPath);
    const classNames = classes.map((c) => c.name);

    // 1. Open documents in workspace (fastest, unsaved edits included)
    for (const openDoc of (vscode.workspace.textDocuments || [])) {
      if (
        openDoc.uri.scheme !== 'file' ||
        openDoc.uri.fsPath.endsWith('.git') ||
        openDoc.uri.fsPath.includes('/.git/') ||
        openDoc.uri.fsPath.includes('\\.git\\')
      ) {
        continue;
      }
      if (!seenUris.has(openDoc.uri.toString()) && openDoc.languageId === document.languageId) {
        const text = openDoc.getText();
        if (classNames.some((name) => text.includes(name))) {
          seenUris.add(openDoc.uri.toString());
          candidateDocs.push(openDoc);
        }
      }
    }

    if (token?.isCancellationRequested) {
      return candidateDocs;
    }

    // 2. Cache check: If all classes already have cached paths, load silently
    let allCached = true;
    const cachedFileUris = new Set<string>();
    for (const name of classNames) {
      const cached = this.subclassCandidateCache.get(name);
      if (cached) {
        for (const u of cached) cachedFileUris.add(u);
      } else {
        allCached = false;
      }
    }

    if (allCached && cachedFileUris.size > 0) {
      for (const uriStr of cachedFileUris) {
        if (!seenUris.has(uriStr)) {
          seenUris.add(uriStr);
          try {
            const uri = vscode.Uri.parse(uriStr);
            const doc = await this.loadDocumentSilently(uri);
            if (doc) {
              candidateDocs.push(doc);
            }
          } catch {}
        }
      }
      return candidateDocs;
    }

    const matchedFilePaths: string[] = [];
    const docDir = path.dirname(document.uri.fsPath);
    const isRealDir = docDir && docDir !== '/' && docDir !== '\\' && docDir !== '.' && fs.existsSync(docDir);
    const escapedNames = classNames.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const isPython = document.languageId === 'python';
    const grepRegex = isPython
      ? `(class[[:space:]]+[a-zA-Z0-9_]+[[:space:]]*\\(|from[[:space:]]+[a-zA-Z0-9_.]+[[:space:]]+import.*)\\b(${escapedNames})\\b`
      : `(extends|implements|class)[[:space:]].*\\b(${escapedNames})\\b`;

    // 3. Fast native grep in current folder (< 15ms)
    let grepSucceeded = false;
    if (isRealDir) {
      try {
        const grepOutput = await new Promise<string>((resolve) => {
          const cmd = `grep -rlE --include="*${currentExt}" "${grepRegex}" "${docDir}"`;
          require('child_process').exec(
            cmd,
            { timeout: 800, maxBuffer: 1024 * 1024 },
            (err: any, stdout: string) => {
              if (!err || err.code === 1) {
                grepSucceeded = true;
                resolve(stdout || '');
              } else {
                resolve('');
              }
            }
          );
        });

        if (grepOutput) {
          const lines = grepOutput.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && trimmed.endsWith(currentExt)) {
              matchedFilePaths.push(trimmed);
            }
          }
        }
      } catch {}
    }

    // 4. Fallback if grep command failed or is not available: check via Node fs directly
    if (!grepSucceeded && isRealDir) {
      try {
        const entries = await fs.promises.readdir(docDir);
        for (const name of entries) {
          if (token?.isCancellationRequested) break;
          if (name.endsWith(currentExt)) {
            const fullPath = path.join(docDir, name);
            if (!seenUris.has(fullPath) && !seenUris.has(`file://${fullPath}`)) {
              try {
                const content = await fs.promises.readFile(fullPath, 'utf8');
                if (classNames.some((cn) => content.includes(cn))) {
                  matchedFilePaths.push(fullPath);
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    // 5. Workspace folder grep (only if no matches found in sibling folder)
    if (matchedFilePaths.length === 0 && candidateDocs.length === 0) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder
        ? vscode.workspace.getWorkspaceFolder(document.uri)
        : undefined;
      if (workspaceFolder && workspaceFolder.uri.scheme === 'file') {
        const rootPath = workspaceFolder.uri.fsPath;
        const isRealRoot = rootPath && rootPath !== '/' && rootPath !== '\\' && rootPath !== '.' && fs.existsSync(rootPath);
        if (isRealRoot && rootPath !== docDir) {
          try {
            const grepOutput = await new Promise<string>((resolve) => {
              const cmd = `grep -rlE --include="*${currentExt}" "${grepRegex}" "${rootPath}"`;
              require('child_process').exec(
                cmd,
                { timeout: 1000, maxBuffer: 1024 * 1024 },
                (err: any, stdout: string) => {
                  resolve(err || !stdout ? '' : stdout);
                }
              );
            });

            if (grepOutput) {
              const lines = grepOutput.split('\n');
              for (const line of lines) {
                if (token?.isCancellationRequested) break;
                const trimmed = line.trim();
                if (trimmed && trimmed.endsWith(currentExt)) {
                  matchedFilePaths.push(trimmed);
                }
              }
            }
          } catch {}
        }
      }
    }

    // 6. Open ONLY the matched files silently (avoiding opening into VS Code registry!)
    for (const fPath of matchedFilePaths) {
      if (token?.isCancellationRequested) break;
      const fileUri = vscode.Uri.file(fPath);
      if (!seenUris.has(fileUri.toString())) {
        seenUris.add(fileUri.toString());
        try {
          const doc = await this.loadDocumentSilently(fileUri);
          if (doc) {
            candidateDocs.push(doc);
          }
        } catch {}
      }
    }

    // Cache the candidate URIs for each class
    for (const name of classNames) {
      const matchingUris = candidateDocs
        .filter((d) => d.getText().includes(name))
        .map((d) => d.uri.toString());
      this.subclassCandidateCache.set(name, matchingUris);
    }

    return candidateDocs;
  }

  /**
   * Resolve a Python module name to a vscode.Uri.
   */
  private async resolvePythonModuleUri(
    currentDocUri: vscode.Uri,
    moduleName: string
  ): Promise<vscode.Uri | undefined> {
    try {
      const docPath = currentDocUri.fsPath;
      const docDir = path.dirname(docPath);
      const modParts = moduleName.split('.');
      const lastPart = modParts[modParts.length - 1];

      // Check currently open documents in editor
      for (const openDoc of (vscode.workspace.textDocuments || [])) {
        if (openDoc.languageId === 'python') {
          const baseName = path.basename(openDoc.fileName, '.py');
          if (baseName === lastPart) {
            return openDoc.uri;
          }
        }
      }

      // 1. Same directory: lastPart + '.py' (< 0.01ms)
      const sameDirCandidate = path.join(docDir, `${lastPart}.py`);
      if (fs.existsSync(sameDirCandidate)) {
        return vscode.Uri.file(sameDirCandidate);
      }

      // 2. Relative to ancestor directories (< 0.05ms)
      let searchDir = docDir;
      for (let level = 0; level < 4; level++) {
        const cand1 = path.join(searchDir, ...modParts) + '.py';
        if (fs.existsSync(cand1)) {
          return vscode.Uri.file(cand1);
        }

        const candInit = path.join(searchDir, ...modParts, '__init__.py');
        if (fs.existsSync(candInit)) {
          return vscode.Uri.file(candInit);
        }

        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
      }

      // 3. Fast workspace findFiles fallback (top 5 matches) with 200ms timeout
      try {
        const found = await executeCommandWithTimeout<vscode.Uri[]>(
          'vscode.workspace.findFiles',
          [`**/${lastPart}.py`, '**/node_modules/**', 5],
          200
        );
        if (found && found.length > 0) {
          return found[0];
        }
      } catch {}
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Load external parent class directly from resolved URI.
   */
  private async loadExternalParentClassByUri(
    uri: vscode.Uri,
    targetClassName: string,
    childCls: InternalClass,
    classMap: Map<string, InternalClass>,
    aliasOrBaseName?: string
  ): Promise<void> {
    try {
      const parentDoc = await this.loadDocumentSilently(uri);
      if (!parentDoc) {
        return;
      }
      const tempClassMap = new Map<string, InternalClass>();

      if (parentDoc.languageId === 'python') {
        this.extractPythonSyntactic(parentDoc, tempClassMap);
      } else {
        this.extractTypeScriptSyntactic(parentDoc, tempClassMap);
      }

      const simpleName = targetClassName.split('.').pop() || targetClassName;
      const parentCls = tempClassMap.get(targetClassName) || tempClassMap.get(simpleName);

      if (parentCls && (parentCls.uri.toString() !== childCls.uri.toString() || parentCls.name !== childCls.name)) {
        childCls.parentClasses.push({
          uri: parentCls.uri.toString(),
          range: rangeToSerializable(parentCls.selectionRange),
          name: parentCls.name,
          kind: 'class',
          description: `Superclass of ${childCls.name}`,
        });

        parentCls.childClasses.push({
          uri: childCls.uri.toString(),
          range: rangeToSerializable(childCls.selectionRange),
          name: childCls.name,
          kind: 'class',
          description: `Subclass of ${parentCls.name}`,
        });

        const parentKey = `${parentCls.uri.toString()}#${parentCls.name}`;
        classMap.set(parentKey, parentCls);
        this.globalClassCache.set(parentKey, parentCls);

        if (aliasOrBaseName) {
          classMap.set(aliasOrBaseName, parentCls);
        }
        if (!classMap.has(parentCls.name)) {
          classMap.set(parentCls.name, parentCls);
        }

        // Recursively resolve parent's ancestors
        for (const ancestorBase of parentCls.baseClassNames) {
          const ancestorSimple = ancestorBase.split('.').pop() || ancestorBase;
          if (!classMap.has(ancestorBase) && !classMap.has(ancestorSimple)) {
            const externalParent = await this.resolveExternalClassDefinition(
              parentDoc,
              parentCls,
              ancestorBase
            );
            if (externalParent) {
              parentCls.parentClasses.push(externalParent);
              await this.loadExternalParentClass(externalParent, classMap);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Recursively collect all descendant classes in classMap.
   */
  private collectAllSubclasses(
    className: string,
    classMap: Map<string, InternalClass>,
    visited: Set<string>
  ): InternalClass[] {
    if (visited.has(className)) {
      return [];
    }
    visited.add(className);

    const result: InternalClass[] = [];
    for (const cls of classMap.values()) {
      const match = cls.baseClassNames.some(
        (b) => b === className || b.split('.').pop() === className
      );
      if (match) {
        result.push(cls);
        result.push(...this.collectAllSubclasses(cls.name, classMap, visited));
      }
    }
    return result;
  }

  /**
   * Resolve external superclass definition using LSP definition provider.
   */
  private async resolveExternalClassDefinition(
    document: vscode.TextDocument | AnalysisDocument,
    cls: InternalClass,
    baseName: string
  ): Promise<TargetLocation | undefined> {
    const simpleBase = baseName.split('.').pop() || baseName;
    if (PYTHON_BUILTIN_CLASSES.has(baseName) || PYTHON_BUILTIN_CLASSES.has(simpleBase)) {
      return undefined;
    }

    const lineText = document.lineAt(cls.selectionRange.start.line).text;
    const offset = lineText.indexOf(baseName);
    if (offset < 0) {
      return undefined;
    }

    const pos = new vscode.Position(cls.selectionRange.start.line, offset + 1);
    try {
      const defs = await executeCommandWithTimeout<
        (vscode.Location | vscode.LocationLink)[]
      >('vscode.executeDefinitionProvider', [document.uri, pos], 150);

      if (defs && defs.length > 0) {
        const loc = defs[0];
        const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
        const range =
          'targetUri' in loc
            ? loc.targetSelectionRange || loc.targetRange
            : loc.range;

        const simpleName = baseName.split('.').pop() || baseName;
        return {
          uri: uri.toString(),
          range: rangeToSerializable(range),
          name: simpleName,
          kind: 'class',
          description: `Superclass of ${cls.name}`,
        };
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Load and parse external parent class document so its methods and ancestors are available.
   */
  private async loadExternalParentClass(
    externalParent: TargetLocation,
    classMap: Map<string, InternalClass>
  ): Promise<void> {
    try {
      const uri = vscode.Uri.parse(externalParent.uri);
      const parentDoc = await this.loadDocumentSilently(uri);
      if (!parentDoc) {
        return;
      }
      const tempClassMap = new Map<string, InternalClass>();
      if (parentDoc.languageId === 'python') {
        this.extractPythonSyntactic(parentDoc, tempClassMap);
      } else {
        this.extractTypeScriptSyntactic(parentDoc, tempClassMap);
      }

      const simpleName = externalParent.name.split('.').pop() || externalParent.name;
      const parentCls = tempClassMap.get(externalParent.name) || tempClassMap.get(simpleName);
      if (parentCls) {
        if (!classMap.has(parentCls.name)) {
          classMap.set(parentCls.name, parentCls);
        }
        if (!classMap.has(externalParent.name)) {
          classMap.set(externalParent.name, parentCls);
        }

        this.globalClassCache.set(`${parentCls.uri.toString()}#${parentCls.name}`, parentCls);

        // Recursively resolve parent's ancestors (e.g. Grandparent)
        for (const ancestorBase of parentCls.baseClassNames) {
          const ancestorSimple = ancestorBase.split('.').pop() || ancestorBase;
          if (!classMap.has(ancestorBase) && !classMap.has(ancestorSimple)) {
            const ancestorParent = await this.resolveExternalClassDefinition(
              parentDoc,
              parentCls,
              ancestorBase
            );
            if (ancestorParent) {
              parentCls.parentClasses.push(ancestorParent);
              await this.loadExternalParentClass(ancestorParent, classMap);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Search an ancestor chain for a matching method.
   */
  private findMethodInAncestors(
    classMap: Map<string, InternalClass>,
    targetUri: string,
    targetClassName: string,
    methodName: string,
    visited = new Set<string>()
  ): { parentClass: InternalClass; method: InternalMethod } | undefined {
    const targetKey = `${targetUri}#${targetClassName}`;
    if (visited.has(targetKey)) {
      return undefined;
    }
    visited.add(targetKey);

    const simpleName = targetClassName.split('.').pop() || targetClassName;
    const cls =
      classMap.get(targetKey) ||
      this.globalClassCache.get(targetKey) ||
      classMap.get(targetClassName) ||
      classMap.get(simpleName);

    if (!cls) {
      return undefined;
    }

    const foundMethod = cls.methods.get(methodName);
    if (foundMethod) {
      return { parentClass: cls, method: foundMethod };
    }

    for (const parent of cls.parentClasses) {
      const found = this.findMethodInAncestors(
        classMap,
        parent.uri,
        parent.name,
        methodName,
        visited
      );
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * Resolve method overrides across class hierarchy.
   */
  private async resolveMethodOverrides(
    document: vscode.TextDocument | AnalysisDocument,
    classMap: Map<string, InternalClass>,
    token?: vscode.CancellationToken
  ): Promise<void> {
    for (const cls of classMap.values()) {
      if (token?.isCancellationRequested) {
        return;
      }

      for (const method of cls.methods.values()) {
        // 1. Upward: check superclasses (and ancestors) for matching method name
        for (const parentRef of cls.parentClasses) {
          // Never match self
          if (parentRef.uri === cls.uri.toString() && parentRef.name === cls.name) {
            continue;
          }

          const found = this.findMethodInAncestors(
            classMap,
            parentRef.uri,
            parentRef.name,
            method.name
          );
          if (found) {
            const { parentClass, method: parentMethod } = found;
            if (parentClass.uri.toString() === cls.uri.toString() && parentClass.name === cls.name) {
              continue;
            }

            const parentFileName = path.basename(parentClass.uri.fsPath);
            const clsFileName = path.basename(cls.uri.fsPath);

            if (
              !method.parentMethods.some(
                (m) =>
                  m.uri === parentMethod.uri.toString() &&
                  m.range.startLine === parentMethod.selectionRange.start.line
              )
            ) {
              method.parentMethods.push({
                uri: parentMethod.uri.toString(),
                range: rangeToSerializable(parentMethod.selectionRange),
                name: `${parentClass.name}.${method.name}`,
                containerName: parentClass.name,
                kind: 'method',
                description: `Super method in ${parentClass.name} (${parentFileName})`,
              });
            }

            // Reciprocally mark parentMethod
            if (
              !parentMethod.childMethods.some(
                (m) =>
                  m.uri === method.uri.toString() &&
                  m.range.startLine === method.selectionRange.start.line
              )
            ) {
              parentMethod.childMethods.push({
                uri: method.uri.toString(),
                range: rangeToSerializable(method.selectionRange),
                name: `${cls.name}.${method.name}`,
                containerName: cls.name,
                kind: 'method',
                description: `Overriding method in ${cls.name} (${clsFileName})`,
              });
            }
          }
        }

        // 2. Downward: check subclasses for matching method name
        for (const childRef of cls.childClasses) {
          if (childRef.uri === cls.uri.toString() && childRef.name === cls.name) {
            continue;
          }

          const childKey = `${childRef.uri}#${childRef.name}`;
          const childClass =
            classMap.get(childKey) ||
            this.globalClassCache.get(childKey) ||
            classMap.get(childRef.name) ||
            classMap.get(childRef.name.split('.').pop() || '');

          if (
            childClass &&
            (childClass.uri.toString() !== cls.uri.toString() || childClass.name !== cls.name)
          ) {
            const childMethod = childClass.methods.get(method.name);
            if (childMethod) {
              const childFileName = path.basename(childClass.uri.fsPath);
              const parentFileName = path.basename(cls.uri.fsPath);

              if (
                !method.childMethods.some(
                  (m) =>
                    m.uri === childMethod.uri.toString() &&
                    m.range.startLine === childMethod.selectionRange.start.line
                )
              ) {
                method.childMethods.push({
                  uri: childMethod.uri.toString(),
                  range: rangeToSerializable(childMethod.selectionRange),
                  name: `${childClass.name}.${method.name}`,
                  containerName: childClass.name,
                  kind: 'method',
                  description: `Overriding method in ${childClass.name} (${childFileName})`,
                });
              }
              if (
                !childMethod.parentMethods.some(
                  (m) =>
                    m.uri === method.uri.toString() &&
                    m.range.startLine === method.selectionRange.start.line
                )
              ) {
                childMethod.parentMethods.push({
                  uri: method.uri.toString(),
                  range: rangeToSerializable(method.selectionRange),
                  name: `${cls.name}.${method.name}`,
                  containerName: cls.name,
                  kind: 'method',
                  description: `Super method in ${cls.name} (${parentFileName})`,
                });
              }
            }
          }
        }
      }
    }

    // Deduplicate
    for (const cls of classMap.values()) {
      for (const method of cls.methods.values()) {
        method.parentMethods = this.deduplicateTargets(method.parentMethods);
        method.childMethods = this.deduplicateTargets(method.childMethods);
      }
    }
  }

  private createClassMarker(cls: InternalClass): InheritanceMarker | undefined {
    const hasParents = cls.parentClasses.length > 0;
    const hasChildren = cls.childClasses.length > 0;

    if (!hasParents && !hasChildren) {
      return undefined;
    }

    let markerKind: MarkerKind = 'super';
    if (hasParents && hasChildren) {
      markerKind = 'both';
    } else if (hasChildren) {
      markerKind = 'sub';
    }

    return {
      symbolName: cls.name,
      symbolKind: vscode.SymbolKind.Class,
      markerKind,
      range: cls.range,
      selectionRange: cls.selectionRange,
      parents: cls.parentClasses,
      children: cls.childClasses,
      documentUri: cls.uri,
    };
  }

  private createMethodMarker(
    cls: InternalClass,
    method: InternalMethod
  ): InheritanceMarker | undefined {
    const hasParents = method.parentMethods.length > 0;
    const hasChildren = method.childMethods.length > 0;

    if (!hasParents && !hasChildren) {
      return undefined;
    }

    let markerKind: MarkerKind = 'super';
    if (hasParents && hasChildren) {
      markerKind = 'both';
    } else if (hasChildren) {
      markerKind = 'sub';
    }

    return {
      symbolName: `${cls.name}.${method.name}`,
      symbolKind: vscode.SymbolKind.Method,
      markerKind,
      range: method.range,
      selectionRange: method.selectionRange,
      parents: method.parentMethods,
      children: method.childMethods,
      documentUri: method.uri,
    };
  }

  private async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    const key = uri.toString();
    if (this.documentSymbolCache.has(key)) {
      return this.documentSymbolCache.get(key)!;
    }

    const result = await executeCommandWithTimeout<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >('vscode.executeDocumentSymbolProvider', [uri], 1000);

    if (!result || result.length === 0) {
      this.documentSymbolCache.set(key, []);
      return [];
    }

    let docSymbols: vscode.DocumentSymbol[] = [];
    if ('children' in result[0]) {
      docSymbols = result as vscode.DocumentSymbol[];
    }

    this.documentSymbolCache.set(key, docSymbols);
    return docSymbols;
  }

  private deduplicateTargets(targets: TargetLocation[]): TargetLocation[] {
    const seen = new Set<string>();
    const result: TargetLocation[] = [];

    for (const t of targets) {
      const key = `${t.uri}#${t.range.startLine}:${t.range.startCharacter}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(t);
      }
    }

    return result;
  }
}
