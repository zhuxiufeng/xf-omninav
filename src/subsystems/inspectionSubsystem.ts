import * as vscode from 'vscode';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { CallArgumentInspector } from '../visual/callArgumentInspector';
import { PyCharmFileErrorDecorator } from '../visual/fileErrorDecorator';
import { PythonParamInlayHintsProvider } from '../visual/pythonParamInlayHints';
import {
  CallArgumentCodeActionProvider,
  addParameterToMethodDefinition,
} from '../visual/callArgumentCodeActions';
import { DynamicTypeHoverProvider } from '../navigation/dynamicTypeHoverProvider';

/**
 * Subsystem responsible for PyCharm-grade heuristic call argument inspection,
 * missing argument/keyword checking, parameter inlay hints, file tree error badges,
 * and dynamic type hover cards.
 */
export class InspectionSubsystem implements vscode.Disposable {
  public readonly inspector: CallArgumentInspector;
  public readonly fileErrorDecorator: PyCharmFileErrorDecorator;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly indexer: SymbolIndexer) {
    this.inspector = new CallArgumentInspector(this.indexer);
    this.fileErrorDecorator = new PyCharmFileErrorDecorator();
    this.disposables.push(this.inspector, this.fileErrorDecorator);
  }

  public activate(
    context: vscode.ExtensionContext,
    registerMulti: (baseName: string, cb: (...args: any[]) => any) => void,
    outputChannel: vscode.OutputChannel
  ): void {
    // 1. File Error Decoration in Explorer Tree
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this.fileErrorDecorator)
    );

    // 2. Python Parameter Inlay Hints
    try {
      const pythonParamInlayHints = new PythonParamInlayHintsProvider(this.inspector);
      if (typeof vscode.languages.registerInlayHintsProvider === 'function') {
        context.subscriptions.push(
          vscode.languages.registerInlayHintsProvider(
            { language: 'python' },
            pythonParamInlayHints
          )
        );
      }
    } catch (err) {
      outputChannel.appendLine(`[XF OmniNav] InlayHints registration warning: ${err}`);
    }

    // 3. QuickFix Code Actions
    try {
      const callArgumentCodeActions = new CallArgumentCodeActionProvider(
        this.inspector,
        this.indexer
      );
      const regCodeActions =
        vscode.languages.registerCodeActionsProvider ||
        (vscode.languages as any).registerCodeActionProvider;
      if (typeof regCodeActions === 'function') {
        context.subscriptions.push(
          regCodeActions.call(vscode.languages, { language: 'python' }, callArgumentCodeActions)
        );
      }
    } catch (err) {
      outputChannel.appendLine(`[XF OmniNav] CodeActions registration warning: ${err}`);
    }

    // 4. Dynamic Type Hover Provider (Python & TypeScript)
    try {
      const dynamicHoverProvider = new DynamicTypeHoverProvider(this.indexer);
      if (typeof vscode.languages.registerHoverProvider === 'function') {
        context.subscriptions.push(
          vscode.languages.registerHoverProvider(
            [{ language: 'python' }, { language: 'typescript' }],
            dynamicHoverProvider
          )
        );
      }
    } catch (err) {
      outputChannel.appendLine(`[XF OmniNav] HoverProvider registration warning: ${err}`);
    }

    // 5. Register Inspection Commands
    registerMulti('toggleFileErrorDecoration', async () => {
      const config = vscode.workspace.getConfiguration('xfOmniNav');
      const current = config.get<boolean>('enableFileErrorDecoration', true);
      await config.update('enableFileErrorDecoration', !current, vscode.ConfigurationTarget.Global);
      this.fileErrorDecorator.refreshAll();
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
        this.fileErrorDecorator.refreshAll();
        vscode.window.showInformationMessage(`XF OmniNav: 错误警号样式已切换为: ${pick.label}`);
      }
    });

    registerMulti('toggleCallArgumentInspection', async () => {
      const config = vscode.workspace.getConfiguration('xfOmniNav');
      const current = config.get<boolean>('enableCallArgumentInspection', true);
      await config.update('enableCallArgumentInspection', !current, vscode.ConfigurationTarget.Global);
      if (vscode.window.activeTextEditor) {
        this.inspector.inspectDocument(vscode.window.activeTextEditor.document);
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
          this.inspector.inspectDocument(vscode.window.activeTextEditor.document);
        }
        vscode.window.showInformationMessage(`XF OmniNav: 参数检查提示级别已切换为: ${pick.label}`);
      }
    });

    registerMulti('inspectCallArguments', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this.inspector.inspectDocument(editor.document);
        vscode.window.showInformationMessage('XF OmniNav: 当前文件函数调用检查完毕');
      }
    });

    registerMulti('addParameterToMethod', async (args: any) => {
      await addParameterToMethodDefinition(args);
    });
  }

  public triggerInspect(editor: vscode.TextEditor): void {
    if (editor.document.languageId === 'python') {
      this.inspector.triggerInspect(editor);
    }
  }

  public clearDocument(uri: vscode.Uri): void {
    this.inspector.clearDocument(uri);
  }

  public refreshAllDecorations(): void {
    this.fileErrorDecorator.refreshAll();
  }

  public async scanGitModifiedFiles(): Promise<number> {
    return await this.inspector.scanGitModifiedFiles();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
