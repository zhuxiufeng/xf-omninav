import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SymbolDefinition, CompactSymbolDefinition } from '../types';
import { SymbolParser } from './symbolParser';
import { getOmniConfig } from '../utils';
import { WorkerPool } from './workerPool';

export class SymbolIndexer implements vscode.Disposable {
  private exactMap: Map<string, SymbolDefinition[]> = new Map();
  private lowerMap: Map<string, SymbolDefinition[]> = new Map();
  private acronymMap: Map<string, SymbolDefinition[]> = new Map();
  private prefixMap: Map<string, SymbolDefinition[]> = new Map();
  private fileMap: Map<string, SymbolDefinition[]> = new Map();
  private classHierarchy: Map<string, string[]> = new Map();
  private classMethods: Map<string, Set<string>> = new Map();
  private directSubClasses: Map<string, Set<string>> = new Map(); // normalizedBaseClassName -> Set<subClassName>
  private fileClassesMap: Map<string, string[]> = new Map();
  private fileMtimeMap: Map<string, number> = new Map();

  private disposables: vscode.Disposable[] = [];
  private isIndexing: boolean = false;
  private _onDidIndexUpdate = new vscode.EventEmitter<number>();
  public readonly onDidIndexUpdate = this._onDidIndexUpdate.event;

  private pendingChanges: Map<string, NodeJS.Timeout> = new Map();
  private dirtyDocuments: Map<string, vscode.TextDocument> = new Map();
  private workerPool: WorkerPool;
  private context?: vscode.ExtensionContext;

  constructor(context?: vscode.ExtensionContext) {
    this.context = context;
    this.workerPool = new WorkerPool();
    this.registerWatchers();
  }

  public setContext(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Extract acronym / abbreviation from symbol name.
   * e.g. "box_filament_err" -> "bfe"
   * e.g. "BoxFilamentError" -> "bfe"
   * e.g. "get_flush_velocity" -> "gfv"
   */
  public static extractAcronym(name: string): string {
    if (!name || name.length <= 1) return '';
    // 1. snake_case / kebab-case: box_filament_err -> bfe
    if (name.includes('_') || name.includes('-')) {
      const parts = name.split(/[_-]+/).filter(Boolean);
      if (parts.length > 1) {
        return parts.map((p) => p[0].toLowerCase()).join('');
      }
    }
    // 2. CamelCase / PascalCase: BoxFilamentError -> bfe
    const letters: string[] = [];
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (i === 0 || (code >= 65 && code <= 90)) {
        letters.push(name[i].toLowerCase());
      }
    }
    if (letters.length > 1) {
      return letters.join('');
    }
    return '';
  }

  /**
   * Mark a document as dirty (edited).
   */
  public markDirty(document: vscode.TextDocument): void {
    this.dirtyDocuments.set(document.uri.toString(), document);
  }

