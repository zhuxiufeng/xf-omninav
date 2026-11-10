import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { ImportResolver } from '../resolver/importResolver';
import { VenvResolver } from '../resolver/venvResolver';
import { UsageResolver } from '../resolver/usageResolver';
import { ContextResolver, ReceiverInfo } from '../resolver/contextResolver';
import { SymbolDefinition } from '../types';
import { getOmniConfig, getRipgrepPath } from '../utils';

export class SmoothDefinitionProvider implements vscode.DefinitionProvider {
  private static isQueryingLsp = false;

  constructor(private indexer: SymbolIndexer) {}

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.LocationLink[] | vscode.Location[] | null> {
    if (SmoothDefinitionProvider.isQueryingLsp) {
      return null;
    }

    const isEnabled = getOmniConfig<boolean>('enable', true);
    if (!isEnabled) {
      return null;
    }

    // Ensure any dirty edits in current document or workspace are synced just before jump
    this.indexer.ensureSynchronized();

    // 1. Resolve imports and file path strings first
    const supportImports = getOmniConfig<boolean>('supportFileImports', true);
    if (supportImports) {
      const importLoc = await ImportResolver.resolveImportOrPath(document, position);
      if (importLoc) {
        return [importLoc];
      }
    }

    // 2. Extract word at position
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
    if (!wordRange) {
      return null;
    }

    const symbolName = document.getText(wordRange);

    // 2.5 PyCharm Feature: If cursor is ALREADY at the definition header (e.g. def foo, class Bar):
    // Jump directly to the direct call site (or display list of call sites if multiple)
    if (UsageResolver.isAtDefinition(document, position, symbolName)) {
      const usages = await UsageResolver.findUsages(document, position, symbolName, this.indexer);
      if (usages.length > 0) {
        return usages.map((u) => ({
          originSelectionRange: wordRange,
          targetUri: u.uri,
          targetRange: u.range,
          targetSelectionRange: u.range,
        }));
      }

      return null;
    }

    // Query native LSP definitions in background (with re-entrancy guard)
    const lspTargets = await this.queryLspDefinitions(document, position);

    // 3. Resolve receiver & container context (subclass override resolution)
    const receiver = ContextResolver.inferReceiverFromPrefix(document, position, wordRange);
    const containerHint = receiver.containerName;

    // 3.0 Local variable / parameter immediate resolution:
    // If the symbol is a bare identifier (no self., cls., or obj. prefix) and is declared locally:
    // Jump DIRECTLY to the local assignment/declaration (1 single definition, never pop up multi-choice)!
    if (!receiver.isSelf && !receiver.isCls && !receiver.isSuper && !receiver.varName) {
      const localScope = ContextResolver.resolveLocalScope(document, position, symbolName);
      if (localScope) {
        if (this.isCoveredByLsp(localScope, lspTargets)) {
          return null;
        }
        return [
          await this.toCalibratedLocationLink(wordRange, localScope.uri, localScope.range, localScope.selectionRange, symbolName)
        ];
      }
    }

    // 3.1 Subclass / Self-invocation Direct Precision Jump:
    // If calling via self. / this. in a subclass and current subclass implements the method:
    // Jump DIRECTLY to the subclass override! (Avoid jumping to base class or showing peek)
    if (receiver.isSelf && receiver.containerName) {
      const subclassDef = this.indexer.findByContainerAndName(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (subclassDef) {
        if (this.isCoveredByLsp(subclassDef, lspTargets)) {
          return null;
        }
        return [
          await this.toCalibratedLocationLink(wordRange, subclassDef.uri, subclassDef.range, subclassDef.selectionRange, symbolName, receiver.containerName)
        ];
      }

      // If subclass doesn't override it, check hierarchy (parent classes)
      const inheritedDef = this.indexer.findInHierarchy(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (inheritedDef) {
        if (this.isCoveredByLsp(inheritedDef, lspTargets)) {
          return null;
        }
        return [
          await this.toCalibratedLocationLink(wordRange, inheritedDef.uri, inheritedDef.range, inheritedDef.selectionRange, symbolName, inheritedDef.containerName)
        ];
      }

      // Check immediate in-document definition (e.g. self.xxx = ... created in this file)
      const localDef = this.scanLocalDocument(document, symbolName, receiver.containerName);
      if (localDef) {
        if (this.isCoveredByLsp(localDef, lspTargets)) {
          return null;
        }
        return [
          await this.toCalibratedLocationLink(wordRange, localDef.uri, localDef.range, localDef.selectionRange, symbolName, receiver.containerName)
        ];
      }

      // Attribute is explicitly bound to self / current class hierarchy.
      // If not found in current class or its superclasses, strictly DO NOT fall back to other unrelated classes!
      return null;
    }

    // 3.2 Super-invocation: super().method() -> Jump directly to parent class definition!
    if (receiver.isSuper && receiver.containerName) {
      const parentDef = this.indexer.findInHierarchy(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (parentDef) {
        if (this.isCoveredByLsp(parentDef, lspTargets)) {
          return null;
        }
        return [
          await this.toCalibratedLocationLink(wordRange, parentDef.uri, parentDef.range, parentDef.selectionRange, symbolName, parentDef.containerName)
        ];
      }
    }

    // 3.3 Explicit or inferred variable container match (e.g. d = Dog(); d.speak(), self.box_action.get_flush_velocity())
    if (containerHint && !receiver.isSelf && !receiver.isSuper) {
      const directMatch = this.indexer.findByContainerAndName(
        containerHint,
        symbolName,
        document.uri
      );

      // Subclass override priority: if current file or workspace defines a subclass override, prioritize it
      const enableSubclassJump = getOmniConfig<boolean>('enableSubclassJump', true);
      if (enableSubclassJump) {
        const overrides = this.indexer.findSubclassOverrides(containerHint, symbolName);
        if (overrides.length > 0) {
          const inDoc = overrides.find((o) => o.uri.toString() === document.uri.toString());
          const chosen = inDoc || overrides[0];
          if (inDoc || overrides.length === 1 || !directMatch) {
            if (this.isCoveredByLsp(chosen, lspTargets)) {
              return null;
            }
            return [
              await this.toCalibratedLocationLink(wordRange, chosen.uri, chosen.range, chosen.selectionRange, symbolName, chosen.containerName)
            ];
          }
        }
      }

      if (directMatch) {
        if (this.isCoveredByLsp(directMatch, lspTargets)) {
          return null;
        }
        return [
          await this.toCalibratedLocationLink(wordRange, directMatch.uri, directMatch.range, directMatch.selectionRange, symbolName, directMatch.containerName)
        ];
      }
    }

    // 4. Query our workspace symbol index
    let matchedDefs = await this.findCandidates(symbolName, containerHint, document.uri, receiver);

    // If containerHint matched, filter to container matches to avoid ambiguous peek popups
    if (containerHint) {
      const containerMatches = matchedDefs.filter((d) => this.matchContainer(d.containerName, containerHint));
      if (containerMatches.length > 0) {
        matchedDefs = containerMatches;
      }
    }

    // If matching container definitions exist in the CURRENT document, prefer current document and drop other files:
    if (containerHint && matchedDefs.length > 1) {
      const currentDocDefs = matchedDefs.filter(
        (d) =>
          (d.uri.toString() === document.uri.toString() || d.uri.fsPath === document.uri.fsPath) &&
          this.matchContainer(d.containerName, containerHint)
      );
      if (currentDocDefs.length > 0) {
        matchedDefs = currentDocDefs;
      }
    }

    // If multiple matches include both C implementation (.c/.cpp) and header (.h/.hpp),
    // prioritize the implementation file to jump directly without popup:
    const cImpls = matchedDefs.filter((d) => /\.(?:c|cpp|cxx|cc)$/i.test(d.uri.fsPath));
    if (cImpls.length > 0 && !matchedDefs.every((d) => /\.(?:c|cpp|cxx|cc)$/i.test(d.uri.fsPath))) {
      matchedDefs = cImpls;
    }

    // 5. In-document immediate fallback scanner (instant & resilient for self.xxx = ...)
    if (matchedDefs.length === 0) {
      const localDef = this.scanLocalDocument(document, symbolName);
      if (localDef) {
        matchedDefs = [localDef];
      }
    }

    // 6. If no workspace match, check virtual environment (site-packages)
    const indexVenv = getOmniConfig<boolean>('indexVirtualEnv', true);
    if (matchedDefs.length === 0 && indexVenv) {
      if (containerHint) {
        // e.g. requests.get -> containerHint = requests, symbolName = get
        matchedDefs = await VenvResolver.resolveVenvSymbol(containerHint, symbolName);
      } else {
        matchedDefs = await VenvResolver.resolveVenvSymbol(symbolName);
      }
    }

    // 6.5 Module/Package jump: e.g. `import chelper` or `from chelper import ...` or `chelper.foo`
    if (matchedDefs.length === 0) {
      const modDef = this.indexer.findModuleDefinition(symbolName);
      if (modDef) {
        matchedDefs = [modDef];
      }
    }

    // Never jump in-place to the exact current cursor position if other candidates exist
    const filteredDefs = matchedDefs.filter(
      (d) => !(d.uri.toString() === document.uri.toString() && d.range.start.line === position.line)
    );
    if (filteredDefs.length > 0) {
      matchedDefs = filteredDefs;
    }

    // Deduplicate internally by file URI and start line
    const seenLocations = new Set<string>();
    matchedDefs = matchedDefs.filter((d) => {
      const key = `${d.uri.toString()}:${d.range.start.line}`;
      if (seenLocations.has(key)) {
        return false;
      }
      seenLocations.add(key);
      return true;
    });

    // Filter out candidates that are already covered by the language server
    // to prevent VS Code from showing duplicate entries in the Peek widget
    const filteredByLsp = matchedDefs.filter((d) => !this.isCoveredByLsp(d, lspTargets));
    if (filteredByLsp.length === 0) {
      return null;
    }
    matchedDefs = filteredByLsp;

    // Convert to calibrated LocationLinks
    return await Promise.all(
      matchedDefs.map((def) =>
        this.toCalibratedLocationLink(wordRange, def.uri, def.range, def.selectionRange, symbolName, def.containerName)
      )
    );
  }

  /**
   * Query native language server definitions with re-entrancy protection.
   */
  private async queryLspDefinitions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<Array<{ uriStr: string; line: number; range?: vscode.Range }>> {
    if (SmoothDefinitionProvider.isQueryingLsp) {
      return [];
    }

    SmoothDefinitionProvider.isQueryingLsp = true;
    try {
      let timer: NodeJS.Timeout | undefined;
      const lspPromise = vscode.commands.executeCommand<
        vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined
      >('vscode.executeDefinitionProvider', document.uri, position);

      const timeoutPromise = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 450);
      });

      const raw = await Promise.race([lspPromise, timeoutPromise]);
      if (timer) {
        clearTimeout(timer);
      }

      if (!raw) {
        return [];
      }

      const list: Array<vscode.Location | vscode.LocationLink> = Array.isArray(raw)
        ? raw
        : [raw as vscode.Location];

      const targets: Array<{ uriStr: string; fsPath?: string; line: number; range?: vscode.Range }> = [];
      for (const item of list) {
        if (!item) continue;
        if ('targetUri' in item) {
          const selRange = item.targetSelectionRange || item.targetRange;
          targets.push({
            uriStr: item.targetUri.toString(),
            fsPath: item.targetUri.fsPath,
            line: selRange.start.line,
            range: item.targetRange,
          });
        } else if ('uri' in item && 'range' in item) {
          targets.push({
            uriStr: item.uri.toString(),
            fsPath: item.uri.fsPath,
            line: item.range.start.line,
            range: item.range,
          });
        }
      }
      return targets;
    } catch {
      return [];
    } finally {
      SmoothDefinitionProvider.isQueryingLsp = false;
    }
  }

