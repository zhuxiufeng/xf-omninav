import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { getOmniConfig } from '../utils';

/**
 * Universal Status Bar item for XF OmniNav.
 * Displays live indexed symbol count, indexing state, and provides a quick action menu.
 */
export class OmniStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly indexer: SymbolIndexer) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      95
    );
    this.statusBarItem.command = 'xfOmniNav.showStatusBarMenu';
    this.disposables.push(this.statusBarItem);

    // Subscribe to indexer updates
    this.disposables.push(
      this.indexer.onDidIndexUpdate(() => {
        this.update();
      })
    );

    this.update();
  }

  /**
   * Update status bar text and tooltip based on index state.
   */
  public update(): void {
    if (!getOmniConfig<boolean>('showStatusBar', true)) {
      this.statusBarItem.hide();
      return;
    }
    this.statusBarItem.show();

    if (this.indexer.indexing) {
      this.statusBarItem.text = '$(sync~spin) OmniNav: Indexing...';
      this.statusBarItem.tooltip = 'XF OmniNav is currently scanning workspace symbols...';
      return;
    }

    const symbolCount = this.indexer.totalSymbols;
    const fileCount = this.indexer.totalFiles;

    const formattedSymbols = symbolCount > 0 ? symbolCount.toLocaleString() : '0';
    this.statusBarItem.text = `$(symbol-class) OmniNav: ${formattedSymbols}`;

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.appendMarkdown(`### 🧭 **XF OmniNav Suite**\n\n`);
    tooltip.appendMarkdown(`- **Indexed Files**: \`${fileCount.toLocaleString()}\`\n`);
    tooltip.appendMarkdown(`- **Active Symbols**: \`${formattedSymbols}\`\n`);
    tooltip.appendMarkdown(`- **Call Argument Inspector**: \`Active\`\n\n`);
    tooltip.appendMarkdown(`*Click to open OmniNav actions menu*`);

    this.statusBarItem.tooltip = tooltip;
  }

  /**
   * Display interactive QuickPick menu for common OmniNav actions.
   */
  public async showMenu(): Promise<void> {
    const items: (vscode.QuickPickItem & { action: () => Promise<void> | void })[] = [
      {
        label: '$(refresh) Reload Window (重新加载窗口)',
        description: 'Reload editor window to apply latest extension updates immediately',
        action: async () => {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        },
      },
      {
        label: '$(sync) Rebuild Symbol Index',
        description: 'Force re-scan all workspace files and refresh persistent cache',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.rebuildIndex');
        },
      },
      {
        label: '$(search) Inspect Active File Calls',
        description: 'Re-analyze current file for missing arguments and type mismatches',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.inspectCallArguments');
        },
      },
      {
        label: '$(list-tree) Show Class Hierarchy Tree (PyCharm Style)',
        description: 'Interactive tree view of ancestors, subclasses, and missing abstract methods',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.showHierarchyTree');
        },
      },
      {
        label: '$(graph) Export Inheritance Hierarchy (Mermaid)',
        description: 'Generate and export class diagram to Markdown / Mermaid preview',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.exportMermaidHierarchy');
        },
      },
      {
        label: '$(symbol-parameter) Toggle Parameter Inlay Hints',
        description: 'Show/hide inline parameter names in function calls (PyCharm style)',
        action: async () => {
          const config = vscode.workspace.getConfiguration('xfOmniNav');
          const current = config.get<boolean>('enablePythonParamInlayHints', true);
          await config.update('enablePythonParamInlayHints', !current, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(
            `XF OmniNav: Parameter Inlay Hints ${!current ? 'Enabled' : 'Disabled'}`
          );
        },
      },
      {
        label: '$(error) Toggle Call Argument Inspection',
        description: 'Enable/disable heuristic parameter count checking',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.toggleCallArgumentInspection');
        },
      },
      {
        label: '$(gear) Open OmniNav Settings',
        description: 'Configure folding, debouncing, decorators, and analysis options',
        action: async () => {
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xf.omninav');
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `XF OmniNav (${this.indexer.totalSymbols.toLocaleString()} symbols across ${this.indexer.totalFiles} files)`,
    });

    if (pick) {
      await pick.action();
    }
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
