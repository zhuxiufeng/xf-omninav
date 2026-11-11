import * as vscode from 'vscode';
import { StringInterner } from './indexer/stringInterner';

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
  isStatic?: boolean;
  isClassMethod?: boolean;
  isAbstract?: boolean;
}

/**
 * High-performance lightweight flyweight implementation of SymbolDefinition.
 * Stores range coordinates as primitive number tuples to avoid allocating
 * thousands of vscode.Position & vscode.Range objects during workspace indexing.
 */
export class CompactSymbolDefinition implements SymbolDefinition {
  public readonly name: string;
  public readonly kind: SymbolKind;
  public readonly containerName?: string;
  public readonly parentContainers?: string[];
  public readonly uri: vscode.Uri;
  public readonly signature: string;
  public readonly docstring?: string;
  public readonly fileRelativePath: string;
  public readonly isExported?: boolean;
  public readonly isStatic?: boolean;
  public readonly isClassMethod?: boolean;
  public readonly isAbstract?: boolean;

  private readonly _r: [number, number, number, number];
  private readonly _sr: [number, number, number, number];
  private _rangeObj?: vscode.Range;
  private _selRangeObj?: vscode.Range;

  constructor(options: {
    name: string;
    kind: SymbolKind;
    uri: vscode.Uri;
    range: vscode.Range | [number, number, number, number];
    selectionRange: vscode.Range | [number, number, number, number];
    signature: string;
    fileRelativePath: string;
    containerName?: string;
    parentContainers?: string[];
    docstring?: string;
    isExported?: boolean;
    isStatic?: boolean;
    isClassMethod?: boolean;
    isAbstract?: boolean;
  }) {
    this.name = options.name;
    this.kind = StringInterner.intern(options.kind);
    this.uri = options.uri;
    this.isStatic = options.isStatic;
    this.isClassMethod = options.isClassMethod;
    this.isAbstract = options.isAbstract;
    this._r = Array.isArray(options.range)
      ? options.range
      : [
          options.range.start.line,
          options.range.start.character,
          options.range.end.line,
          options.range.end.character,
        ];
    this._sr = Array.isArray(options.selectionRange)
      ? options.selectionRange
      : [
          options.selectionRange.start.line,
          options.selectionRange.start.character,
          options.selectionRange.end.line,
          options.selectionRange.end.character,
        ];
    this.signature = options.signature;
    this.fileRelativePath = StringInterner.intern(options.fileRelativePath);
    this.containerName = StringInterner.intern(options.containerName);
    this.parentContainers = options.parentContainers;
    this.docstring = options.docstring;
    this.isExported = options.isExported;
  }

  get range(): vscode.Range {
    if (!this._rangeObj) {
      this._rangeObj = new vscode.Range(this._r[0], this._r[1], this._r[2], this._r[3]);
    }
    return this._rangeObj;
  }

  set range(r: vscode.Range) {
    this._rangeObj = r;
    this._r[0] = r.start.line;
    this._r[1] = r.start.character;
    this._r[2] = r.end.line;
    this._r[3] = r.end.character;
  }

  get selectionRange(): vscode.Range {
    if (!this._selRangeObj) {
      this._selRangeObj = new vscode.Range(this._sr[0], this._sr[1], this._sr[2], this._sr[3]);
    }
    return this._selRangeObj;
  }

  set selectionRange(r: vscode.Range) {
    this._selRangeObj = r;
    this._sr[0] = r.start.line;
    this._sr[1] = r.start.character;
    this._sr[2] = r.end.line;
    this._sr[3] = r.end.character;
  }
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
