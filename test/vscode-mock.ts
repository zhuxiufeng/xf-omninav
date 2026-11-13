export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  public start: Position;
  public end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(a: any, b: any, c?: any, d?: any) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }

  isEqual(other: Range): boolean {
    return (
      this.start.line === other.start.line &&
      this.start.character === other.start.character &&
      this.end.line === other.end.line &&
      this.end.character === other.end.character
    );
  }

  contains(positionOrRange: Position | Range): boolean {
    if ('start' in positionOrRange) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    const pos = positionOrRange;
    if (pos.line < this.start.line || pos.line > this.end.line) {
      return false;
    }
    if (pos.line === this.start.line && pos.character < this.start.character) {
      return false;
    }
    if (pos.line === this.end.line && pos.character > this.end.character) {
      return false;
    }
    return true;
  }
}

export class Selection extends Range {
  public active: Position;
  public anchor: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export class Location {
  constructor(public uri: Uri, public range: Range | Position) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  public isTrusted: boolean = false;
  public supportHtml: boolean = false;
  constructor(public value: string = '') {}
  appendMarkdown(val: string): MarkdownString {
    this.value += val;
    return this;
  }
  appendCodeblock(code: string, language?: string): MarkdownString {
    this.value += `\n\`\`\`${language || ''}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error
  ) {}
}

export class CodeLens {
  constructor(public range: Range, public command?: any) {}
}

export class Uri {
  public scheme: string = 'file';
  constructor(public fsPath: string, scheme: string = 'file') {
    this.scheme = scheme;
    if (fsPath.startsWith('vscode-remote://')) {
      this.scheme = 'vscode-remote';
    }
  }
  static parse(val: string): Uri {
    const match = val.match(/^([a-zA-Z0-9+.-]+):\/\/(.*)$/);
    if (match) {
      return new Uri(match[2].split('?')[0], match[1]);
    }
    const matchWithoutDoubleSlash = val.match(/^([a-zA-Z0-9+.-]+):(.*)$/);
    if (matchWithoutDoubleSlash) {
      return new Uri(matchWithoutDoubleSlash[2].split('?')[0], matchWithoutDoubleSlash[1]);
    }
    return new Uri(val);
  }
  static file(val: string): Uri {
    return new Uri(val, 'file');
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class MockTextLine {
  constructor(public text: string, public lineNumber: number) {}
  get range(): Range {
    return new Range(this.lineNumber, 0, this.lineNumber, this.text.length);
  }
  get firstNonWhitespaceCharacterIndex(): number {
    const match = this.text.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }
}

export class MockTextDocument {
  private lines: string[];
  public uri: Uri;
  public languageId: string;

  constructor(content: string, uriStr = 'file:///test.py', languageId = 'python') {
    this.lines = content.split('\n');
    this.uri = Uri.parse(uriStr);
    this.languageId = languageId;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get fileName(): string {
    return this.uri.fsPath;
  }

  getText(range?: Range): string {
    if (!range) {
      return this.lines.join('\n');
    }
    if (range.start.line === range.end.line) {
      const line = this.lines[range.start.line] || '';
      return line.substring(range.start.character, range.end.character);
    }
    const result: string[] = [];
    for (let i = range.start.line; i <= range.end.line; i++) {
      const line = this.lines[i] || '';
      if (i === range.start.line) {
        result.push(line.substring(range.start.character));
      } else if (i === range.end.line) {
        result.push(line.substring(0, range.end.character));
      } else {
        result.push(line);
      }
    }
    return result.join('\n');
  }

  lineAt(line: number): MockTextLine {
    return new MockTextLine(this.lines[line] || '', line);
  }

  getWordRangeAtPosition(position: Position, regex = /[A-Za-z0-9_]+/): Range | undefined {
    const line = this.lineAt(position.line).text;
    const globalRegex = new RegExp(regex.source, 'g');
    let match;
    while ((match = globalRegex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return new Range(position.line, start, position.line, end);
      }
    }
    return undefined;
  }
}

export class EventEmitter<T = any> {
  private listeners: ((e: T) => any)[] = [];
  event = (listener: (e: T) => any) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    this.listeners.forEach((l) => l(data));
  }
  dispose() {
    this.listeners = [];
  }
}

export const env = {
  appRoot: '',
};

export const workspace = {
  workspaceFolders: [] as any[],
  textDocuments: [] as MockTextDocument[],
  asRelativePath(uri: Uri) {
    return uri.fsPath;
  },
  fs: {
    stat: async () => ({ type: 1 }),
    readDirectory: async () => [] as [string, number][],
    readFile: async () => Buffer.from(''),
  },
  findFiles: async () => [],
  getWorkspaceFolder(_uri: Uri) {
    return undefined;
  },
  getConfiguration() {
    return {
      get: (_key: string, defVal: any) => defVal,
    };
  },
  openTextDocument: async (uri: Uri) => {
    const found = workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString() || d.uri.fsPath.endsWith(uri.fsPath)
    );
    if (found) {
      return found;
    }
    return new MockTextDocument('', uri.toString(), 'python');
  },
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
  onDidOpenTextDocument: () => ({ dispose: () => {} }),
  onDidCloseTextDocument: () => ({ dispose: () => {} }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export const window = {
  activeTextEditor: undefined as any,
  visibleTextEditors: [] as any[],
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
  onDidChangeTextEditorVisibleRanges: () => ({ dispose: () => {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showQuickPick: async () => undefined,
  createTextEditorDecorationType: (_opt: any) => ({
    key: 'mock-dec',
    dispose: () => {},
  }),
  createQuickPick: () => ({
    title: '',
    placeholder: '',
    busy: false,
    items: [],
    selectedItems: [],
    matchOnDescription: false,
    matchOnDetail: false,
    show: () => {},
    hide: () => {},
    dispose: () => {},
    onDidAccept: (_cb: any) => ({ dispose: () => {} }),
    onDidHide: (_cb: any) => ({ dispose: () => {} }),
    onDidChangeSelection: (_cb: any) => ({ dispose: () => {} }),
  }),
  showTextDocument: async (doc: any) => ({
    document: doc,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    revealRange: () => {},
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  setStatusBarMessage: (_msg: string) => ({ dispose: () => {} }),
  createOutputChannel: (_name: string) => ({
    name: _name,
    append: (_val: string) => {},
    appendLine: (_val: string) => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  withProgress: async (_opt: any, task: any) => await task(),
  registerFileDecorationProvider: (_provider: any) => ({ dispose: () => {} }),
  onDidChangeVisibleTextEditors: (_cb: any) => ({ dispose: () => {} }),
};

export const languages = {
  diagnosticsMap: new Map<string, Diagnostic[]>(),
  getDiagnostics(uri?: Uri) {
    if (uri) {
      return languages.diagnosticsMap.get(uri.toString()) || [];
    }
    return Array.from(languages.diagnosticsMap.entries()).map(([k, v]) => [Uri.parse(k), v]);
  },
  onDidChangeDiagnosticsEmitter: new EventEmitter<any>(),
  onDidChangeDiagnostics(cb: any) {
    return languages.onDidChangeDiagnosticsEmitter.event(cb);
  },
  createDiagnosticCollection(name?: string) {
    return {
      name,
      get: (uri: Uri) => languages.diagnosticsMap.get(uri.toString()) || [],
      has: (uri: Uri) => languages.diagnosticsMap.has(uri.toString()),
      set: (uri: Uri, diags: Diagnostic[]) => {
        languages.diagnosticsMap.set(uri.toString(), diags);
        languages.onDidChangeDiagnosticsEmitter.fire({ uris: [uri] });
      },
      delete: (uri: Uri) => {
        languages.diagnosticsMap.delete(uri.toString());
        languages.onDidChangeDiagnosticsEmitter.fire({ uris: [uri] });
      },
      clear: () => {
        languages.diagnosticsMap.clear();
        languages.onDidChangeDiagnosticsEmitter.fire({ uris: [] });
      },
      dispose: () => {},
    };
  },
  registerDefinitionProvider: () => ({ dispose: () => {} }),
  registerImplementationProvider: () => ({ dispose: () => {} }),
  registerCodeLensProvider: () => ({ dispose: () => {} }),
  registerInlayHintsProvider: () => ({ dispose: () => {} }),
  registerHoverProvider: () => ({ dispose: () => {} }),
  registerCodeActionsProvider: () => ({ dispose: () => {} }),
  registerCodeActionProvider: () => ({ dispose: () => {} }),
  registerFoldingRangeProvider: () => ({ dispose: () => {} }),
  registerSignatureHelpProvider: () => ({ dispose: () => {} }),
  registerCompletionItemProvider: () => ({ dispose: () => {} }),
};

export class Hover {
  public contents: any[];
  constructor(contents: any, public range?: Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
}

export class CompletionItem {
  public detail?: string;
  public documentation?: string | MarkdownString;
  public sortText?: string;
  public filterText?: string;
  public insertText?: string | SnippetString;
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class SnippetString {
  constructor(public value: string = '') {}
}

export class ParameterInformation {
  public documentation?: string | MarkdownString;
  constructor(public label: string, documentation?: string | MarkdownString) {
    this.documentation = documentation;
  }
}

export class SignatureInformation {
  public documentation?: string | MarkdownString;
  public parameters: ParameterInformation[] = [];
  constructor(public label: string, documentation?: string | MarkdownString) {
    this.documentation = documentation;
  }
}

export class SignatureHelp {
  public signatures: SignatureInformation[] = [];
  public activeSignature: number = 0;
  public activeParameter: number = 0;
}

export enum CodeActionKind {
  QuickFix = 'quickfix',
  Refactor = 'refactor',
}

export class CodeAction {
  public edit?: WorkspaceEdit;
  public command?: any;
  public isPreferred?: boolean;
  constructor(public title: string, public kind?: CodeActionKind) {}
}

export class WorkspaceEdit {
  public _edits: any[] = [];
  delete(uri: Uri, range: Range) {
    this._edits.push({ type: 'delete', uri, range });
  }
  insert(uri: Uri, position: Position, newText: string) {
    this._edits.push({ type: 'insert', uri, position, newText });
  }
  replace(uri: Uri, range: Range, newText: string) {
    this._edits.push({ type: 'replace', uri, range, newText });
  }
  has(uri: Uri) {
    return this._edits.some((e) => e.uri.toString() === uri.toString());
  }
  get(uri: Uri) {
    return this._edits.filter((e) => e.uri.toString() === uri.toString());
  }
}

export enum InlayHintKind {
  Type = 1,
  Parameter = 2,
}

export class InlayHint {
  public tooltip?: string | MarkdownString;
  public paddingLeft?: boolean;
  public paddingRight?: boolean;
  constructor(
    public position: Position,
    public label: string | InlayHintLabelPart[],
    public kind?: InlayHintKind
  ) {}
}

export class InlayHintLabelPart {
  public tooltip?: string | MarkdownString;
  public command?: any;
  constructor(public value: string) {}
}

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
}

export const debug = {
  breakpoints: [],
  onDidChangeBreakpoints: () => ({ dispose: () => {} }),
};

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3,
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: FoldingRangeKind
  ) {}
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}
