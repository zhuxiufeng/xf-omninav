import * as vscode from 'vscode';
import { CallArgumentInspector } from './callArgumentInspector';
import { getOmniConfig } from '../utils';

/**
 * PyCharm-style inline parameter name hints for Python & TypeScript/JavaScript calls.
 * Displays parameter labels like `nozzle_num: ` before arguments in calls.
 */
export class ParamInlayHintsProvider implements vscode.InlayHintsProvider {
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
    if (
      document.languageId !== 'python' &&
      document.languageId !== 'typescript' &&
      document.languageId !== 'javascript'
    ) {
      return [];
    }
    const isEnabled = getOmniConfig<boolean>('enableParameterInlayHints', true);
    if (!isEnabled) return [];

    const calls = this.inspector.getCallsForDocument(document.uri);
    if (!calls || calls.length === 0) return [];
    const hints: vscode.InlayHint[] = [];

    // O(log N) binary search for the first call that can possibly intersect the viewport range
    let low = 0;
    let high = calls.length - 1;
    let startIndex = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const call = calls[mid];
      if (call.targetRange && call.targetRange.end.line >= range.start.line) {
        startIndex = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    for (let cIdx = startIndex; cIdx < calls.length; cIdx++) {
      const call = calls[cIdx];
      if (!call.targetRange) continue;
      // Since calls are strictly ordered by line ascending, once start.line exceeds range.end.line,
      // subsequent calls cannot possibly be in the viewport! Break early!
      if (call.targetRange.start.line > range.end.line) {
        break;
      }
      if (call.targetRange.end.line < range.start.line) {
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
            const tooltip = new vscode.MarkdownString();
            tooltip.isTrusted = true;
            const typeStr = param.type ? `: ${param.type}` : '';
            const statusStr = param.hasDefault
              ? ' *(可选参数/带默认值)*'
              : param.isKeywordOnly
              ? ' *(仅关键字参数)*'
              : ' *(必填参数)*';

            tooltip.appendMarkdown(`**形参**: \`${param.name}${typeStr}\`${statusStr}\n\n`);
            tooltip.appendMarkdown(`- **方法/函数**: \`${call.methodName}\`\n`);
            tooltip.appendMarkdown(`- **参数序号**: 第 ${i + 1} 个参数\n`);
            if (param.defaultValue) {
              tooltip.appendMarkdown(`- **默认值**: \`${param.defaultValue}\`\n`);
            }
            if (param.description) {
              tooltip.appendMarkdown(`- **说明**: ${param.description}\n`);
            }
            if (sig.name) {
              tooltip.appendMarkdown(`- **签名**: \`${sig.name}\`\n`);
            }
            hint.tooltip = tooltip;
            hint.paddingRight = true;
            hints.push(hint);
          }
        }
      }
    }

    return hints;
  }
}

/** Backward-compatible alias for existing imports */
export const PythonParamInlayHintsProvider = ParamInlayHintsProvider;
