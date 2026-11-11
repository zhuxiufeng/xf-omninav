import * as vscode from 'vscode';
import { CallArgumentInspector } from '../visual/callArgumentInspector';
import { SymbolIndexer } from '../indexer/symbolIndexer';

/**
 * PyCharm-grade active Signature Help provider for Python function calls.
 * Displays parameter list, highlights active parameter in bold, and renders docstring hints.
 */
export class PythonSignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(
    private readonly inspector: CallArgumentInspector,
    private readonly indexer: SymbolIndexer
  ) {}

  public provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.SignatureHelpContext
  ): vscode.ProviderResult<vscode.SignatureHelp> {
    if (document.languageId !== 'python') return null;

    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, position.character);

    // Look backwards from cursor to find enclosing open parenthesis '('
    let depth = 0;
    let openParenCol = -1;
    let inQuote: string | null = null;

    for (let c = prefix.length - 1; c >= 0; c--) {
      const ch = prefix[c];
      if (inQuote) {
        if (ch === inQuote && (c === 0 || prefix[c - 1] !== '\\')) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        continue;
      }
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth > 0) {
          depth--;
        } else {
          openParenCol = c;
          break;
        }
      }
    }

    if (openParenCol === -1) return null;

    // Extract function/method name preceding '('
    const beforeParen = prefix.substring(0, openParenCol).trimEnd();
    const callMatch = beforeParen.match(/(?:((?:[A-Za-z0-9_]+\.)*[A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)$/);
    if (!callMatch) return null;

    const methodName = callMatch[2];

    // Find candidate definitions
    const exactDefs = this.indexer.findExact(methodName);
    if (exactDefs.length === 0) return null;

    // Count top-level commas between '(' and current cursor position to determine active parameter index
    let activeParam = 0;
    depth = 0;
    inQuote = null;
    const argSlice = prefix.substring(openParenCol + 1);
    for (let i = 0; i < argSlice.length; i++) {
      const ch = argSlice[i];
      if (inQuote) {
        if (ch === inQuote && (i === 0 || argSlice[i - 1] !== '\\')) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        activeParam++;
      }
    }

    const help = new vscode.SignatureHelp();
    help.activeSignature = 0;
    help.activeParameter = activeParam;

    for (const def of exactDefs) {
      if (!def.signature) continue;
      const isMethod = def.kind === 'method' || Boolean(def.containerName);
      const sigInfo = this.inspector.parsePythonSignature(def.signature, isMethod, Boolean(def.isStatic));
      if (!sigInfo) continue;

      if (def.docstring) {
        this.inspector.enrichParamsWithDocstring(sigInfo.params, def.docstring);
      }

      const sigLabel = `${methodName}(${sigInfo.params.map((p) => {
        let text = p.name;
        if (p.type) text += `: ${p.type}`;
        if (p.hasDefault && p.defaultValue) text += ` = ${p.defaultValue}`;
        return text;
      }).join(', ')})`;

      const sigInformation = new vscode.SignatureInformation(sigLabel);
      if (def.docstring) {
        sigInformation.documentation = new vscode.MarkdownString(def.docstring);
      }

      sigInformation.parameters = sigInfo.params.map((p) => {
        let pLabel = p.name;
        if (p.type) pLabel += `: ${p.type}`;
        if (p.hasDefault && p.defaultValue) pLabel += ` = ${p.defaultValue}`;
        const pInfo = new vscode.ParameterInformation(pLabel);
        if (p.description) {
          pInfo.documentation = new vscode.MarkdownString(p.description);
        }
        return pInfo;
      });

      help.signatures.push(sigInformation);
    }

    return help.signatures.length > 0 ? help : null;
  }
}
