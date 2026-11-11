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

      if (diag.code === 'too-many-arguments' || diag.code === 'keyword-only-as-positional') {
        if (matchingCall && matchingCall.sigInfos.length > 0) {
          const maxAllowed = Math.max(...matchingCall.sigInfos.map((s) => s.maxPositional));
          const positionalItems = matchingCall.callArgs.items.filter((it) => !it.isKeyword);
          const hasExplicitSelf =
            positionalItems.length > 0 &&
            (positionalItems[0].text === 'self' || positionalItems[0].text === 'cls');
          const excessSliceStart = hasExplicitSelf ? maxAllowed + 1 : maxAllowed;
          const excessItems = positionalItems.slice(excessSliceStart);

          // 1. If keyword-only violation, offer 1-click QuickFix to convert to keyword argument
          if (diag.code === 'keyword-only-as-positional' && excessItems.length > 0) {
            const kwMatch = diag.message.match(/'([^']+)' 为仅关键字/);
            if (kwMatch && kwMatch[1]) {
              const kwName = kwMatch[1];
              const targetItem = excessItems[0];
              const convertAction = new vscode.CodeAction(
                `XF OmniNav: 将参数转换为关键字形式 '${kwName}=${targetItem.text}'`,
                vscode.CodeActionKind.QuickFix
              );
              convertAction.isPreferred = true;
              convertAction.diagnostics = [diag];
              const convertEdit = new vscode.WorkspaceEdit();
              convertEdit.replace(document.uri, targetItem.range, `${kwName}=${targetItem.text}`);
              convertAction.edit = convertEdit;
              actions.push(convertAction);
            }
          }

          if (excessItems.length > 0) {
            const action = new vscode.CodeAction(
              `XF OmniNav: 移除多余实参 (${excessItems.map((e) => e.text).join(', ')})`,
              vscode.CodeActionKind.QuickFix
            );
            if (diag.code !== 'keyword-only-as-positional') {
              action.isPreferred = true;
            }
            action.diagnostics = [diag];
            const edit = new vscode.WorkspaceEdit();
            for (const item of excessItems) {
              edit.delete(document.uri, item.removalRange);
            }
            action.edit = edit;
            actions.push(action);

            // Offer action to inspect or jump to definition to add parameter
            const exactDefs = this.indexer.findExact(matchingCall.methodName);
            if (exactDefs.length > 0) {
              const targetDef = exactDefs[0];
              const firstExcess = excessItems[0].text.replace(/[^A-Za-z0-9_]/g, '') || 'arg';
              const addParamAction = new vscode.CodeAction(
                `XF OmniNav: 在方法 '${matchingCall.methodName}' 中添加形参 '${firstExcess}'`,
                vscode.CodeActionKind.QuickFix
              );
              addParamAction.diagnostics = [diag];
              addParamAction.command = {
                title: 'Add Parameter to Method Definition',
                command: 'xfOmniNav.addParameterToMethod',
                arguments: [
                  {
                    targetUri: targetDef.uri.toString(),
                    methodName: matchingCall.methodName,
                    paramName: firstExcess,
                    isKeyword: false,
                    line: targetDef.range.start.line,
                  },
                ],
              };
              actions.push(addParamAction);

              const jumpAction = new vscode.CodeAction(
                `XF OmniNav: 跳转至 '${matchingCall.methodName}' 定义处追加形参`,
                vscode.CodeActionKind.QuickFix
              );
              jumpAction.diagnostics = [diag];
              jumpAction.command = {
                title: 'Go to Definition',
                command: 'xfOmniNav.jumpToLocation',
                arguments: [targetDef],
              };
              actions.push(jumpAction);
            }
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
            matchingCall.callArgs.items.length > 0
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

            // PyCharm-style 1-click QuickFix: Add parameter to target method definition
            const exactDefs = this.indexer.findExact(matchingCall.methodName);
            if (exactDefs.length > 0 && unexpectedItem.keywordName) {
              const targetDef = exactDefs[0];
              const addParamAction = new vscode.CodeAction(
                `XF OmniNav: 在方法 '${matchingCall.methodName}' 中添加形参 '${unexpectedItem.keywordName}=None'`,
                vscode.CodeActionKind.QuickFix
              );
              addParamAction.diagnostics = [diag];
              addParamAction.command = {
                title: 'Add Parameter to Method Definition',
                command: 'xfOmniNav.addParameterToMethod',
                arguments: [
                  {
                    targetUri: targetDef.uri.toString(),
                    methodName: matchingCall.methodName,
                    paramName: unexpectedItem.keywordName,
                    isKeyword: true,
                    line: targetDef.range.start.line,
                  },
                ],
              };
              actions.push(addParamAction);
            }
          }
        }
      } else if (diag.code === 'duplicate-keyword-argument' || diag.code === 'duplicate-argument-value') {
        if (matchingCall) {
          const dupItem = matchingCall.callArgs.items.find(
            (it) => it.isKeyword && (it.range.contains(diag.range.start) || diag.range.contains(it.range))
          );
          if (dupItem) {
            const action = new vscode.CodeAction(
              `XF OmniNav: 移除重复关键字传参 '${dupItem.keywordName}'`,
              vscode.CodeActionKind.QuickFix
            );
            action.isPreferred = true;
            action.diagnostics = [diag];
            const edit = new vscode.WorkspaceEdit();
            edit.delete(document.uri, dupItem.removalRange);
            action.edit = edit;
            actions.push(action);
          }
        }
      } else if (diag.code === 'positional-only-as-keyword') {
        if (matchingCall) {
          const posOnlyItem = matchingCall.callArgs.items.find(
            (it) => it.isKeyword && (it.range.contains(diag.range.start) || diag.range.contains(it.range))
          );
          if (posOnlyItem && posOnlyItem.valueText) {
            const action = new vscode.CodeAction(
              `XF OmniNav: 转换为位置参数形式 (去掉 '${posOnlyItem.keywordName}=')`,
              vscode.CodeActionKind.QuickFix
            );
            action.isPreferred = true;
            action.diagnostics = [diag];
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, posOnlyItem.range, posOnlyItem.valueText);
            action.edit = edit;
            actions.push(action);
          }
        }
      } else if (diag.code === 'mutable-default-argument') {
        const lineText = document.lineAt(diag.range.start.line).text;
        const defaultMatch = lineText.match(/=\s*(\[.*?\]|\{.*?\})/);
        if (defaultMatch) {
          const eqIndex = lineText.indexOf(defaultMatch[0]);
          const range = new vscode.Range(
            diag.range.start.line,
            eqIndex,
            diag.range.start.line,
            eqIndex + defaultMatch[0].length
          );
          const action = new vscode.CodeAction(
            'XF OmniNav: 替换为 None 默认参数 (=None)',
            vscode.CodeActionKind.QuickFix
          );
          action.isPreferred = true;
          action.diagnostics = [diag];
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, range, '=None');
          action.edit = edit;
          actions.push(action);
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

/**
 * Universal PyCharm-style command to automatically insert a missing parameter
 * into a Python / TS method or function definition.
 */
export async function addParameterToMethodDefinition(args: {
  targetUri: string;
  methodName: string;
  paramName?: string;
  isKeyword?: boolean;
  line?: number;
}): Promise<void> {
  if (!args || !args.targetUri || !args.paramName) return;
  try {
    const uri = vscode.Uri.parse(args.targetUri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const startLine = Math.max(0, (args.line || 0) - 5);
    const endLine = Math.min(doc.lineCount - 1, (args.line || 0) + 20);

    let defLine = -1;
    const defRegex = new RegExp(`(?:def|async\\s+def|function)\\s+${args.methodName}\\s*\\(`);
    for (let l = startLine; l <= endLine; l++) {
      if (defRegex.test(doc.lineAt(l).text)) {
        defLine = l;
        break;
      }
    }

    if (defLine === -1) {
      for (let l = 0; l < doc.lineCount; l++) {
        if (defRegex.test(doc.lineAt(l).text)) {
          defLine = l;
          break;
        }
      }
    }

    if (defLine === -1) {
      vscode.window.showWarningMessage(
        `XF OmniNav: 未能定位方法 '${args.methodName}' 的声明行`
      );
      return;
    }

    // Locate closing parenthesis ')' of parameter list
    let parenDepth = 0;
    let foundClosePos: vscode.Position | null = null;
    let hasExistingParams = false;

    for (let l = defLine; l < Math.min(doc.lineCount, defLine + 35); l++) {
      const lineText = doc.lineAt(l).text;
      for (let c = 0; c < lineText.length; c++) {
        const ch = lineText[c];
        if (ch === '(') {
          parenDepth++;
        } else if (ch === ')') {
          parenDepth--;
          if (parenDepth === 0) {
            foundClosePos = new vscode.Position(l, c);
            break;
          }
        } else if (parenDepth > 0 && !/\s/.test(ch)) {
          hasExistingParams = true;
        }
      }
      if (foundClosePos) break;
    }

    if (!foundClosePos) {
      vscode.window.showWarningMessage(
        `XF OmniNav: 未能找到方法 '${args.methodName}' 参数列表闭合括号 ')'`
      );
      return;
    }

    const insertText = args.isKeyword
      ? (hasExistingParams ? `, ${args.paramName}=None` : `${args.paramName}=None`)
      : (hasExistingParams ? `, ${args.paramName}` : args.paramName);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, foundClosePos, insertText);
    const applied = await vscode.workspace.applyEdit(edit);

    if (applied) {
      editor.revealRange(
        new vscode.Range(foundClosePos, foundClosePos),
        vscode.TextEditorRevealType.InCenter
      );
      vscode.window.showInformationMessage(
        `XF OmniNav: 已在 '${args.methodName}' 中添加形参 '${args.paramName}'`
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`XF OmniNav 添加形参失败: ${String(err)}`);
  }
}