  /**
   * Check if a candidate definition is already covered by the language server
   * to prevent VS Code from showing duplicate entries in the Peek widget.
   */
  private isCoveredByLsp(
    def: SymbolDefinition,
    lspTargets: Array<{ uriStr: string; fsPath?: string; line: number; range?: vscode.Range }>
  ): boolean {
    if (lspTargets.length === 0) {
      return false;
    }
    const defUriStr = def.uri.toString();
    const defFsPath = def.uri.fsPath;
    const defLine = def.selectionRange.start.line;
    const defRangeStartLine = def.range.start.line;

    return lspTargets.some((lsp) => {
      const sameFile =
        lsp.uriStr === defUriStr ||
        (lsp.fsPath && defFsPath && lsp.fsPath.toLowerCase() === defFsPath.toLowerCase());
      if (!sameFile) {
        return false;
      }
      if (lsp.line === defLine || lsp.line === defRangeStartLine) {
        return true;
      }
      if (Math.abs(lsp.line - defLine) <= 1 || Math.abs(lsp.line - defRangeStartLine) <= 1) {
        return true;
      }
      if (lsp.range && (lsp.range.contains(def.selectionRange.start) || lsp.range.contains(def.range.start))) {
        return true;
      }
      if (def.range && lsp.range && def.range.contains(lsp.range.start)) {
        return true;
      }
      return false;
    });
  }

