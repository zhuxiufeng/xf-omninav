import * as vscode from 'vscode';
import { SymbolDefinition, SymbolKind } from '../types';

export class SymbolParser {
  /**
   * Parse document lines into symbol definitions based on language.
   */
  public static parseDocument(
    document: vscode.TextDocument,
    workspaceRoot?: string
  ): SymbolDefinition[] {
    return this.parseText(
      document.getText(),
      document.uri,
      document.languageId,
      workspaceRoot
    );
  }

  /**
   * Parse raw text string into symbol definitions based on language or file extension.
   */
  public static parseText(
    text: string,
    uri: vscode.Uri,
    languageId?: string,
    workspaceRoot?: string
  ): SymbolDefinition[] {
    const lang = languageId || this.detectLanguage(uri.fsPath);
    const relativePath = workspaceRoot
      ? vscode.workspace.asRelativePath(uri, false)
      : uri.fsPath;

    if (lang === 'python') {
      return this.parsePython(text, uri, relativePath);
    } else if (
      lang === 'typescript' ||
      lang === 'javascript' ||
      lang === 'typescriptreact' ||
      lang === 'javascriptreact'
    ) {
      return this.parseJavaScriptOrTypeScript(text, uri, relativePath);
    } else if (lang === 'go') {
      return this.parseGo(text, uri, relativePath);
    } else if (lang === 'rust') {
      return this.parseRust(text, uri, relativePath);
    } else if (lang === 'cpp' || lang === 'c') {
      return this.parseCAndCpp(text, uri, relativePath);
    }

    // Default fallback parser for other languages
    return this.parseGeneric(text, uri, relativePath);
  }

