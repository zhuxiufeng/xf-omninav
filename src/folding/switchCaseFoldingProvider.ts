import * as vscode from 'vscode';
import { FoldingCache } from './foldingCache';

interface SwitchContext {
  depth: number;
  activeCaseStart: number | null;
}

/**
 * Universal fine-grained Switch-Case & Select-Case folding provider.
 * Supports: TypeScript, JavaScript, Java, Go.
 *
 * Provides independent folding for:
 * - Each `case ...:` and `default:` branch inside `switch` / Go `select` blocks
 * - Consecutive import blocks
 * - Consecutive line comments
 */
export class SwitchCaseFoldingProvider implements vscode.FoldingRangeProvider {
  private _onDidChangeFoldingRanges: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeFoldingRanges: vscode.Event<void> =
    this._onDidChangeFoldingRanges.event;

  public fireDidChange(): void {
    this._onDidChangeFoldingRanges.fire();
  }

  public provideFoldingRanges(
    document: vscode.TextDocument,
    _context: vscode.FoldingContext,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FoldingRange[]> {
    if (token?.isCancellationRequested) {
      return [];
    }

    const uriStr = document.uri.toString();
    const version = document.version;
    const cached = FoldingCache.get(uriStr, version);
    if (cached) {
      return cached;
    }

    const ranges = SwitchCaseFoldingProvider.computeFoldingRanges(
      document.getText(),
      token
    );

    if (!token?.isCancellationRequested) {
      FoldingCache.set(uriStr, version, ranges);
    }

    return ranges;
  }

  /**
   * Pure compute function for switch/select cases across TS, JS, Java, and Go.
   */
  public static computeFoldingRanges(
    text: string,
    token?: vscode.CancellationToken
  ): vscode.FoldingRange[] {
    const lines = text.split('\n');
    const ranges: vscode.FoldingRange[] = [];
    const lineCount = lines.length;
    if (lineCount === 0) {
      return ranges;
    }

    // 1. Scan for consecutive import blocks
    let importStart = -1;
    let lastImport = -1;
    for (let i = 0; i < lineCount; i++) {
      const stripped = lines[i].trim();
      if (
        stripped.startsWith('import ') ||
        stripped.startsWith('import(') ||
        stripped.startsWith('package ')
      ) {
        if (importStart === -1) {
          importStart = i;
        }
        lastImport = i;
      } else if (!stripped || stripped.startsWith('//') || stripped.startsWith('/*')) {
        continue;
      } else {
        if (importStart !== -1 && lastImport > importStart) {
          ranges.push(
            new vscode.FoldingRange(
              importStart,
              lastImport,
              vscode.FoldingRangeKind.Imports
            )
          );
        }
        importStart = -1;
        lastImport = -1;
      }
    }
    if (importStart !== -1 && lastImport > importStart) {
      ranges.push(
        new vscode.FoldingRange(
          importStart,
          lastImport,
          vscode.FoldingRangeKind.Imports
        )
      );
    }

    // 2. Scan for consecutive comment blocks
    let commentStart = -1;
    let lastComment = -1;
    for (let i = 0; i < lineCount; i++) {
      const stripped = lines[i].trim();
      if (stripped.startsWith('//')) {
        if (commentStart === -1) {
          commentStart = i;
        }
        lastComment = i;
      } else {
        if (commentStart !== -1 && lastComment > commentStart) {
          ranges.push(
            new vscode.FoldingRange(
              commentStart,
              lastComment,
              vscode.FoldingRangeKind.Comment
            )
          );
        }
        commentStart = -1;
        lastComment = -1;
      }
    }
    if (commentStart !== -1 && lastComment > commentStart) {
      ranges.push(
        new vscode.FoldingRange(
          commentStart,
          lastComment,
          vscode.FoldingRangeKind.Comment
        )
      );
    }

    // 3. Scan switch / select blocks and their cases
    let braceDepth = 0;
    const switchStack: SwitchContext[] = [];

    let inBlockComment = false;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateLiteral = false;
    let lastNonEmptyCleanLine = '';

    const caseRegex = /^\s*(case\b[^:]*:|default\s*:)/;

    for (let i = 0; i < lineCount; i++) {
      const rawLine = lines[i];
      let escaped = false;
      const cleanChars: string[] = [];

      for (let j = 0; j < rawLine.length; j++) {
        const ch = rawLine.charAt(j);
        const nextCh = j + 1 < rawLine.length ? rawLine.charAt(j + 1) : '';

        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\' && (inSingleQuote || inDoubleQuote || inTemplateLiteral)) {
          escaped = true;
          continue;
        }

        if (inBlockComment) {
          if (ch === '*' && nextCh === '/') {
            inBlockComment = false;
            j++;
          }
          continue;
        }

        if (inSingleQuote) {
          if (ch === "'") inSingleQuote = false;
          continue;
        }
        if (inDoubleQuote) {
          if (ch === '"') inDoubleQuote = false;
          continue;
        }
        if (inTemplateLiteral) {
          if (ch === '`') inTemplateLiteral = false;
          continue;
        }

        // Check comment starters outside strings
        if (ch === '/' && nextCh === '/') {
          break; // Single line comment
        }
        if (ch === '/' && nextCh === '*') {
          inBlockComment = true;
          j++;
          continue;
        }

        if (ch === "'") {
          inSingleQuote = true;
          continue;
        }
        if (ch === '"') {
          inDoubleQuote = true;
          continue;
        }
        if (ch === '`') {
          inTemplateLiteral = true;
          continue;
        }

        // Handle braces
        if (ch === '{') {
          braceDepth++;
          // Check if preceding code was switch or select
          const linePrefix = cleanChars.join('').trim();
          const isSwitchOrSelect = /\b(switch|select)\b/.test(linePrefix) || (/\b(switch|select)\b/.test(lastNonEmptyCleanLine) && !lastNonEmptyCleanLine.includes("{"));

          if (isSwitchOrSelect) {
            switchStack.push({ depth: braceDepth, activeCaseStart: null });
          }
        } else if (ch === '}') {
          if (
            switchStack.length > 0 &&
            switchStack[switchStack.length - 1].depth === braceDepth
          ) {
            const sw = switchStack.pop()!;
            if (sw.activeCaseStart !== null) {
              let endLine = i - 1;
              while (endLine > sw.activeCaseStart && !lines[endLine].trim()) {
                endLine--;
              }
              if (endLine > sw.activeCaseStart) {
                ranges.push(new vscode.FoldingRange(sw.activeCaseStart, endLine));
              }
            }
          }
          braceDepth = Math.max(0, braceDepth - 1);
        }

        cleanChars.push(ch);
      }

      const cleanLine = cleanChars.join('').trim();
      if (cleanLine.length > 0) {
        lastNonEmptyCleanLine = cleanLine;
      }

      // Check for case or default at the switch block's depth
      if (
        switchStack.length > 0 &&
        braceDepth === switchStack[switchStack.length - 1].depth
      ) {
        const sw = switchStack[switchStack.length - 1];
        if (caseRegex.test(cleanLine)) {
          if (sw.activeCaseStart !== null) {
            let endLine = i - 1;
            while (endLine > sw.activeCaseStart && !lines[endLine].trim()) {
              endLine--;
            }
            if (endLine > sw.activeCaseStart) {
              ranges.push(new vscode.FoldingRange(sw.activeCaseStart, endLine));
            }
          }
          sw.activeCaseStart = i;
        }
      }
    }

    return ranges.sort((a, b) => a.start - b.start);
  }
}
