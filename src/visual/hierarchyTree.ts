import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { SymbolDefinition } from '../types';

/**
 * PyCharm-style interactive Type Hierarchy Tree Viewer and Abstract Method Generator.
 * Lets developers explore complete class inheritance trees (Ancestors & Descendants)
 * and generate missing abstract method stubs in one click.
 */
export class HierarchyTreeViewer {
  /**
   * Display interactive QuickPick tree of class ancestors and descendants.
   */
  public static async showHierarchyTree(
    indexer: SymbolIndexer,
    targetClassName?: string
  ): Promise<void> {
    let className = targetClassName;

    // 1. If not provided, inspect cursor word in active editor
    if (!className && vscode.window.activeTextEditor) {
      const editor = vscode.window.activeTextEditor;
      const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
      if (wordRange) {
        const word = editor.document.getText(wordRange);
        const exact = indexer.findExact(word);
        if (exact.some((d) => d.kind === 'class')) {
          className = word;
        } else {
          // Check if cursor is inside a method of a class
          const line = editor.selection.active.line;
          for (let l = line; l >= 0; l--) {
            const text = editor.document.lineAt(l).text.trim();
            const classMatch = text.match(/^class\s+([A-Za-z0-9_]+)/);
            if (classMatch) {
              className = classMatch[1];
              break;
            }
          }
        }
      }
    }

    // 2. If still not determined, prompt with QuickPick of all indexed classes
    if (!className) {
      const allClassNames = indexer.getAllClassNames();
      if (allClassNames.length === 0) {
        vscode.window.showInformationMessage('XF OmniNav: No classes indexed in current workspace.');
        return;
      }
      const pick = await vscode.window.showQuickPick(allClassNames.sort(), {
        placeHolder: 'Select class to view Type Hierarchy Tree (PyCharm Style)',
      });
      if (!pick) return;
      className = pick;
    }

    // 3. Collect Ancestors & Descendants
    const superClasses = indexer.getSuperClasses(className);
    const subClasses = indexer.getSubClasses(className);

    interface HierarchyItem extends vscode.QuickPickItem {
      def?: SymbolDefinition;
      action?: () => Promise<void>;
    }

    const items: HierarchyItem[] = [];

    // Ancestor Base Classes (Top-down)
    const reversedBases = [...superClasses].reverse();
    for (let i = 0; i < reversedBases.length; i++) {
      const baseName = reversedBases[i];
      const defs = indexer.findExact(baseName).filter((d) => d.kind === 'class');
      const def = defs[0];
      const indent = '  '.repeat(i);
      const loc = def ? `${def.fileRelativePath}:${def.range.start.line + 1}` : 'external / library';
      items.push({
        label: `${indent}▲ [Base] ${baseName}`,
        description: loc,
        detail: `Superclass in inheritance chain`,
        def,
      });
    }

    // Current Target Class
    const currentDefs = indexer.findExact(className).filter((d) => d.kind === 'class');
    const currentDef = currentDefs[0];
    const currentIndent = '  '.repeat(reversedBases.length);
    const currentLoc = currentDef
      ? `${currentDef.fileRelativePath}:${currentDef.range.start.line + 1}`
      : 'workspace';
    items.push({
      label: `${currentIndent}▶ [Current] ${className}`,
      description: currentLoc,
      detail: `Target Class (${superClasses.length} bases, ${subClasses.length} subclasses)`,
      def: currentDef,
    });

    // Descendant Subclasses
    for (let i = 0; i < subClasses.length; i++) {
      const subName = subClasses[i];
      const defs = indexer.findExact(subName).filter((d) => d.kind === 'class');
      const def = defs[0];
      const indent = '  '.repeat(reversedBases.length + 1);
      const loc = def ? `${def.fileRelativePath}:${def.range.start.line + 1}` : 'workspace';
      items.push({
        label: `${indent}▼ [Sub] ${subName}`,
        description: loc,
        detail: `Derived class overriding or extending ${className}`,
        def,
      });
    }

    // Check for unimplemented abstract methods
    const missingAbstracts = this.findMissingAbstractMethods(indexer, className);
    if (missingAbstracts.length > 0 && currentDef) {
      items.push({
        label: `$(tools) Generate ${missingAbstracts.length} Missing Abstract Method Stub(s)`,
        description: missingAbstracts.map((m) => m.name).join(', '),
        detail: `PyCharm-style QuickFix: automatically insert method stubs into '${className}'`,
        action: async () => {
          await this.implementMissingAbstractMethods(currentDef, missingAbstracts);
        },
      });
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Type Hierarchy: ${className} (▲ ${superClasses.length} superclasses, ▼ ${subClasses.length} subclasses)`,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) {
      if (selected.action) {
        await selected.action();
      } else if (selected.def) {
        await vscode.commands.executeCommand('xfOmniNav.jumpToLocation', selected.def);
      }
    }
  }

  /**
   * Find abstract methods in base classes that are not implemented in the target class.
   */
  public static findMissingAbstractMethods(
    indexer: SymbolIndexer,
    className: string
  ): SymbolDefinition[] {
    const superClasses = indexer.getSuperClasses(className);
    if (superClasses.length === 0) return [];

    // All methods implemented in current class
    const currentClassMethods = new Set(
      indexer.getMethodsInClass(className).map((d) => d.name)
    );

    const missing: SymbolDefinition[] = [];
    const seenNames = new Set<string>();

    for (const base of superClasses) {
      const baseDefs = indexer
        .getMethodsInClass(base)
        .filter((d) => d.isAbstract);

      for (const m of baseDefs) {
        if (!currentClassMethods.has(m.name) && !seenNames.has(m.name)) {
          seenNames.add(m.name);
          missing.push(m);
        }
      }
    }

    return missing;
  }

  /**
   * Generate Python / TypeScript method stubs for missing abstract methods.
   */
  public static async implementMissingAbstractMethods(
    classDef: SymbolDefinition,
    missingMethods: SymbolDefinition[]
  ): Promise<void> {
    if (missingMethods.length === 0) return;

    try {
      const doc = await vscode.workspace.openTextDocument(classDef.uri);
      const editor = await vscode.window.showTextDocument(doc);

      // Locate insertion line: end of class definition or right after class header
      const classStartLine = classDef.range.start.line;
      let insertLine = Math.min(doc.lineCount - 1, classStartLine + 1);

      // Determine class indentation
      const classLineText = doc.lineAt(classStartLine).text;
      const classIndentMatch = classLineText.match(/^(\s*)/);
      const classIndent = classIndentMatch ? classIndentMatch[1] : '';
      const methodIndent = classIndent + '    ';

      // Scan to find the last line of the class
      for (let l = classStartLine + 1; l < doc.lineCount; l++) {
        const line = doc.lineAt(l).text;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        if (indent <= classIndent.length && !trimmed.startsWith('@')) {
          insertLine = l;
          break;
        }
        insertLine = l + 1;
      }

      const isPython = classDef.uri.fsPath.endsWith('.py');
      let stubs = '\n';

      for (const m of missingMethods) {
        const sig = m.signature && m.signature.includes('(') ? m.signature : `def ${m.name}(self):`;
        if (isPython) {
          stubs += `${methodIndent}${sig}\n`;
          stubs += `${methodIndent}    raise NotImplementedError\n\n`;
        } else {
          stubs += `${methodIndent}${sig} {\n`;
          stubs += `${methodIndent}    throw new Error('Method not implemented.');\n`;
          stubs += `${methodIndent}}\n\n`;
        }
      }

      const edit = new vscode.WorkspaceEdit();
      const insertPos = new vscode.Position(insertLine, 0);
      edit.insert(classDef.uri, insertPos, stubs);
      await vscode.workspace.applyEdit(edit);

      editor.revealRange(
        new vscode.Range(insertPos, insertPos),
        vscode.TextEditorRevealType.InCenter
      );
      vscode.window.showInformationMessage(
        `XF OmniNav: Generated ${missingMethods.length} abstract method stub(s) for '${classDef.name}'.`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`XF OmniNav Stub Generation Error: ${String(err)}`);
    }
  }
}
