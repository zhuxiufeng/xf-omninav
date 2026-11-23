import * as vscode from 'vscode';
import * as path from 'path';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { UsageResolver } from '../resolver/usageResolver';
import { ContextResolver } from '../resolver/contextResolver';
import { SymbolDefinition } from '../types';

interface CallHierarchyQuickPickItem extends vscode.QuickPickItem {
  uri?: vscode.Uri;
  position?: vscode.Position;
  range?: vscode.Range;
  isHeader?: boolean;
}

/**
 * Universal Call Hierarchy Viewer (PyCharm Ctrl+Alt+H Style).
 * Inspects who calls the current function (Callers) and who the current function calls (Callees).
 */
export class CallHierarchyViewer {
  constructor(private readonly indexer: SymbolIndexer) {}

  public async showHierarchy(editor?: vscode.TextEditor): Promise<void> {
    const activeEditor = editor || vscode.window.activeTextEditor;
    if (!activeEditor || !activeEditor.document) {
      vscode.window.showInformationMessage('XF OmniNav: 请先在代码中将光标置于函数或方法上');
      return;
    }

    const doc = activeEditor.document;
    const pos = activeEditor.selection.active;
    const wordRange = doc.getWordRangeAtPosition(pos);
    if (!wordRange) {
      vscode.window.showInformationMessage('XF OmniNav: 当前光标位置未找到符号名称');
      return;
    }

    const symbolName = doc.getText(wordRange);
    this.indexer.ensureSynchronized(doc.uri);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `XF OmniNav: 正在分析 '${symbolName}' 调用关系树...`,
        cancellable: false,
      },
      async () => {
        // 1. Fetch Callers (who calls this function)
        const usages = await UsageResolver.findUsages(doc, pos, symbolName, this.indexer);
        const callers = usages.filter(
          (u) => !(u.uri.toString() === doc.uri.toString() && u.range.start.line === pos.line)
        );

        // 2. Fetch Callees (who this function calls)
        const callees = this.findCallees(doc, pos, symbolName);

        // 3. Build QuickPick items
        const items: CallHierarchyQuickPickItem[] = [];

        // Header: Target Symbol
        items.push({
          label: `$(symbol-method) 目标方法: ${symbolName}`,
          description: `${callers.length} 处传入调用 (Callers) | ${callees.length} 处传出调用 (Callees)`,
          isHeader: true,
        });

        // Section 1: Callers
        items.push({
          label: `--- 谁调用了我 (Callers: ${callers.length}) ---`,
          isHeader: true,
        });

        if (callers.length === 0) {
          items.push({
            label: '  $(info) 未在工作区中检测到直接调用点',
            isHeader: true,
          });
        } else {
          for (const c of callers) {
            const fileName = path.basename(c.uri.fsPath);
            const lineNum = c.range.start.line + 1;
            items.push({
              label: `  $(arrow-right) ${fileName}:${lineNum}`,
              description: c.relativePath || fileName,
              detail: c.text ? `    ${c.text.trim()}` : undefined,
              uri: c.uri,
              position: c.range.start,
              range: c.range,
            });
          }
        }

        // Section 2: Callees
        items.push({
          label: `--- 我调用了谁 (Callees: ${callees.length}) ---`,
          isHeader: true,
        });

        if (callees.length === 0) {
          items.push({
            label: '  $(info) 当前方法内部未调用其他命名函数',
            isHeader: true,
          });
        } else {
          for (const callee of callees) {
            const fileName = path.basename(callee.uri.fsPath);
            const lineNum = callee.range.start.line + 1;
            items.push({
              label: `  $(arrow-left) ${callee.name}`,
              description: callee.containerName
                ? `in ${callee.containerName} (${fileName}:${lineNum})`
                : `${fileName}:${lineNum}`,
              detail: callee.signature ? `    ${callee.signature}` : undefined,
              uri: callee.uri,
              position: callee.range.start,
              range: callee.range,
            });
          }
        }

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `调用关系树: ${symbolName} (PyCharm 风格调用层级，回车直接跳转)`,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (picked && !picked.isHeader && picked.uri && picked.position) {
          const targetDoc =
            picked.uri.toString() === doc.uri.toString()
              ? doc
              : await vscode.workspace.openTextDocument(picked.uri);
          const targetEditor = await vscode.window.showTextDocument(targetDoc);
          targetEditor.selection = new vscode.Selection(picked.position, picked.position);
          targetEditor.revealRange(
            picked.range || new vscode.Range(picked.position, picked.position),
            vscode.TextEditorRevealType.InCenter
          );
        }
      }
    );
  }

  /**
   * Find methods called inside the target function body.
   */
  private findCallees(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _symbolName: string
  ): SymbolDefinition[] {
    const isPython = doc.languageId === 'python';
    const totalLines = doc.lineCount;

    // Determine function body bounds
    let startLine = pos.line;
    while (startLine > 0) {
      const txt = doc.lineAt(startLine).text;
      if (/^\s*(?:async\s+)?def\s+/.test(txt) || /^\s*(?:public|private|protected)?\s*(?:async\s+)?(?:function|\w+)\s*\(/.test(txt)) {
        break;
      }
      startLine--;
    }

    const baseIndent = doc.lineAt(startLine).firstNonWhitespaceCharacterIndex;
    let endLine = startLine + 1;

    for (let l = startLine + 1; l < totalLines; l++) {
      const lineText = doc.lineAt(l).text;
      if (!lineText.trim()) continue;
      const indent = doc.lineAt(l).firstNonWhitespaceCharacterIndex;
      if (isPython && indent <= baseIndent) {
        endLine = l - 1;
        break;
      }
      endLine = l;
    }

    // Extract all calls inside [startLine, endLine]
    const calleeNames = new Set<string>();
    const callRegex = /(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

    for (let l = startLine; l <= endLine; l++) {
      const lineText = doc.lineAt(l).text;
      if (lineText.trim().startsWith('#') || lineText.trim().startsWith('//')) continue;

      let match: RegExpExecArray | null;
      while ((match = callRegex.exec(lineText)) !== null) {
        const calledMethod = match[2];
        if (calledMethod !== 'super' && calledMethod !== 'len' && calledMethod !== 'print') {
          calleeNames.add(calledMethod);
        }
      }
    }

    const results: SymbolDefinition[] = [];
    const seenDefs = new Set<string>();

    for (const name of calleeNames) {
      const exacts = this.indexer.findExact(name);
      for (const def of exacts) {
        if (def.kind === 'method' || def.kind === 'function') {
          const key = `${def.uri.toString()}:${def.range.start.line}`;
          if (!seenDefs.has(key)) {
            seenDefs.add(key);
            results.push(def);
          }
        }
      }
    }

    return results;
  }
}
