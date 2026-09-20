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
      await vscode.commands.executeCommand('workbench.action.navigateBack');
      return true;
    }

    const item = this.stack.pop();
    if (!item) {
      return false;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      const editor = await vscode.window.showTextDocument(doc);
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
}

export const globalHistory = new JumpHistory();
