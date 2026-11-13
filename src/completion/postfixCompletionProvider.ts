import * as vscode from 'vscode';
import { getOmniConfig } from '../utils';

interface PostfixTemplate {
  name: string;
  description: string;
  getSnippet: (expr: string) => string;
}

/**
 * Universal Postfix Completion Provider (PyCharm Style).
 * Transforms `expr.for` -> `for item in expr:`, `expr.if` -> `if expr:`, etc.
 */
export class PostfixCompletionProvider implements vscode.CompletionItemProvider {
  private pythonTemplates: PostfixTemplate[] = [
    {
      name: 'for',
      description: 'for item in expr:',
      getSnippet: (expr) => `for \${1:item} in ${expr}:\n\t\${0}`,
    },
    {
      name: 'if',
      description: 'if expr:',
      getSnippet: (expr) => `if ${expr}:\n\t\${0}`,
    },
    {
      name: 'not',
      description: 'not expr',
      getSnippet: (expr) => `not ${expr}\${0}`,
    },
    {
      name: 'len',
      description: 'len(expr)',
      getSnippet: (expr) => `len(${expr})\${0}`,
    },
    {
      name: 'return',
      description: 'return expr',
      getSnippet: (expr) => `return ${expr}\${0}`,
    },
    {
      name: 'print',
      description: 'print(expr)',
      getSnippet: (expr) => `print(${expr})\${0}`,
    },
    {
      name: 'var',
      description: 'val = expr',
      getSnippet: (expr) => `\${1:val} = ${expr}\${0}`,
    },
    {
      name: 'par',
      description: '(expr)',
      getSnippet: (expr) => `(${expr})\${0}`,
    },
    {
      name: 'await',
      description: 'await expr',
      getSnippet: (expr) => `await ${expr}\${0}`,
    },
    {
      name: 'yield',
      description: 'yield expr',
      getSnippet: (expr) => `yield ${expr}\${0}`,
    },
  ];

  private jsTsTemplates: PostfixTemplate[] = [
    {
      name: 'for',
      description: 'for (const item of expr) { ... }',
      getSnippet: (expr) => `for (const \${1:item} of ${expr}) {\n\t\${0}\n}`,
    },
    {
      name: 'fori',
      description: 'for (let i = 0; i < expr.length; i++) { ... }',
      getSnippet: (expr) => `for (let \${1:i} = 0; \${1:i} < ${expr}.length; \${1:i}++) {\n\t\${0}\n}`,
    },
    {
      name: 'if',
      description: 'if (expr) { ... }',
      getSnippet: (expr) => `if (${expr}) {\n\t\${0}\n}`,
    },
    {
      name: 'not',
      description: '!expr',
      getSnippet: (expr) => `!${expr}\${0}`,
    },
    {
      name: 'return',
      description: 'return expr;',
      getSnippet: (expr) => `return ${expr};\${0}`,
    },
    {
      name: 'log',
      description: 'console.log(expr);',
      getSnippet: (expr) => `console.log(${expr});\${0}`,
    },
    {
      name: 'print',
      description: 'console.log(expr);',
      getSnippet: (expr) => `console.log(${expr});\${0}`,
    },
    {
      name: 'const',
      description: 'const val = expr;',
      getSnippet: (expr) => `const \${1:val} = ${expr};\${0}`,
    },
    {
      name: 'let',
      description: 'let val = expr;',
      getSnippet: (expr) => `let \${1:val} = ${expr};\${0}`,
    },
    {
      name: 'await',
      description: 'await expr',
      getSnippet: (expr) => `await ${expr}\${0}`,
    },
    {
      name: 'par',
      description: '(expr)',
      getSnippet: (expr) => `(${expr})\${0}`,
    },
  ];

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    const isEnabled = getOmniConfig<boolean>('enablePostfixCompletion', true);
    if (!isEnabled) return [];

    const line = document.lineAt(position.line).text;
    const linePrefix = line.slice(0, position.character);

    // Extract expression and postfix word: e.g. "my_list.for" or "items."
    // Support calls, brackets, quotes, identifiers
    const match = linePrefix.match(/([a-zA-Z0-9_.\(\)\[\]"']+)\.([a-zA-Z0-9_]*)$/);
    if (!match) return [];

    const fullMatch = match[0];
    const expr = match[1].trim();
    const postfixPrefix = match[2];

    if (!expr || expr.endsWith('.')) return [];

    const lang = document.languageId;
    const isPython = lang === 'python';
    const isJsTs =
      lang === 'typescript' ||
      lang === 'javascript' ||
      lang === 'typescriptreact' ||
      lang === 'javascriptreact';

    const templates = isPython
      ? this.pythonTemplates
      : isJsTs
      ? this.jsTsTemplates
      : [];

    if (templates.length === 0) return [];

    const replaceRange = new vscode.Range(
      new vscode.Position(position.line, position.character - fullMatch.length),
      position
    );

    const items: vscode.CompletionItem[] = [];

    for (const t of templates) {
      if (postfixPrefix && !t.name.startsWith(postfixPrefix)) {
        continue;
      }

      const item = new vscode.CompletionItem(`.${t.name}`, vscode.CompletionItemKind.Snippet);
      item.detail = `${t.description} (Postfix)`;
      item.documentation = new vscode.MarkdownString(
        `**XF OmniNav: 后缀补全 (PyCharm 风格)**\n\n将 \`${fullMatch}\` 自动展开为:\n\`\`\`${lang}\n${t.getSnippet(
          expr
        ).replace(/\$\{\d+:?([^}]*)\}/g, '$1')}\n\`\`\``
      );
      item.insertText = new vscode.SnippetString(t.getSnippet(expr));
      item.range = replaceRange;
      item.sortText = `00_postfix_${t.name}`;
      item.filterText = `.${t.name}`;
      items.push(item);
    }

    return items;
  }
}
