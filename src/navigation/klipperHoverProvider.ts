import * as vscode from 'vscode';
import { ContextResolver } from '../resolver/contextResolver';
import { SymbolIndexer } from '../indexer/symbolIndexer';
import { getOmniConfig } from '../utils';

/**
 * Rich hover card provider for Klipper components (lookup_object) and dynamic Python variables.
 */
export class KlipperHoverProvider implements vscode.HoverProvider {
  constructor(private readonly indexer: SymbolIndexer) {}

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    if (document.languageId !== 'python') return undefined;
    const isEnabled = getOmniConfig<boolean>('enableKlipperHover', true);
    if (!isEnabled) return undefined;

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return undefined;

    const inferredType = ContextResolver.inferVariableType(document, word, position.line);
    if (!inferredType) return undefined;

    const pascalName = inferredType[0].toUpperCase() + inferredType.slice(1);
    let defs = this.indexer.findExact(inferredType);
    if (defs.length === 0) {
      defs = this.indexer.findExact(pascalName);
    }
    if (defs.length === 0) {
      defs = this.indexer.findExact(`${pascalName}Action`);
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(`### 🐍 **Klipper Component Reference**\n\n`);
    md.appendMarkdown(`- **Variable**: \`${word}\`\n`);
    md.appendMarkdown(`- **Inferred Component**: \`${inferredType}\`\n`);

    if (defs.length > 0) {
      const def = defs[0];
      const basename = def.uri.fsPath.split(/[/\\]/).pop() || def.uri.fsPath;
      md.appendMarkdown(`- **Component Class**: \`${def.name}\`\n`);
      md.appendMarkdown(`- **Source**: [${basename}#L${def.range.start.line + 1}](${def.uri.toString()})\n`);

      // List key methods in class
      const methods = this.indexer
        .findExactCaseInsensitive(def.name)
        .filter((d) => d.containerName === def.name && d.kind === 'method')
        .slice(0, 5);
      if (methods.length > 0) {
        md.appendMarkdown(`\n**Available Methods**:\n`);
        for (const m of methods) {
          const sig = m.signature && m.signature.includes('(') ? m.signature.slice(m.signature.indexOf('(')) : '()';
          md.appendMarkdown(`- \`${m.name}${sig}\`\n`);
        }
      }
    } else {
      md.appendMarkdown(`- **Lookup**: Inferred via \`printer.lookup_object('${inferredType}')\`\n`);
    }

    return new vscode.Hover(md, wordRange);
  }
}