  /**
   * Ensure target range accurately points to the symbol even if lines shifted after indexing.
   */
  private async toCalibratedLocationLink(
    originSelectionRange: vscode.Range,
    targetUri: vscode.Uri,
    targetRange: vscode.Range,
    targetSelectionRange: vscode.Range,
    symbolName?: string,
    containerName?: string
  ): Promise<vscode.LocationLink> {
    if (!symbolName) {
      return { originSelectionRange, targetUri, targetRange, targetSelectionRange };
    }

    // Check if open in workspace
    const openDoc = vscode.workspace.textDocuments?.find(
      (d) => d.uri.toString() === targetUri.toString()
    );
    if (!openDoc) {
      return { originSelectionRange, targetUri, targetRange, targetSelectionRange };
    }

    const lineIdx = targetSelectionRange.start.line;
    if (lineIdx >= 0 && lineIdx < openDoc.lineCount) {
      if (openDoc.lineAt(lineIdx).text.includes(symbolName)) {
        return { originSelectionRange, targetUri, targetRange, targetSelectionRange };
      }
    }

    // Line shifted! Calibrate dynamically via scanLocalDocument
    const local = this.scanLocalDocument(openDoc, symbolName, containerName) || this.scanLocalDocument(openDoc, symbolName);
    if (local) {
      return {
        originSelectionRange,
        targetUri,
        targetRange: local.range,
        targetSelectionRange: local.selectionRange,
      };
    }

    return { originSelectionRange, targetUri, targetRange, targetSelectionRange };
  }