  /**
   * Detect language id from file extension.
   */
  public static detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py':
        return 'python';
      case 'ts':
        return 'typescript';
      case 'tsx':
        return 'typescriptreact';
      case 'js':
        return 'javascript';
      case 'jsx':
        return 'javascriptreact';
      case 'go':
        return 'go';
      case 'rs':
        return 'rust';
      case 'cpp':
      case 'cxx':
      case 'cc':
      case 'c':
      case 'h':
      case 'hpp':
        return 'cpp';
      case 'java':
        return 'java';
      default:
        return 'plaintext';
    }
  }

  /**
   * Python parser supporting classes, functions, methods, properties, and constants.
   */
  public static parsePython(
    text: string,
    uri: vscode.Uri,
    relativePath: string
  ): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = text.split(/\r?\n/);
    const importAliases = new Map<string, string>();

    // Scan import aliases (e.g. from extras.box_wrapper import BoxAction as BoxActionBase)
    for (let lineIdx = 0; lineIdx < Math.min(lines.length, 300); lineIdx++) {
      const lineTrim = lines[lineIdx].trim();
      if (!lineTrim || lineTrim.startsWith('#')) continue;
      if (lineTrim.startsWith('class ') || lineTrim.startsWith('def ')) break;

      if (lineTrim.startsWith('from ') || lineTrim.startsWith('import ')) {
        const matches = lineTrim.matchAll(/\b([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/g);
        for (const m of matches) {
          importAliases.set(m[2], m[1]);
        }
      }
    }

    let currentClass: { name: string; indent: number } | null = null;
    let currentFuncIndent: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Calculate indentation level (using spaces/tabs)
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;

      // Check if we exited current class scope
      if (currentClass && indent <= currentClass.indent && !trimmed.startsWith('@')) {
        currentClass = null;
        currentFuncIndent = null;
      }

      // Check if we exited current function/method scope
      if (currentFuncIndent !== null && indent <= currentFuncIndent && !trimmed.startsWith('@')) {
        currentFuncIndent = null;
      }

      // 1. Class definition: class Foo(Bar):
      if (trimmed.startsWith('class ')) {
        const classMatch = line.match(/^(\s*)class\s+([A-Za-z0-9_]+)(?:\s*\((.*?)\))?\s*:/);
        if (classMatch) {
          const className = classMatch[2];
          const basesStr = classMatch[3];
          let parentContainers: string[] | undefined;
          if (basesStr) {
            const parsedBases = basesStr
              .split(',')
              .map((b) => b.trim().split('.').pop() || b.trim())
              .filter((b) => Boolean(b) && b !== 'object');
            if (parsedBases.length > 0) {
              const allBases: string[] = [];
              for (const b of parsedBases) {
                if (importAliases.has(b)) {
                  allBases.push(importAliases.get(b)!);
                }
                allBases.push(b);
              }
              parentContainers = Array.from(new Set(allBases));
            }
          }
          const startCol = classMatch[1].length + 6; // length of indentation + "class "
          const endCol = startCol + className.length;

          currentClass = { name: className, indent };
          currentFuncIndent = null;

          const range = new vscode.Range(i, 0, i, line.length);
          const selectionRange = new vscode.Range(i, startCol, i, endCol);
          const signature = trimmed.replace(/:$/, '');

          definitions.push({
            name: className,
            kind: 'class',
            parentContainers,
            uri,
            range,
            selectionRange,
            signature,
            docstring: this.extractDocstring(lines, i + 1),
            fileRelativePath: relativePath,
            isExported: !className.startsWith('_'),
          });
          continue;
        }
      }

      // 2. Function / Method definition: def foo(...) or async def foo(...)
      if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
        const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
        if (defMatch) {
          const funcName = defMatch[2];
          currentFuncIndent = indent;
          const isMethod = currentClass !== null && indent > currentClass.indent;
          const prefix = defMatch[1] + (line.includes('async ') ? 'async def ' : 'def ');
          const startCol = prefix.length;
          const endCol = startCol + funcName.length;

          const isProperty =
            i > 0 && lines[i - 1].trim().startsWith('@property');

          const kind: SymbolKind = isProperty
            ? 'property'
            : isMethod
            ? 'method'
            : 'function';

          // Extract full signature up to colon
          let fullSig = trimmed;
          let sigEndLine = i;
          while (!fullSig.includes(':') && sigEndLine < lines.length - 1) {
            sigEndLine++;
            fullSig += ' ' + lines[sigEndLine].trim();
          }
          fullSig = fullSig.replace(/:.*$/, '');

          const range = new vscode.Range(i, 0, sigEndLine, lines[sigEndLine].length);
          const selectionRange = new vscode.Range(i, startCol, i, endCol);

          definitions.push({
            name: funcName,
            kind,
            containerName: isMethod && currentClass ? currentClass.name : undefined,
            uri,
            range,
            selectionRange,
            signature: fullSig,
            docstring: this.extractDocstring(lines, sigEndLine + 1),
            fileRelativePath: relativePath,
            isExported: !funcName.startsWith('_'),
          });
          continue;
        }
      }

      // 3. Assignments: requires '='
      if (trimmed.includes('=')) {
        // Instance / Class attribute assignment: self.attr = ... or cls.attr = ...
        if (trimmed.includes('self.') || trimmed.includes('cls.')) {
          const selfAssignMatch = line.match(
            /^(\s*)(?:self|cls)\.([A-Za-z0-9_]+)(?:\s*:\s*[^=]+)?\s*=\s*([^#]+)/
          );
          if (selfAssignMatch) {
            const attrName = selfAssignMatch[2];
            if (!attrName.startsWith('__')) {
              const startCol = line.indexOf(attrName);
              const endCol = startCol + attrName.length;

              definitions.push({
                name: attrName,
                kind: 'property',
                containerName: currentClass ? currentClass.name : undefined,
                uri,
                range: new vscode.Range(i, 0, i, line.length),
                selectionRange: new vscode.Range(i, startCol, i, endCol),
                signature: trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed,
                fileRelativePath: relativePath,
                isExported: !attrName.startsWith('_'),
              });
              continue;
            }
          }
        }

        // 4. Constant or Variable assignment: NAME = ... or NAME: Type = ...
        // Only index module-level or class-level assignments
        const assignMatch = line.match(
          /^(\s*)([A-Za-z0-9_]+)(?:\s*:\s*[^=]+)?\s*=\s*([^#]+)/
        );
      if (assignMatch && (indent === 0 || (currentClass && currentFuncIndent === null && indent > currentClass.indent))) {
        const varName = assignMatch[2];
        // Ignore private dunder names like __name__, __file__, etc.
        if (varName.startsWith('__') && varName.endsWith('__')) {
          continue;
        }

        const isConstant = /^[A-Z0-9_]{2,}$/.test(varName);
        const isClassAttr = currentClass !== null;
        const kind: SymbolKind = isConstant ? 'constant' : 'variable';

        const startCol = assignMatch[1].length;
        const endCol = startCol + varName.length;

        definitions.push({
          name: varName,
          kind,
          containerName: isClassAttr && currentClass ? currentClass.name : undefined,
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, endCol),
          signature: trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed,
          fileRelativePath: relativePath,
          isExported: !varName.startsWith('_'),
        });
      }
    }
  }

  return definitions;
}

  /**
   * JavaScript / TypeScript parser.
   */
  public static parseJavaScriptOrTypeScript(
    text: string,
    uri: vscode.Uri,
    relativePath: string
  ): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = text.split(/\r?\n/);

    let currentClass: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        continue;
      }

      // Class or Interface or Type
      const classMatch = line.match(
        /(?:export\s+)?(?:default\s+)?(?:class|interface|type)\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$,\s]+))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/
      );
      if (classMatch) {
        const name = classMatch[1];
        const extendsStr = classMatch[2];
        const implementsStr = classMatch[3];
        const parentContainers: string[] = [];
        if (extendsStr) {
          parentContainers.push(
            ...extendsStr
              .split(',')
              .map((s) => s.trim().split('.').pop() || s.trim())
              .filter(Boolean)
          );
        }
        if (implementsStr) {
          parentContainers.push(
            ...implementsStr
              .split(',')
              .map((s) => s.trim().split('.').pop() || s.trim())
              .filter(Boolean)
          );
        }
        const kind: SymbolKind = line.includes('interface ')
          ? 'interface'
          : line.includes('type ')
          ? 'type'
          : 'class';
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind,
          parentContainers: parentContainers.length > 0 ? parentContainers : undefined,
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: line.includes('export'),
        });
        if (kind === 'class') {
          currentClass = name;
        }
        continue;
      }

      // Function declaration: function foo(...)
      const funcMatch = line.match(
        /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([A-Za-z0-9_$]+)?\s*\(/
      );
      if (funcMatch && funcMatch[1]) {
        const name = funcMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'function',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: line.includes('export'),
        });
        continue;
      }

      // Arrow function / constant: const foo = (...) => or const foo = function
      const constMatch = line.match(
        /(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)?\s*=>/
      );
      if (constMatch) {
        const name = constMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'function',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: line.includes('export'),
        });
        continue;
      }

      // Method inside class: methodName(...) {
      if (currentClass) {
        const methodMatch = line.match(
          /^\s*(?:public|private|protected|async|static|\*)*\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/
        );
        if (
          methodMatch &&
          methodMatch[1] !== 'constructor' &&
          methodMatch[1] !== 'if' &&
          methodMatch[1] !== 'for' &&
          methodMatch[1] !== 'while'
        ) {
          const name = methodMatch[1];
          const startCol = line.indexOf(name);
          definitions.push({
            name,
            kind: 'method',
            containerName: currentClass,
            uri,
            range: new vscode.Range(i, 0, i, line.length),
            selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
            signature: trimmed.replace(/\{$/, '').trim(),
            fileRelativePath: relativePath,
            isExported: true,
          });
        }
      }
    }

    return definitions;
  }

  /**
   * Go parser for func, struct, interface.
   */
  public static parseGo(
    text: string,
    uri: vscode.Uri,
    relativePath: string
  ): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Method: func (r *Receiver) MethodName(...)
      const methodMatch = line.match(
        /^func\s+\(\s*(?:[A-Za-z0-9_]+\s+)?\*?([A-Za-z0-9_]+)\s*\)\s+([A-Za-z0-9_]+)\s*\(/
      );
      if (methodMatch) {
        const receiver = methodMatch[1];
        const methodName = methodMatch[2];
        const startCol = line.indexOf(methodName);
        definitions.push({
          name: methodName,
          kind: 'method',
          containerName: receiver,
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + methodName.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: /^[A-Z]/.test(methodName),
        });
        continue;
      }

      // Function: func FuncName(...)
      const funcMatch = line.match(/^func\s+([A-Za-z0-9_]+)\s*\(/);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const startCol = line.indexOf(funcName);
        definitions.push({
          name: funcName,
          kind: 'function',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + funcName.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: /^[A-Z]/.test(funcName),
        });
        continue;
      }

      // Type: type StructName struct
      const typeMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        const typeName = typeMatch[1];
        const startCol = line.indexOf(typeName);
        definitions.push({
          name: typeName,
          kind: typeMatch[2] === 'interface' ? 'interface' : 'class',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + typeName.length),
          signature: trimmed,
          fileRelativePath: relativePath,
          isExported: /^[A-Z]/.test(typeName),
        });
      }
    }

    return definitions;
  }

  /**
   * Rust parser.
   */
  public static parseRust(
    text: string,
    uri: vscode.Uri,
    relativePath: string
  ): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const fnMatch = line.match(/(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'function',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: line.includes('pub '),
        });
        continue;
      }

      const structMatch = line.match(/(?:pub(?:\(crate\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (structMatch) {
        const name = structMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'class',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed.replace(/\{$/, '').trim(),
          fileRelativePath: relativePath,
          isExported: line.includes('pub '),
        });
      }
    }

    return definitions;
  }

  /**
   * C and C++ parser supporting functions (including GNU/Klipper multi-line signatures),
   * structs, typedefs, enums, unions, and #define macros.
   */
  public static parseCAndCpp(
    text: string,
    uri: vscode.Uri,
    relativePath: string
  ): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }

      // 1. #define MACRO
      const defineMatch = trimmed.match(/^#define\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (defineMatch) {
        const name = defineMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'constant',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed,
          fileRelativePath: relativePath,
          isExported: true,
        });
        continue;
      }

      // 2. struct/enum/union definitions
      const structMatch = trimmed.match(/^(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|$)/);
      if (structMatch && !trimmed.endsWith(';')) {
        const name = structMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'class',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed,
          fileRelativePath: relativePath,
          isExported: true,
        });
        continue;
      }

      // 3. typedef struct ... Name;
      const typedefMatch = trimmed.match(/}\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/);
      if (typedefMatch) {
        const name = typedefMatch[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: 'class',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed,
          fileRelativePath: relativePath,
          isExported: true,
        });
        continue;
      }

      // 4. Case A: GNU/Klipper multi-line style function:
      // Return type on previous line(s), function name at column 0 with (
      // e.g. "stepcompress_alloc(uint32_t oid)"
      const col0Func = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (col0Func) {
        const name = col0Func[1];
        const keywords = new Set(['if', 'while', 'for', 'switch', 'return', 'sizeof', 'case', 'default']);
        if (!keywords.has(name)) {
          let isFunc = false;
          let prevIsType = false;
          if (i > 0) {
            const prevTrim = lines[i - 1].trim();
            if (prevTrim && !prevTrim.endsWith(';') && !prevTrim.endsWith('}') && !prevTrim.startsWith('#')) {
              prevIsType = true;
            }
          }
          if (prevIsType) {
            isFunc = true;
          } else {
            for (let j = i; j < Math.min(i + 8, lines.length); j++) {
              if (lines[j].includes('{') || lines[j].includes(';')) {
                isFunc = true;
                break;
              }
            }
          }
          if (isFunc) {
            const startCol = line.indexOf(name);
            const isStatic = i > 0 && lines[i - 1].includes('static');
            definitions.push({
              name,
              kind: 'function',
              uri,
              range: new vscode.Range(i, 0, i, line.length),
              selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
              signature: (i > 0 ? lines[i - 1].trim() + ' ' : '') + trimmed,
              fileRelativePath: relativePath,
              isExported: !isStatic,
            });
            continue;
          }
        }
      }

      // 5. Case B: Single-line or inline function definition / declaration:
      // e.g. "static inline int32_t idiv_up(int32_t n, int32_t d)"
      // or "void stepcompress_free(struct stepcompress *sc);"
      const singleLineFunc = trimmed.match(
        /^(?:(?:static|inline|extern|__visible|const|unsigned|signed|void|char|short|int|long|float|double|uint\d+_t|int\d+_t|size_t|struct\s+[A-Za-z0-9_]+|[A-Za-z0-9_]+_t|[A-Za-z0-9_]+)(?:\s*\*+|\s+))+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/
      );
      if (singleLineFunc) {
        const name = singleLineFunc[1];
        const keywords = new Set(['if', 'while', 'for', 'switch', 'return', 'sizeof', 'define']);
        if (!keywords.has(name)) {
          const startCol = line.indexOf(name);
          const isStatic = trimmed.startsWith('static');
          definitions.push({
            name,
            kind: 'function',
            uri,
            range: new vscode.Range(i, 0, i, line.length),
            selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
            signature: trimmed,
            fileRelativePath: relativePath,
            isExported: !isStatic,
          });
          continue;
        }
      }
    }

    return definitions;
  }

  /**
   * Generic fallback parser for any file.
   */
  public static parseGeneric(
    text: string,
    uri: vscode.Uri,
    relativePath: string
  ): SymbolDefinition[] {
    const definitions: SymbolDefinition[] = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const match = trimmed.match(/(?:def|function|class|fn|func)\s+([A-Za-z0-9_]+)/);
      if (match) {
        const name = match[1];
        const startCol = line.indexOf(name);
        definitions.push({
          name,
          kind: trimmed.includes('class') ? 'class' : 'function',
          uri,
          range: new vscode.Range(i, 0, i, line.length),
          selectionRange: new vscode.Range(i, startCol, i, startCol + name.length),
          signature: trimmed.substring(0, 80),
          fileRelativePath: relativePath,
          isExported: true,
        });
      }
    }

    return definitions;
  }

  /**
   * Extract docstrings directly below the definition line.
   */
  private static extractDocstring(lines: string[], startLine: number): string | undefined {
    if (startLine >= lines.length) {
      return undefined;
    }

    const firstLine = lines[startLine].trim();
    if (firstLine.startsWith('"""') || firstLine.startsWith("'''")) {
      const quote = firstLine.substring(0, 3);
      if (firstLine.length > 3 && firstLine.endsWith(quote)) {
        return firstLine.substring(3, firstLine.length - 3).trim();
      }

      const docLines: string[] = [firstLine.substring(3)];
      for (let j = startLine + 1; j < Math.min(startLine + 10, lines.length); j++) {
        const current = lines[j].trim();
        if (current.includes(quote)) {
          docLines.push(current.substring(0, current.indexOf(quote)));
          break;
        }
        docLines.push(current);
      }
      return docLines.join('\n').trim();
    }

    return undefined;
  }
}
