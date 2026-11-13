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
  private activeDocErrors: number = 0;

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
   * Set live argument error count for the currently active document.
   */
  public setActiveDocumentErrors(count: number): void {
    this.activeDocErrors = count;
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
      this.statusBarItem.color = undefined;
      return;
    }

    const symbolCount = this.indexer.totalSymbols;
    const fileCount = this.indexer.totalFiles;

    const formattedSymbols = symbolCount > 0 ? symbolCount.toLocaleString() : '0';
    if (this.activeDocErrors > 0) {
      this.statusBarItem.text = `$(symbol-class) OmniNav: ${formattedSymbols} $(error) ${this.activeDocErrors}`;
      this.statusBarItem.color = '#ff6b6b';
    } else {
      this.statusBarItem.text = `$(symbol-class) OmniNav: ${formattedSymbols} $(check)`;
      this.statusBarItem.color = undefined;
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.appendMarkdown(`### 🧭 **XF OmniNav Suite**\n\n`);
    tooltip.appendMarkdown(`- **Indexed Files**: \`${fileCount.toLocaleString()}\`\n`);
    tooltip.appendMarkdown(`- **Active Symbols**: \`${formattedSymbols}\`\n`);
    tooltip.appendMarkdown(
      `- **Active File Status**: ${
        this.activeDocErrors > 0
          ? `❌ **${this.activeDocErrors}** argument / type mismatch error(s) detected (Press F2 to navigate)`
          : `✅ All calls verified clean`
      }\n\n`
    );
    tooltip.appendMarkdown(`*Click to open OmniNav actions menu*`);

    this.statusBarItem.tooltip = tooltip;
  }

  /**
   * Display interactive QuickPick menu for common OmniNav actions.
   */
  public async showMenu(): Promise<void> {
    const items: (vscode.QuickPickItem & { action: () => Promise<void> | void })[] = [
      {
        label: '$(arrow-down) Jump to Next Parameter Error (F2)',
        description: 'Navigate to next call argument or type mismatch in active file',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.nextCallArgumentError');
        },
      },
      {
        label: '$(arrow-up) Jump to Previous Parameter Error (Shift+F2)',
        description: 'Navigate to previous call argument or type mismatch in active file',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.prevCallArgumentError');
        },
      },
      {
        label: '$(history) Show Recent Locations (Ctrl+E)',
        description: 'View and jump back to recently visited code positions (PyCharm Style)',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.showRecentLocations');
        },
      },
      {
        label: '$(symbol-structure) Show File Structure Outline (Ctrl+F12)',
        description: 'Floating outline of classes and methods with inherited toggle (PyCharm Style)',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.showFileStructure');
        },
      },
      {
        label: '$(call-incoming) Show Call Hierarchy (Ctrl+Alt+H)',
        description: 'Inspect who calls this function (Callers) and who it calls (Callees)',
        action: async () => {
          await vscode.commands.executeCommand('xfOmniNav.showCallHierarchy');
        },
      },
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
