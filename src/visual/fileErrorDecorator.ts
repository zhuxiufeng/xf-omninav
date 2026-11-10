import * as vscode from 'vscode';
import { getOmniConfig, debounce } from '../utils';

export interface FileErrorInfo {
  count: number;
  sample: string;
}

/**
 * PyCharm-style file error decoration provider.
 * When code inside a file is highlighted in red (DiagnosticSeverity.Error),
 * this provider flags the file and its parent directories with a prominent
 * red alert indicator ('!' or custom badge) and applies the error foreground color,
 * replicating PyCharm's file tree error inspection indicators in Antigravity IDE / VS Code.
 */
export class PyCharmFileErrorDecorator implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> =
    this._onDidChangeFileDecorations.event;

  private disposables: vscode.Disposable[] = [];
  private errorCache = new Map<string, FileErrorInfo>();

  private debouncedFireChanges: ((uris: vscode.Uri[]) => void) & { cancel: () => void };
  private pendingUris = new Set<vscode.Uri>();

  constructor() {
    this.debouncedFireChanges = debounce(() => {
      if (this.pendingUris.size > 0) {
        const uris = Array.from(this.pendingUris);
        this.pendingUris.clear();
        this._onDidChangeFileDecorations.fire(uris);
      }
    }, 50);

    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(this.handleDiagnosticsChange, this),
      this._onDidChangeFileDecorations
    );

    // Initial scan of active diagnostics if any are already present
    this.scanExistingDiagnostics();
  }

  private scanExistingDiagnostics(): void {
    try {
      if (typeof vscode.languages.getDiagnostics === 'function') {
        const allDiags = vscode.languages.getDiagnostics();
        if (Array.isArray(allDiags)) {
          for (const item of allDiags) {
            if (Array.isArray(item) && item.length === 2) {
              const [uri, diags] = item as [vscode.Uri, vscode.Diagnostic[]];
              if (uri && (uri.scheme === 'file' || uri.scheme === 'untitled')) {
                const info = this.extractErrorInfo(diags);
                if (info.count > 0) {
                  this.errorCache.set(uri.toString(), info);
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  public extractErrorInfo(diags: vscode.Diagnostic[]): FileErrorInfo {
    let count = 0;
    let sample = '';
    if (Array.isArray(diags)) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          count++;
          if (!sample && d.message) {
            sample = d.message;
          }
        }
      }
    }
    return { count, sample };
  }

  private handleDiagnosticsChange = (e: vscode.DiagnosticChangeEvent): void => {
    if (!e || !Array.isArray(e.uris)) {
      return;
    }

    let hasChanges = false;

    for (const uri of e.uris) {
      if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled')) {
        continue;
      }
      const uriStr = uri.toString();
      const diags = vscode.languages.getDiagnostics(uri);
      const newInfo = this.extractErrorInfo(diags);
      const prevInfo = this.errorCache.get(uriStr);

      if (newInfo.count === 0) {
        if (prevInfo !== undefined) {
          this.errorCache.delete(uriStr);
          this.pendingUris.add(uri);
          hasChanges = true;
        }
      } else {
        if (!prevInfo || prevInfo.count !== newInfo.count || prevInfo.sample !== newInfo.sample) {
          this.errorCache.set(uriStr, newInfo);
          this.pendingUris.add(uri);
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      this.debouncedFireChanges(Array.from(this.pendingUris));
    }
  }

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    const isEnabled = getOmniConfig<boolean>('enableFileErrorDecoration', true);
    if (!isEnabled) {
      return undefined;
    }

    if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled')) {
      return undefined;
    }

    const uriStr = uri.toString();
    let info = this.errorCache.get(uriStr);

    if (info === undefined) {
      const diags = vscode.languages.getDiagnostics(uri);
      const extracted = this.extractErrorInfo(diags);
      if (extracted.count > 0) {
        this.errorCache.set(uriStr, extracted);
        info = extracted;
      }
    }

    if (!info || info.count <= 0) {
      return undefined;
    }

    const rawBadge = getOmniConfig<string>('fileErrorBadge', '!');
    const propagate = getOmniConfig<boolean>('fileErrorPropagate', true);

    let badge: string | undefined = undefined;
    if (rawBadge && rawBadge !== 'none') {
      badge = rawBadge.slice(0, 2);
    }

    const sample = info.sample
      ? ` - ${info.sample.slice(0, 80).replace(/\r?\n/g, ' ')}`
      : '';
    const tooltip = `XF OmniNav: 发现 ${info.count} 处代码错误 (PyCharm 警号)${sample}`;

    return {
      badge,
      color: new vscode.ThemeColor('list.errorForeground'),
      tooltip,
      propagate,
    };
  }

  public getCachedErrorCount(uri: vscode.Uri): number {
    return this.errorCache.get(uri.toString())?.count ?? 0;
  }

  public refreshAll(): void {
    this.errorCache.clear();
    this.scanExistingDiagnostics();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  dispose(): void {
    this.debouncedFireChanges.cancel();
    this.errorCache.clear();
    this.pendingUris.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
