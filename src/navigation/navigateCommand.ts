import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { ImportResolver } from '../resolver/importResolver';
import { VenvResolver } from '../resolver/venvResolver';
import { UsageResolver, UsageItem } from '../resolver/usageResolver';
import { ContextResolver, ReceiverInfo } from '../resolver/contextResolver';
import { globalHistory } from './jumpHistory';
import { SymbolDefinition, SymbolKind } from '../types';
import { getOmniConfig } from '../utils';

export class NavigateCommand {
  constructor(private indexer: SymbolIndexer) {}

  /**
   * Main smart jump logic.
   */
  public async execute(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    const position = editor.selection.active;

    // 1. Save history before jump
    globalHistory.pushCurrentLocation(editor);

    // 2. Check imports or file paths
    const importLoc = await ImportResolver.resolveImportOrPath(document, position);
    if (importLoc) {
      await this.jumpToLocation(importLoc.uri, importLoc.range.start);
      return;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
    if (!wordRange) {
      vscode.window.showInformationMessage('XF OmniJump: No symbol under cursor.');
      return;
    }

    const symbolName = document.getText(wordRange);

    // 2.5 PyCharm Feature: If cursor is ALREADY at the definition header (e.g. def foo, class Bar):
    // Automatically switch to Show Usages / Callers!
    if (UsageResolver.isAtDefinition(document, position, symbolName)) {
      await this.handleUsages(document, position, symbolName);
      return;
    }

    // 2.6 Resolve receiver context (subclass override resolution)
    const receiver = ContextResolver.inferReceiverFromPrefix(document, position, wordRange);
    const containerHint = receiver.containerName;

    // 2.65 Local variable / parameter immediate resolution:
    if (!receiver.isSelf && !receiver.isCls && !receiver.isSuper && !receiver.varName) {
      const localScope = ContextResolver.resolveLocalScope(document, position, symbolName);
      if (localScope) {
        await this.jumpToLocation(localScope.uri, localScope.selectionRange.start);
        return;
      }
    }

    // 2.7 Subclass / Self-invocation Direct Precision Jump:
    // If calling via self. / this. in a subclass and current subclass implements the method:
    // Jump DIRECTLY to the subclass override! (Avoid jumping to base class)
    if (receiver.isSelf && receiver.containerName) {
      const subclassDef = this.indexer.findByContainerAndName(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (subclassDef) {
        await this.jumpToLocation(subclassDef.uri, subclassDef.selectionRange.start);
        return;
      }

      // If subclass doesn't override it, check hierarchy (closest parent classes)
      const inheritedDef = this.indexer.findInHierarchy(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (inheritedDef) {
        await this.jumpToLocation(inheritedDef.uri, inheritedDef.selectionRange.start);
        return;
      }
    }

    // 2.8 Super-invocation: super().method() -> Jump directly to parent class definition!
    if (receiver.isSuper && receiver.containerName) {
      const parentDef = this.indexer.findInHierarchy(
        receiver.containerName,
        symbolName,
        document.uri
      );
      if (parentDef) {
        await this.jumpToLocation(parentDef.uri, parentDef.selectionRange.start);
        return;
      }
    }

    // 2.9 Direct variable container match (e.g. d = Dog(); d.speak(), self.box_action.get_flush_velocity())
    if (containerHint && !receiver.isSelf && !receiver.isSuper) {
      const directMatch = this.indexer.findByContainerAndName(
        containerHint,
        symbolName,
        document.uri
      );
      const enableSubclassJump = getOmniConfig<boolean>('enableSubclassJump', true);
      if (enableSubclassJump) {
        const overrides = this.indexer.findSubclassOverrides(containerHint, symbolName);
        if (overrides.length > 0) {
          const inDoc = overrides.find((o) => o.uri.toString() === document.uri.toString());
          const chosen = inDoc || overrides[0];
          if (inDoc || overrides.length === 1 || !directMatch) {
            await this.jumpToLocation(chosen.uri, chosen.selectionRange.start);
            return;
          }
        }
      }

      if (directMatch) {
        await this.jumpToLocation(directMatch.uri, directMatch.selectionRange.start);
        return;
      }
    }

    // 3. Try native LSP definition provider first (with 120ms timeout for instant responsiveness)
    try {
      const lspLocations = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
          'vscode.executeDefinitionProvider',
          document.uri,
          position
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 120)),
      ]);

      if (lspLocations && lspLocations.length > 0) {
        // Check if LSP just returned current line (i.e. already at definition)
        if (lspLocations.length === 1) {
          const loc = lspLocations[0];
          const targetUri = 'targetUri' in loc ? loc.targetUri : loc.uri;
          const targetRange = 'targetRange' in loc ? loc.targetRange : loc.range;

          if (
            targetUri.toString() === document.uri.toString() &&
            targetRange.start.line === position.line
          ) {
            // Already at definition! Switch to find usages!
            await this.handleUsages(document, position, symbolName);
            return;
          }

          // Single subclass override penetration if target is an abstract base method
          const exactDefs = this.indexer.findExact(symbolName);
          const targetDef = exactDefs.find(
            (d) => d.uri.toString() === targetUri.toString() && d.range.start.line === targetRange.start.line
          );
          if (targetDef && targetDef.containerName) {
            const overrides = this.indexer.findSubclassOverrides(targetDef.containerName, symbolName);
            if (overrides.length === 1 && ContextResolver.isAbstractOrEmpty(document.getText(), targetDef)) {
              await this.jumpToLocation(overrides[0].uri, overrides[0].selectionRange.start);
              return;
            }
          }

          await this.jumpToLocation(targetUri, targetRange.start);
          return;
        } else {
          // Multiple LSP definitions, show them
          await this.showLspQuickPick(lspLocations);
          return;
        }
      }
    } catch {
      // LSP failed or timed out, seamlessly continue to our in-memory AST engine
    }

