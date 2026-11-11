import * as vscode from 'vscode';
import { PythonBranchFoldingProvider } from '../folding/pythonFoldingProvider';
import { ShellBranchFoldingProvider } from '../folding/shellFoldingProvider';
import { CppMacroFoldingProvider } from '../folding/cppMacroFoldingProvider';
import { SwitchCaseFoldingProvider } from '../folding/switchCaseFoldingProvider';
import { RustBranchFoldingProvider } from '../folding/rustFoldingProvider';
import { getOmniConfig } from '../utils';

/**
 * Subsystem responsible for independent syntax branch folding
 * across Python, Shell, C/C++, TypeScript, JavaScript, Java, Go, and Rust.
 */
export class FoldingSubsystem implements vscode.Disposable {
  private foldingDisposables: vscode.Disposable[] = [];
  public readonly pythonFolding = new PythonBranchFoldingProvider();
  public readonly shellFolding = new ShellBranchFoldingProvider();
  public readonly cppFolding = new CppMacroFoldingProvider();
  public readonly switchCaseFolding = new SwitchCaseFoldingProvider();
  public readonly rustFolding = new RustBranchFoldingProvider();

  public activate(
    context: vscode.ExtensionContext,
    registerMulti: (baseName: string, cb: (...args: any[]) => any) => void
  ): void {
    registerMulti('refreshFoldings', () => this.syncFoldingProviders(true, context));

    this.syncFoldingProviders(false, context);

    // Leapfrog deferred language servers (e.g. Pyrefly, Pyright, clangd) so our providers hold top rank
    setTimeout(() => this.syncFoldingProviders(true, context), 1500);
    setTimeout(() => this.syncFoldingProviders(true, context), 4000);
    setTimeout(() => this.syncFoldingProviders(true, context), 8000);

    let hasReSyncedForPython = false;
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.languageId === 'python' && !hasReSyncedForPython) {
          hasReSyncedForPython = true;
          setTimeout(() => this.syncFoldingProviders(true, context), 2500);
          setTimeout(() => this.syncFoldingProviders(true, context), 6000);
        }
      })
    );
  }

  public syncFoldingProviders(forceReRegister = false, context?: vscode.ExtensionContext): void {
    const isFoldingEnabled = getOmniConfig<boolean>('enableFineGrainedFolding', true);
    if (isFoldingEnabled) {
      if (forceReRegister && this.foldingDisposables.length > 0) {
        this.foldingDisposables.forEach((d) => d.dispose());
        this.foldingDisposables = [];
      }
      if (this.foldingDisposables.length === 0) {
        // Python fine-grained branch folding (PyCharm style)
        this.foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'python' },
            this.pythonFolding
          )
        );
        // Shell / Bash
        this.foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'shellscript' },
            this.shellFolding
          )
        );
        // C / C++ preprocessor macro conditionals
        this.foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'c' },
            this.cppFolding
          ),
          vscode.languages.registerFoldingRangeProvider(
            { language: 'cpp' },
            this.cppFolding
          )
        );
        // TypeScript, JavaScript, Java, Go switch/case & select/case
        const switchCaseLanguages = [
          'typescript',
          'javascript',
          'typescriptreact',
          'javascriptreact',
          'java',
          'go',
        ];
        for (const lang of switchCaseLanguages) {
          this.foldingDisposables.push(
            vscode.languages.registerFoldingRangeProvider(
              [
                { language: lang, scheme: 'file' },
                { language: lang, scheme: 'untitled' },
              ],
              this.switchCaseFolding
            )
          );
        }
        // Rust match arms, derive attributes, and doc comments
        this.foldingDisposables.push(
          vscode.languages.registerFoldingRangeProvider(
            { language: 'rust' },
            this.rustFolding
          )
        );
        if (context) {
          this.foldingDisposables.forEach((d) => context.subscriptions.push(d));
        }
      }
      this.pythonFolding.fireDidChange();
      this.shellFolding.fireDidChange();
      this.cppFolding.fireDidChange();
      this.switchCaseFolding.fireDidChange();
      this.rustFolding.fireDidChange();
    } else if (!isFoldingEnabled && this.foldingDisposables.length > 0) {
      this.foldingDisposables.forEach((d) => d.dispose());
      this.foldingDisposables = [];
    }
  }

  public fireDidChange(lang: string): void {
    if (lang === 'python') this.pythonFolding.fireDidChange();
    else if (lang === 'shellscript') this.shellFolding.fireDidChange();
    else if (lang === 'c' || lang === 'cpp') this.cppFolding.fireDidChange();
    else if (lang === 'rust') this.rustFolding.fireDidChange();
  }

  public dispose(): void {
    this.foldingDisposables.forEach((d) => d.dispose());
    this.foldingDisposables = [];
  }
}
