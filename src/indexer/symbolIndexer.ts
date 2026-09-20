import * as vscode from 'vscode';
import * as fs from 'fs';
import { SymbolDefinition } from '../types';
import { SymbolParser } from './symbolParser';
import { getOmniConfig } from '../utils';

export class SymbolIndexer implements vscode.Disposable {
  private exactMap: Map<string, SymbolDefinition[]> = new Map();
  private lowerMap: Map<string, SymbolDefinition[]> = new Map();
  private fileMap: Map<string, SymbolDefinition[]> = new Map();
  private classHierarchy: Map<string, string[]> = new Map();
  private classMethods: Map<string, Set<string>> = new Map();
  private fileClassesMap: Map<string, string[]> = new Map();

  private disposables: vscode.Disposable[] = [];
  private isIndexing: boolean = false;
  private _onDidIndexUpdate = new vscode.EventEmitter<number>();
  public readonly onDidIndexUpdate = this._onDidIndexUpdate.event;

  private pendingChanges: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.registerWatchers();
  }

  public get totalSymbols(): number {
    let count = 0;
    for (const defs of this.exactMap.values()) {
      count += defs.length;
    }
    return count;
  }

  public get totalFiles(): number {
    return this.fileMap.size;
  }

  /**
   * Run full workspace index scan with parallel batched I/O.
   */
  public async indexWorkspace(): Promise<void> {
    if (this.isIndexing) {
      return;
    }
    this.isIndexing = true;

    try {
      this.clear();
      const maxFiles = getOmniConfig<number>('maxIndexedFiles', 5000);

      // Search for code files across project
      const pattern = '**/*.{py,ts,js,tsx,jsx,go,rs,cpp,c,h,hpp,java}';
      const exclude =
        '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/dist/**,**/build/**,**/.venv/**,**/venv/**,**/env/**,**/.tox/**}';

      const uris = await vscode.workspace.findFiles(pattern, exclude, maxFiles);

      // Process files in concurrent batches of 25 without opening VS Code text documents
      const batchSize = 25;
      for (let i = 0; i < uris.length; i += batchSize) {
        const batch = uris.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (uri) => {
            try {
              // If already open in an editor, use in-memory document
              const openDoc = vscode.workspace.textDocuments?.find(
                (d) => d.uri.toString() === uri.toString()
              );
              if (openDoc) {
                this.indexDocument(openDoc);
                return;
              }

              // Fast raw read bypassing VS Code TextDocument allocation & event storms
              let text: string;
              if (uri.scheme === 'file') {
                text = await fs.promises.readFile(uri.fsPath, 'utf8');
              } else {
                const raw = await vscode.workspace.fs.readFile(uri);
                text = Buffer.from(raw).toString('utf8');
              }
              this.indexFile(uri, text);
            } catch {
              // File unreadable or binary, skip silently
            }
          })
        );
      }

      this._onDidIndexUpdate.fire(this.totalSymbols);
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Index symbols from raw text without requiring vscode.TextDocument.
   */
  public indexFile(uri: vscode.Uri, text: string): void {
    const uriStr = uri.toString();
    this.removeFileSymbols(uriStr);

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;

    const defs = SymbolParser.parseText(text, uri, undefined, workspaceRoot);
    this.fileMap.set(uriStr, defs);
    if (defs.length === 0) {
      return;
    }

    this.storeDefinitions(uriStr, defs);
  }

  /**
   * Index or re-index a single document.
   */
  public indexDocument(document: vscode.TextDocument): void {
    const uriStr = document.uri.toString();
    this.removeFileSymbols(uriStr);

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;

    const defs = SymbolParser.parseDocument(document, workspaceRoot);
    this.fileMap.set(uriStr, defs);
    if (defs.length === 0) {
      return;
    }

    this.storeDefinitions(uriStr, defs);
  }

  /**
   * Internal helper to store parsed definitions and index class hierarchy.
   */
  private storeDefinitions(uriStr: string, defs: SymbolDefinition[]): void {
    this.fileMap.set(uriStr, defs);
    const fileClasses: string[] = [];

    for (const def of defs) {
      // 1. Add to exact map
      const exactList = this.exactMap.get(def.name) || [];
      exactList.push(def);
      this.exactMap.set(def.name, exactList);

      // 2. Add to lower map
      const lowerName = def.name.toLowerCase();
      const lowerList = this.lowerMap.get(lowerName) || [];
      lowerList.push(def);
      this.lowerMap.set(lowerName, lowerList);

      // 3. Track class hierarchy and class methods
      if (def.kind === 'class') {
        fileClasses.push(def.name);
        if (def.parentContainers && def.parentContainers.length > 0) {
          this.classHierarchy.set(def.name, def.parentContainers);
        }
      } else if (def.kind === 'method' && def.containerName) {
        let methods = this.classMethods.get(def.containerName);
        if (!methods) {
          methods = new Set();
          this.classMethods.set(def.containerName, methods);
        }
        methods.add(def.name);
      }
    }

    if (fileClasses.length > 0) {
      this.fileClassesMap.set(uriStr, fileClasses);
    }
  }

  /**
   * Remove symbols belonging to a specific file URI.
   */
  public removeFileSymbols(uriStr: string): void {
    const existing = this.fileMap.get(uriStr);
    if (!existing) {
      return;
    }

    for (const def of existing) {
      // Remove from exact map
      const exactList = this.exactMap.get(def.name);
      if (exactList) {
        const filtered = exactList.filter((d) => d.uri.toString() !== uriStr);
        if (filtered.length === 0) {
          this.exactMap.delete(def.name);
        } else {
          this.exactMap.set(def.name, filtered);
        }
      }

      // Remove from lower map
      const lowerName = def.name.toLowerCase();
      const lowerList = this.lowerMap.get(lowerName);
      if (lowerList) {
        const filtered = lowerList.filter((d) => d.uri.toString() !== uriStr);
        if (filtered.length === 0) {
          this.lowerMap.delete(lowerName);
        } else {
          this.lowerMap.set(lowerName, filtered);
        }
      }
    }

    const classes = this.fileClassesMap.get(uriStr);
    if (classes) {
      for (const cls of classes) {
        this.classHierarchy.delete(cls);
        this.classMethods.delete(cls);
      }
      this.fileClassesMap.delete(uriStr);
    }

    this.fileMap.delete(uriStr);
  }

  /**
   * Find definitions by exact symbol name.
   */
  public findExact(name: string): SymbolDefinition[] {
    return this.exactMap.get(name) || [];
  }

  /**
   * Find definitions by container (class name) and symbol name.
   * e.g. container = "User", method = "login"
   */
  public findByContainer(
    containerName: string,
    symbolName: string,
    preferredUri?: vscode.Uri | string
  ): SymbolDefinition[] {
    const candidates = this.findExact(symbolName);
    const matched = candidates.filter(
      (def) => def.containerName?.toLowerCase() === containerName.toLowerCase()
    );
    if (!preferredUri || matched.length <= 1) {
      return matched;
    }
    const prefStr = preferredUri.toString();
    return matched.slice().sort((a, b) => {
      const aMatch = a.uri.toString() === prefStr ? 1 : 0;
      const bMatch = b.uri.toString() === prefStr ? 1 : 0;
      return bMatch - aMatch;
    });
  }

  /**
   * Find first definition matching container and symbol name.
   */
  public findByContainerAndName(
    containerName: string,
    symbolName: string,
    preferredUri?: vscode.Uri | string
  ): SymbolDefinition | undefined {
    const candidates = this.findByContainer(containerName, symbolName, preferredUri);
    return candidates.length > 0 ? candidates[0] : undefined;
  }

  /**
   * Find a module definition by module / directory / file name (e.g. `import chelper` -> `chelper/__init__.py`).
   */
  public findModuleDefinition(moduleName: string): SymbolDefinition | undefined {
    const cleanName = moduleName.toLowerCase();
    for (const [uriStr, _defs] of this.fileMap.entries()) {
      // 1. Package directory: chelper/__init__.py
      if (uriStr.toLowerCase().endsWith(`/${cleanName}/__init__.py`)) {
        const uri = vscode.Uri.parse(uriStr);
        return {
          name: moduleName,
          kind: 'module',
          uri,
          range: new vscode.Range(0, 0, 0, 0),
          selectionRange: new vscode.Range(0, 0, 0, 0),
          fileRelativePath: vscode.workspace.asRelativePath(uri, false),
          signature: `package ${moduleName}`,
          isExported: true,
        };
      }
      // 2. Single-file module: chelper.py or chelper.ts
      if (
        uriStr.toLowerCase().endsWith(`/${cleanName}.py`) ||
        uriStr.toLowerCase().endsWith(`/${cleanName}.ts`) ||
        uriStr.toLowerCase().endsWith(`/${cleanName}.js`)
      ) {
        const uri = vscode.Uri.parse(uriStr);
        return {
          name: moduleName,
          kind: 'module',
          uri,
          range: new vscode.Range(0, 0, 0, 0),
          selectionRange: new vscode.Range(0, 0, 0, 0),
          fileRelativePath: vscode.workspace.asRelativePath(uri, false),
          signature: `module ${moduleName}`,
          isExported: true,
        };
      }
    }
    return undefined;
  }

  /**
   * Get all superclasses (ancestors) of a class.
   */
  public getSuperClasses(className: string): string[] {
    const results: string[] = [];
    const visited = new Set<string>();
    const queue = [className];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const lowerCurrent = current.toLowerCase();
      if (visited.has(lowerCurrent)) continue;
      visited.add(lowerCurrent);

      let parents: string[] | undefined;
      for (const [cls, p] of this.classHierarchy) {
        if (cls.toLowerCase() === lowerCurrent) {
          parents = p;
          break;
        }
      }

      if (parents) {
        for (const p of parents) {
          const lowerP = p.toLowerCase();
          if (!visited.has(lowerP)) {
            results.push(p);
            queue.push(p);
          }
        }
      }
    }
    return results;
  }

  /**
   * Get all subclasses that inherit directly or indirectly from baseClassName.
   */
  public getSubClasses(baseClassName: string): string[] {
    const results: string[] = [];
    const lowerBase = baseClassName.toLowerCase();
    for (const [subClass] of this.classHierarchy) {
      if (subClass.toLowerCase() === lowerBase) continue;
      const ancestors = this.getSuperClasses(subClass);
      if (ancestors.some((a) => a.toLowerCase() === lowerBase)) {
        results.push(subClass);
      }
    }
    return results;
  }

  /**
   * Find all definitions of methodName implemented in subclasses of baseClassName.
   */
  public findSubclassOverrides(baseClassName: string, methodName: string): SymbolDefinition[] {
    const subClasses = this.getSubClasses(baseClassName);
    if (subClasses.length === 0) return [];

    const candidates = this.findExact(methodName);
    const lowerSubClasses = subClasses.map((s) => s.toLowerCase());
    return candidates.filter(
      (def) => def.containerName && lowerSubClasses.includes(def.containerName.toLowerCase())
    );
  }

  /**
   * Find method in container, or if not found, in closest ancestor.
   */
  public findInHierarchy(
    containerName: string,
    methodName: string,
    preferredUri?: vscode.Uri | string
  ): SymbolDefinition | undefined {
    // 1. Direct container match
    const directMatch = this.findByContainerAndName(containerName, methodName, preferredUri);
    if (directMatch) {
      return directMatch;
    }

    // 2. Check superclasses in resolution order (closest parent first)
    const superClasses = this.getSuperClasses(containerName);
    for (const parent of superClasses) {
      const parentMatch = this.findByContainerAndName(parent, methodName, preferredUri);
      if (parentMatch) {
        return parentMatch;
      }
    }

    return undefined;
  }

  /**
   * Find definitions by fuzzy / case-insensitive name.
   */
  public findFuzzy(name: string): SymbolDefinition[] {
    const lower = name.toLowerCase();
    const results: SymbolDefinition[] = [];

    // Exact matches first
    const exact = this.exactMap.get(name);
    if (exact) {
      results.push(...exact);
    }

    // Case-insensitive matches
    const lowerList = this.lowerMap.get(lower);
    if (lowerList) {
      for (const item of lowerList) {
        if (!results.includes(item)) {
          results.push(item);
        }
      }
    }

    return results;
  }

  /**
   * Clear all indexed data.
   */
  public clear(): void {
    this.exactMap.clear();
    this.lowerMap.clear();
    this.fileMap.clear();
    this.classHierarchy.clear();
    this.classMethods.clear();
    this.fileClassesMap.clear();
  }

  /**
   * Register filesystem watchers and document event listeners.
   */
  private registerWatchers(): void {
    // 1. On document save: re-index immediately
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.indexDocument(doc);
        this._onDidIndexUpdate.fire(this.totalSymbols);
      })
    );

    // 2. On document edit: debounce re-index (300ms)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const uriStr = e.document.uri.toString();
        const existingTimer = this.pendingChanges.get(uriStr);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          this.pendingChanges.delete(uriStr);
          this.indexDocument(e.document);
        }, 300);

        this.pendingChanges.set(uriStr, timer);
      })
    );

    // 3. File system events
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{py,ts,js,tsx,jsx,go,rs}'
    );
    this.disposables.push(watcher);

    watcher.onDidCreate(async (uri) => {
      try {
        let text: string;
        if (uri.scheme === 'file') {
          text = await fs.promises.readFile(uri.fsPath, 'utf8');
        } else {
          const raw = await vscode.workspace.fs.readFile(uri);
          text = Buffer.from(raw).toString('utf8');
        }
        this.indexFile(uri, text);
        this._onDidIndexUpdate.fire(this.totalSymbols);
      } catch {}
    });

    watcher.onDidDelete((uri) => {
      this.removeFileSymbols(uri.toString());
      this._onDidIndexUpdate.fire(this.totalSymbols);
    });
  }

  public dispose(): void {
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();
    this._onDidIndexUpdate.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
