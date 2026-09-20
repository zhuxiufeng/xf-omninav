import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class ImportResolver {
  /**
   * Check if current position is on an import line or string path and resolve target file / location.
   */
  public static async resolveImportOrPath(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | null> {
    const line = document.lineAt(position.line).text;
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_./\\-]+/);
    if (!wordRange) {
      return null;
    }

    const clickedText = document.getText(wordRange);

    // 1. Check if clicking inside a string literal pointing to a file path
    const pathTarget = await this.resolveStringFilePath(document, line, clickedText);
    if (pathTarget) {
      return pathTarget;
    }

    // 2. Check Python imports: `import foo.bar` or `from foo.bar import baz`
    if (document.languageId === 'python') {
      const pythonImportTarget = await this.resolvePythonImport(document, line, clickedText, position);
      if (pythonImportTarget) {
        return pythonImportTarget;
      }
    }

    // 3. Check JS/TS imports: `import ... from './components/Header'`
    if (
      document.languageId === 'typescript' ||
      document.languageId === 'javascript' ||
      document.languageId === 'typescriptreact' ||
      document.languageId === 'javascriptreact'
    ) {
      const jsImportTarget = await this.resolveJsTsImport(document, line, clickedText);
      if (jsImportTarget) {
        return jsImportTarget;
      }
    }

    return null;
  }

  /**
   * Resolve string literals that represent file paths.
   */
  private static async resolveStringFilePath(
    document: vscode.TextDocument,
    line: string,
    clickedText: string
  ): Promise<vscode.Location | null> {
    // Check if clicked text looks like a file path (contains / or has file extension)
    if (!clickedText.includes('/') && !clickedText.includes('.')) {
      return null;
    }

    // Check if within quotes
    const quoteRegex = /['"`]([^'"`]+)['"`]/g;
    let match;
    while ((match = quoteRegex.exec(line)) !== null) {
      const strContent = match[1];
      if (strContent.includes(clickedText)) {
        // Resolve path relative to current document directory
        const docDir = path.dirname(document.uri.fsPath);
        const relativeToDoc = path.resolve(docDir, strContent);
        if (await this.fileExists(relativeToDoc)) {
          return new vscode.Location(
            vscode.Uri.file(relativeToDoc),
            new vscode.Position(0, 0)
          );
        }

        // Resolve path relative to workspace root
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (workspaceFolder) {
          const relativeToRoot = path.resolve(workspaceFolder.uri.fsPath, strContent);
          if (await this.fileExists(relativeToRoot)) {
            return new vscode.Location(
              vscode.Uri.file(relativeToRoot),
              new vscode.Position(0, 0)
            );
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolve Python `import a.b.c` or `from a.b import c`.
   */
  private static async resolvePythonImport(
    document: vscode.TextDocument,
    line: string,
    clickedText: string,
    position: vscode.Position
  ): Promise<vscode.Location | null> {
    const trimmed = line.trim();
    const docDir = path.dirname(document.uri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : docDir;

    // A. `from .module import foo` or `from ..parent import bar` (Relative import)
    const relFromMatch = trimmed.match(/^from\s+(\.+[A-Za-z0-9_.]*)\s+import\s+(.*)/);
    if (relFromMatch) {
      const relDotsAndModule = relFromMatch[1];
      const targetFilePath = this.resolvePythonRelativePath(docDir, relDotsAndModule);
      if (targetFilePath && (await this.fileExists(targetFilePath))) {
        return new vscode.Location(
          vscode.Uri.file(targetFilePath),
          new vscode.Position(0, 0)
        );
      }
    }

    // B. `from foo.bar import baz`
    const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+(.*)/);
    if (fromMatch) {
      const modulePath = fromMatch[1];
      const importedNames = fromMatch[2];

      // Check if user clicked on the module name itself: `from foo.bar import ...`
      if (modulePath.includes(clickedText)) {
        const fileLoc = await this.findPythonModuleFile(rootPath, docDir, modulePath);
        if (fileLoc) {
          return fileLoc;
        }
      }

      // If user clicked on the imported name: `from foo.bar import baz`
      if (importedNames.includes(clickedText)) {
        // Maybe the imported name is a submodule file (e.g. `from foo import bar` where bar is bar.py)
        const subModule = `${modulePath}.${clickedText}`;
        const subFileLoc = await this.findPythonModuleFile(rootPath, docDir, subModule);
        if (subFileLoc) {
          return subFileLoc;
        }

        // Or it's a symbol inside modulePath
        const modFile = await this.findPythonModuleFile(rootPath, docDir, modulePath);
        if (modFile) {
          // Read target document/file without openTextDocument
          let text: string | null = null;
          const openDoc = vscode.workspace.textDocuments?.find(
            (d) => d.uri.toString() === modFile.uri.toString()
          );
          if (openDoc) {
            text = openDoc.getText();
          } else if (modFile.uri.scheme === 'file') {
            try {
              text = await fs.promises.readFile(modFile.uri.fsPath, 'utf8');
            } catch {}
          }
          if (text) {
            const targetPos = this.findSymbolInText(text, clickedText);
            return new vscode.Location(modFile.uri, targetPos || new vscode.Position(0, 0));
          }
          return new vscode.Location(modFile.uri, new vscode.Position(0, 0));
        }
      }
    }

    // C. `import foo.bar` or `import foo.bar as baz`
    const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_., ]+)/);
    if (importMatch) {
      const fullImport = importMatch[1];
      if (fullImport.includes(clickedText)) {
        // Find module path matching clickedText or full dotted path
        const fileLoc = await this.findPythonModuleFile(rootPath, docDir, clickedText);
        if (fileLoc) {
          return fileLoc;
        }
      }
    }

    return null;
  }

  /**
   * Resolve JavaScript/TypeScript import paths like `./components/Button`.
   */
  private static async resolveJsTsImport(
    document: vscode.TextDocument,
    line: string,
    clickedText: string
  ): Promise<vscode.Location | null> {
    const importMatch = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!importMatch) {
      return null;
    }

    const importPath = importMatch[1];
    const docDir = path.dirname(document.uri.fsPath);
    const resolvedBase = path.resolve(docDir, importPath);

    // Extensions to try
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

    for (const ext of ['', ...extensions]) {
      const candidate = resolvedBase + ext;
      if (await this.fileExists(candidate)) {
        return new vscode.Location(vscode.Uri.file(candidate), new vscode.Position(0, 0));
      }
    }

    return null;
  }

  /**
   * Helper: Find Python module file (module.py or module/__init__.py) in search roots.
   */
  private static async findPythonModuleFile(
    rootPath: string,
    docDir: string,
    moduleDotted: string
  ): Promise<vscode.Location | null> {
    const parts = moduleDotted.split('.');
    const searchRoots = [
      docDir,
      rootPath,
      path.join(rootPath, 'src'),
      path.join(rootPath, 'app'),
    ];

    for (const root of searchRoots) {
      const base = path.join(root, ...parts);
      // 1. Check base + .py
      const pyFile = `${base}.py`;
      if (await this.fileExists(pyFile)) {
        return new vscode.Location(vscode.Uri.file(pyFile), new vscode.Position(0, 0));
      }
      // 2. Check base + /__init__.py
      const initFile = path.join(base, '__init__.py');
      if (await this.fileExists(initFile)) {
        return new vscode.Location(vscode.Uri.file(initFile), new vscode.Position(0, 0));
      }
    }

    return null;
  }

  /**
   * Helper: Resolve relative Python dots (e.g. .module or ..parent.module).
   */
  private static resolvePythonRelativePath(
    docDir: string,
    dotsAndModule: string
  ): string | null {
    const match = dotsAndModule.match(/^(\.+)(.*)$/);
    if (!match) {
      return null;
    }

    const dots = match[1].length; // e.g. 1 for '.', 2 for '..'
    const rest = match[2]; // e.g. 'models' or ''

    let targetDir = docDir;
    for (let i = 1; i < dots; i++) {
      targetDir = path.dirname(targetDir);
    }

    if (!rest) {
      const initFile = path.join(targetDir, '__init__.py');
      return initFile;
    }

    const parts = rest.split('.');
    const pyCandidate = path.join(targetDir, ...parts) + '.py';
    return pyCandidate;
  }

  /**
   * Find symbol definition line in raw text content with early line.includes check.
   */
  private static findSymbolInText(
    text: string,
    symbolName: string
  ): vscode.Position | null {
    const lines = text.split(/\r?\n/);
    const regex = new RegExp(`(?:def|class|async\\s+def)\\s+(${symbolName})\\b`);
    const varRegex = new RegExp(`^\\s*${symbolName}\\s*=`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(symbolName)) {
        continue;
      }
      const match = regex.exec(line);
      if (match) {
        return new vscode.Position(i, match.index + match[0].indexOf(symbolName));
      }
      if (varRegex.test(line)) {
        return new vscode.Position(i, line.indexOf(symbolName));
      }
    }
    return null;
  }

  /**
   * Find symbol definition line in document.
   */
  private static findSymbolInDoc(
    doc: vscode.TextDocument,
    symbolName: string
  ): vscode.Position | null {
    return this.findSymbolInText(doc.getText(), symbolName);
  }

  /**
   * Check if file exists.
   */
  private static async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }
}
