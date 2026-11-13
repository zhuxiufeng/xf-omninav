import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { InheritanceAnalyzer } from '../indexer/inheritanceAnalyzer';
import { InheritanceDecorator } from '../visual/gutterDecorator';
import { InheritanceCodeLensProvider } from '../visual/codelensProvider';
import { InheritanceInlayHintsProvider } from '../visual/inlayHints';
import { InheritanceCommands } from '../visual/visualCommands';
import {
  SmoothDefinitionProvider,
  SmoothImplementationProvider,
} from '../navigation/definitionProvider';
import { NavigateCommand } from '../navigation/navigateCommand';
import { globalHistory } from '../navigation/jumpHistory';
import { MermaidHierarchyExporter } from '../visual/mermaidExporter';
import { HierarchyTreeViewer } from '../visual/hierarchyTree';
import { FileStructureViewer } from '../navigation/fileStructureViewer';
import { CallHierarchyViewer } from '../navigation/callHierarchyViewer';
import { debounce, getOmniConfig } from '../utils';
import { InheritanceMarker } from '../types';

/**
 * Subsystem responsible for precision symbol definition / implementation jump,
 * class & method inheritance analysis, gutter override indicators, and CodeLens.
 */
export class NavigationSubsystem implements vscode.Disposable {
  public readonly analyzer = new InheritanceAnalyzer();
  public readonly decorator: InheritanceDecorator;
  public readonly codeLensProvider = new InheritanceCodeLensProvider();
  public readonly inlayHintsProvider = new InheritanceInlayHintsProvider();
  public readonly visualCommands: InheritanceCommands;
  public readonly definitionProvider: SmoothDefinitionProvider;
  public readonly implementationProvider: SmoothImplementationProvider;
  public readonly navigateCommand: NavigateCommand;
  public readonly fileStructureViewer: FileStructureViewer;
  public readonly callHierarchyViewer: CallHierarchyViewer;

  private inheritanceStatusBar: vscode.StatusBarItem;
  private cancellationTokens = new Map<string, vscode.CancellationTokenSource>();
  private analyzedDocVersions = new Map<string, number>();
  private retriedDocs = new Set<string>();
  private debouncedAnalysis: ((editor: vscode.TextEditor) => void) & { cancel: () => void };
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly indexer: SymbolIndexer,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.decorator = new InheritanceDecorator(context);
    this.visualCommands = new InheritanceCommands(this.decorator);
    this.definitionProvider = new SmoothDefinitionProvider(this.indexer);
    this.implementationProvider = new SmoothImplementationProvider(this.indexer);
    this.navigateCommand = new NavigateCommand(this.indexer);
    this.fileStructureViewer = new FileStructureViewer(this.indexer);
    this.callHierarchyViewer = new CallHierarchyViewer(this.indexer);

    this.inheritanceStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

    this.debouncedAnalysis = debounce((editor: vscode.TextEditor) => {
      this.triggerAnalysis(editor, true);
    }, getOmniConfig<number>('debounceDelay', 150));