  /**
   * Find candidates and rank by relevance:
   * 1. Same container & method name (fuzzy/normalized match)
   * 2. Enclosing subclass override priority
   * 3. Current file definitions
   * 4. Same folder definitions
   * 5. Workspace definitions
   */
  private async findCandidates(
    symbolName: string,
    containerHint?: string,
    currentDocUri?: vscode.Uri,
    receiver?: ReceiverInfo
  ): Promise<SymbolDefinition[]> {
    let exact = this.indexer.findExact(symbolName);

    if (exact.length === 0) {
      // 1. Exact case-insensitive match (e.g. nozzle_manager vs NOZZLE_MANAGER)
      exact = this.indexer.findExactCaseInsensitive(symbolName);
    }

    if (exact.length === 0 && currentDocUri) {
      // 2. On-demand discovery of un-indexed sibling or workspace files
      const discovered = await this.fastDiscoverDefinition(symbolName, currentDocUri, receiver);
      if (discovered.length > 0) {
        exact = discovered;
      }
    }

    if (exact.length === 0) {
      return [];
    }

    const currentDocStr = currentDocUri?.toString();

    // Sort by relevance
    return exact.slice().sort((a, b) => {
      // 1. Container match has highest priority
      if (containerHint) {
        const aContainerMatch = this.matchContainer(a.containerName, containerHint) ? 1 : 0;
        const bContainerMatch = this.matchContainer(b.containerName, containerHint) ? 1 : 0;
        if (aContainerMatch !== bContainerMatch) {
          return bContainerMatch - aContainerMatch;
        }
      }

      // 2. Enclosing subclass priority
      if (receiver?.enclosingClass?.name) {
        const encName = receiver.enclosingClass.name.toLowerCase();
        const aIsEnc = a.containerName?.toLowerCase() === encName ? 1 : 0;
        const bIsEnc = b.containerName?.toLowerCase() === encName ? 1 : 0;
        if (aIsEnc !== bIsEnc) {
          return bIsEnc - aIsEnc;
        }
      }

      // 3. Same file has higher priority
      const aIsCurrent = a.uri.toString() === currentDocStr ? 1 : 0;
      const bIsCurrent = b.uri.toString() === currentDocStr ? 1 : 0;
      if (aIsCurrent !== bIsCurrent) {
        return bIsCurrent - aIsCurrent;
      }

      // 4. Prefer classes/functions/methods over variables
      const kindRank: Record<string, number> = {
        class: 3,
        function: 2,
        method: 2,
        property: 1,
        constant: 1,
        variable: 0,
      };
      const aRank = kindRank[a.kind] || 0;
      const bRank = kindRank[b.kind] || 0;
      if (aRank !== bRank) {
        return bRank - aRank;
      }

      // 5. C/C++ implementation (.c, .cpp) has higher priority than header (.h, .hpp)
      const aIsCImpl = /\.(?:c|cpp|cxx|cc)$/i.test(a.uri.fsPath) ? 1 : 0;
      const bIsCImpl = /\.(?:c|cpp|cxx|cc)$/i.test(b.uri.fsPath) ? 1 : 0;
      return bIsCImpl - aIsCImpl;
    });
  }

