import * as vscode from 'vscode';
import { CallArgumentInspector } from './callArgumentInspector';
import { getOmniConfig } from '../utils';

/**
 * PyCharm-style inline parameter name hints for Python calls.
 * Displays parameter labels like `nozzle_num: ` before arguments in Python calls.
 */
export class PythonParamInlayHintsProvider implements vscode.InlayHintsProvider {
  private _onDidChangeInlayHints = new vscode.EventEmitter<void>();
  public readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

  constructor(private readonly inspector: CallArgumentInspector) {}

  public fireDidChange(): void {
    this._onDidChangeInlayHints.fire();
  }

  public provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    _token: vscode.CancellationToken
  ): vscode.InlayHint[] {
    if (document.languageId !== 'python') return [];
    const isEnabled = getOmniConfig<boolean>('enableParameterInlayHints', true);
    if (!isEnabled) return [];

    const calls = this.inspector.getCallsForDocument(document.uri);
    const hints: vscode.InlayHint[] = [];

    for (const call of calls) {
      if (!call.targetRange) continue;
      // Only provide hints for calls within the requested viewport range
      if (
        call.targetRange.end.line < range.start.line ||
        call.targetRange.start.line > range.end.line
      ) {
        continue;
      }
      if (call.sigInfos.length === 0) continue;

      const sig = call.sigInfos[0];
      const positionalItems = call.callArgs.items.filter((it) => !it.isKeyword);
      const hasExplicitSelf =
        positionalItems.length > 0 &&
        (positionalItems[0].text === 'self' || positionalItems[0].text === 'cls');
      const itemsToMatch = hasExplicitSelf ? positionalItems.slice(1) : positionalItems;

      for (let i = 0; i < itemsToMatch.length; i++) {
        const item = itemsToMatch[i];
        if (i < sig.params.length) {
          const param = sig.params[i];
          if (param && param.name && !param.isVararg && !param.isVarkwarg) {
            const hint = new vscode.InlayHint(
              item.range.start,
              `${param.name}: `,
              vscode.InlayHintKind.Parameter
            );
            hint.tooltip = `形参: ${param.name}${param.hasDefault ? ' (可选/带默认值)' : ' (必填参数)'}`;
            hint.paddingRight = true;
            hints.push(hint);
          }
        }
      }
    }

    return hints;
  }
}
