import * as vscode from 'vscode';
import { FoldingCache } from './foldingCache';

interface MatchContext {
  depth: number;
  activeArmStart: number | null;
}

/**
 * Fine-grained folding provider for Rust (.rs).
 * Provides independent folding for:
 * - Each match arm inside `match` blocks (without needing extra braces)
 * - Consecutive derive and attribute macros (#[...])
 * - Consecutive doc comments (/// and //!)
 * - Consecutive `use` import blocks
 */
export class RustBranchFoldingProvider implements vscode.FoldingRangeProvider {
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

    const ranges = RustBranchFoldingProvider.computeFoldingRanges(
      document.getText(),
      token
    );

    if (!token?.isCancellationRequested) {
      FoldingCache.set(uriStr, version, ranges);
    }

    return ranges;
  }

  /**
   * Pure compute function for Rust syntax structures.
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

    // 1. Scan for consecutive `use ` import blocks
    let useStart = -1;
    let lastUse = -1;
    for (let i = 0; i < lineCount; i++) {
      const stripped = lines[i].trim();
      if (stripped.startsWith('use ') || stripped.startsWith('pub use ')) {
        if (useStart === -1) {
          useStart = i;
        }
        lastUse = i;
      } else if (!stripped || stripped.startsWith('//') || stripped.startsWith('/*')) {
        continue;
      } else {
        if (useStart !== -1 && lastUse > useStart) {
          ranges.push(
            new vscode.FoldingRange(
              useStart,
              lastUse,
              vscode.FoldingRangeKind.Imports
            )
          );
        }
        useStart = -1;
        lastUse = -1;
      }
    }
    if (useStart !== -1 && lastUse > useStart) {
      ranges.push(
        new vscode.FoldingRange(
          useStart,
          lastUse,
          vscode.FoldingRangeKind.Imports
        )
      );
    }

    // 2. Scan for consecutive doc comments (/// or //!)
    let docStart = -1;
    let lastDoc = -1;
    for (let i = 0; i < lineCount; i++) {
      const stripped = lines[i].trim();
      if (stripped.startsWith('///') || stripped.startsWith('//!')) {
        if (docStart === -1) {
          docStart = i;
        }
        lastDoc = i;
      } else {
        if (docStart !== -1 && lastDoc > docStart) {
          ranges.push(
            new vscode.FoldingRange(
              docStart,
              lastDoc,
              vscode.FoldingRangeKind.Comment
            )
          );
        }
        docStart = -1;
        lastDoc = -1;
      }
    }
    if (docStart !== -1 && lastDoc > docStart) {
      ranges.push(
        new vscode.FoldingRange(
          docStart,
          lastDoc,
          vscode.FoldingRangeKind.Comment
        )
      );
    }

    // 3. Scan for consecutive attribute macros (#[...])
    let attrStart = -1;
    let lastAttr = -1;
    for (let i = 0; i < lineCount; i++) {
      const stripped = lines[i].trim();
      if (stripped.startsWith('#[') || stripped.startsWith('#![')) {
        if (attrStart === -1) {
          attrStart = i;
        }
        lastAttr = i;
      } else {
        if (attrStart !== -1 && lastAttr > attrStart) {
          ranges.push(new vscode.FoldingRange(attrStart, lastAttr));
        }
        attrStart = -1;
        lastAttr = -1;
      }
    }
    if (attrStart !== -1 && lastAttr > attrStart) {
      ranges.push(new vscode.FoldingRange(attrStart, lastAttr));
    }

    // 4. Scan match blocks and their arms
    let braceDepth = 0;
    const matchStack: MatchContext[] = [];

    let inBlockComment = false;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let lastNonEmptyCleanLine = '';

    for (let i = 0; i < lineCount; i++) {
      const rawLine = lines[i];
      let escaped = false;
      const cleanChars: string[] = [];
      const startOfLineDepth = braceDepth;

      for (let j = 0; j < rawLine.length; j++) {
        const ch = rawLine.charAt(j);
        const nextCh = j + 1 < rawLine.length ? rawLine.charAt(j + 1) : '';

        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\' && inDoubleQuote) {
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

        if (ch === '/' && nextCh === '/') {
          break; // Single line comment
        }
        if (ch === '/' && nextCh === '*') {
          inBlockComment = true;
          j++;
          continue;
        }

        if (ch === '"') {
          inDoubleQuote = true;
          continue;
        }

        // Braces
        if (ch === '{') {
          braceDepth++;
          const linePrefix = cleanChars.join('').trim();
          const isMatch = /\bmatch\b/.test(linePrefix) || (/\bmatch\b/.test(lastNonEmptyCleanLine) && !lastNonEmptyCleanLine.includes("{"));

          if (isMatch) {
            matchStack.push({ depth: braceDepth, activeArmStart: null });
          }
        } else if (ch === '}') {
          if (
            matchStack.length > 0 &&
            matchStack[matchStack.length - 1].depth === braceDepth
          ) {
            const m = matchStack.pop()!;
            if (m.activeArmStart !== null) {
              let endLine = i - 1;
              while (endLine > m.activeArmStart && !lines[endLine].trim()) {
                endLine--;
              }
              if (endLine > m.activeArmStart) {
                ranges.push(new vscode.FoldingRange(m.activeArmStart, endLine));
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

      // Check for match arm (=>) when entering at the match block's inner depth
      if (
        matchStack.length > 0 &&
        startOfLineDepth === matchStack[matchStack.length - 1].depth
      ) {
        const m = matchStack[matchStack.length - 1];
        if (cleanLine.includes('=>')) {
          if (m.activeArmStart !== null) {
            let endLine = i - 1;
            while (endLine > m.activeArmStart && !lines[endLine].trim()) {
              endLine--;
            }
            if (endLine > m.activeArmStart) {
              ranges.push(new vscode.FoldingRange(m.activeArmStart, endLine));
            }
          }
          m.activeArmStart = i;
        }
      }
    }

    return ranges.sort((a, b) => a.start - b.start);
  }
}