  /**
   * Fast on-demand file discovery for symbols not yet indexed in memory.
   */
  private async fastDiscoverDefinition(
    symbolName: string,
    currentDocUri: vscode.Uri,
    receiver?: ReceiverInfo
  ): Promise<SymbolDefinition[]> {
    if (currentDocUri.scheme !== 'file') return [];

    // 1. Sibling file discovery: check files in the same directory first
    try {
      const currentDir = path.dirname(currentDocUri.fsPath);
      if (fs.existsSync(currentDir)) {
        const files = await fs.promises.readdir(currentDir);
        const candidates: string[] = [];
        const varName = receiver?.varName?.toLowerCase();
        for (const file of files) {
          if (
            !file.endsWith('.py') &&
            !file.endsWith('.ts') &&
            !file.endsWith('.js') &&
            !file.endsWith('.c') &&
            !file.endsWith('.cpp')
          ) {
            continue;
          }
          const fullPath = path.join(currentDir, file);
          if (fullPath === currentDocUri.fsPath) continue;

          if (varName && file.toLowerCase().includes(varName)) {
            candidates.unshift(fullPath);
          } else {
            candidates.push(fullPath);
          }
        }

        const checkLimit = Math.min(candidates.length, 10);
        for (let i = 0; i < checkLimit; i++) {
          const filePath = candidates[i];
          const uriStr = vscode.Uri.file(filePath).toString();
          if (this.indexer.hasFile(uriStr)) continue;

          const content = await fs.promises.readFile(filePath, 'utf8');
          if (content.includes(symbolName)) {
            this.indexer.indexFile(vscode.Uri.file(filePath), content);
            const found = this.indexer.findExact(symbolName);
            if (found.length > 0) {
              return found;
            }
          }
        }
      }
    } catch {}

    // 2. Ripgrep workspace discovery
    const rgPath = getRipgrepPath();
    if (rgPath) {
      try {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentDocUri);
        const rootPath = workspaceFolder
          ? workspaceFolder.uri.fsPath
          : path.dirname(currentDocUri.fsPath);
        const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = `^\\s*(?:async\\s+)?def\\s+${escaped}\\b|^\\s*class\\s+${escaped}\\b`;

        const stdout = await new Promise<string>((resolve) => {
          cp.execFile(
            rgPath,
            ['-l', '--max-count', '1', pattern, rootPath],
            { timeout: 800, maxBuffer: 1024 * 512 },
            (err, out) => {
              if (err || !out) resolve('');
              else resolve(out);
            }
          );
        });

        if (stdout) {
          const lines = stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          for (const matchedPath of lines.slice(0, 5)) {
            const uriStr = vscode.Uri.file(matchedPath).toString();
            if (this.indexer.hasFile(uriStr)) continue;
            try {
              const content = await fs.promises.readFile(matchedPath, 'utf8');
              this.indexer.indexFile(vscode.Uri.file(matchedPath), content);
              const found = this.indexer.findExact(symbolName);
              if (found.length > 0) {
                return found;
              }
            } catch {}
          }
        }
      } catch {}
    }