    // 4. LSP returned nothing, trigger our AST / Symbol fallback engine!
    let candidates = this.findCandidates(symbolName, containerHint, document.uri, receiver);

    // If containerHint matched, filter candidates to matching container
    if (containerHint) {
      const containerMatches = candidates.filter((d) => this.matchContainer(d.containerName, containerHint));
      if (containerMatches.length > 0) {
        candidates = containerMatches;
      }
    }

    // If multiple matches include both C implementation (.c/.cpp) and header (.h/.hpp),
    // prioritize the implementation file to jump directly without popup:
    const cImpls = candidates.filter((d) => /\.(?:c|cpp|cxx|cc)$/i.test(d.uri.fsPath));
    if (cImpls.length > 0 && !candidates.every((d) => /\.(?:c|cpp|cxx|cc)$/i.test(d.uri.fsPath))) {
      candidates = cImpls;
    }

    // If empty in index, check local document directly
    if (candidates.length === 0) {
      const local = this.scanLocalDocument(document, symbolName);
      if (local) {
        candidates = [local];
      }
    }

    // If still empty, try virtual environment
    if (candidates.length === 0) {
      if (containerHint) {
        candidates = await VenvResolver.resolveVenvSymbol(containerHint, symbolName);
      } else {
        candidates = await VenvResolver.resolveVenvSymbol(symbolName);
      }
    }

    // Module/Package jump fallback: e.g. `import chelper` -> `chelper/__init__.py`
    if (candidates.length === 0) {
      const modDef = this.indexer.findModuleDefinition(symbolName);
      if (modDef) {
        candidates = [modDef];
      }
    }

    if (candidates.length === 0) {
      // Offer text search fallback
      const action = await vscode.window.showInformationMessage(
        `XF OmniJump: No definition found for "${symbolName}". Search text in workspace?`,
        'Search in Files'
      );
      if (action === 'Search in Files') {
        vscode.commands.executeCommand('workbench.action.findInFiles', {
          query: symbolName,
        });
      }
      return;
    }

    // Single match: direct smooth jump
    if (candidates.length === 1) {
      const target = candidates[0];
      await this.jumpToLocation(target.uri, target.selectionRange.start);
      return;
    }

