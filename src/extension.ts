import * as vscode from 'vscode';
import { SymbolIndexer } from './indexer/symbolIndexer';
import { InheritanceAnalyzer } from './indexer/inheritanceAnalyzer';
import { InheritanceDecorator } from './visual/gutterDecorator';
import { InheritanceCodeLensProvider } from './visual/codelensProvider';
import { InheritanceInlayHintsProvider } from './visual/inlayHints';
import { InheritanceCommands } from './visual/visualCommands';
import {
  SmoothDefinitionProvider,
  SmoothImplementationProvider,
} from './navigation/definitionProvider';
import { NavigateCommand } from './navigation/navigateCommand';
import { globalHistory } from './navigation/jumpHistory';
import { debounce, getOmniConfig, isOmniConfigAffected } from './utils';
import { InheritanceMarker } from './types';
import { PythonBranchFoldingProvider } from './folding/pythonFoldingProvider';
import { ShellBranchFoldingProvider } from './folding/shellFoldingProvider';
import { CppMacroFoldingProvider } from './folding/cppMacroFoldingProvider';
import { SwitchCaseFoldingProvider } from './folding/switchCaseFoldingProvider';
import { RustBranchFoldingProvider } from './folding/rustFoldingProvider';
import { FoldingCache } from './folding/foldingCache';
import { MermaidHierarchyExporter } from './visual/mermaidExporter';
import { PyCharmFileErrorDecorator } from './visual/fileErrorDecorator';
import { CallArgumentInspector } from './visual/callArgumentInspector';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('XF OmniNav');
  outputChannel.appendLine('[XF OmniNav] Activating unified navigation suite...');

  // 1. Core Engines
  const indexer = new SymbolIndexer(context);
  context.subscriptions.push(indexer);

  // Instant cold-boot cache hydration (~5ms)
  indexer.loadFromDiskCache().then((loaded) => {
    if (loaded) {
      outputChannel.appendLine(
        `[XF OmniNav] Restored ${indexer.totalSymbols} symbols across ${indexer.totalFiles} files from persistent disk cache.`
      );
    }
  });

  const analyzer = new InheritanceAnalyzer();
  const decorator = new InheritanceDecorator(context);
  context.subscriptions.push(decorator);

  // PyCharm-style file error decoration in project explorer
  const fileErrorDecorator = new PyCharmFileErrorDecorator();
  context.subscriptions.push(
    fileErrorDecorator,
    vscode.window.registerFileDecorationProvider(fileErrorDecorator)
  );

  // PyCharm-style call argument inspector (checks parameter counts without type annotations)
  const callArgumentInspector = new CallArgumentInspector(indexer);
  context.subscriptions.push(callArgumentInspector);

  const codeLensProvider = new InheritanceCodeLensProvider();
  const inlayHintsProvider = new InheritanceInlayHintsProvider();
  const visualCommands = new InheritanceCommands(decorator);

  const definitionProvider = new SmoothDefinitionProvider(indexer);
  const implementationProvider = new SmoothImplementationProvider(indexer);
  const navigateCommand = new NavigateCommand(indexer);

  // 2. Language registrations
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
    context.subscriptions.push(
      vscode.languages.registerDefinitionProvider({ language: lang }, definitionProvider),
      vscode.languages.registerImplementationProvider({ language: lang }, implementationProvider)
    );
  }

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(documentSelector, codeLensProvider),
    vscode.languages.registerInlayHintsProvider(documentSelector, inlayHintsProvider)
  );

  // 3. Fine-grained branch folding providers (Python, Shell, C/C++, TS/JS/Java/Go, Rust)
  let foldingDisposables: vscode.Disposable[] = [];
  const pythonFoldingProvider = new PythonBranchFoldingProvider();
  const shellFoldingProvider = new ShellBranchFoldingProvider();
  const cppFoldingProvider = new CppMacroFoldingProvider();
  const switchCaseFoldingProvider = new SwitchCaseFoldingProvider();
  const rustFoldingProvider = new RustBranchFoldingProvider();

  const syncFoldingProviders = (forceReRegister = false) => {
    const isFoldingEnabled = getOmniConfig<boolean>(
      'enableFineGrainedFolding',
      true
    );
    if (isFoldingEnabled) {
      if (forceReRegister && foldingDisposables.length > 0) {
        foldingDisposables.forEach((d) => d.dispose());
        foldingDisposables = [];
      }
      if (foldingDisposables.length === 0) {
        // Python fine-grained branch folding (PyCharm style)
        foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'python' },
            pythonFoldingProvider
          )
        );
        // Shell / Bash
        foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'shellscript' },
            shellFoldingProvider
          )
        );
        // C / C++ preprocessor macro conditionals
        foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'c' },
            cppFoldingProvider
          ),
          vscode.languages.registerFoldingRangeProvider(
            { language: 'cpp' },
            cppFoldingProvider
          )
        );
        // TypeScript, JavaScript, Java, Go switch/case & select/case
        const switchCaseLanguages = [
          'typescript',
          'javascript',
          'typescriptreact',
          'javascriptreact',
          'java',
          'go',
        ];
        for (const lang of switchCaseLanguages) {
          foldingDisposables.push(
            vscode.languages.registerFoldingRangeProvider(
              [
                { language: lang, scheme: 'file' },
                { language: lang, scheme: 'untitled' },
              ],
              switchCaseFoldingProvider
            )
          );
        }
        // Rust match arms, derive attributes, and doc comments
        foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'rust' },
            rustFoldingProvider
          )
        );
        foldingDisposables.forEach((d) => context.subscriptions.push(d));
      }
      pythonFoldingProvider.fireDidChange();
      shellFoldingProvider.fireDidChange();
      cppFoldingProvider.fireDidChange();
      switchCaseFoldingProvider.fireDidChange();
      rustFoldingProvider.fireDidChange();
    } else if (!isFoldingEnabled && foldingDisposables.length > 0) {
      foldingDisposables.forEach((d) => d.dispose());
      foldingDisposables = [];
    }
  };

  syncFoldingProviders();

  // Leapfrog deferred language servers (e.g. Pyrefly, Pyright, clangd) so our providers hold top rank
  setTimeout(() => syncFoldingProviders(true), 1500);
  setTimeout(() => syncFoldingProviders(true), 4000);
  setTimeout(() => syncFoldingProviders(true), 8000);

  let hasReSyncedForPython = false;
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'python' && !hasReSyncedForPython) {
        hasReSyncedForPython = true;
        setTimeout(() => syncFoldingProviders(true), 2500);
        setTimeout(() => syncFoldingProviders(true), 6000);
      }
    })
  );

  // 3. Command registration helper (multi-namespace backward compatibility)
  const registerMulti = (
    baseName: string,
    callback: (...args: any[]) => any
  ) => {
    const namespaces = ['xfOmniNav', 'xfOmniJump', 'xfOmniTree', 'inheritanceNavigator', 'smoothJump'];
    for (const ns of namespaces) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`${ns}.${baseName}`, callback)
      );
    }
  };

  // Jump Commands
  const onNavigate = async () => await navigateCommand.execute();
  const onNavigateBack = async () => await globalHistory.popAndNavigate();
  const onRebuild = async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'XF OmniNav: Indexing workspace symbols...',
        cancellable: false,
      },
      async () => {
        analyzer.clearCache();
        await indexer.indexWorkspace();
      }
    );
    vscode.window.showInformationMessage(
      `XF OmniNav: Indexed ${indexer.totalSymbols.toLocaleString()} symbols across ${indexer.totalFiles.toLocaleString()} files.`
    );
  };

  registerMulti('navigate', onNavigate);
  registerMulti('navigateBack', onNavigateBack);
  registerMulti('rebuildIndex', onRebuild);
  registerMulti('findImplementations', onNavigate);
  registerMulti('refreshFoldings', () => syncFoldingProviders(true));
  registerMulti('exportClassHierarchyMermaid', async (className?: string) => {
    await MermaidHierarchyExporter.exportClassHierarchy(indexer, className);
  });

  registerMulti('toggleFileErrorDecoration', async () => {
    const config = vscode.workspace.getConfiguration('xfOmniNav');
    const current = config.get<boolean>('enableFileErrorDecoration', true);
    await config.update('enableFileErrorDecoration', !current, vscode.ConfigurationTarget.Global);
    fileErrorDecorator.refreshAll();
    vscode.window.showInformationMessage(
      `XF OmniNav: 文件错误警号标记已${!current ? '开启' : '关闭'}`
    );
  });

  registerMulti('setFileErrorBadge', async () => {
    const config = vscode.workspace.getConfiguration('xfOmniNav');
    const items = [
      { label: '! (经典感叹号)', description: '推荐：经典 PyCharm 错误感叹号，高亮红', value: '!' },
      { label: '❗ (红色警号 Emoji)', description: '显眼醒目的红色警号 Emoji 图标', value: '❗' },
      { label: '🔴 (红点警号)', description: '紧凑型实心红点', value: '🔴' },
      { label: '⚠️ (警告三角)', description: '醒目的三角警告图标', value: '⚠️' },
      { label: 'E (字母 E)', description: '字母 Error 缩写', value: 'E' },
      { label: 'none (仅文字变红)', description: '不显示角标字符，仅将文件名变为错误红', value: 'none' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: '选择文件代码错误（标红）时显示的警号样式',
    });
    if (pick) {
      await config.update('fileErrorBadge', pick.value, vscode.ConfigurationTarget.Global);
      fileErrorDecorator.refreshAll();
      vscode.window.showInformationMessage(`XF OmniNav: 错误警号样式已切换为: ${pick.label}`);
    }
  });

  registerMulti('toggleCallArgumentInspection', async () => {
    const config = vscode.workspace.getConfiguration('xfOmniNav');
    const current = config.get<boolean>('enableCallArgumentInspection', true);
    await config.update('enableCallArgumentInspection', !current, vscode.ConfigurationTarget.Global);
    if (vscode.window.activeTextEditor) {
      callArgumentInspector.inspectDocument(vscode.window.activeTextEditor.document);
    }
    vscode.window.showInformationMessage(
      `XF OmniNav: PyCharm 风格函数传参检查已${!current ? '开启' : '关闭'}`
    );
  });

  registerMulti('setCallArgumentSeverity', async () => {
    const config = vscode.workspace.getConfiguration('xfOmniNav');
    const items = [
      { label: 'Warning (黄色波浪线, 推荐)', description: '温和显眼的黄色警告提示', value: 'warning' },
      { label: 'Error (红色波浪线, 强警示)', description: '直接标红报错，联动侧边栏与文件红色警号', value: 'error' },
      { label: 'Information (蓝色提示线)', description: '仅作为信息提示', value: 'information' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: '选择函数调用参数不匹配时的提示级别',
    });
    if (pick) {
      await config.update('callArgumentSeverity', pick.value, vscode.ConfigurationTarget.Global);
      if (vscode.window.activeTextEditor) {
        callArgumentInspector.inspectDocument(vscode.window.activeTextEditor.document);
      }
      vscode.window.showInformationMessage(`XF OmniNav: 参数检查提示级别已切换为: ${pick.label}`);
    }
  });

  // Inheritance Commands
  registerMulti('jumpToLocation', async (target: any) => {
    await visualCommands.jumpToLocation(target);
  });
  registerMulti('showTargetsQuickPick', async (targets: any, placeHolder?: string) => {
    await visualCommands.showTargetsQuickPick(targets, placeHolder);
  });
  registerMulti('jumpToParent', async (arg?: any) => {
    await visualCommands.jumpToParent(arg);
  });
  registerMulti('jumpToChild', async (arg?: any) => {
    await visualCommands.jumpToChild(arg);
  });

  registerMulti('refresh', () => {
    analyzer.clearCache();
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      triggerAnalysis(editor, true);
    }
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

      decorator.createDecorationTypes();
      for (const editor of vscode.window.visibleTextEditors) {
        const markers = decorator.getMarkers(editor.document.uri);
        decorator.applyDecorations(editor, markers);
      }
      vscode.window.showInformationMessage(`XF OmniNav: 已切换为 ${selected.label}`);
    }
  });

  // 4. Status Bar Items
  const indexStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  indexStatusBar.command = 'xfOmniNav.rebuildIndex';
  context.subscriptions.push(indexStatusBar);

  const inheritanceStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  context.subscriptions.push(inheritanceStatusBar);

  const updateIndexStatusBar = (count: number) => {
    if (!getOmniConfig<boolean>('showStatusBar', true)) {
      indexStatusBar.hide();
      return;
    }
    indexStatusBar.text = `$(search) OmniNav: ${count.toLocaleString()}`;
    indexStatusBar.tooltip = `XF OmniNav: ${count.toLocaleString()} symbols indexed in ${indexer.totalFiles} files. Click to re-index.`;
    indexStatusBar.show();
  };

  const updateInheritanceStatusBar = (editor?: vscode.TextEditor) => {
    if (!editor) {
      inheritanceStatusBar.hide();
      return;
    }

    const marker = decorator.getMarkerAtPosition(
      editor.document.uri,
      editor.selection.active
    );

    if (!marker) {
      inheritanceStatusBar.hide();
      return;
    }

    if (marker.parents.length > 0) {
      const parent = marker.parents[0];
      inheritanceStatusBar.text = `$(arrow-up) Super: ${parent.name}`;
      inheritanceStatusBar.tooltip = `Click to jump to superclass / method: ${parent.name}`;
      inheritanceStatusBar.command = 'xfOmniNav.jumpToParent';
      inheritanceStatusBar.show();
    } else if (marker.children.length > 0) {
      const child = marker.children[0];
      inheritanceStatusBar.text = `$(arrow-down) Sub: ${child.name}`;
      inheritanceStatusBar.tooltip = `Click to jump to subclass / override: ${child.name}`;
      inheritanceStatusBar.command = 'xfOmniNav.jumpToChild';
      inheritanceStatusBar.show();
    } else {
      inheritanceStatusBar.hide();
    }
  };

  indexer.onDidIndexUpdate((count) => {
    updateIndexStatusBar(count);
  });

  // 5. Analysis Pipeline
  const cancellationTokens = new Map<string, vscode.CancellationTokenSource>();
  const analyzedDocVersions = new Map<string, number>();
  const retriedDocs = new Set<string>();

  async function triggerAnalysis(
    editor: vscode.TextEditor,
    force = false,
    _isInitialLoad = false
  ): Promise<void> {
    const document = editor.document;
    const uriStr = document.uri.toString();

    if (!force && analyzedDocVersions.get(uriStr) === document.version) {
      const existing = decorator.getMarkers(document.uri);
      if (existing.length > 0) {
        decorator.applyDecorations(editor, existing);
        codeLensProvider.updateMarkers(document.uri, existing);
        inlayHintsProvider.updateMarkers(document.uri, existing);
      }
      return;
    }

    if (cancellationTokens.has(uriStr)) {
      cancellationTokens.get(uriStr)!.cancel();
      cancellationTokens.get(uriStr)!.dispose();
      cancellationTokens.delete(uriStr);
    }

    const cts = new vscode.CancellationTokenSource();
    cancellationTokens.set(uriStr, cts);

    try {
      const onProgress = (intermediateMarkers: InheritanceMarker[]) => {
        if (cts.token.isCancellationRequested) return;
        codeLensProvider.updateMarkers(document.uri, intermediateMarkers);
        inlayHintsProvider.updateMarkers(document.uri, intermediateMarkers);
        for (const visEditor of vscode.window.visibleTextEditors) {
          if (visEditor.document.uri.toString() === uriStr) {
            decorator.applyDecorations(visEditor, intermediateMarkers);
          }
        }
        if (
          vscode.window.activeTextEditor &&
          vscode.window.activeTextEditor.document.uri.toString() === uriStr
        ) {
          updateInheritanceStatusBar(vscode.window.activeTextEditor);
        }
      };

      const markers = await analyzer.analyzeDocument(document, cts.token, onProgress);

      if (cts.token.isCancellationRequested) {
        return;
      }

      // Safeguard against transient 0-marker results wiping out valid existing markers
      const existing = decorator.getMarkers(document.uri);
      if (markers.length === 0 && existing.length > 0 && document.lineCount > 5) {
        outputChannel.appendLine(
          `[XF OmniNav] ${document.fileName}: 0 markers returned; preserving ${existing.length} existing markers.`
        );
        return;
      }

      analyzedDocVersions.set(uriStr, document.version);
      codeLensProvider.updateMarkers(document.uri, markers);
      inlayHintsProvider.updateMarkers(document.uri, markers);

      for (const visEditor of vscode.window.visibleTextEditors) {
        if (visEditor.document.uri.toString() === uriStr) {
          decorator.applyDecorations(visEditor, markers);
        }
      }

      if (
        vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.uri.toString() === uriStr
      ) {
        updateInheritanceStatusBar(vscode.window.activeTextEditor);
      }

      // If this was an initial load and 0 markers were found, schedule retry in 1.5s
      if (_isInitialLoad && markers.length === 0 && !retriedDocs.has(uriStr) && document.lineCount > 5) {
        retriedDocs.add(uriStr);
        setTimeout(() => {
          for (const visEditor of vscode.window.visibleTextEditors) {
            if (visEditor.document.uri.toString() === uriStr) {
              triggerAnalysis(visEditor, true, false);
              break;
            }
          }
        }, 1500);
      }
    } catch (err) {
      outputChannel.appendLine(`[Analysis Error] ${String(err)}`);
    } finally {
      if (cancellationTokens.get(uriStr) === cts) {
        cancellationTokens.delete(uriStr);
      }
      cts.dispose();
    }
  }

  const debouncedAnalysis = debounce((editor: vscode.TextEditor) => {
    triggerAnalysis(editor, true);
  }, getOmniConfig<number>('debounceDelay', 150));

  // 6. Listeners
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        const uriStr = editor.document.uri.toString();
        const cached = decorator.getMarkers(editor.document.uri);
        if (cached && cached.length > 0) {
          decorator.applyDecorations(editor, cached);
          codeLensProvider.updateMarkers(editor.document.uri, cached);
          inlayHintsProvider.updateMarkers(editor.document.uri, cached);
          updateInheritanceStatusBar(editor);
        }

        indexer.indexDocument(editor.document);
        updateIndexStatusBar(indexer.totalSymbols);

        if (analyzedDocVersions.get(uriStr) !== editor.document.version) {
          triggerAnalysis(editor, false, true);
        }

        const lang = editor.document.languageId;
        if (lang === 'python') {
          pythonFoldingProvider.fireDidChange();
          callArgumentInspector.triggerInspect(editor);
        } else if (lang === 'shellscript') {
          shellFoldingProvider.fireDidChange();
        } else if (lang === 'c' || lang === 'cpp') {
          cppFoldingProvider.fireDidChange();
        } else if (lang === 'rust') {
          rustFoldingProvider.fireDidChange();
        }
      } else {
        inheritanceStatusBar.hide();
      }
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      updateInheritanceStatusBar(event.textEditor);
    }),

    vscode.window.onDidChangeTextEditorVisibleRanges
      ? vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
          decorator.updateViewportDecorations(event.textEditor);
        })
      : { dispose: () => {} },

    vscode.workspace.onDidChangeTextDocument((event) => {
      const uriStr = event.document.uri.toString();
      analyzedDocVersions.delete(uriStr);
      analyzer.clearFileCache(uriStr);
      // Mark document dirty with zero overhead during fast keystroke typing
      indexer.markDirty(event.document);
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === uriStr) {
        debouncedAnalysis(editor);
        if (editor.document.languageId === 'python') {
          callArgumentInspector.triggerInspect(editor);
        }
      }
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      const uriStr = document.uri.toString();
      analyzer.clearFileCache(uriStr);
      analyzer.clearCandidateCache();
      indexer.indexDocument(document);

      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === uriStr) {
          debouncedAnalysis(editor);
        }
      }
    }),

    vscode.workspace.onDidCloseTextDocument((document) => {
      const uriStr = document.uri.toString();
      FoldingCache.delete(uriStr);
      analyzedDocVersions.delete(uriStr);
      retriedDocs.delete(uriStr);
      codeLensProvider.clear(document.uri);
      inlayHintsProvider.clear(document.uri);
      callArgumentInspector.clearDocument(document.uri);
      analyzer.clearFileCache(uriStr);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (isOmniConfigAffected(e)) {
        syncFoldingProviders();
        decorator.createDecorationTypes();
        codeLensProvider.clear();
        fileErrorDecorator.refreshAll();
        for (const editor of vscode.window.visibleTextEditors) {
          triggerAnalysis(editor, true);
          if (editor.document.languageId === 'python') {
            callArgumentInspector.triggerInspect(editor);
          }
        }
      }
    })
  );

  // Breakpoints listener to dynamically yield gutter space
  if (vscode.debug && vscode.debug.onDidChangeBreakpoints) {
    context.subscriptions.push(
      vscode.debug.onDidChangeBreakpoints(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          decorator.applyDecorations(editor, decorator.getMarkers(editor.document.uri));
        }
      })
    );
  }

  // 7. Initial startup indexing
  if (vscode.window.activeTextEditor) {
    indexer.indexDocument(vscode.window.activeTextEditor.document);
    updateIndexStatusBar(indexer.totalSymbols);
    triggerAnalysis(vscode.window.activeTextEditor, false, true);
    if (vscode.window.activeTextEditor.document.languageId === 'python') {
      callArgumentInspector.triggerInspect(vscode.window.activeTextEditor);
    }
  }

  setTimeout(() => {
    indexer.indexWorkspace().then(() => {
      updateIndexStatusBar(indexer.totalSymbols);
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'python') {
        callArgumentInspector.triggerInspect(vscode.window.activeTextEditor);
      }
    });
  }, 1000);

  outputChannel.appendLine('[XF OmniNav] Unified extension activated successfully.');
}

export function deactivate() {}
