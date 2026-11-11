import * as vscode from 'vscode';
import { CallArgumentInspector } from '../visual/callArgumentInspector';
import { SymbolIndexer } from '../indexer/symbolIndexer';

/**
 * PyCharm-grade Keyword Argument Completion Provider.
 * Automatically suggests available keyword parameter names (e.g. `param=`) when typing arguments inside function calls.
 */
export class PythonKeywordCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly inspector: CallArgumentInspector,
    private readonly indexer: SymbolIndexer
  ) {}

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
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

    // Parse call arguments up to cursor to see which keywords are already used
    const parsedArgs = this.inspector.parseCallArguments(document, position.line, openParenCol);
    const existingKeywords = new Set(parsedArgs ? parsedArgs.keywords : []);

    const items: vscode.CompletionItem[] = [];
    const seenParamNames = new Set<string>();

    for (const def of exactDefs) {
      if (!def.signature) continue;
      const isMethod = def.kind === 'method' || Boolean(def.containerName);
      const sigInfo = this.inspector.parsePythonSignature(def.signature, isMethod, Boolean(def.isStatic));
      if (!sigInfo) continue;

      if (def.docstring) {
        this.inspector.enrichParamsWithDocstring(sigInfo.params, def.docstring);
      }

      for (const p of sigInfo.params) {
        // Skip self, cls, varargs, varkwargs, positional-only params, and already passed keywords
        if (
          p.name === 'self' ||
          p.name === 'cls' ||
          p.isVararg ||
          p.isVarkwarg ||
          p.isPositionalOnly ||
          existingKeywords.has(p.name) ||
          seenParamNames.has(p.name)
        ) {
          continue;
        }

        seenParamNames.add(p.name);

        const item = new vscode.CompletionItem(
          `${p.name}=`,
          vscode.CompletionItemKind.Variable
        );
        item.insertText = new vscode.SnippetString(`${p.name}=\${1:${p.defaultValue || 'None'}}`);
        item.filterText = p.name;
        item.sortText = p.hasDefault ? `1_${p.name}` : `0_${p.name}`; // Required keywords first
        item.detail = `(keyword parameter) ${p.name}: ${p.type || 'Any'}${p.hasDefault ? ` = ${p.defaultValue}` : ''}`;

        const docMarkdown = new vscode.MarkdownString();
        docMarkdown.appendMarkdown(`**${methodName}** (\`${def.containerName || 'global'}\`)\n\n`);
        if (p.description) {
          docMarkdown.appendMarkdown(`${p.description}\n\n`);
        }
        if (p.hasDefault && p.defaultValue) {
          docMarkdown.appendMarkdown(`*Default value:* \`${p.defaultValue}\`\n\n`);
        }
        if (p.type) {
          docMarkdown.appendMarkdown(`*Type:* \`${p.type}\`\n`);
        }
        item.documentation = docMarkdown;

        items.push(item);
      }
    }

    return items;
  }
}
