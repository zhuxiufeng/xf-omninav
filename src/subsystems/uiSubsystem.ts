import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { OmniStatusBar } from '../statusBar/omniStatusBar';
import { getOmniConfig } from '../utils';

/**
 * Subsystem responsible for Status Bar indicators and command namespace registration.
 */
export class UiSubsystem implements vscode.Disposable {
  public readonly omniStatusBar: OmniStatusBar;
  private indexStatusBar: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexer: SymbolIndexer
  ) {
    this.omniStatusBar = new OmniStatusBar(indexer);

    this.indexStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90
    );
    this.indexStatusBar.command = 'xfOmniNav.rebuildIndex';

    this.disposables.push(this.omniStatusBar, this.indexStatusBar);
  }

  public activate(
    registerMulti: (baseName: string, cb: (...args: any[]) => any) => void
  ): void {
    registerMulti('showStatusBarMenu', async () => {
      await this.omniStatusBar.showMenu();
    });

    this.disposables.push(
      this.indexer.onDidIndexUpdate((count) => {
        this.updateIndexStatusBar(count);
      })
    );

    this.updateIndexStatusBar(this.indexer.totalSymbols);
  }

  public updateIndexStatusBar(count: number): void {
    if (!getOmniConfig<boolean>('showStatusBar', true)) {
      this.indexStatusBar.hide();
      return;
    }
    this.indexStatusBar.text = `$(search) OmniNav: ${count.toLocaleString()}`;
    this.indexStatusBar.tooltip = `XF OmniNav: ${count.toLocaleString()} symbols indexed in ${this.indexer.totalFiles} files. Click to re-index.`;
    this.indexStatusBar.show();
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