    this.disposables.push(this.decorator, this.inheritanceStatusBar);
  }

  public activate(
    registerMulti: (baseName: string, cb: (...args: any[]) => any) => void
  ): void {
    const supportedLanguages = [
      'python',
      'typescript',
      'javascript',
      'typescriptreact',
      'javascriptreact',
      'rust',
      'cpp',
      'c',
      'java',
      'csharp',
      'go',
      'php',
    ];
    const documentSelector: vscode.DocumentSelector = supportedLanguages.map((lang) => ({ language: lang }));

    for (const lang of supportedLanguages) {
      this.context.subscriptions.push(
        vscode.languages.registerDefinitionProvider({ language: lang }, this.definitionProvider),
        vscode.languages.registerImplementationProvider({ language: lang }, this.implementationProvider)
      );
    }

    this.context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(documentSelector, this.codeLensProvider),
      vscode.languages.registerInlayHintsProvider(documentSelector, this.inlayHintsProvider)
    );

    // Register Navigation Commands
    registerMulti('navigate', async () => await this.navigateCommand.execute());
    registerMulti('navigateBack', async () => await globalHistory.popAndNavigate());
    registerMulti('findImplementations', async () => await this.navigateCommand.execute());
    registerMulti('jumpToLocation', async (target: any) => await this.visualCommands.jumpToLocation(target));
    registerMulti('showTargetsQuickPick', async (targets: any, placeHolder?: string) =>
      await this.visualCommands.showTargetsQuickPick(targets, placeHolder)
    );
    registerMulti('jumpToParent', async (arg?: any) => await this.visualCommands.jumpToParent(arg));
    registerMulti('jumpToChild', async (arg?: any) => await this.visualCommands.jumpToChild(arg));

    registerMulti('refresh', () => {
      this.analyzer.clearCache();
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this.triggerAnalysis(editor, true);
      }
    });

    registerMulti('exportClassHierarchyMermaid', async (className?: string) => {
      await MermaidHierarchyExporter.exportClassHierarchy(this.indexer, className);
    });

    registerMulti('showHierarchyTree', async (className?: string) => {
      await HierarchyTreeViewer.showHierarchyTree(this.indexer, className);
    });

    registerMulti('showFileStructure', async () => {
      await this.fileStructureViewer.showFileStructure();
    });

    registerMulti('showCallHierarchy', async () => {
      await this.callHierarchyViewer.showHierarchy();
    });

    registerMulti('toggleGutterPosition', async () => {
      const config = vscode.workspace.getConfiguration('xfOmniNav');
      const items: Array<{
        label: string;
        description: string;
        position: 'inline' | 'glyphMargin';
        enable: boolean;
      }> = [
        {
          label: '行内箭头 (Inline, 推荐)',
          description: '显示在代码行前，不占用断点区域',
          position: 'inline',
          enable: true,
        },
        {
          label: '断点边栏 (Glyph Margin)',
          description: '显示在编辑器最左侧边栏',
          position: 'glyphMargin',
          enable: true,
        },
        {
          label: '关闭箭头指示器',
          description: '仅保留 CodeLens 与快捷键跳转',
          position: 'glyphMargin',
          enable: false,
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '选择继承指示箭头的显示位置与方式',
      });

      if (selected) {
        await config.update('gutterPosition', selected.position, vscode.ConfigurationTarget.Global);
        await config.update('enableGutterIcons', selected.enable, vscode.ConfigurationTarget.Global);

        this.decorator.createDecorationTypes();
        for (const editor of vscode.window.visibleTextEditors) {
          const markers = this.decorator.getMarkers(editor.document.uri);
          this.decorator.applyDecorations(editor, markers);
        }
        vscode.window.showInformationMessage(`XF OmniNav: 已切换为 ${selected.label}`);
      }
    });
  }

  public updateInheritanceStatusBar(editor?: vscode.TextEditor): void {
    if (!editor) {
      this.inheritanceStatusBar.hide();
      return;
    }

    const marker = this.decorator.getMarkerAtPosition(
      editor.document.uri,
      editor.selection.active
    );

    if (!marker) {
      this.inheritanceStatusBar.hide();
      return;
    }

    if (marker.parents.length > 0) {
      const parent = marker.parents[0];
      this.inheritanceStatusBar.text = `$(arrow-up) Super: ${parent.name}`;
      this.inheritanceStatusBar.tooltip = `Click to jump to superclass / method: ${parent.name}`;
      this.inheritanceStatusBar.command = 'xfOmniNav.jumpToParent';
      this.inheritanceStatusBar.show();
    } else if (marker.children.length > 0) {
      const child = marker.children[0];
      this.inheritanceStatusBar.text = `$(arrow-down) Sub: ${child.name}`;
      this.inheritanceStatusBar.tooltip = `Click to jump to subclass / override: ${child.name}`;
      this.inheritanceStatusBar.command = 'xfOmniNav.jumpToChild';
      this.inheritanceStatusBar.show();
    } else {
      this.inheritanceStatusBar.hide();
    }
  }

  public async triggerAnalysis(
    editor: vscode.TextEditor,
    force = false,
    _isInitialLoad = false
  ): Promise<void> {
    const document = editor.document;
    const uriStr = document.uri.toString();

    if (!force && this.analyzedDocVersions.get(uriStr) === document.version) {
      const existing = this.decorator.getMarkers(document.uri);
      if (existing.length > 0) {
        this.decorator.applyDecorations(editor, existing);
        this.codeLensProvider.updateMarkers(document.uri, existing);
        this.inlayHintsProvider.updateMarkers(document.uri, existing);
      }
      return;
    }

    if (this.cancellationTokens.has(uriStr)) {
      this.cancellationTokens.get(uriStr)!.cancel();
      this.cancellationTokens.get(uriStr)!.dispose();
      this.cancellationTokens.delete(uriStr);
    }

    const cts = new vscode.CancellationTokenSource();
    this.cancellationTokens.set(uriStr, cts);

    try {
      const onProgress = (intermediateMarkers: InheritanceMarker[]) => {
        if (cts.token.isCancellationRequested) return;
        this.codeLensProvider.updateMarkers(document.uri, intermediateMarkers);
        this.inlayHintsProvider.updateMarkers(document.uri, intermediateMarkers);
        for (const visEditor of vscode.window.visibleTextEditors) {
          if (visEditor.document.uri.toString() === uriStr) {
            this.decorator.applyDecorations(visEditor, intermediateMarkers);
          }
        }
        if (
          vscode.window.activeTextEditor &&
          vscode.window.activeTextEditor.document.uri.toString() === uriStr
        ) {
          this.updateInheritanceStatusBar(vscode.window.activeTextEditor);
        }
      };

      const markers = await this.analyzer.analyzeDocument(document, cts.token, onProgress);

      if (cts.token.isCancellationRequested) {
        return;
      }

      const existing = this.decorator.getMarkers(document.uri);
      if (markers.length === 0 && existing.length > 0 && document.lineCount > 5) {
        this.outputChannel.appendLine(
          `[XF OmniNav] ${document.fileName}: 0 markers returned; preserving ${existing.length} existing markers.`
        );
        return;
      }

      this.analyzedDocVersions.set(uriStr, document.version);
      this.codeLensProvider.updateMarkers(document.uri, markers);
      this.inlayHintsProvider.updateMarkers(document.uri, markers);

      for (const visEditor of vscode.window.visibleTextEditors) {
        if (visEditor.document.uri.toString() === uriStr) {
          this.decorator.applyDecorations(visEditor, markers);
        }
      }

      if (
        vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.uri.toString() === uriStr
      ) {
        this.updateInheritanceStatusBar(vscode.window.activeTextEditor);
      }

      if (_isInitialLoad && markers.length === 0 && !this.retriedDocs.has(uriStr) && document.lineCount > 5) {
        this.retriedDocs.add(uriStr);
        setTimeout(() => {
          for (const visEditor of vscode.window.visibleTextEditors) {
            if (visEditor.document.uri.toString() === uriStr) {
              this.triggerAnalysis(visEditor, true, false);
              break;
            }
          }
        }, 1500);
      }
    } catch (err) {
      this.outputChannel.appendLine(`[Analysis Error] ${String(err)}`);
    } finally {
      if (this.cancellationTokens.get(uriStr) === cts) {
        this.cancellationTokens.delete(uriStr);
      }
      cts.dispose();
    }
  }

  public scheduleAnalysis(editor: vscode.TextEditor): void {
    this.debouncedAnalysis(editor);
  }

  public onActiveEditorChanged(editor?: vscode.TextEditor): void {
    if (editor) {
      const uriStr = editor.document.uri.toString();
      const cached = this.decorator.getMarkers(editor.document.uri);
      if (cached && cached.length > 0) {
        this.decorator.applyDecorations(editor, cached);
        this.codeLensProvider.updateMarkers(editor.document.uri, cached);
        this.inlayHintsProvider.updateMarkers(editor.document.uri, cached);
        this.updateInheritanceStatusBar(editor);
      }
      if (this.analyzedDocVersions.get(uriStr) !== editor.document.version) {
        this.triggerAnalysis(editor, false, true);
      }
    } else {
      this.inheritanceStatusBar.hide();
    }
  }

  public onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    this.updateInheritanceStatusBar(event.textEditor);
  }

  public onVisibleRangesChanged(event: vscode.TextEditorVisibleRangesChangeEvent): void {
    this.decorator.updateViewportDecorations(event.textEditor);
  }

  public onDocumentChanged(document: vscode.TextDocument): void {
    const uriStr = document.uri.toString();
    this.analyzedDocVersions.delete(uriStr);
    this.analyzer.clearFileCache(uriStr);
  }

  public onDocumentSaved(document: vscode.TextDocument): void {
    const uriStr = document.uri.toString();
    this.analyzer.clearFileCache(uriStr);
    this.analyzer.clearCandidateCache();
  }

  public onDocumentClosed(document: vscode.TextDocument): void {
    const uriStr = document.uri.toString();
    this.analyzedDocVersions.delete(uriStr);
    this.retriedDocs.delete(uriStr);
    this.codeLensProvider.clear(document.uri);
    this.inlayHintsProvider.clear(document.uri);
    this.analyzer.clearFileCache(uriStr);
  }

  public refreshAllDecorations(): void {
    this.decorator.createDecorationTypes();
    this.codeLensProvider.clear();
  }

  public clearAllCaches(): void {
    this.analyzer.clearCache();
  }

  public dispose(): void {
    this.debouncedAnalysis.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
