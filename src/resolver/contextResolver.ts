import * as vscode from 'vscode';
import { SymbolDefinition } from '../types';

export interface EnclosingClassInfo {
  name: string;
  startLine: number;
  parentClasses: string[];
}

export interface ReceiverInfo {
  rawPrefix: string;
  varName?: string;
  containerName?: string; // Resolved target class (e.g. "Dog")
  isSelf: boolean;
  isCls: boolean;
  isSuper: boolean;
  enclosingClass?: EnclosingClassInfo;
}

export class ContextResolver {
  /**
   * Determine the enclosing class of a given position in a document.
   */
  public static getEnclosingClass(
    document: vscode.TextDocument,
    position: vscode.Position
  ): EnclosingClassInfo | undefined {
    const isPython = document.languageId === 'python';
    const currentLine = position.line;
    const currentLineText = document.lineAt(currentLine).text;
    const indentMatch = currentLineText.match(/^(\s*)/);
    const currentIndent = indentMatch ? indentMatch[1].length : 0;

    for (let i = currentLine - 1; i >= 0; i--) {
      const lineText = document.lineAt(i).text;
      const trimmed = lineText.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      if (isPython) {
        const classMatch = lineText.match(/^(\s*)class\s+([A-Za-z0-9_]+)(?:\s*\((.*?)\))?\s*:/);
        if (classMatch) {
          const classIndent = classMatch[1].length;
          // Must be indented under the class (or inside class body)
          if (currentIndent > classIndent || (currentIndent === 0 && currentLineText.trim().length === 0)) {
            const className = classMatch[2];
            const basesStr = classMatch[3];
            const parentClasses = basesStr
              ? basesStr
                  .split(',')
                  .map((b) => b.trim().split('.').pop() || b.trim())
                  .filter((b) => Boolean(b) && b !== 'object')
              : [];
            return {
              name: className,
              startLine: i,
              parentClasses,
            };
          }
        }
      } else {
        // TypeScript, JavaScript, Java, C++, etc.
        const classMatch = lineText.match(
          /(?:class|interface)\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$,\s]+))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/
        );
        if (classMatch) {
          const className = classMatch[1];
          const extendsStr = classMatch[2];
          const implementsStr = classMatch[3];
          const parentClasses: string[] = [];
          if (extendsStr) {
            parentClasses.push(
              ...extendsStr
                .split(',')
                .map((b) => b.trim().split('.').pop() || b.trim())
                .filter(Boolean)
            );
          }
          if (implementsStr) {
            parentClasses.push(
              ...implementsStr
                .split(',')
                .map((b) => b.trim().split('.').pop() || b.trim())
                .filter(Boolean)
            );
          }
          return {
            name: className,
            startLine: i,
            parentClasses,
          };
        }
      }
    }

    return undefined;
  }

  /**
   * Infer receiver details and container hint right before the symbol word.
   */
  public static inferReceiverFromPrefix(
    document: vscode.TextDocument,
    position: vscode.Position,
    wordRange: vscode.Range
  ): ReceiverInfo {
    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.substring(0, wordRange.start.character);

    // 1. Check super() call: e.g. super().method or super(Dog, self).method or super.method
    const isSuper = /super\s*(?:\(.*?\))?\s*\.\s*$/.test(prefix) || /base\s*\.\s*$/.test(prefix);
    if (isSuper) {
      const enclosing = this.getEnclosingClass(document, position);
      return {
        rawPrefix: prefix,
        isSelf: false,
        isCls: false,
        isSuper: true,
        enclosingClass: enclosing,
        containerName: enclosing?.parentClasses[0],
      };
    }

    // 2. Check self / cls / this / $this
    const selfMatch = prefix.match(/(?:self|cls|this|\$this)\s*(?:->|\.)\s*$/);
    if (selfMatch) {
      const isCls = prefix.endsWith('cls.');
      const enclosing = this.getEnclosingClass(document, position);
      return {
        rawPrefix: prefix,
        isSelf: true,
        isCls,
        isSuper: false,
        enclosingClass: enclosing,
        containerName: enclosing?.name,
      };
    }

    // 3. Check dot expression: obj.method or Class.method
    const dotMatch = prefix.match(/([A-Za-z0-9_]+)\s*(?:->|\.)\s*$/);
    if (dotMatch) {
      const varName = dotMatch[1];
      // Check if varName starts with uppercase (likely a class name already)
      if (/^[A-Z]/.test(varName)) {
        return {
          rawPrefix: prefix,
          varName,
          containerName: varName,
          isSelf: false,
          isCls: false,
          isSuper: false,
        };
      }

      // Infer variable type by scanning backward in current function/scope
      const inferredType = this.inferVariableType(document, varName, position.line);
      return {
        rawPrefix: prefix,
        varName,
        containerName: inferredType || varName,
        isSelf: false,
        isCls: false,
        isSuper: false,
      };
    }

    return {
      rawPrefix: prefix,
      isSelf: false,
      isCls: false,
      isSuper: false,
    };
  }

  /**
   * Scan upwards in current local scope to infer variable type.
   * e.g. `d = Dog()` or `d: Dog = ...` or `def test(d: Dog):`
   */
  public static inferVariableType(
    document: vscode.TextDocument,
    varName: string,
    callLine: number
  ): string | undefined {
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      // const x = new Dog(...) or x = Dog(...)
      new RegExp(`(?:const|let|var\\s+)?${escaped}\\s*=\\s*(?:new\\s+)?([A-Z][A-Za-z0-9_]*)\\s*\\(`),
      // x: Dog = ...
      new RegExp(`(?:const|let|var\\s+)?${escaped}\\s*:\\s*([A-Z][A-Za-z0-9_]*)\\b`),
      // def func(x: Dog):
      new RegExp(`(?:def|function)\\s+[A-Za-z0-9_]+\\s*\\(.*?[\\s,]${escaped}\\s*:\\s*([A-Z][A-Za-z0-9_]*)`),
      // (x as Dog)
      new RegExp(`\\(${escaped}\\s+as\\s+([A-Z][A-Za-z0-9_]*)\\)`),
    ];

    const minLine = Math.max(0, callLine - 60);
    for (let i = callLine - 1; i >= minLine; i--) {
      const line = document.lineAt(i).text.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }

      // Stop searching if we reach the enclosing function or class definition
      if (/^(?:def|function|class)\b/.test(line)) {
        break;
      }
    }

    return undefined;
  }

  /**
   * Check if a symbol definition represents an abstract or empty stub method.
   */
  public static isAbstractOrEmpty(docText: string, def: SymbolDefinition): boolean {
    const lines = docText.split(/\r?\n/);
    const startLine = def.range.start.line;
    const endLine = Math.min(lines.length - 1, startLine + 8);

    for (let i = startLine; i <= endLine; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      if (
        line === 'pass' ||
        line === '...' ||
        line.startsWith('raise NotImplementedError') ||
        line.startsWith('raise NotImplemented') ||
        line.startsWith('@abstractmethod')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a local variable or parameter in the current enclosing function/block scope.
   */
  public static resolveLocalScope(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolName: string
  ): { uri: vscode.Uri; range: vscode.Range; selectionRange: vscode.Range } | null {
    const isPython = document.languageId === 'python';
    const currentLine = position.line;
    let funcStartLine = 0;

    // 1. Find enclosing function start line
    if (isPython) {
      const lineText = document.lineAt(currentLine).text;
      const curIndentMatch = lineText.match(/^(\s*)/);
      const curIndent = curIndentMatch ? curIndentMatch[1].length : 0;
      for (let i = currentLine - 1; i >= 0; i--) {
        const line = document.lineAt(i).text;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
        if (defMatch) {
          const defIndent = defMatch[1].length;
          if (curIndent > defIndent || curIndent === 0) {
            funcStartLine = i;
            break;
          }
        }
        // If we hit class declaration with lower indent, stop
        const classMatch = line.match(/^(\s*)class\s+/);
        if (classMatch && classMatch[1].length < curIndent) {
          funcStartLine = i + 1;
          break;
        }
      }
    } else {
      for (let i = currentLine - 1; i >= 0; i--) {
        const line = document.lineAt(i).text;
        if (/\bfunction\b|\bdef\b|\bfunc\b|=>|\b(?:public|private|protected|async)\s+[A-Za-z0-9_$]+\s*\(/.test(line)) {
          funcStartLine = i;
          break;
        }
      }
    }

    // 2. Scan from funcStartLine up to currentLine
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`\\b${escaped}\\b`);
    const assignRegex = new RegExp(`^(\\s*)(?:const|let|var)?\\s*\\b(${escaped})\\b(?:\\[[^\\]]*\\])?(?:\\s*:\\s*[^=]+)?\\s*=(?!=)`);
    const forRegex = new RegExp(`^(\\s*)for\\s+.*?\\b(${escaped})\\b.*?\\bin\\b`);
    const withRegex = new RegExp(`^(\\s*)with\\s+.*?\\bas\\s+.*?\\b(${escaped})\\b`);

    let firstDecl: { line: number; col: number; len: number } | null = null;

    for (let i = funcStartLine; i < currentLine; i++) {
      const lineText = document.lineAt(i).text;
      if (!wordRegex.test(lineText)) continue;

      // Parameter in function header
      if (i === funcStartLine && (lineText.includes('def ') || lineText.includes('function ') || lineText.includes('func '))) {
        const paramRegex = new RegExp(`[\\(, ]\\s*(${escaped})\\s*[\\), =:]`);
        const paramMatch = paramRegex.exec(lineText);
        if (paramMatch) {
          const col = lineText.indexOf(symbolName, paramMatch.index);
          firstDecl = { line: i, col, len: symbolName.length };
          break;
        }
      }

      // Assignment: var = ...
      const mAssign = assignRegex.exec(lineText);
      if (mAssign) {
        const col = lineText.indexOf(symbolName, mAssign[1].length);
        firstDecl = { line: i, col, len: symbolName.length };
        break;
      }

      // for loop: for var in ...
      const mFor = forRegex.exec(lineText);
      if (mFor) {
        const col = lineText.indexOf(symbolName, mFor[1].length);
        firstDecl = { line: i, col, len: symbolName.length };
        break;
      }

      // with statement: with ... as var:
      const mWith = withRegex.exec(lineText);
      if (mWith) {
        const col = lineText.indexOf(symbolName, mWith[1].length);
        firstDecl = { line: i, col, len: symbolName.length };
        break;
      }
    }

    if (firstDecl) {
      const lineLen = document.lineAt(firstDecl.line).text.length;
      return {
        uri: document.uri,
        range: new vscode.Range(firstDecl.line, 0, firstDecl.line, lineLen),
        selectionRange: new vscode.Range(firstDecl.line, firstDecl.col, firstDecl.line, firstDecl.col + firstDecl.len),
      };
    }

    return null;
  }
}
