import * as vscode from 'vscode';

export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'interface'
  | 'type'
  | 'module'
  | 'file';

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  containerName?: string; // e.g. "UserManager" for method "login"
  parentContainers?: string[]; // e.g. ["BaseService"] for class "UserService"
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
  signature: string; // e.g. "def login(self, username, password) -> bool:"
  docstring?: string;
  fileRelativePath: string;
  isExported?: boolean;
}

export interface JumpTarget {
  definition: SymbolDefinition;
  score: number;
  source: 'lsp' | 'workspace_ast' | 'import' | 'venv' | 'path';
}

export interface NavigationHistoryItem {
  uri: vscode.Uri;
  position: vscode.Position;
  timestamp: number;
}

/**
 * Type of inheritance relationship marker.
 */
export type MarkerKind = 'super' | 'sub' | 'both';

/**
 * Serializable target location for jump commands and hover URLs.
 */
export interface TargetLocation {
  uri: string;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  name: string;
  containerName?: string;
  kind?: string;
  detail?: string;
  description?: string;
  preview?: string;
}

/**
 * Represents a single inheritance marker on a class or method.
 */
export interface InheritanceMarker {
  symbolName: string;
  symbolKind: vscode.SymbolKind;
  markerKind: MarkerKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
  parents: TargetLocation[];
  children: TargetLocation[];
  documentUri: vscode.Uri;
}

/**
 * Analysis result for a document.
 */
export interface DocumentInheritanceResult {
  uri: vscode.Uri;
  version: number;
  markers: InheritanceMarker[];
}
