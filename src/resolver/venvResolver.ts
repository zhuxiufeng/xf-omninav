import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SymbolDefinition } from '../types';
import { SymbolParser } from '../indexer/symbolParser';

export class VenvResolver {
  private static cachedSitePackages: string[] = [];
  private static isScanningVenv = false;

  /**
   * Find candidate site-packages directories in current workspace or python configuration.
   */
  public static async getSitePackagesPaths(): Promise<string[]> {
    if (this.cachedSitePackages.length > 0) {
      return this.cachedSitePackages;
    }

    const sitePackagesList: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders || [];

    for (const folder of workspaceFolders) {
      const root = folder.uri.fsPath;
      // Common virtualenv folder names
      const venvNames = ['.venv', 'venv', 'env', '.conda'];

      for (const name of venvNames) {
        const venvDir = path.join(root, name);
        if (fs.existsSync(venvDir)) {
          // Linux / macOS: lib/pythonX.Y/site-packages
          const libDir = path.join(venvDir, 'lib');
          if (fs.existsSync(libDir)) {
            try {
              const pyDirs = fs.readdirSync(libDir);
              for (const pyDir of pyDirs) {
                const sp = path.join(libDir, pyDir, 'site-packages');
                if (fs.existsSync(sp)) {
                  sitePackagesList.push(sp);
                }
              }
            } catch {}
          }

          // Windows: Lib/site-packages
          const winSp = path.join(venvDir, 'Lib', 'site-packages');
          if (fs.existsSync(winSp)) {
            sitePackagesList.push(winSp);
          }
        }
      }
    }

    this.cachedSitePackages = sitePackagesList;
    return sitePackagesList;
  }

  /**
   * Try to resolve a symbol or module in the virtual environment.
   * e.g. moduleName = "requests", symbolName = "get"
   */
  public static async resolveVenvSymbol(
    moduleName: string,
    symbolName?: string
  ): Promise<SymbolDefinition[]> {
    const sitePackages = await this.getSitePackagesPaths();
    if (sitePackages.length === 0) {
      return [];
    }

    const results: SymbolDefinition[] = [];

    for (const sp of sitePackages) {
      // 1. Check if module folder exists: <site-packages>/requests
      const modDir = path.join(sp, moduleName);
      // 2. Check if single file exists: <site-packages>/requests.py
      const modFile = path.join(sp, `${moduleName}.py`);

      let targetFiles: string[] = [];

      if (fs.existsSync(modFile)) {
        targetFiles.push(modFile);
      } else if (fs.existsSync(modDir) && fs.statSync(modDir).isDirectory()) {
        const initFile = path.join(modDir, '__init__.py');
        if (fs.existsSync(initFile)) {
          targetFiles.push(initFile);
        }
        // If symbolName is specified, also check files named <symbolName>.py or common files
        try {
          const files = fs.readdirSync(modDir);
          for (const f of files) {
            if (f.endsWith('.py') && targetFiles.length < 10) {
              targetFiles.push(path.join(modDir, f));
            }
          }
        } catch {}
      }

      // If no specific symbol is sought, return the module/init file itself
      if (!symbolName && targetFiles.length > 0) {
        const uri = vscode.Uri.file(targetFiles[0]);
        results.push({
          name: moduleName,
          kind: 'module',
          uri,
          range: new vscode.Range(0, 0, 0, 0),
          selectionRange: new vscode.Range(0, 0, 0, 0),
          signature: `module ${moduleName}`,
          fileRelativePath: path.relative(sp, targetFiles[0]),
          isExported: true,
        });
        continue;
      }

      // Search for symbolName inside target files
      if (symbolName) {
        for (const file of targetFiles) {
          try {
            const content = fs.readFileSync(file, 'utf-8');
            if (content.includes(symbolName)) {
              const uri = vscode.Uri.file(file);
              const defs = SymbolParser.parsePython(content, uri, path.relative(sp, file));
              const matched = defs.filter(
                (d) => d.name === symbolName || d.name.toLowerCase() === symbolName.toLowerCase()
              );
              results.push(...matched);
              if (results.length > 0) {
                break;
              }
            }
          } catch {}
        }
      }
    }

    return results;
  }
}
