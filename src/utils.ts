import * as vscode from 'vscode';
import * as path from 'path';
import { TargetLocation, InheritanceMarker } from './types';

/**
 * Check if two arrays of inheritance markers are structurally identical.
 * Used to avoid redundant UI re-renders that cause flickering.
 */
export function areMarkersEqual(
  a?: InheritanceMarker[],
  b?: InheritanceMarker[]
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const ma = a[i];
    const mb = b[i];
    if (
      ma.symbolName !== mb.symbolName ||
      ma.markerKind !== mb.markerKind ||
      ma.selectionRange.start.line !== mb.selectionRange.start.line ||
      ma.selectionRange.start.character !== mb.selectionRange.start.character ||
      ma.parents.length !== mb.parents.length ||
      ma.children.length !== mb.children.length
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Convert vscode.Range to a plain serializable object.
 */
export function rangeToSerializable(range: vscode.Range) {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

/**
 * Convert serializable range back to vscode.Range.
 */
export function serializableToRange(range: TargetLocation['range']): vscode.Range {
  return new vscode.Range(
    range.startLine,
    range.startCharacter,
    range.endLine,
    range.endCharacter
  );
}

/**
 * Format a Uri and line number into a human-readable label.
 */
export function formatLocationLabel(uriStr: string, line: number): string {
  try {
    const uri = vscode.Uri.parse(uriStr);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      const rel = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
      return `${rel}:${line + 1}`;
    }
    return `${path.basename(uri.fsPath)}:${line + 1}`;
  } catch {
    return `line ${line + 1}`;
  }
}

/**
 * Build a markdown command link for VS Code hover.
 */
export function createCommandUri(command: string, args: unknown): string {
  const argArray = Array.isArray(args) ? args : [args];
  const encodedArgs = encodeURIComponent(JSON.stringify(argArray));
  return `command:${command}?${encodedArgs}`;
}

/**
 * Execute a command with a timeout to prevent hanging on slow language servers.
 */
export async function executeCommandWithTimeout<T>(
  command: string,
  args: any[],
  timeoutMs = 5000
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });

  try {
    const execPromise = (vscode.commands.executeCommand(command, ...args) as Promise<T>).catch(
      () => undefined
    );
    return await Promise.race([execPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Simple debounce function.
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let timeout: NodeJS.Timeout | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };

  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return debounced;
}

/**
 * Embedded Base64 Data URIs for icons to ensure 100% reliable rendering
 * across Remote WSL, SSH, containers, and local environments.
 */
export const ICON_DATA_URIS = {
  dark_up_arrow: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ij4KICA8IS0tIFVwIGFycm93IGZvciBvdmVycmlkaW5nL2V4dGVuZGluZyBzdXBlcmNsYXNzL3N1cGVybWV0aG9kIChEYXJrIFRoZW1lKSAtLT4KICA8ZyBmaWxsPSIjNEVDOUIwIj4KICAgIDxwYXRoIGQ9Ik04IDIuNSBMMyA4IEw2IDggTDYgMTMuNSBMMTAgMTMuNSBMMTAgOCBMMTMgOCBaIiAvPgogICAgPHJlY3QgeD0iMiIgeT0iMTQiIHdpZHRoPSIxMiIgaGVpZ2h0PSIxLjUiIHJ4PSIwLjUiIG9wYWNpdHk9IjAuOCIvPgogIDwvZz4KPC9zdmc+Cg==',
  dark_down_arrow: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ij4KICA8IS0tIERvd24gYXJyb3cgZm9yIG92ZXJyaWRkZW4gYnkgc3ViY2xhc3MgKERhcmsgVGhlbWUpIC0tPgogIDxnIGZpbGw9IiNFNUMwN0IiPgogICAgPHJlY3QgeD0iMiIgeT0iMSIgd2lkdGg9IjEyIiBoZWlnaHQ9IjEuNSIgcng9IjAuNSIgb3BhY2l0eT0iMC44Ii8+CiAgICA8cGF0aCBkPSJNOCAxMy41IEwzIDggTDYgOCBMNiAyLjUgTDEwIDIuNSBMMTAgOCBMMTMgOCBaIiAvPgogIDwvZz4KPC9zdmc+Cg==',
  dark_up_down_arrow: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ij4KICA8IS0tIEJpZGlyZWN0aW9uYWwgYXJyb3cgZm9yIGJvdGggb3ZlcnJpZGluZyBhbmQgYmVpbmcgb3ZlcnJpZGRlbiAoRGFyayBUaGVtZSkgLS0+CiAgPGcgZmlsbD0iIzRFQzlCMCI+CiAgICA8IS0tIFVwIGFycm93IC0tPgogICAgPHBhdGggZD0iTTUgMiBMMiA2IEw0IDYgTDQgMTAgTDYgMTAgTDYgNiBMOCA2IFoiIC8+CiAgPC9nPgogIDxnIGZpbGw9IiNFNUMwN0IiPgogICAgPCEtLSBEb3duIGFycm93IC0tPgogICAgPHBhdGggZD0iTTExIDE0IEw4IDEwIEwxMCAxMCBMMTAgNiBMMTIgNiBMMTIgMTAgTDE0IDEwIFoiIC8+CiAgPC9nPgo8L3N2Zz4K',
  light_up_arrow: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ij4KICA8IS0tIFVwIGFycm93IGZvciBvdmVycmlkaW5nL2V4dGVuZGluZyBzdXBlcmNsYXNzL3N1cGVybWV0aG9kIChMaWdodCBUaGVtZSkgLS0+CiAgPGcgZmlsbD0iIzAwN0FDQyI+CiAgICA8cGF0aCBkPSJNOCAyLjUgTDMgOCBMNiA4IEw2IDEzLjUgTDEwIDEzLjUgTDEwIDggTDEzIDggWiIgLz4KICAgIDxyZWN0IHg9IjIiIHk9IjE0IiB3aWR0aD0iMTIiIGhlaWdodD0iMS41IiByeD0iMC41IiBvcGFjaXR5PSIwLjgiLz4KICA8L2c+Cjwvc3ZnPgo=',
  light_down_arrow: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ij4KICA8IS0tIERvd24gYXJyb3cgZm9yIG92ZXJyaWRkZW4gYnkgc3ViY2xhc3MgKExpZ2h0IFRoZW1lKSAtLT4KICA8ZyBmaWxsPSIjQjI2QjAwIj4KICAgIDxyZWN0IHg9IjIiIHk9IjEiIHdpZHRoPSIxMiIgaGVpZ2h0PSIxLjUiIHJ4PSIwLjUiIG9wYWNpdHk9IjAuOCIvPgogICAgPHBhdGggZD0iTTggMTMuNSBMMyA4IEw2IDggTDYgMi41IEwxMCAyLjUgTDEwIDggTDEzIDggWiIgLz4KICA8L2c+Cjwvc3ZnPgo=',
  light_up_down_arrow: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2Ij4KICA8IS0tIEJpZGlyZWN0aW9uYWwgYXJyb3cgZm9yIGJvdGggb3ZlcnJpZGluZyBhbmQgYmVpbmcgb3ZlcnJpZGRlbiAoTGlnaHQgVGhlbWUpIC0tPgogIDxnIGZpbGw9IiMwMDdBQ0MiPgogICAgPCEtLSBVcCBhcnJvdyAtLT4KICAgIDxwYXRoIGQ9Ik01IDIgTDIgNiBMNCA2IEw0IDEwIEw2IDEwIEw2IDYgTDggNiBaIiAvPgogIDwvZz4KICA8ZyBmaWxsPSIjQjI2QjAwIj4KICAgIDwhLS0gRG93biBhcnJvdyAtLT4KICAgIDxwYXRoIGQ9Ik0xMSAxNCBMOCAxMCBMMTAgMTAgTDEwIDYgTDEyIDYgTDEyIDEwIEwxNCAxMCBaIiAvPgogIDwvZz4KPC9zdmc+Cg==',
};

/**
 * Get configuration value with multi-level fallback:
 * xfOmniNav -> xfOmniTree / xfOmniJump -> inheritanceNavigator / smoothJump
 */
export function getOmniConfig<T>(key: string, defaultValue: T): T {
  const sections = ['xfOmniNav', 'xfOmniTree', 'xfOmniJump', 'inheritanceNavigator', 'smoothJump'];
  for (const section of sections) {
    try {
      const cfg = vscode.workspace.getConfiguration(section);
      const inspected = cfg.inspect<T>(key);
      if (inspected) {
        if (inspected.workspaceFolderValue !== undefined) {
          return inspected.workspaceFolderValue;
        }
        if (inspected.workspaceValue !== undefined) {
          return inspected.workspaceValue;
        }
        if (inspected.globalValue !== undefined) {
          return inspected.globalValue;
        }
      }
    } catch {
      // ignore
    }
  }

  const navCfg = vscode.workspace.getConfiguration('xfOmniNav');
  return navCfg.get<T>(key, defaultValue);
}

/**
 * Check whether a configuration change affects any OmniNav settings.
 */
export function isOmniConfigAffected(event: vscode.ConfigurationChangeEvent): boolean {
  return (
    event.affectsConfiguration('xfOmniNav') ||
    event.affectsConfiguration('xfOmniTree') ||
    event.affectsConfiguration('xfOmniJump') ||
    event.affectsConfiguration('inheritanceNavigator') ||
    event.affectsConfiguration('smoothJump')
  );
}

export const getTreeConfig = getOmniConfig;
export const isTreeConfigAffected = isOmniConfigAffected;

