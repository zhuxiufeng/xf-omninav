import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface UsageItem {
  uri: vscode.Uri;
  range: vscode.Range;
  text: string;
  relativePath: string;
}

export class UsageResolver {
  /**
   * Check if current position is on the definition header of symbolName.
   */
  public static isAtDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolName: string
  ): boolean {
    const lineText = document.lineAt(position.line).text;
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Python patterns
    if (document.languageId === 'python') {
      const pyPatterns = [
        new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\b`),
        new RegExp(`^\\s*class\\s+${escaped}\\b`),
        new RegExp(`^\\s*(?:self|cls)\\.${escaped}\\b(?:\\s*:\\s*[^=]+)?\\s*=`),
        new RegExp(`^\\s*${escaped}\\b(?:\\s*:\\s*[^=]+)?\\s*=`),
      ];
      return pyPatterns.some((pattern) => pattern.test(lineText));
    }

    // 2. JS / TS patterns
    if (
      document.languageId === 'typescript' ||
      document.languageId === 'javascript' ||
      document.languageId === 'typescriptreact' ||
      document.languageId === 'javascriptreact'
    ) {
      const jsPatterns = [
        new RegExp(`(?:function|class|interface|type)\\s+${escaped}\\b`),
        new RegExp(`(?:const|let|var)\\s+${escaped}\\b\\s*(?::\\s*[^=]+)?\\s*=`),
        new RegExp(`^\\s*(?:public|private|protected|async|static|\\*)*\\s*${escaped}\\b\\s*\\(`),
      ];
      return jsPatterns.some((pattern) => pattern.test(lineText));
    }

    // 3. Generic fallback patterns
    const genericPatterns = [
      new RegExp(`(?:def|function|class|fn|func|struct)\\s+${escaped}\\b`),
      new RegExp(`^\\s*${escaped}\\b\\s*[:=]`),
    ];
    return genericPatterns.some((pattern) => pattern.test(lineText));
  }

  /**
   * Find all usages/callers of symbolName across LSP and workspace text search.
   */
  public static async findUsages(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolName: string
  ): Promise<UsageItem[]> {
    const seen = new Set<string>();
    const results: UsageItem[] = [];
    const defKey = `${document.uri.toString()}:${position.line}`;

    // 1. Try LSP Reference Provider (with 200ms timeout for instant responsiveness)
    try {
      const lspRefs = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          position
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
      ]);

      if (lspRefs && lspRefs.length > 0) {
        for (const ref of lspRefs) {
          const key = `${ref.uri.toString()}:${ref.range.start.line}`;
          if (key === defKey || seen.has(key)) {
            continue;
          }
          seen.add(key);

          // Get line snippet if available without calling openTextDocument
          let lineText = '';
          try {
            const openDoc = vscode.workspace.textDocuments?.find(
              (d) => d.uri.toString() === ref.uri.toString()
            );
            if (openDoc) {
              lineText = openDoc.lineAt(ref.range.start.line).text.trim();
            } else if (ref.uri.scheme === 'file') {
              const fileContent = await fs.promises.readFile(ref.uri.fsPath, 'utf8');
              const refLines = fileContent.split(/\r?\n/);
              lineText = (refLines[ref.range.start.line] || '').trim();
            }
          } catch {}

          results.push({
            uri: ref.uri,
            range: ref.range,
            text: lineText,
            relativePath: vscode.workspace.asRelativePath(ref.uri, false),
          });
        }
      }
    } catch {}

    // 2. Fast scan inside current document (instant & 100% resilient)
    const docResults = this.scanDocumentForCalls(document, symbolName, position.line);
    for (const item of docResults) {
      const key = `${item.uri.toString()}:${item.range.start.line}`;
      if (key !== defKey && !seen.has(key)) {
        seen.add(key);
        results.push(item);
      }
    }

    // 3. If callers in current document are sparse, scan workspace files of same extension
    if (results.length < 5) {
      const ext = path.extname(document.uri.fsPath);
      if (ext) {
        try {
          const pattern = `**/*${ext}`;
          const exclude =
            '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/dist/**,**/build/**,**/.venv/**,**/venv/**}';
          const uris = await vscode.workspace.findFiles(pattern, exclude, 50);

          for (const uri of uris) {
            if (uri.toString() === document.uri.toString()) {
              continue;
            }
            try {
              let content: string;
              const openDoc = vscode.workspace.textDocuments?.find(
                (d) => d.uri.toString() === uri.toString()
              );
              if (openDoc) {
                content = openDoc.getText();
              } else if (uri.scheme === 'file') {
                content = await fs.promises.readFile(uri.fsPath, 'utf8');
              } else {
                const raw = await vscode.workspace.fs.readFile(uri);
                content = Buffer.from(raw).toString('utf8');
              }

              if (!content.includes(symbolName)) {
                continue;
              }

              const fileResults = this.scanTextForCalls(uri, content, symbolName);
              for (const item of fileResults) {
                const key = `${item.uri.toString()}:${item.range.start.line}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  results.push(item);
                }
              }
            } catch {}
          }
        } catch {}
      }
    }

    // Sort by: current file first, then line number
    const currentDocStr = document.uri.toString();
    return results.sort((a, b) => {
      const aIsCurrent = a.uri.toString() === currentDocStr ? 1 : 0;
      const bIsCurrent = b.uri.toString() === currentDocStr ? 1 : 0;
      if (aIsCurrent !== bIsCurrent) {
        return bIsCurrent - aIsCurrent;
      }
      return a.range.start.line - b.range.start.line;
    });
  }

  /**
   * Scan text content for lines calling or referencing symbolName.
   */
  public static scanTextForCalls(
    uri: vscode.Uri,
    text: string,
    symbolName: string,
    excludeLine?: number
  ): UsageItem[] {
    const results: UsageItem[] = [];
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callRegex = new RegExp(`\\b${escaped}\\b`);
    const lines = text.split(/\r?\n/);
    const relPath = vscode.workspace.asRelativePath(uri, false);

    for (let i = 0; i < lines.length; i++) {
      if (excludeLine !== undefined && i === excludeLine) {
        continue;
      }

      const line = lines[i];
      if (!line.includes(symbolName)) {
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      // Skip the definition line itself (e.g. def func_name)
      if (
        new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\b`).test(line) ||
        new RegExp(`^\\s*class\\s+${escaped}\\b`).test(line)
      ) {
        continue;
      }

      const match = callRegex.exec(line);
      if (match) {
        const startChar = match.index;
        const endChar = startChar + symbolName.length;
        results.push({
          uri,
          range: new vscode.Range(i, startChar, i, endChar),
          text: trimmed,
          relativePath: relPath,
        });
      }
    }

    return results;
  }

  /**
   * Scan text document for lines calling or referencing symbolName.
   */
  private static scanDocumentForCalls(
    document: vscode.TextDocument,
    symbolName: string,
    excludeLine?: number
  ): UsageItem[] {
    return this.scanTextForCalls(document.uri, document.getText(), symbolName, excludeLine);
  }
}