    return [];
  }

  /**
   * Match container name flexibly:
   * e.g. "BoxSave" matches "box_save" (PEP 8 snake_case instance variable)
   */
  private matchContainer(containerName?: string, hint?: string): boolean {
    if (!containerName || !hint) {
      return false;
    }
    const cleanContainer = containerName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanHint = hint.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (
      cleanContainer === cleanHint ||
      cleanContainer.includes(cleanHint) ||
      cleanHint.includes(cleanContainer)
    );
  }

  /**
   * Fast in-document scanner to guarantee immediate local definition jumps.
   */
  private scanLocalDocument(
    document: vscode.TextDocument,
    symbolName: string,
    targetContainer?: string
  ): SymbolDefinition | null {
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const isPython = document.languageId === 'python';
    const regexList = [
      new RegExp(`^(\\s*)(?:self|cls)\\.(${symbolName})\\b(?:\\s*:\\s*[^=]+)?\\s*=`),
      new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${symbolName})\\s*\\(`),
      new RegExp(`^(\\s*)class\\s+(${symbolName})\\b`),
      new RegExp(`^(\\s*)(${symbolName})\\b(?:\\s*:\\s*[^=]+)?\\s*=`),
    ];

    let currentClassName: string | undefined;
    let currentClassIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isPython) {
        const classMatch = line.match(/^(\s*)class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          currentClassName = classMatch[2];
          currentClassIndent = classMatch[1].length;
        } else if (currentClassIndent >= 0) {
          const indentMatch = line.match(/^(\s*)/);
          const indent = indentMatch ? indentMatch[1].length : 0;
          if (line.trim().length > 0 && !line.trim().startsWith('#') && indent <= currentClassIndent) {
            currentClassName = undefined;
            currentClassIndent = -1;
          }
        }
      }

      if (!line.includes(symbolName)) {
        continue;
      }
      for (const regex of regexList) {
        const match = regex.exec(line);
        if (match) {
          if (targetContainer && currentClassName && !this.matchContainer(currentClassName, targetContainer)) {
            continue;
          }
          const startCol = line.indexOf(symbolName);
          const endCol = startCol + symbolName.length;
          return {
            name: symbolName,
            kind: line.includes('def ') ? 'method' : line.includes('class ') ? 'class' : 'property',
            containerName: currentClassName,
            uri: document.uri,
            range: new vscode.Range(i, 0, i, line.length),
            selectionRange: new vscode.Range(i, startCol, i, endCol),
            signature: line.trim(),
            fileRelativePath: vscode.workspace.asRelativePath(document.uri, false),
            isExported: true,
          };
        }
      }
    }

    return null;
  }
}

export class SmoothImplementationProvider implements vscode.ImplementationProvider {
  constructor(private indexer: SymbolIndexer) {}

  public async provideImplementation(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.LocationLink[] | vscode.Location[] | null> {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
    if (!wordRange) return null;

    const symbolName = document.getText(wordRange);

    // 1. Try LSP Implementation Provider first
    try {
      const lspImpls = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeImplementationProvider',
        document.uri,
        position
      );
      if (lspImpls && lspImpls.length > 0) {
        return lspImpls;
      }
    } catch {}

    // 2. Query our indexer for other definitions in workspace (overrides / implementations)
    const exact = this.indexer.findExact(symbolName);
    const candidates = exact.filter(
      (d) => !(d.uri.toString() === document.uri.toString() && d.range.start.line === position.line)
    );

    if (candidates.length === 0) return null;

    return candidates.map((def) => ({
      originSelectionRange: wordRange,
      targetUri: def.uri,
      targetRange: def.range,
      targetSelectionRange: def.selectionRange,
    }));
  }
}
