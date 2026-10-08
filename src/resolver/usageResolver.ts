import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { ContextResolver, EnclosingClassInfo } from './contextResolver';

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
    symbolName: string,
    indexer?: any
  ): Promise<UsageItem[]> {
    const seen = new Set<string>();
    const results: UsageItem[] = [];
    const defKey = `${document.uri.toString()}:${position.line}`;
    const defKeys = new Set<string>([defKey]);

    // Check if current position is within a subclass method definition
    const enclosingClass = ContextResolver.getEnclosingClass(document, position);
    const isSubclass = Boolean(
      enclosingClass &&
      enclosingClass.parentClasses &&
      enclosingClass.parentClasses.length > 0
    );

    // Resolve parent class files and parent class names to strictly exclude parent class call sites!
    const { parentUris, parentClassNames } = isSubclass && enclosingClass
      ? this.resolveParentClassInfo(document, enclosingClass, indexer)
      : { parentUris: new Set<string>(), parentClassNames: new Set<string>() };

    // Track known definitions from indexer to never mistake definition lines for calls
    if (indexer && typeof indexer.findExact === 'function') {
      const exactDefs = indexer.findExact(symbolName);
      for (const d of exactDefs) {
        if (d && d.uri && d.range) {
          defKeys.add(`${d.uri.toString()}:${d.range.start.line}`);
        }
      }
    }

    // 1. Try LSP Reference Provider (with 600ms timeout for instant responsiveness)
    try {
      const lspRefs = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          position
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 600)),
      ]);

      if (lspRefs && lspRefs.length > 0) {
        await this.collectLocations(lspRefs, seen, defKeys, results, symbolName, isSubclass ? parentUris : undefined);
      }
    } catch {}

    // 2. Fast scan inside current document (instant & 100% resilient)
    const docResults = this.scanDocumentForCalls(document, symbolName, position.line, defKeys);
    for (const item of docResults) {
      const key = `${item.uri.toString()}:${item.range.start.line}`;
      if (!defKeys.has(key) && !seen.has(key)) {
        seen.add(key);
        results.push(item);
      }
    }

    // 3. Workspace file call search
    const ext = path.extname(document.uri.fsPath);
    let grepSucceeded = false;

    // 3.1 Try fast system grep/rg on workspace folder(s) (typically takes <50ms across entire project)
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const currentFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const searchFolders = currentFolder
      ? [currentFolder]
      : workspaceFolders.length > 0
      ? workspaceFolders
      : [];

    if (searchFolders.length > 0 && ext) {
      for (const folder of searchFolders) {
        const rootPath = folder.uri.fsPath;
        if (!rootPath || !fs.existsSync(rootPath)) {
          continue;
        }
        try {
          const matchedFiles = await new Promise<string[]>((resolve) => {
            const cp = require('child_process');
            cp.execFile(
              'grep',
              ['-rn', '-l', '-w', `--include=*${ext}`, symbolName, rootPath],
              { timeout: 3000 },
              (err: any, stdout: string) => {
                if (err && err.code !== 1) {
                  resolve([]);
                } else if (stdout) {
                  const files = stdout
                    .trim()
                    .split(/\r?\n/)
                    .map((s: string) => s.trim())
                    .filter(Boolean);
                  resolve(files);
                } else {
                  resolve([]);
                }
              }
            );
          });

          if (matchedFiles.length > 0) {
            grepSucceeded = true;
            for (const filePath of matchedFiles) {
              const fileUri = this.toWorkspaceUri(filePath, document.uri);
              // CRUCIAL: Exclude parent class files when at subclass definition!
              if (isSubclass && (parentUris.has(fileUri.toString()) || this.isParentPath(filePath, parentUris))) {
                continue;
              }

              let content = '';
              try {
                const openDoc = vscode.workspace.textDocuments?.find(
                  (d) => d.uri.fsPath === filePath || d.uri.toString() === fileUri.toString()
                );
                if (openDoc) {
                  content = openDoc.getText();
                } else {
                  content = await fs.promises.readFile(filePath, 'utf8');
                }
              } catch {}
              if (!content) continue;

              const fileResults = this.scanTextForCalls(fileUri, content, symbolName, undefined, defKeys);
              for (const item of fileResults) {
                const key = `${item.uri.toString()}:${item.range.start.line}`;
                if (!defKeys.has(key) && !seen.has(key)) {
                  seen.add(key);
                  results.push(item);
                }
              }
            }
          }
        } catch {}
      }
    }

    // 3.2 If grep did not run or find anything, fallback to vscode.workspace.findFiles
    if (!grepSucceeded && ext) {
      try {
        const pattern = `**/*${ext}`;
        const exclude =
          '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/dist/**,**/build/**,**/.venv/**,**/venv/**,**/env/**,**/.tox/**}';
        const uris = await vscode.workspace.findFiles(pattern, exclude, 5000);

        const batchSize = 50;
        for (let i = 0; i < uris.length; i += batchSize) {
          const batch = uris.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (uri) => {
              if (uri.toString() === document.uri.toString()) {
                return;
              }
              if (isSubclass && (parentUris.has(uri.toString()) || this.isParentPath(uri.fsPath, parentUris))) {
                return;
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
                  return;
                }

                const fileResults = this.scanTextForCalls(uri, content, symbolName, undefined, defKeys);
                for (const item of fileResults) {
                  const key = `${item.uri.toString()}:${item.range.start.line}`;
                  if (!defKeys.has(key) && !seen.has(key)) {
                    seen.add(key);
                    results.push(item);
                  }
                }
              } catch {}
            })
          );
        }
      } catch {}
    }

    // 3.3 Check open in-memory text documents (handles unsaved edits, test mocks, etc.)
    if (vscode.workspace.textDocuments && vscode.workspace.textDocuments.length > 0) {
      for (const openDoc of vscode.workspace.textDocuments) {
        if (openDoc.uri.toString() === document.uri.toString()) {
          continue;
        }
        if (isSubclass && (parentUris.has(openDoc.uri.toString()) || this.isParentPath(openDoc.uri.fsPath, parentUris))) {
          continue;
        }
        try {
          const text = openDoc.getText();
          if (!text.includes(symbolName)) {
            continue;
          }
          const fileResults = this.scanTextForCalls(openDoc.uri, text, symbolName, undefined, defKeys);
          for (const item of fileResults) {
            const key = `${item.uri.toString()}:${item.range.start.line}`;
            if (!defKeys.has(key) && !seen.has(key)) {
              seen.add(key);
              results.push(item);
            }
          }
        } catch {}
      }
    }

    // 4. Subclass template method invocation fallback:
    // If no direct callers were found in subclass/workspace, but this method is overridden in a subclass:
    // Find where the subclass invokes the parent template method (e.g. self.state_init() in BoxState)
    if (results.length === 0 && isSubclass && enclosingClass && parentUris.size > 0) {
      const templateCaller = await this.findSubclassTemplateCaller(
        document,
        enclosingClass,
        symbolName,
        parentUris,
        indexer
      );
      if (templateCaller) {
        results.push(templateCaller);
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

  public static isParentPath(targetPath: string, parentUris: Set<string>): boolean {
    if (!targetPath || parentUris.size === 0) return false;
    const normTarget = path.normalize(targetPath);
    const baseTarget = path.basename(normTarget);
    for (const pUri of parentUris) {
      try {
        let pPath = '';
        if (pUri.startsWith('file://')) {
          pPath = path.normalize(vscode.Uri.parse(pUri).fsPath);
        } else {
          pPath = path.normalize(pUri);
        }
        if (normTarget === pPath || (baseTarget && path.basename(pPath) === baseTarget)) {
          return true;
        }
      } catch {}
    }
    return false;
  }

  public static resolveParentClassInfo(
    document: vscode.TextDocument,
    enclosingClass: EnclosingClassInfo,
    indexer?: any
  ): { parentUris: Set<string>; parentClassNames: Set<string> } {
    const parentUris = new Set<string>();
    const parentClassNames = new Set<string>();

    for (const p of enclosingClass.parentClasses) {
      parentClassNames.add(p.toLowerCase());
    }

    if (indexer && typeof indexer.getSuperClasses === 'function') {
      const ancestors = indexer.getSuperClasses(enclosingClass.name);
      for (const a of ancestors) {
        parentClassNames.add(a.toLowerCase());
      }
    }

    // Resolve imports in current document to identify base class files
    const docText = document.getText();
    if (document.languageId === 'python') {
      const importRegex = /(?:from\s+([A-Za-z0-9_.]+)\s+import\s+([^#\r\n]+)|import\s+([^#\r\n]+))/g;
      let m: RegExpExecArray | null;
      while ((m = importRegex.exec(docText)) !== null) {
        if (m[1] && m[2]) {
          const mod = m[1];
          const items = m[2].split(',');
          for (const item of items) {
            const parts = item.trim().split(/\s+as\s+/);
            const orig = parts[0].trim();
            const alias = (parts[1] || orig).trim();
            if (parentClassNames.has(alias.toLowerCase()) || parentClassNames.has(orig.toLowerCase())) {
              parentClassNames.add(orig.toLowerCase());
              // e.g. extras.box_wrapper -> box_wrapper.py
              const modFile = mod.split('.').pop() + '.py';
              if (indexer && typeof indexer.findExact === 'function') {
                const defs = indexer.findExact(orig);
                for (const d of defs) {
                  if (d.kind === 'class') {
                    parentUris.add(d.uri.toString());
                  }
                }
              }
              for (const openDoc of vscode.workspace.textDocuments || []) {
                if (openDoc.uri.fsPath.endsWith(modFile)) {
                  parentUris.add(openDoc.uri.toString());
                }
              }
            }
          }
        }
      }
    }

    // Query indexer for any class matching parentClassNames
    if (indexer && typeof indexer.findExact === 'function') {
      for (const p of parentClassNames) {
        const defs = indexer.findExact(p);
        for (const d of defs) {
          if (d.kind === 'class' && d.uri.toString() !== document.uri.toString()) {
            parentUris.add(d.uri.toString());
          }
        }
      }
    }

    // Also check open documents or indexer for any files whose name matches imported base class
    for (const openDoc of vscode.workspace.textDocuments || []) {
      if (openDoc.uri.toString() === document.uri.toString()) continue;
      const text = openDoc.getText();
      for (const p of parentClassNames) {
        if (new RegExp(`^\\s*class\\s+${p}\\b`, 'm').test(text)) {
          parentUris.add(openDoc.uri.toString());
        }
      }
    }

    return { parentUris, parentClassNames };
  }

  public static async findSubclassTemplateCaller(
    document: vscode.TextDocument,
    enclosingClass: EnclosingClassInfo,
    symbolName: string,
    parentUris: Set<string>,
    indexer?: any
  ): Promise<UsageItem | null> {
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selfCallRegex = new RegExp(`\\b(?:self|this|cls)\\s*\\.\\s*${escaped}\\s*\\(`, 'm');

    let templateMethodName: string | null = null;

    for (const parentUriStr of parentUris) {
      let content = '';
      try {
        const openDoc = vscode.workspace.textDocuments?.find((d) => d.uri.toString() === parentUriStr);
        if (openDoc) {
          content = openDoc.getText();
        } else {
          const uri = vscode.Uri.parse(parentUriStr);
          if (uri.scheme === 'file') {
            content = await fs.promises.readFile(uri.fsPath, 'utf8');
          } else {
            const raw = await vscode.workspace.fs.readFile(uri);
            content = Buffer.from(raw).toString('utf8');
          }
        }
      } catch {}

      if (!content || !selfCallRegex.test(content)) {
        continue;
      }

      // Find which method in the parent class calls self.<symbolName>()
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (selfCallRegex.test(lines[i])) {
          // Look backwards for def <methodName>(
          for (let j = i - 1; j >= 0; j--) {
            const defMatch = lines[j].match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
            if (defMatch) {
              templateMethodName = defMatch[2];
              break;
            }
          }
          if (templateMethodName) break;
        }
      }
      if (templateMethodName) break;
    }

    if (!templateMethodName) {
      return null;
    }

    // Search inside current document within the subclass body for calls to this template method
    // (e.g. self.state_init() in BoxState)
    const docLines = document.getText().split(/\r?\n/);
    const classStart = enclosingClass.startLine;
    const templateCallRegex = new RegExp(`\\b(?:self|this)\\s*\\.\\s*${templateMethodName}\\s*\\(`);

    const classIndentMatch = docLines[classStart]?.match(/^(\s*)/);
    const classIndent = classIndentMatch ? classIndentMatch[1].length : 0;

    for (let i = classStart + 1; i < docLines.length; i++) {
      const line = docLines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indentMatch = line.match(/^(\s*)/);
      const lineIndent = indentMatch ? indentMatch[1].length : 0;
      if (lineIndent <= classIndent && /^class\s+/.test(trimmed)) {
        break; // Next class reached
      }

      if (templateCallRegex.test(line)) {
        const col = line.indexOf(templateMethodName);
        return {
          uri: document.uri,
          range: new vscode.Range(i, col >= 0 ? col : 0, i, (col >= 0 ? col : 0) + templateMethodName.length),
          text: trimmed,
          relativePath: vscode.workspace.asRelativePath(document.uri, false),
        };
      }
    }

    return null;
  }

  public static toWorkspaceUri(filePath: string, sampleUri?: vscode.Uri): vscode.Uri {
    if (sampleUri && sampleUri.scheme !== 'file') {
      return sampleUri.with({ path: filePath });
    }
    return vscode.Uri.file(filePath);
  }

  private static async collectLocations(
    locations: vscode.Location[],
    seen: Set<string>,
    defKeys: Set<string>,
    results: UsageItem[],
    symbolName?: string,
    excludedParentUris?: Set<string>
  ): Promise<void> {
    for (const ref of locations) {
      if (
        excludedParentUris &&
        (excludedParentUris.has(ref.uri.toString()) || this.isParentPath(ref.uri.fsPath, excludedParentUris))
      ) {
        continue;
      }
      const key = `${ref.uri.toString()}:${ref.range.start.line}`;
      if (defKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);

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

      if (symbolName && lineText) {
        const ext = path.extname(ref.uri.fsPath).toLowerCase();
        const isPy = ext === '.py' || ext === '.pyi';
        const state = { inBlockComment: false, inTripleQuote: null as string | null };
        const code = this.extractCodeFromLine(lineText, isPy, state, ext);
        const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const callRegex = new RegExp(`\\b${escaped}\\b`);
        if (!callRegex.test(code)) {
          continue; // Symbol only appears in comment, discard!
        }
      }

      results.push({
        uri: ref.uri,
        range: ref.range,
        text: lineText,
        relativePath: vscode.workspace.asRelativePath(ref.uri, false),
      });
    }
  }

  /**
   * Strips single-line comments (#, //), block comments (/* ... *\/),
   * and multi-line docstrings (""" or ''') from a line, preserving code outside comments.
   */
  public static extractCodeFromLine(
    line: string,
    isPython: boolean,
    state: { inBlockComment: boolean; inTripleQuote: string | null },
    ext?: string
  ): string {
    let result = '';
    let i = 0;
    const len = line.length;

    // Handle ongoing C-style block comment /* ... */
    if (state.inBlockComment) {
      const closeIdx = line.indexOf('*/');
      if (closeIdx === -1) {
        return '';
      }
      state.inBlockComment = false;
      i = closeIdx + 2;
    }

    // Handle ongoing Python triple quote docstrings """ or '''
    if (state.inTripleQuote) {
      const closeIdx = line.indexOf(state.inTripleQuote);
      if (closeIdx === -1) {
        return '';
      }
      const quoteStr = state.inTripleQuote;
      state.inTripleQuote = null;
      i = closeIdx + quoteStr.length;
    }

    let inString: string | null = null;

    while (i < len) {
      const ch = line[i];
      const next = i + 1 < len ? line[i + 1] : '';

      if (inString) {
        if (ch === '\\') {
          result += ch + next;
          i += 2;
          continue;
        }
        result += ch;
        if (ch === inString) {
          inString = null;
        }
        i++;
        continue;
      }

      // Check Python docstring start """ or '''
      if (isPython && (ch === '"' || ch === "'")) {
        const triple = ch + ch + ch;
        if (line.startsWith(triple, i)) {
          const closeIdx = line.indexOf(triple, i + 3);
          if (closeIdx === -1) {
            state.inTripleQuote = triple;
            break; // rest of line is docstring
          } else {
            i = closeIdx + 3;
            continue;
          }
        }
      }

      // Check string start
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        result += ch;
        i++;
        continue;
      }

      // Check Python line comment #
      if (isPython && ch === '#') {
        break; // rest of line is comment
      }

      // Check C-style single-line comment //
      if (!isPython && ch === '/' && next === '/') {
        break; // rest of line is comment
      }

      // Check C-style block comment /*
      if (!isPython && ch === '/' && next === '*') {
        const closeIdx = line.indexOf('*/', i + 2);
        if (closeIdx === -1) {
          state.inBlockComment = true;
          break; // rest of line is comment
        } else {
          i = closeIdx + 2;
          continue;
        }
      }

      // Also check shell/yaml # comment
      if (ch === '#' && (ext === '.sh' || ext === '.bash' || ext === '.yaml' || ext === '.yml')) {
        break;
      }

      result += ch;
      i++;
    }

    return result;
  }

  /**
   * Scan text content for lines calling or referencing symbolName.
   */
  public static scanTextForCalls(
    uri: vscode.Uri,
    text: string,
    symbolName: string,
    excludeLine?: number,
    defKeys?: Set<string>
  ): UsageItem[] {
    const results: UsageItem[] = [];
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callRegex = new RegExp(`\\b${escaped}\\b`);
    const lines = text.split(/\r?\n/);
    const relPath = vscode.workspace.asRelativePath(uri, false);
    const uriStr = uri.toString();
    const ext = path.extname(uri.fsPath).toLowerCase();
    const isPython = ext === '.py' || ext === '.pyi';

    const parseState = { inBlockComment: false, inTripleQuote: null as string | null };

    for (let i = 0; i < lines.length; i++) {
      if (excludeLine !== undefined && i === excludeLine) {
        continue;
      }
      if (defKeys && defKeys.has(`${uriStr}:${i}`)) {
        continue;
      }

      const line = lines[i];

      // Extract code outside comments and docstrings
      const code = this.extractCodeFromLine(line, isPython, parseState, ext);

      if (!line.includes(symbolName)) {
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      // Check if symbolName actually appears in executable code (not inside comments)
      if (!callRegex.test(code)) {
        continue;
      }

      // Skip the definition line itself (e.g. def func_name, class Name, fn name)
      if (
        new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\b`).test(line) ||
        new RegExp(`^\\s*class\\s+${escaped}\\b`).test(line) ||
        new RegExp(`(?:function|interface|type)\\s+${escaped}\\b`).test(line) ||
        new RegExp(`^\\s*(?:public|private|protected|async|static|\\*)*\\s*${escaped}\\b\\s*\\(`).test(line) ||
        new RegExp(`^\\s*(?:fn|func)\\s+${escaped}\\b`).test(line)
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
    excludeLine?: number,
    defKeys?: Set<string>
  ): UsageItem[] {
    return this.scanTextForCalls(document.uri, document.getText(), symbolName, excludeLine, defKeys);
  }
}
