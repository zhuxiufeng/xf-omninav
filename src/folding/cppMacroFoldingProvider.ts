import * as vscode from 'vscode';
import { FoldingCache } from './foldingCache';

interface MacroBlockEntry {
  startLine: number;
  type: 'if' | 'elif' | 'else';
}

/**
 * Fine-grained folding provider for C/C++ preprocessor directives (#if, #elif, #else, #endif).
 * Allows independent folding of each platform/condition branch without swallowing others.
 */
export class CppMacroFoldingProvider implements vscode.FoldingRangeProvider {
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

    const ranges = CppMacroFoldingProvider.computeFoldingRanges(
      document.getText(),
      token
    );

    if (!token?.isCancellationRequested) {
      FoldingCache.set(uriStr, version, ranges);
    }

    return ranges;
  }

  /**
   * Pure compute function: parses C/C++ text for preprocessor macro branches.
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

    const macroRe =
      /^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b/;
    const stack: MacroBlockEntry[] = [];

    let directiveStartLine = -1;
    let directiveKeyword = '';

    for (let i = 0; i < lineCount; i++) {
      const rawLine = lines[i];
      const stripped = rawLine.trim();
      if (!stripped) {
        continue;
      }

      // Check for backslash line continuation
      const isBackslashContinuation = stripped.endsWith('\\');
      const cleanLine = isBackslashContinuation
        ? stripped.slice(0, -1).trimEnd()
        : stripped;

      if (directiveStartLine === -1) {
        const match = macroRe.exec(cleanLine);
        if (match) {
          directiveStartLine = i;
          directiveKeyword = match[1];
        }
      }

      if (isBackslashContinuation) {
        continue; // Directive condition continues on next line
      }

      if (directiveStartLine !== -1) {
        const kw = directiveKeyword;
        const actualStart = directiveStartLine;
        directiveStartLine = -1;
        directiveKeyword = '';

        if (kw === 'if' || kw === 'ifdef' || kw === 'ifndef') {
          stack.push({ startLine: actualStart, type: 'if' });
        } else if (kw === 'elif' || kw === 'elifdef' || kw === 'elifndef') {
          if (
            stack.length > 0 &&
            (stack[stack.length - 1].type === 'if' ||
              stack[stack.length - 1].type === 'elif')
          ) {
            const top = stack.pop()!;
            let endLine = actualStart - 1;
            while (endLine > top.startLine && !lines[endLine].trim()) {
              endLine--;
            }
            if (endLine > top.startLine) {
              ranges.push(new vscode.FoldingRange(top.startLine, endLine));
            }
          }
          stack.push({ startLine: actualStart, type: 'elif' });
        } else if (kw === 'else') {
          if (
            stack.length > 0 &&
            (stack[stack.length - 1].type === 'if' ||
              stack[stack.length - 1].type === 'elif')
          ) {
            const top = stack.pop()!;
            let endLine = actualStart - 1;
            while (endLine > top.startLine && !lines[endLine].trim()) {
              endLine--;
            }
            if (endLine > top.startLine) {
              ranges.push(new vscode.FoldingRange(top.startLine, endLine));
            }
          }
          stack.push({ startLine: actualStart, type: 'else' });
        } else if (kw === 'endif') {
          if (stack.length > 0) {
            const top = stack.pop()!;
            // Endif folds down to line before or including endif
            if (i > top.startLine) {
              ranges.push(new vscode.FoldingRange(top.startLine, i));
            }
          }
        }
      }
    }

    return ranges.sort((a, b) => a.start - b.start);
  }
}
