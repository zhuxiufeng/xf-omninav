import * as vscode from 'vscode';
import { SymbolIndexer } from './indexer/symbolIndexer';
import { isOmniConfigAffected } from './utils';
import { FoldingCache } from './folding/foldingCache';
import { FoldingSubsystem } from './subsystems/foldingSubsystem';
import { InspectionSubsystem } from './subsystems/inspectionSubsystem';
import { NavigationSubsystem } from './subsystems/navigationSubsystem';
import { UiSubsystem, createCommandMultiplexer } from './subsystems/uiSubsystem';

/**
 * XF OmniNav - Universal PyCharm-Grade IDE Enhancement & Navigation Suite.
 * Core Entry Point coordinating modular subsystems:
 * - Navigation: Precision symbol jump, inheritance tree, override arrows & CodeLens
 * - Inspection: Heuristic call argument inspector, missing/unexpected keywords, inlay hints & quick fixes
 * - Folding: PyCharm-style independent branch folding (Python, Shell, C/C++, TS/JS/Go, Rust)
 * - UI: Omni status bar, health monitor, and command namespace routing
 */
export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('XF OmniNav');
  outputChannel.appendLine('[XF OmniNav] Activating PyCharm-grade enhancement suite...');

  // 1. Core Symbol Indexer
  const indexer = new SymbolIndexer(context);
  context.subscriptions.push(indexer);

  // Cold-boot cache hydration (~5ms)
  indexer.loadFromDiskCache().then((loaded) => {
    if (loaded) {
      outputChannel.appendLine(
        `[XF OmniNav] Restored ${indexer.totalSymbols.toLocaleString()} symbols across ${indexer.totalFiles} files from persistent disk cache.`
      );
    }
  });

  // 2. Command Multiplexer for backward-compatible namespaces
  const registerMulti = createCommandMultiplexer(context);

  // 3. Subsystem Initialization
  const uiSubsystem = new UiSubsystem(context, indexer);
  const foldingSubsystem = new FoldingSubsystem();
  const navigationSubsystem = new NavigationSubsystem(context, indexer, outputChannel);
  const inspectionSubsystem = new InspectionSubsystem(indexer);

  context.subscriptions.push(
    uiSubsystem,
    foldingSubsystem,
    navigationSubsystem,
    inspectionSubsystem
  );

  // 4. Activate Subsystems
  uiSubsystem.activate(registerMulti);
  foldingSubsystem.activate(context, registerMulti);
  navigationSubsystem.activate(registerMulti);
  inspectionSubsystem.activate(context, registerMulti, outputChannel);

  // 5. Global Index Commands
  registerMulti('rebuildIndex', async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'XF OmniNav: Indexing workspace symbols...',
        cancellable: false,
      },
      async () => {
        navigationSubsystem.clearAllCaches();
        await indexer.indexWorkspace();
      }
    );
    vscode.window.showInformationMessage(
      `XF OmniNav: Indexed ${indexer.totalSymbols.toLocaleString()} symbols across ${indexer.totalFiles.toLocaleString()} files.`
    );
  });

  // 6. Unified Editor & Document Event Listeners
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        indexer.indexDocument(editor.document);
        uiSubsystem.updateIndexStatusBar(indexer.totalSymbols);
        navigationSubsystem.onActiveEditorChanged(editor);
        foldingSubsystem.fireDidChange(editor.document.languageId);
        inspectionSubsystem.triggerInspect(editor);
      } else {
        navigationSubsystem.onActiveEditorChanged(undefined);
      }
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      navigationSubsystem.onSelectionChanged(event);
    }),

    vscode.window.onDidChangeTextEditorVisibleRanges
      ? vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
          navigationSubsystem.onVisibleRangesChanged(event);
        })
      : { dispose: () => {} },

    vscode.workspace.onDidChangeTextDocument((event) => {
      indexer.markDirty(event.document);
      navigationSubsystem.onDocumentChanged(event.document);

      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === event.document.uri.toString()) {
        navigationSubsystem.scheduleAnalysis(editor);
        inspectionSubsystem.triggerInspect(editor);
      }
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      indexer.indexDocument(document);
      navigationSubsystem.onDocumentSaved(document);

      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === document.uri.toString()) {
          navigationSubsystem.scheduleAnalysis(editor);
        }
      }
    }),

    vscode.workspace.onDidCloseTextDocument((document) => {
      FoldingCache.delete(document.uri.toString());
      navigationSubsystem.onDocumentClosed(document);
      inspectionSubsystem.clearDocument(document.uri);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (isOmniConfigAffected(e)) {
        foldingSubsystem.syncFoldingProviders();
        navigationSubsystem.refreshAllDecorations();
        inspectionSubsystem.refreshAllDecorations();

        for (const editor of vscode.window.visibleTextEditors) {
          navigationSubsystem.scheduleAnalysis(editor);
          inspectionSubsystem.triggerInspect(editor);
        }
      }
    })
  );

  // Yield gutter space when debugging breakpoints change
  if (vscode.debug && vscode.debug.onDidChangeBreakpoints) {
    context.subscriptions.push(
      vscode.debug.onDidChangeBreakpoints(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          navigationSubsystem.decorator.applyDecorations(
            editor,
            navigationSubsystem.decorator.getMarkers(editor.document.uri)
          );
        }
      })
    );
  }

  // 7. Initial Startup Indexing & Background Pre-scan
  if (vscode.window.activeTextEditor) {
    const editor = vscode.window.activeTextEditor;
    indexer.indexDocument(editor.document);
    uiSubsystem.updateIndexStatusBar(indexer.totalSymbols);
    navigationSubsystem.triggerAnalysis(editor, false, true);
    inspectionSubsystem.triggerInspect(editor);
  }

  setTimeout(() => {
    indexer.indexWorkspace().then(() => {
      uiSubsystem.updateIndexStatusBar(indexer.totalSymbols);
      if (vscode.window.activeTextEditor) {
        inspectionSubsystem.triggerInspect(vscode.window.activeTextEditor);
      }
      inspectionSubsystem.scanGitModifiedFiles().then((errCount) => {
        if (errCount > 0) {
          outputChannel.appendLine(
            `[XF OmniNav] Git pre-scan found errors in ${errCount} modified file(s).`
          );
        }
      });
    });
  }, 1000);

  outputChannel.appendLine('[XF OmniNav] Subsystems activated cleanly.');
}

export function deactivate() {}
