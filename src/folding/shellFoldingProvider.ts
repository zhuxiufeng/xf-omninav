import * as vscode from 'vscode';
import { FoldingCache } from './foldingCache';

interface ShellBlockEntry {
  startLine: number;
  type: 'if' | 'elif' | 'else' | 'case';
}

/**
 * Fine-grained folding provider for Shell / Bash scripts (.sh, .bash).
 * Provides independent folding ranges for:
 * - if ... elif ... else ... fi
 * - case ... in ... esac
 * - consecutive comment blocks
 */
export class ShellBranchFoldingProvider implements vscode.FoldingRangeProvider {
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

    const ranges = ShellBranchFoldingProvider.computeFoldingRanges(
      document.getText(),
      token
    );

    if (!token?.isCancellationRequested) {
      FoldingCache.set(uriStr, version, ranges);
    }

    return ranges;
  }

  /**
   * Pure compute function: parses Shell text and returns folding ranges.
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

    // 1. Scan for consecutive comment blocks
    let commentStart = -1;
    let lastComment = -1;
    for (let i = 0; i < lineCount; i++) {
      const stripped = lines[i].trim();
      if (stripped.startsWith('#') && !stripped.startsWith('#!')) {
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

    // 2. Scan if-elif-else-fi and case-esac
    const ifStack: ShellBlockEntry[] = [];
    const caseStack: number[] = [];

    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < lineCount; i++) {
      const rawLine = lines[i];

      // Tokenize line outside quotes and comments
      const { tokens, nextInSingle, nextInDouble } =
        ShellBranchFoldingProvider.extractShellKeywords(
          rawLine,
          inSingleQuote,
          inDoubleQuote
        );

      inSingleQuote = nextInSingle;
      inDoubleQuote = nextInDouble;

      for (const token of tokens) {
        if (token === 'if') {
          ifStack.push({ startLine: i, type: 'if' });
        } else if (token === 'elif') {
          if (ifStack.length > 0 && (ifStack[ifStack.length - 1].type === 'if' || ifStack[ifStack.length - 1].type === 'elif')) {
            const top = ifStack.pop()!;
            let endLine = i - 1;
            while (endLine > top.startLine && !lines[endLine].trim()) {
              endLine--;
            }
            if (endLine > top.startLine) {
              ranges.push(new vscode.FoldingRange(top.startLine, endLine));
            }
          }
          ifStack.push({ startLine: i, type: 'elif' });
        } else if (token === 'else') {
          if (ifStack.length > 0 && (ifStack[ifStack.length - 1].type === 'if' || ifStack[ifStack.length - 1].type === 'elif')) {
            const top = ifStack.pop()!;
            let endLine = i - 1;
            while (endLine > top.startLine && !lines[endLine].trim()) {
              endLine--;
            }
            if (endLine > top.startLine) {
              ranges.push(new vscode.FoldingRange(top.startLine, endLine));
            }
          }
          ifStack.push({ startLine: i, type: 'else' });
        } else if (token === 'fi') {
          if (ifStack.length > 0) {
            const top = ifStack.pop()!;
            // Folds down to fi
            if (i > top.startLine) {
              ranges.push(new vscode.FoldingRange(top.startLine, i));
            }
          }
        } else if (token === 'case') {
          caseStack.push(i);
        } else if (token === 'esac') {
          if (caseStack.length > 0) {
            const start = caseStack.pop()!;
            if (i > start) {
              ranges.push(new vscode.FoldingRange(start, i));
            }
          }
        }
      }
    }

    return ranges.sort((a, b) => a.start - b.start);
  }

  /**
   * Extracts keywords (if, elif, else, fi, case, esac) outside quotes and comments.
   */
  public static extractShellKeywords(
    line: string,
    startInSingle: boolean,
    startInDouble: boolean
  ): {
    tokens: string[];
    nextInSingle: boolean;
    nextInDouble: boolean;
  } {
    let inSingle = startInSingle;
    let inDouble = startInDouble;
    let escaped = false;
    const cleanChars: string[] = [];

    for (let i = 0; i < line.length; i++) {
      const ch = line.charAt(i);

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && !inSingle) {
        escaped = true;
        continue;
      }

      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        }
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === '#') {
        // Comment starts, ignore rest of line
        break;
      }

      cleanChars.push(ch);
    }

    const cleanLine = cleanChars.join('');
    const kwRegex = /\b(if|elif|else|fi|case|esac)\b/g;
    const tokens: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = kwRegex.exec(cleanLine)) !== null) {
      tokens.push(match[1]);
    }

    return {
      tokens,
      nextInSingle: inSingle,
      nextInDouble: inDouble,
    };
  }
}
