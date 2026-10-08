import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { ImportResolver } from '../resolver/importResolver';
import { VenvResolver } from '../resolver/venvResolver';
import { UsageResolver } from '../resolver/usageResolver';
import { ContextResolver, ReceiverInfo } from '../resolver/contextResolver';
import { SymbolDefinition } from '../types';
import { getOmniConfig } from '../utils';

export class SmoothDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private indexer: SymbolIndexer) {}

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.LocationLink[] | vscode.Location[] | null> {
    const isEnabled = getOmniConfig<boolean>('enable', true);
    if (!isEnabled) {
      return null;
    }

    // Ensure any dirty edits in current document or workspace are synced just before jump
    this.indexer.ensureSynchronized(document.uri);

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

    // 3. Resolve receiver & container context (subclass override resolution)
    const receiver = ContextResolver.inferReceiverFromPrefix(document, position, wordRange);
    const containerHint = receiver.containerName;

    // 3.0 Local variable / parameter immediate resolution:
    // If the symbol is a bare identifier (no self., cls., or obj. prefix) and is declared locally:
    // Jump DIRECTLY to the local assignment/declaration (1 single definition, never pop up multi-choice)!
    if (!receiver.isSelf && !receiver.isCls && !receiver.isSuper && !receiver.varName) {
      const localScope = ContextResolver.resolveLocalScope(document, position, symbolName);
      if (localScope) {
        return [
          {
            originSelectionRange: wordRange,
            targetUri: localScope.uri,
            targetRange: localScope.range,
            targetSelectionRange: localScope.selectionRange,
          },
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
        return [
          {
            originSelectionRange: wordRange,
            targetUri: subclassDef.uri,
            targetRange: subclassDef.range,
            targetSelectionRange: subclassDef.selectionRange,
          },
        ];
      }

      // If subclass doesn't override it, check hierarchy (parent classes)
      const inheritedDef = this.indexer.findInHierarchy(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (inheritedDef) {
        return [
          {
            originSelectionRange: wordRange,
            targetUri: inheritedDef.uri,
            targetRange: inheritedDef.range,
            targetSelectionRange: inheritedDef.selectionRange,
          },
        ];
      }

      // Check immediate in-document definition (e.g. self.xxx = ... created in this file)
      const localDef = this.scanLocalDocument(document, symbolName, receiver.containerName);
      if (localDef) {
        return [
          {
            originSelectionRange: wordRange,
            targetUri: localDef.uri,
            targetRange: localDef.range,
            targetSelectionRange: localDef.selectionRange,
          },
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
        return [
          {
            originSelectionRange: wordRange,
            targetUri: parentDef.uri,
            targetRange: parentDef.range,
            targetSelectionRange: parentDef.selectionRange,
          },
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
            return [
              {
                originSelectionRange: wordRange,
                targetUri: chosen.uri,
                targetRange: chosen.range,
                targetSelectionRange: chosen.selectionRange,
              },
            ];
          }
        }
      }

      if (directMatch) {
        return [
          {
            originSelectionRange: wordRange,
            targetUri: directMatch.uri,
            targetRange: directMatch.range,
            targetSelectionRange: directMatch.selectionRange,
          },
        ];
      }
    }

    // 4. Query our workspace symbol index
    let matchedDefs = this.findCandidates(symbolName, containerHint, document.uri, receiver);

    // If containerHint matched, filter to container matches to avoid ambiguous peek popups
    if (containerHint) {
      const containerMatches = matchedDefs.filter((d) => this.matchContainer(d.containerName, containerHint));
      if (containerMatches.length > 0) {
        matchedDefs = containerMatches;
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

    if (matchedDefs.length === 0) {
      return null;
    }

    // Convert to LocationLinks
    return matchedDefs.map((def) => {
      return {
        originSelectionRange: wordRange,
        targetUri: def.uri,
        targetRange: def.range,
        targetSelectionRange: def.selectionRange,
      };
    });
  }

  /**
   * Find candidates and rank by relevance:
   * 1. Same container & method name (fuzzy/normalized match)
   * 2. Enclosing subclass override priority
   * 3. Current file definitions
   * 4. Same folder definitions
   * 5. Workspace definitions
   */
  private findCandidates(
    symbolName: string,
    containerHint?: string,
    currentDocUri?: vscode.Uri,
    receiver?: ReceiverInfo
  ): SymbolDefinition[] {
    let exact = this.indexer.findExact(symbolName);

    if (exact.length === 0) {
      exact = this.indexer.findFuzzy(symbolName);
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
