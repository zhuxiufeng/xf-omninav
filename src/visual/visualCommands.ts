import * as vscode from 'vscode';
import { TargetLocation } from '../types';
import { serializableToRange, formatLocationLabel } from '../utils';
import { InheritanceDecorator } from './gutterDecorator';
import { globalHistory } from '../navigation/jumpHistory';

export class InheritanceCommands {
  constructor(private decorator: InheritanceDecorator) {}

  /**
   * Jump directly to a TargetLocation (e.g. from hover link).
   */
  public async jumpToLocation(target: any): Promise<void> {
    if (Array.isArray(target)) {
      target = target[0];
    }
    if (!target || !target.uri || !target.range) {
      return;
    }

    const currentEditor = vscode.window.activeTextEditor;
    if (currentEditor) {
      globalHistory.pushCurrentLocation(currentEditor);
    }

    const uriStr = target.uri || target.targetUri;
    if (!uriStr) {
      return;
    }

    try {
      const uri = typeof uriStr === 'string' ? vscode.Uri.parse(uriStr) : uriStr;
      const doc = await vscode.workspace.openTextDocument(uri);
      const range = target.range
        ? serializableToRange(target.range)
        : new vscode.Range(0, 0, 0, 0);

      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: false,
      });

      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to navigate to target: ${String(err)}`);
    }
  }

  /**
   * Jump to superclass or super method at current cursor position or right-clicked gutter line.
   */
  public async jumpToParent(arg?: any): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    let line = editor.selection.active.line;
    if (typeof arg === 'number') {
      line = arg;
    } else if (arg && typeof arg.lineNumber === 'number') {
      line = arg.lineNumber - 1; // VS Code gutter passes 1-based lineNumber
    } else if (arg && typeof arg.line === 'number') {
      line = arg.line;
    }

    const pos = new vscode.Position(line, 0);
    const marker = this.decorator.getMarkerAtPosition(
      editor.document.uri,
      pos
    );

    if (!marker || marker.parents.length === 0) {
      vscode.window.showInformationMessage(
        'Inheritance: No superclass or overridden method found at this position.'
      );
      return;
    }

    await this.navigateTargets(marker.parents, `Select superclass / method to navigate`);
  }

  /**
   * Jump to subclass or overriding method at current cursor position or right-clicked gutter line.
   */
  public async jumpToChild(arg?: any): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    let line = editor.selection.active.line;
    if (typeof arg === 'number') {
      line = arg;
    } else if (arg && typeof arg.lineNumber === 'number') {
      line = arg.lineNumber - 1;
    } else if (arg && typeof arg.line === 'number') {
      line = arg.line;
    }

    const pos = new vscode.Position(line, 0);
    const marker = this.decorator.getMarkerAtPosition(
      editor.document.uri,
      pos
    );

    if (!marker || marker.children.length === 0) {
      vscode.window.showInformationMessage(
        'Inheritance: No subclass or overriding method found at this position.'
      );
      return;
    }

    await this.navigateTargets(marker.children, `Select subclass / implementation to navigate`);
  }

  /**
   * Handle single or multiple navigation targets.
   */
  public async navigateTargets(targets: TargetLocation[], placeHolder: string): Promise<void> {
    if (targets.length === 0) {
      return;
    }

    if (targets.length === 1) {
      await this.jumpToLocation(targets[0]);
      return;
    }

    // Multiple targets: present QuickPick
    interface QuickPickItemWithTarget extends vscode.QuickPickItem {
      target: TargetLocation;
    }

    const items: QuickPickItemWithTarget[] = await Promise.all(
      targets.map(async (t) => {
        const fileLoc = formatLocationLabel(t.uri, t.range.startLine);
        let preview = t.preview;

        // Try to fetch code preview line if not already cached
        if (!preview) {
          try {
            const uri = vscode.Uri.parse(t.uri);
            const doc = await vscode.workspace.openTextDocument(uri);
            const line = doc.lineAt(t.range.startLine);
            preview = line.text.trim();
          } catch {
            preview = undefined;
          }
        }

        const icon = t.kind === 'class' ? '$(symbol-class)' : '$(symbol-method)';

        return {
          label: `${icon} ${t.name}`,
          description: fileLoc,
          detail: preview || t.description,
          target: t,
        };
      })
    );

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) {
      await this.jumpToLocation(selected.target);
    }
  }

  /**
   * Show QuickPick for multiple targets directly (e.g. from CodeLens click).
   */
  public async showTargetsQuickPick(
    targets: any,
    placeHolder?: string
  ): Promise<void> {
    if (Array.isArray(targets) && targets.length > 0 && Array.isArray(targets[0])) {
      targets = targets[0];
    }
    if (!Array.isArray(targets)) {
      return;
    }
    await this.navigateTargets(targets, placeHolder || 'Select target to navigate');
  }
}