    // Multiple matches: show PyCharm-style QuickPick
    await this.showDefinitionQuickPick(symbolName, candidates);
  }

  /**
   * Jump to location, center view and highlight line.
   */
  private async jumpToLocation(
    uri: vscode.Uri,
    position: vscode.Position
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const targetEditor = await vscode.window.showTextDocument(doc);
    targetEditor.selection = new vscode.Selection(position, position);
    targetEditor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter
    );
  }

  /**
   * Show PyCharm-style QuickPick for multiple candidates.
   */
  private async showDefinitionQuickPick(
    symbolName: string,
    candidates: SymbolDefinition[]
  ): Promise<void> {
    interface DefinitionQuickPickItem extends vscode.QuickPickItem {
      definition: SymbolDefinition;
    }

    const items: DefinitionQuickPickItem[] = candidates.map((def) => {
      const icon = this.getKindIcon(def.kind);
      const title = def.containerName
        ? `${def.containerName}.${def.name}`
        : def.name;

      return {
        label: `${icon} ${title}`,
        description: `${def.fileRelativePath}:${def.range.start.line + 1}`,
        detail: def.signature || def.docstring,
        definition: def,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Choose Definition for "${symbolName}" (${candidates.length} found)`,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) {
      await this.jumpToLocation(
        selected.definition.uri,
        selected.definition.selectionRange.start
      );
    }
  }

  /**
   * Show QuickPick for LSP multiple definitions.
   */
  private async showLspQuickPick(
    locations: vscode.Location[] | vscode.LocationLink[]
  ): Promise<void> {
    interface LspItem extends vscode.QuickPickItem {
      uri: vscode.Uri;
      pos: vscode.Position;
    }

    const items: LspItem[] = locations.map((loc, idx) => {
      const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
      const range = 'targetRange' in loc ? loc.targetRange : loc.range;
      const relPath = vscode.workspace.asRelativePath(uri, false);
      return {
        label: `$(symbol-reference) Match ${idx + 1}`,
        description: `${relPath}:${range.start.line + 1}`,
        uri,
        pos: range.start,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select definition target (${locations.length} found)`,
    });

    if (selected) {
      await this.jumpToLocation(selected.uri, selected.pos);
    }
  }

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

    const currentDocStr = currentDocUri?.toString();

    return exact.slice().sort((a, b) => {
      // 1. Container match
      if (containerHint) {
        const aMatch = this.matchContainer(a.containerName, containerHint) ? 1 : 0;
        const bMatch = this.matchContainer(b.containerName, containerHint) ? 1 : 0;
        if (aMatch !== bMatch) {
          return bMatch - aMatch;
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

      // 3. Same file
      const aIsCurrent = a.uri.toString() === currentDocStr ? 1 : 0;
      const bIsCurrent = b.uri.toString() === currentDocStr ? 1 : 0;
      if (aIsCurrent !== bIsCurrent) {
        return bIsCurrent - aIsCurrent;
      }

      // 4. C/C++ implementation (.c, .cpp) has higher priority than header (.h, .hpp)
      const aIsCImpl = /\.(?:c|cpp|cxx|cc)$/i.test(a.uri.fsPath) ? 1 : 0;
      const bIsCImpl = /\.(?:c|cpp|cxx|cc)$/i.test(b.uri.fsPath) ? 1 : 0;
      if (aIsCImpl !== bIsCImpl) {
        return bIsCImpl - aIsCImpl;
      }

      return 0;
    });
  }

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

  private scanLocalDocument(
    document: vscode.TextDocument,
    symbolName: string
  ): SymbolDefinition | null {
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const regexList = [
      new RegExp(`^(\\s*)(?:self|cls)\\.(${symbolName})\\b(?:\\s*:\\s*[^=]+)?\\s*=`),
      new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${symbolName})\\s*\\(`),
      new RegExp(`^(\\s*)class\\s+(${symbolName})\\b`),
      new RegExp(`^(\\s*)(${symbolName})\\b(?:\\s*:\\s*[^=]+)?\\s*=`),
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(symbolName)) {
        continue;
      }
      for (const regex of regexList) {
        const match = regex.exec(line);
        if (match) {
          const startCol = line.indexOf(symbolName);
          const endCol = startCol + symbolName.length;
          return {
            name: symbolName,
            kind: line.includes('def ') ? 'method' : line.includes('class ') ? 'class' : 'property',
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

  private async handleUsages(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolName: string
  ): Promise<void> {
    const usages = await UsageResolver.findUsages(document, position, symbolName);
    if (usages.length === 0) {
      vscode.window.showInformationMessage(`XF OmniJump: No usages found for "${symbolName}".`);
      return;
    }

    if (usages.length === 1) {
      await this.jumpToLocation(usages[0].uri, usages[0].range.start);
      return;
    }

    await this.showUsagesQuickPick(symbolName, usages);
  }

  private async showUsagesQuickPick(
    symbolName: string,
    usages: UsageItem[]
  ): Promise<void> {
    interface UsageQuickPickItem extends vscode.QuickPickItem {
      usage: UsageItem;
    }

    const items: UsageQuickPickItem[] = usages.map((u) => {
      return {
        label: `$(references) ${u.text}`,
        description: `${u.relativePath}:${u.range.start.line + 1}`,
        detail: `Line ${u.range.start.line + 1}: ${u.text}`,
        usage: u,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Usages of "${symbolName}" (${usages.length} found)`,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) {
      await this.jumpToLocation(selected.usage.uri, selected.usage.range.start);
    }
  }

  private getKindIcon(kind: SymbolKind): string {
    switch (kind) {
      case 'class':
        return '$(symbol-class)';
      case 'method':
        return '$(symbol-method)';
      case 'function':
        return '$(symbol-function)';
      case 'property':
        return '$(symbol-property)';
      case 'constant':
        return '$(symbol-constant)';
      case 'variable':
        return '$(symbol-variable)';
      case 'interface':
        return '$(symbol-interface)';
      case 'module':
        return '$(package)';
      default:
        return '$(symbol-misc)';
    }
  }
}
