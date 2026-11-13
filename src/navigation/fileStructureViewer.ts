import * as vscode from 'vscode';
import * as path from 'path';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { SymbolDefinition, SymbolKind } from '../types';
import { SymbolParser } from '../indexer/symbolParser';

interface StructureQuickPickItem extends vscode.QuickPickItem {
  def?: SymbolDefinition;
  isToggle?: boolean;
}

/**
 * PyCharm-style File Structure Viewer (Ctrl+F12).
 * Displays a lightweight in-editor floating outline with fuzzy filtering
 * and 1-click toggle for inherited parent class methods.
 */
export class FileStructureViewer {
  constructor(private readonly indexer: SymbolIndexer) {}

  public async showFileStructure(
    editor?: vscode.TextEditor,
    includeInherited = false
  ): Promise<void> {
    const activeEditor = editor || vscode.window.activeTextEditor;
    if (!activeEditor || !activeEditor.document) {
      vscode.window.showInformationMessage('XF OmniNav: 请先打开一个代码文件');
      return;
    }

    const doc = activeEditor.document;
    this.indexer.ensureSynchronized(doc.uri);

    let localSymbols = this.indexer.getFileSymbols(doc.uri.toString());
    if (localSymbols.length === 0) {
      localSymbols = SymbolParser.parseDocument(doc);
    }

    const items: StructureQuickPickItem[] = [];

    // 1. Toggle Button at top (PyCharm Alt+I style)
    items.push({
      label: includeInherited
        ? '$(eye) 包含父类继承成员 (Showing Inherited Members)'
        : '$(eye-closed) 仅当前文件成员 (Local Members Only)',
      description: '点击切换是否展示父类继承方法 (PyCharm Alt+I 风格)',
      isToggle: true,
    });

    // 2. Local Symbols
    const classNames = new Set<string>();
    for (const def of localSymbols) {
      if (def.kind === 'class') {
        classNames.add(def.name);
      }
      items.push({
        label: `${this.getKindIcon(def.kind)} ${def.name}`,
        description: def.signature || (def.containerName ? `in ${def.containerName}` : ''),
        detail: `Line ${def.range.start.line + 1}`,
        def,
      });
    }

    // 3. Inherited Members (if enabled)
    if (includeInherited && classNames.size > 0) {
      const localMethodNames = new Set(
        localSymbols.filter((s) => s.kind === 'method').map((s) => `${s.containerName}.${s.name}`)
      );

      for (const clsName of classNames) {
        const superClasses = this.indexer.getSuperClasses(clsName);
        for (const superClass of superClasses) {
          const inheritedDefs = this.getContainerMethods(superClass);
          for (const inhDef of inheritedDefs) {
            const key = `${clsName}.${inhDef.name}`;
            if (localMethodNames.has(key)) {
              continue; // Overridden locally
            }
            items.push({
              label: `${this.getKindIcon(inhDef.kind)} ${inhDef.name}`,
              description: inhDef.signature || `inherited from ${superClass}`,
              detail: `[继承自 ${superClass}] ${path.basename(inhDef.uri.fsPath)}: Line ${
                inhDef.range.start.line + 1
              }`,
              def: inhDef,
            });
          }
        }
      }
    }

    const fileName = path.basename(doc.uri.fsPath);
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `文件结构大纲: ${fileName} (输入名称快速过滤，按 Esc 退出)`,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!picked) return;

    if (picked.isToggle) {
      // Toggle and re-open
      await this.showFileStructure(activeEditor, !includeInherited);
      return;
    }

    if (picked.def) {
      try {
        const targetDoc =
          picked.def.uri.toString() === doc.uri.toString()
            ? doc
            : await vscode.workspace.openTextDocument(picked.def.uri);
        const targetEditor = await vscode.window.showTextDocument(targetDoc);
        targetEditor.selection = new vscode.Selection(
          picked.def.range.start,
          picked.def.range.start
        );
        targetEditor.revealRange(picked.def.range, vscode.TextEditorRevealType.InCenter);
      } catch (err) {
        vscode.window.showErrorMessage(`无法跳转至符号: ${err}`);
      }
    }
  }

  private getContainerMethods(containerName: string): SymbolDefinition[] {
    const results: SymbolDefinition[] = [];
    const allDefs = this.indexer.findExactCaseInsensitive(containerName);
    const containerClasses = allDefs.filter((d) => d.kind === 'class');
    const targetContainer = containerClasses.length > 0 ? containerClasses[0].name : containerName;

    // Search across exact symbols belonging to container
    for (const defs of (this.indexer as any).exactMap.values()) {
      for (const def of defs as SymbolDefinition[]) {
        if (
          def.containerName &&
          def.containerName.toLowerCase() === targetContainer.toLowerCase() &&
          (def.kind === 'method' || def.kind === 'property')
        ) {
          results.push(def);
        }
      }
    }
    return results;
  }

  private getKindIcon(kind: SymbolKind): string {
    switch (kind) {
      case 'class':
        return '$(symbol-class)';
      case 'method':
        return '$(symbol-method)';
      case 'function':
        return '$(symbol-function)';
      case 'interface':
        return '$(symbol-interface)';
      case 'variable':
      case 'property':
        return '$(symbol-field)';
      case 'constant':
        return '$(symbol-constant)';
      default:
        return '$(symbol-misc)';
    }
  }
}