  /**
   * Ensure dirty documents (or specific target document) are synchronously indexed before jump/lookup.
   */
  public ensureSynchronized(targetUri?: vscode.Uri | string): void {
    if (targetUri) {
      const uriStr = typeof targetUri === 'string' ? targetUri : targetUri.toString();
      const doc = this.dirtyDocuments.get(uriStr);
      if (doc) {
        this.dirtyDocuments.delete(uriStr);
        const timer = this.pendingChanges.get(uriStr);
        if (timer) {
          clearTimeout(timer);
          this.pendingChanges.delete(uriStr);
        }
        this.indexDocument(doc);
      }
      return;
    }

    // Flush all pending dirty documents
    if (this.dirtyDocuments.size > 0) {
      for (const [uriStr, doc] of Array.from(this.dirtyDocuments.entries())) {
        this.dirtyDocuments.delete(uriStr);
        const timer = this.pendingChanges.get(uriStr);
        if (timer) {
          clearTimeout(timer);
          this.pendingChanges.delete(uriStr);
        }
        this.indexDocument(doc);
      }
    }
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

  public get indexing(): boolean {
    return this.isIndexing;
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
      // 0. If in-memory index is empty, attempt 5ms instant hydration from persistent disk cache
      if (this.fileMap.size === 0) {
        await this.loadFromDiskCache();
      }

      const maxFiles = getOmniConfig<number>('maxIndexedFiles', 5000);

      // Search for code files across project
      const pattern = '**/*.{py,ts,js,tsx,jsx,go,rs,cpp,c,h,hpp,java}';
      const exclude =
        '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/dist/**,**/build/**,**/.venv/**,**/venv/**,**/env/**,**/.tox/**,**/target/**,**/.cache/**,**/coverage/**,**/out/**}';

      const uris = await vscode.workspace.findFiles(pattern, exclude, maxFiles);
      const currentUriSet = new Set(uris.map((u) => u.toString()));

      // Clean up symbols for files that were deleted outside watcher
      for (const uriStr of Array.from(this.fileMap.keys())) {
        if (!currentUriSet.has(uriStr)) {
          this.removeFileSymbols(uriStr);
        }
      }

      // Prioritize active editor document and sibling files in same folder first
      const activeUri = vscode.window.activeTextEditor?.document?.uri;
      if (activeUri && activeUri.scheme === 'file') {
        const activeDir = path.dirname(activeUri.fsPath);
        uris.sort((a, b) => {
          if (a.toString() === activeUri.toString()) return -1;
          if (b.toString() === activeUri.toString()) return 1;
          const aInDir = a.fsPath.startsWith(activeDir);
          const bInDir = b.fsPath.startsWith(activeDir);
          if (aInDir && !bInDir) return -1;
          if (!aInDir && bInDir) return 1;
          return 0;
        });
      }

      // Process files in concurrent batches with micro-yielding to keep event loop 100% responsive
      const batchSize = 25;
      for (let i = 0; i < uris.length; i += batchSize) {
        const batch = uris.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (uri) => {
            try {
              const uriStr = uri.toString();

              // If already open in an editor, use in-memory document
              const openDoc = vscode.workspace.textDocuments?.find(
                (d) => d.uri.toString() === uriStr
              );
              if (openDoc) {
                this.indexDocument(openDoc);
                return;
              }

              // Incremental check: If local file mtime is unchanged and symbols are already cached, skip!
              let mtime: number | undefined;
              if (uri.scheme === 'file') {
                try {
                  const stat = await fs.promises.stat(uri.fsPath);
                  mtime = stat.mtimeMs;
                  const prevMtime = this.fileMtimeMap.get(uriStr);
                  if (prevMtime !== undefined && prevMtime === mtime && this.fileMap.has(uriStr)) {
                    return; // 0ms skipped!
                  }
                } catch {}
              }

              // Fast raw read bypassing VS Code TextDocument allocation & event storms
              let text: string;
              if (uri.scheme === 'file') {
                text = await fs.promises.readFile(uri.fsPath, 'utf8');
              } else {
                const raw = await vscode.workspace.fs.readFile(uri);
                text = Buffer.from(raw).toString('utf8');
              }

              const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
              const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;

              let defs: SymbolDefinition[] | undefined;
              if (this.workerPool.available) {
                try {
                  defs = await this.workerPool.parseText(uriStr, text, workspaceRoot);
                } catch {}
              }

              this.indexFile(uri, text, defs);
              if (mtime !== undefined) {
                this.fileMtimeMap.set(uriStr, mtime);
              }
            } catch {
              // File unreadable or binary, skip silently
            }
          })
        );
        // Micro-yield to Node.js event loop between batches to eliminate startup UI jank
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      this._onDidIndexUpdate.fire(this.totalSymbols);

      // Persist symbol cache asynchronously to disk
      await this.saveToDiskCache();
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Index symbols from raw text without requiring vscode.TextDocument.
   */
  public indexFile(
    uri: vscode.Uri,
    text: string,
    preParsedDefs?: SymbolDefinition[]
  ): void {
    const uriStr = uri.toString();
    this.removeFileSymbols(uriStr);

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;

    const defs =
      preParsedDefs || SymbolParser.parseText(text, uri, undefined, workspaceRoot);
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

      // 3. Add to acronym map
      const acronym = SymbolIndexer.extractAcronym(def.name);
      if (acronym) {
        const acList = this.acronymMap.get(acronym) || [];
        acList.push(def);
        this.acronymMap.set(acronym, acList);
      }

      // 4. Add to prefix map
      if (lowerName.length >= 2) {
        const p2 = lowerName.slice(0, 2);
        const p2List = this.prefixMap.get(p2) || [];
        p2List.push(def);
        this.prefixMap.set(p2, p2List);
      }
      if (lowerName.length >= 3) {
        const p3 = lowerName.slice(0, 3);
        const p3List = this.prefixMap.get(p3) || [];
        p3List.push(def);
        this.prefixMap.set(p3, p3List);
      }

      // 5. Track class hierarchy and class methods
      if (def.kind === 'class') {
        fileClasses.push(def.name);
        if (def.parentContainers && def.parentContainers.length > 0) {
          this.classHierarchy.set(def.name, def.parentContainers);
          for (const parent of def.parentContainers) {
            const cleanParent = parent.toLowerCase().replace(/[^a-z0-9]/g, '');
            let subSet = this.directSubClasses.get(cleanParent);
            if (!subSet) {
              subSet = new Set();
              this.directSubClasses.set(cleanParent, subSet);
            }
            subSet.add(def.name);
          }
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
    this.fileMtimeMap.delete(uriStr);
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

      // Remove from acronym map
      const acronym = SymbolIndexer.extractAcronym(def.name);
      if (acronym) {
        const acList = this.acronymMap.get(acronym);
        if (acList) {
          const filtered = acList.filter((d) => d.uri.toString() !== uriStr);
          if (filtered.length === 0) {
            this.acronymMap.delete(acronym);
          } else {
            this.acronymMap.set(acronym, filtered);
          }
        }
      }

      // Remove from prefix map
      if (lowerName.length >= 2) {
        const p2 = lowerName.slice(0, 2);
        const p2List = this.prefixMap.get(p2);
        if (p2List) {
          const filtered = p2List.filter((d) => d.uri.toString() !== uriStr);
          if (filtered.length === 0) this.prefixMap.delete(p2);
          else this.prefixMap.set(p2, filtered);
        }
      }
      if (lowerName.length >= 3) {
        const p3 = lowerName.slice(0, 3);
        const p3List = this.prefixMap.get(p3);
        if (p3List) {
          const filtered = p3List.filter((d) => d.uri.toString() !== uriStr);
          if (filtered.length === 0) this.prefixMap.delete(p3);
          else this.prefixMap.set(p3, filtered);
        }
      }
    }

    const classes = this.fileClassesMap.get(uriStr);
    if (classes) {
      for (const cls of classes) {
        const parents = this.classHierarchy.get(cls);
        if (parents) {
          for (const parent of parents) {
            const cleanParent = parent.toLowerCase().replace(/[^a-z0-9]/g, '');
            const subSet = this.directSubClasses.get(cleanParent);
            if (subSet) {
              subSet.delete(cls);
              if (subSet.size === 0) {
                this.directSubClasses.delete(cleanParent);
              }
            }
          }
        }
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
   * Find definitions by case-insensitive exact symbol name.
   */
  public findExactCaseInsensitive(name: string): SymbolDefinition[] {
    return this.lowerMap.get(name.toLowerCase()) || [];
  }

  /**
   * Check if a file URI has already been indexed.
   */
  public hasFile(uriStr: string): boolean {
    return this.fileMap.has(uriStr);
  }

  /**
   * Find definitions by container (class name) and symbol name.
   * e.g. container = "User", method = "login", or snake_case "box_action" -> "BoxAction"
   */
  public findByContainer(
    containerName: string,
    symbolName: string,
    preferredUri?: vscode.Uri | string
  ): SymbolDefinition[] {
    const candidates = this.findExact(symbolName);
    const cleanContainer = containerName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matched = candidates.filter((def) => {
      if (!def.containerName) return false;
      const cleanDef = def.containerName.toLowerCase().replace(/[^a-z0-9]/g, '');
      return (
        cleanDef === cleanContainer ||
        cleanDef.includes(cleanContainer) ||
        cleanContainer.includes(cleanDef)
      );
    });
    if (!preferredUri || matched.length <= 1) {
      return matched;
    }
    const prefStr = preferredUri.toString();
    const prefFsPath = typeof preferredUri === 'string' ? preferredUri : preferredUri.fsPath;
    return matched.slice().sort((a, b) => {
      const aMatch =
        a.uri.toString() === prefStr || (prefFsPath && a.uri.fsPath === prefFsPath) ? 1 : 0;
      const bMatch =
        b.uri.toString() === prefStr || (prefFsPath && b.uri.fsPath === prefFsPath) ? 1 : 0;
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
   * Get direct subclasses of a base class in O(1) time.
   */
  public getDirectSubClasses(baseClassName: string): string[] {
    const cleanBase = baseClassName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const set = this.directSubClasses.get(cleanBase);
    return set ? Array.from(set) : [];
  }

  /**
   * Get all subclasses that inherit directly or indirectly from baseClassName.
   * Utilizes reverse adjacency graph index for O(Descendants) fast traversal.
   */
  public getSubClasses(baseClassName: string): string[] {
    const results: string[] = [];
    const cleanBase = baseClassName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const queue = [cleanBase];
    const visited = new Set<string>([cleanBase]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = this.directSubClasses.get(current);
      if (children) {
        for (const child of children) {
          const cleanChild = child.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!visited.has(cleanChild)) {
            visited.add(cleanChild);
            results.push(child);
            queue.push(cleanChild);
          }
        }
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
   * Find definitions by fuzzy / case-insensitive name, acronym, or prefix.
   */
  public findFuzzy(name: string): SymbolDefinition[] {
    const query = name.trim();
    if (!query) return [];
    const lower = query.toLowerCase();
    const results: SymbolDefinition[] = [];
    const seen = new Set<SymbolDefinition>();

    const add = (item: SymbolDefinition) => {
      if (!seen.has(item)) {
        seen.add(item);
        results.push(item);
      }
    };

    // 1. Exact matches first
    const exact = this.exactMap.get(name);
    if (exact) {
      for (const d of exact) add(d);
    }

    // 2. Case-insensitive matches
    const lowerList = this.lowerMap.get(lower);
    if (lowerList) {
      for (const item of lowerList) add(item);
    }

    // 3. Acronym / CamelCase abbreviation matches (e.g. "bfe" -> "box_filament_err", "BoxFilamentError")
    const acList = this.acronymMap.get(lower);
    if (acList) {
      for (const item of acList) add(item);
    }

    // 4. Prefix matches via prefix map
    if (lower.length >= 2) {
      const pKey = lower.slice(0, Math.min(3, lower.length));
      const pList = this.prefixMap.get(pKey);
      if (pList) {
        for (const item of pList) {
          if (item.name.toLowerCase().startsWith(lower)) {
            add(item);
          }
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
    this.acronymMap.clear();
    this.prefixMap.clear();
    this.fileMap.clear();
    this.classHierarchy.clear();
    this.classMethods.clear();
    this.directSubClasses.clear();
    this.fileClassesMap.clear();
    this.fileMtimeMap.clear();
  }

  /**
   * Get methods declared on a class.
   */
  public getClassMethods(className: string): string[] {
    const methods = this.classMethods.get(className);
    return methods ? Array.from(methods) : [];
  }

  /**
   * Get all indexed class names.
   */
  public getAllClassNames(): string[] {
    const set = new Set<string>();
    for (const cls of this.classHierarchy.keys()) {
      set.add(cls);
    }
    for (const classes of this.fileClassesMap.values()) {
      for (const c of classes) set.add(c);
    }
    return Array.from(set);
  }

  /**
   * Get all method definitions belonging to a specific class.
   */
  public getMethodsInClass(className: string): SymbolDefinition[] {
    const methodNames = this.classMethods.get(className);
    if (!methodNames) return [];
    const results: SymbolDefinition[] = [];
    const cleanCls = className.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const name of methodNames) {
      const defs = this.findExact(name);
      for (const d of defs) {
        if (d.containerName && d.containerName.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanCls) {
          results.push(d);
        }
      }
    }
    return results;
  }

  /**
   * Get class hierarchy map clone.
   */
  public getClassHierarchyMap(): Map<string, string[]> {
    return new Map(this.classHierarchy);
  }

  /**
   * Resolve cache file path on disk.
   */
  public getCacheFilePath(customPath?: string): string | undefined {
    if (customPath) {
      return customPath;
    }
    if (this.context?.storageUri?.fsPath) {
      return path.join(this.context.storageUri.fsPath, 'omninav_symbols.cache.json');
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0 && folders[0].uri.scheme === 'file') {
      return path.join(folders[0].uri.fsPath, '.omninav_cache.json');
    }
    if (this.context?.globalStorageUri?.fsPath) {
      return path.join(this.context.globalStorageUri.fsPath, 'omninav_symbols.cache.json');
    }
    return undefined;
  }

  /**
   * Load symbol index from persistent disk cache.
   */
  public async loadFromDiskCache(customPath?: string): Promise<boolean> {
    try {
      const cachePath = this.getCacheFilePath(customPath);
      if (!cachePath || !fs.existsSync(cachePath)) {
        return false;
      }

      const raw = await fs.promises.readFile(cachePath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || !Array.isArray(data.files)) {
        return false;
      }

      this.clear();

      if (Array.isArray(data.fileMtimeMap)) {
        for (const [uriStr, mtime] of data.fileMtimeMap) {
          this.fileMtimeMap.set(uriStr, mtime);
        }
      }

      for (const [uriStr, serializedDefs] of data.files) {
        const uri = vscode.Uri.parse(uriStr);
        const defs: SymbolDefinition[] = serializedDefs.map((d: any) => {
          if (Array.isArray(d)) {
            return new CompactSymbolDefinition({
              name: d[0],
              kind: d[1],
              containerName: d[2],
              parentContainers: d[3],
              range: d[4],
              selectionRange: d[5],
              signature: d[6],
              fileRelativePath: d[7],
              isExported: d[8],
              docstring: d[9],
              isAbstract: d[10] === 1,
              uri,
            });
          }
          return new CompactSymbolDefinition({
            name: d.n,
            kind: d.k,
            uri,
            range: d.r,
            selectionRange: d.sr,
            signature: d.s,
            fileRelativePath: d.rel,
            containerName: d.c,
            parentContainers: d.p,
            docstring: d.doc,
            isExported: d.exp,
            isAbstract: d.abs === 1,
          });
        });
        this.storeDefinitions(uriStr, defs);
      }

      this._onDidIndexUpdate.fire(this.totalSymbols);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save symbol index to persistent disk cache.
   */
  public async saveToDiskCache(customPath?: string): Promise<boolean> {
    try {
      const cachePath = this.getCacheFilePath(customPath);
      if (!cachePath) {
        return false;
      }

      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      const serializedFiles: [string, any[]][] = [];
      for (const [uriStr, defs] of this.fileMap.entries()) {
        const fileDefs = defs.map((d: any) => [
          d.name,
          d.kind,
          d.containerName,
          d.parentContainers,
          d._r || [
            d.range.start.line,
            d.range.start.character,
            d.range.end.line,
            d.range.end.character,
          ],
          d._sr || [
            d.selectionRange.start.line,
            d.selectionRange.start.character,
            d.selectionRange.end.line,
            d.selectionRange.end.character,
          ],
          d.signature,
          d.fileRelativePath,
          d.isExported,
          d.docstring,
          d.isAbstract ? 1 : 0,
        ]);
        serializedFiles.push([uriStr, fileDefs]);
      }

      const data = {
        version: 1,
        fileMtimeMap: Array.from(this.fileMtimeMap.entries()),
        files: serializedFiles,
      };

      const tmpPath = `${cachePath}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
      await fs.promises.rename(tmpPath, cachePath);
      return true;
    } catch {
      return false;
    }
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

    // 2. On document edit: mark dirty instantly (0ms overhead during typing!),
    // and schedule a debounced background refresh (500ms).
    // If user jumps before 500ms, ensureSynchronized() flushes instantly.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const uriStr = e.document.uri.toString();
        this.markDirty(e.document);

        const existingTimer = this.pendingChanges.get(uriStr);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          this.pendingChanges.delete(uriStr);
          this.dirtyDocuments.delete(uriStr);
          this.indexDocument(e.document);
        }, 500);

        this.pendingChanges.set(uriStr, timer);
      })
    );

    // 3. File system events
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{py,ts,js,tsx,jsx,go,rs,cpp,c,h,hpp,java}'
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
    this.workerPool.dispose();
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();
    this._onDidIndexUpdate.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
