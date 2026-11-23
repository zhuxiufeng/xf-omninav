import * as vscode from 'vscode';
import { NavigationHistoryItem } from '../types';

export class JumpHistory {
  private stack: NavigationHistoryItem[] = [];
  private maxHistory: number = 50;

  /**
   * Push current location before jumping.
   */
  public pushCurrentLocation(editor?: vscode.TextEditor): void {
    const current = editor || vscode.window.activeTextEditor;
    if (!current) {
      return;
    }

    // Sync with VS Code native navigation stack so Vim (Ctrl+O) and Alt+Left work seamlessly
    try {
      Promise.resolve(
        vscode.commands.executeCommand('workbench.action.pushEditorLocation')
      ).catch(() => {});
    } catch {}

    const item: NavigationHistoryItem = {
      uri: current.document.uri,
      position: current.selection.active,
      timestamp: Date.now(),
    };

    // Avoid duplicate top items
    if (this.stack.length > 0) {
      const top = this.stack[this.stack.length - 1];
      if (
        top.uri.toString() === item.uri.toString() &&
        top.position.line === item.position.line
      ) {
        return;
      }
    }

    this.stack.push(item);
    if (this.stack.length > this.maxHistory) {
      this.stack.shift();
    }
  }

  /**
   * Pop previous location and navigate back.
   */
  public async popAndNavigate(): Promise<boolean> {
    if (this.stack.length === 0) {
      // Fallback to VS Code native navigate back
      try {
        await Promise.resolve(
          vscode.commands.executeCommand('workbench.action.navigateBack')
        ).catch(() => {});
      } catch {}
      return true;
    }

    const item = this.stack.pop();
    if (!item) {
      return false;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      editor.selection = new vscode.Selection(item.position, item.position);
      editor.revealRange(
        new vscode.Range(item.position, item.position),
        vscode.TextEditorRevealType.InCenter
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all recorded navigation history items (newest first).
   */
  public getHistory(): NavigationHistoryItem[] {
    return [...this.stack].reverse();
  }

  /**
   * Show PyCharm-style Recent Locations QuickPick (Ctrl+E / Recent Locations).
   */
  public async showRecentLocations(): Promise<void> {
    const history = this.getHistory();
    if (history.length === 0) {
      vscode.window.showInformationMessage('XF OmniNav: 暂无最近跳转历史 (Recent Locations is empty)');
      return;
    }

    interface RecentLocationQuickPickItem extends vscode.QuickPickItem {
      item: NavigationHistoryItem;
    }

    const path = await import('path');
    const pickItems: RecentLocationQuickPickItem[] = [];

    for (const h of history) {
      const fsPath = h.uri.fsPath;
      const basename = path.basename(fsPath);
      const lineNum = h.position.line;

      let linePreview = '';
      try {
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === h.uri.toString()
        );
        if (openDoc && lineNum < openDoc.lineCount) {
          linePreview = openDoc.lineAt(lineNum).text.trim();
        } else {
          linePreview = vscode.workspace.asRelativePath(h.uri);
        }
      } catch {
        linePreview = vscode.workspace.asRelativePath(h.uri);
      }

      pickItems.push({
        label: `$(history) ${basename}`,
        description: `Line ${lineNum + 1}`,
        detail: linePreview ? `  ${linePreview}` : undefined,
        item: h,
      });
    }

    const picked = await vscode.window.showQuickPick(pickItems, {
      placeHolder: '选择要跳转的最近位置 (Recent Locations / Jump Stack)',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (picked) {
      try {
        const doc = await vscode.workspace.openTextDocument(picked.item.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(picked.item.position, picked.item.position);
        editor.revealRange(
          new vscode.Range(picked.item.position, picked.item.position),
          vscode.TextEditorRevealType.InCenter
        );
      } catch {}
    }
  }
}

export const globalHistory = new JumpHistory();
