import * as vscode from 'vscode';
import { CallArgumentInspector } from './callArgumentInspector';
import { SymbolIndexer } from '../indexer/symbolIndexer';

/**
 * Quick Fix Code Actions for Python call argument diagnostics.
 * Offers 1-click fixes for too many arguments, missing parameters, and unexpected keywords.
 */
export class CallArgumentCodeActionProvider implements vscode.CodeActionProvider {
  constructor(
    private readonly inspector: CallArgumentInspector,
    private readonly indexer: SymbolIndexer
  ) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    if (document.languageId !== 'python') return [];

    const actions: vscode.CodeAction[] = [];
    const calls = this.inspector.getCallsForDocument(document.uri);

    for (const diag of context.diagnostics) {
      if (diag.source !== 'XF OmniNav') continue;

      const matchingCall = calls.find(
        (c) =>
          c.targetRange.contains(diag.range) ||
          diag.range.contains(c.targetRange) ||
          c.callArgs.argRange.contains(diag.range.start) ||
          c.callArgs.parenRange.contains(diag.range.start)
      );

      if (diag.code === 'too-many-arguments') {
        if (matchingCall && matchingCall.sigInfos.length > 0) {
          const maxAllowed = Math.max(...matchingCall.sigInfos.map((s) => s.maxPositional));
          const positionalItems = matchingCall.callArgs.items.filter((it) => !it.isKeyword);
          const hasExplicitSelf =
            positionalItems.length > 0 &&
            (positionalItems[0].text === 'self' || positionalItems[0].text === 'cls');
          const excessSliceStart = hasExplicitSelf ? maxAllowed + 1 : maxAllowed;
          const excessItems = positionalItems.slice(excessSliceStart);

          if (excessItems.length > 0) {
            const action = new vscode.CodeAction(
              `XF OmniNav: 移除多余实参 (${excessItems.map((e) => e.text).join(', ')})`,
              vscode.CodeActionKind.QuickFix
            );
            action.isPreferred = true;
            action.diagnostics = [diag];
            const edit = new vscode.WorkspaceEdit();
            for (const item of excessItems) {
              edit.delete(document.uri, item.removalRange);
            }
            action.edit = edit;
            actions.push(action);
          }

          // Offer action to inspect or jump to definition to add parameter
          const exactDefs = this.indexer.findExact(matchingCall.methodName);
          if (exactDefs.length > 0) {
            const targetDef = exactDefs[0];
            const action = new vscode.CodeAction(
              `XF OmniNav: 跳转至 '${matchingCall.methodName}' 定义处追加形参`,
              vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diag];
            action.command = {
              title: 'Go to Definition',
              command: 'xfOmniNav.jumpToLocation',
              arguments: [targetDef],
            };
            actions.push(action);
          }
        }
      } else if (diag.code === 'missing-arguments') {
        if (matchingCall) {
          const missingMatch = diag.message.match(/缺少必填参数:\s*([^()]+)/);
          const missingParams = missingMatch ? missingMatch[1].trim() : 'param';
          const action = new vscode.CodeAction(
            `XF OmniNav: 补齐必填参数 (${missingParams})`,
            vscode.CodeActionKind.QuickFix
          );
          action.isPreferred = true;
          action.diagnostics = [diag];
          const edit = new vscode.WorkspaceEdit();
          const insertText =
            matchingCall.callArgs.positionalCount > 0
              ? `, ${missingParams}`
              : missingParams;
          edit.insert(document.uri, matchingCall.callArgs.closeParenPos, insertText);
          action.edit = edit;
          actions.push(action);
        }
      } else if (diag.code === 'unexpected-keyword') {
        if (matchingCall) {
          const unexpectedItem = matchingCall.callArgs.items.find(
            (it) => it.isKeyword && (it.range.contains(diag.range.start) || diag.range.contains(it.range))
          );
          if (unexpectedItem) {
            const action = new vscode.CodeAction(
              `XF OmniNav: 移除未知关键字参数 '${unexpectedItem.keywordName}'`,
              vscode.CodeActionKind.QuickFix
            );
            action.isPreferred = true;
            action.diagnostics = [diag];
            const edit = new vscode.WorkspaceEdit();
            edit.delete(document.uri, unexpectedItem.removalRange);
            action.edit = edit;
            actions.push(action);

            // Typo suggestion check: Levenshtein distance <= 2
            for (const sig of matchingCall.sigInfos) {
              for (const p of sig.params) {
                if (levenshteinDistance(p.name, unexpectedItem.keywordName || '') <= 2) {
                  const fixTypoAction = new vscode.CodeAction(
                    `XF OmniNav: 纠正为 '${p.name}='`,
                    vscode.CodeActionKind.QuickFix
                  );
                  fixTypoAction.diagnostics = [diag];
                  const editTypo = new vscode.WorkspaceEdit();
                  editTypo.replace(
                    document.uri,
                    unexpectedItem.range,
                    `${p.name}=${unexpectedItem.valueText || ''}`
                  );
                  fixTypoAction.edit = editTypo;
                  actions.push(fixTypoAction);
                  break;
                }
              }
            }
          }
        }
      }
    }

    return actions;
  }
}

function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    dp[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}
