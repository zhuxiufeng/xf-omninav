import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { OmniStatusBar } from '../statusBar/omniStatusBar';
import { getOmniConfig } from '../utils';

/**
 * Subsystem responsible for Status Bar indicators and command namespace registration.
 */
export class UiSubsystem implements vscode.Disposable {
  public readonly omniStatusBar: OmniStatusBar;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexer: SymbolIndexer
  ) {
    this.omniStatusBar = new OmniStatusBar(indexer);
    this.disposables.push(this.omniStatusBar);
  }

  public activate(
    registerMulti: (baseName: string, cb: (...args: any[]) => any) => void
  ): void {
    registerMulti('showStatusBarMenu', async () => {
      await this.omniStatusBar.showMenu();
    });
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

/**
 * Register command across all historic / backward-compatible namespaces.
 */
export function createCommandMultiplexer(context: vscode.ExtensionContext) {
  return (baseName: string, callback: (...args: any[]) => any) => {
    const namespaces = ['xfOmniNav', 'xfOmniJump', 'xfOmniTree', 'inheritanceNavigator', 'smoothJump'];
    for (const ns of namespaces) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`${ns}.${baseName}`, callback)
      );
    }
  };
}
